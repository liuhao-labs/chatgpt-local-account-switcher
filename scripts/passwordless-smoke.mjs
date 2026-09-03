import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
  const fakeToken = ["a".repeat(90), "b".repeat(90), "c".repeat(90), "d".repeat(90), "e".repeat(90)].join(".");
  const updatedToken = ["f".repeat(90), "g".repeat(90), "h".repeat(90), "i".repeat(90), "j".repeat(90)].join(".");
  const baseSession = {
    user: { id: "user_fake", email: "fake@example.invalid" },
    account: { id: "account_fake", name: "假账号" },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
    accessToken: "ignored-fake-access-token"
  };
  const fakeSession = JSON.stringify({ ...baseSession, sessionToken: fakeToken });
  const updatedSession = JSON.stringify({ ...baseSession, sessionToken: updatedToken });

  phase = "create-direct-and-import";
  const first = await openPopup(extensionId);
  first.once("dialog", (dialog) => dialog.accept());
  await first.locator("#create-passwordless-button").click();
  await first.locator("#vault-view:not(.hidden)").waitFor();
  const forbiddenWords = /加密|密码|口令|保险库|免密|解锁|锁定/;
  const directViewIsNeutral = !forbiddenWords.test(await first.locator("body").innerText());
  await first.locator("#session-json").fill(fakeSession);
  await first.locator("#import-button").click();
  await first.locator(".account-row").waitFor();

  phase = "update-credential";
  await first.locator(".account-menu-toggle").click();
  await first.getByRole("menuitem", { name: "更新凭证" }).click();
  await first.locator("#session-json").fill(updatedSession);
  await first.locator("#import-button").click();
  await first.getByText("凭证已更新。", { exact: true }).waitFor();
  const passwordlessStorage = await first.evaluate(async () => chrome.storage.local.get(["encryptedVault", "localUnlockKey"]));
  const keyStored = typeof passwordlessStorage.localUnlockKey === "string" && passwordlessStorage.localUnlockKey.length >= 40;
  const secretStillEncrypted =
    !JSON.stringify(passwordlessStorage.encryptedVault).includes(fakeToken) &&
    !JSON.stringify(passwordlessStorage.encryptedVault).includes(updatedToken);
  const credentialUpdated = await first.evaluate(async ({ updatedToken }) => {
    const stored = await chrome.storage.local.get(["encryptedVault", "localUnlockKey"]);
    const { decryptVault } = await import(chrome.runtime.getURL("src/vault.js"));
    const data = await decryptVault(stored.encryptedVault, stored.localUnlockKey);
    return data.accounts.length === 1 && data.accounts[0].sessionToken === updatedToken;
  }, { updatedToken });

  phase = "export-credential";
  await first.locator(".account-menu-toggle").click();
  first.once("dialog", (dialog) => dialog.accept());
  const downloadPromise = first.waitForEvent("download");
  await first.getByRole("menuitem", { name: "导出凭证" }).click();
  const download = await downloadPromise;
  const exportedPath = await download.path();
  const exported = JSON.parse(await readFile(exportedPath, "utf8"));
  const credentialExported =
    exported.exportedBy === "chatgpt-local-account-switcher" &&
    exported.sessionToken === updatedToken &&
    exported.account?.id === "account_fake" &&
    !Object.hasOwn(exported, "accessToken");
  await first.close();

  phase = "auto-unlock";
  const second = await openPopup(extensionId);
  await second.locator("#vault-view:not(.hidden)").waitFor();
  const autoUnlocked = (await second.locator(".account-row").count()) === 1;
  const reopenedViewIsNeutral = !forbiddenWords.test(await second.locator("body").innerText());
  if (process.env.SMOKE_SCREENSHOT) {
    await second.locator(".account-menu-toggle").click();
    await second.screenshot({ path: path.resolve(process.env.SMOKE_SCREENSHOT), fullPage: true });
  }

  report({
    ok:
      directViewIsNeutral &&
      keyStored &&
      secretStillEncrypted &&
      credentialUpdated &&
      credentialExported &&
      autoUnlocked &&
      reopenedViewIsNeutral,
    extensionLoaded: true,
    directViewIsNeutral,
    keyStored,
    secretStillEncrypted,
    credentialUpdated,
    credentialExported,
    autoUnlocked,
    reopenedViewIsNeutral
  });
  if (
    !directViewIsNeutral ||
    !keyStored ||
    !secretStillEncrypted ||
    !credentialUpdated ||
    !credentialExported ||
    !autoUnlocked ||
    !reopenedViewIsNeutral
  ) {
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
