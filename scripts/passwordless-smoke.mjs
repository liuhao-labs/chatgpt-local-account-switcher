import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = process.env.EDGE_EXECUTABLE;
const playwrightPackage = process.env.PLAYWRIGHT_PACKAGE;
let context;
let phase = "startup";

function report(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function extensionIdFromContext(browserContext) {
  const existing = browserContext.serviceWorkers()[0];
  if (existing?.url().startsWith("chrome-extension://")) {
    return new URL(existing.url()).host;
  }
  try {
    const worker = await browserContext.waitForEvent("serviceworker", { timeout: 15_000 });
    return new URL(worker.url()).host;
  } catch {
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());
    const session = await browserContext.newCDPSession(page);
    const targets = await session.send("Target.getTargets");
    const target = targets.targetInfos.find((item) => item.url.startsWith("chrome-extension://"));
    if (!target) {
      throw new Error("extension worker not found");
    }
    return new URL(target.url).host;
  }
}

async function openPopup(extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

try {
  if (!edgePath || !playwrightPackage) {
    throw new Error("required paths are missing");
  }

  const { chromium } = require(playwrightPackage);
  phase = "launch";
  context = await chromium.launchPersistentContext("", {
    executablePath: edgePath,
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=-32000,-32000",
      "--window-size=800,700"
    ],
    viewport: { width: 800, height: 700 }
  });

  const extensionId = await extensionIdFromContext(context);
  const originalPassword = "original local test password";
  const replacementPassword = "replacement local test password";
  const fakeToken = ["a".repeat(90), "b".repeat(90), "c".repeat(90), "d".repeat(90), "e".repeat(90)].join(".");
  const fakeSession = JSON.stringify({
    user: { id: "user_fake", email: "fake@example.invalid" },
    account: { id: "account_fake", name: "假账号" },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
    accessToken: "ignored-fake-access-token",
    sessionToken: fakeToken
  });

  phase = "create-and-import";
  const first = await openPopup(extensionId);
  await first.locator("#setup-password").fill(originalPassword);
  await first.locator("#setup-confirm").fill(originalPassword);
  await first.locator("#create-vault-button").click();
  await first.locator("#vault-view:not(.hidden)").waitFor();
  await first.locator("#session-json").fill(fakeSession);
  await first.locator("#import-button").click();
  await first.locator(".account-row").waitFor();

  phase = "remove-password";
  first.once("dialog", (dialog) => dialog.accept());
  await first.locator("#remove-password-button").click();
  await first.locator("#passwordless-banner:not(.hidden)").waitFor();
  const passwordlessStorage = await first.evaluate(async () => chrome.storage.local.get(["encryptedVault", "localUnlockKey"]));
  const keyStored = typeof passwordlessStorage.localUnlockKey === "string" && passwordlessStorage.localUnlockKey.length >= 40;
  const secretStillEncrypted = !JSON.stringify(passwordlessStorage.encryptedVault).includes(fakeToken);
  await first.close();

  phase = "auto-unlock";
  const second = await openPopup(extensionId);
  await second.locator("#vault-view:not(.hidden)").waitFor();
  await second.locator("#passwordless-banner:not(.hidden)").waitFor();
  const autoUnlocked = (await second.locator(".account-row").count()) === 1;

  phase = "restore-password";
  await second.locator("#set-password-button").click();
  await second.locator("#new-password").fill(replacementPassword);
  await second.locator("#new-password-confirm").fill(replacementPassword);
  await second.locator("#save-new-password-button").click();
  await second.locator("#passwordless-banner").waitFor({ state: "hidden" });
  const protectedStorage = await second.evaluate(async () => chrome.storage.local.get(["encryptedVault", "localUnlockKey"]));
  const localKeyRemoved = protectedStorage.localUnlockKey == null;
  await second.close();

  phase = "unlock-with-new-password";
  const third = await openPopup(extensionId);
  await third.locator("#unlock-view:not(.hidden)").waitFor();
  await third.locator("#unlock-password").fill(replacementPassword);
  await third.locator("#unlock-button").click();
  await third.locator("#vault-view:not(.hidden)").waitFor();
  const newPasswordWorks = (await third.locator(".account-row").count()) === 1;

  report({
    ok: keyStored && secretStillEncrypted && autoUnlocked && localKeyRemoved && newPasswordWorks,
    extensionLoaded: true,
    keyStored,
    secretStillEncrypted,
    autoUnlocked,
    localKeyRemoved,
    newPasswordWorks
  });
  if (!keyStored || !secretStillEncrypted || !autoUnlocked || !localKeyRemoved || !newPasswordWorks) {
    process.exitCode = 1;
  }
} catch (error) {
  report({ ok: false, phase, error: error instanceof Error ? error.name : "UnknownError" });
  process.exitCode = 1;
} finally {
  if (context) {
    await context.close().catch(() => {});
  }
}
