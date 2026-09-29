import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionFile = process.argv[2];
const edgePath = process.env.EDGE_EXECUTABLE;
const playwrightPackage = process.env.PLAYWRIGHT_PACKAGE;

let phase = "startup";
let context;
const checks = {
  extensionLoaded: false,
  encryptedImport: false,
  cookieMatches: false,
  endpointAuthenticated: false,
  identityMatched: false,
  allTabsNavigated: false,
  homepageComposerVisible: false,
  homepageProfileVisible: false,
  homepageIdentityMatched: false
};

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

function reconstructSessionCookie(cookies) {
  const prefix = "__Secure-next-auth.session-token";
  const exact = cookies.find((cookie) => cookie.name === prefix);
  if (exact) {
    return exact.value;
  }
  return cookies
    .filter((cookie) => new RegExp(`^${prefix.replaceAll(".", "\\.")}\\.\\d+$`).test(cookie.name))
    .sort((left, right) => Number(left.name.split(".").at(-1)) - Number(right.name.split(".").at(-1)))
    .map((cookie) => cookie.value)
    .join("");
}

async function verifyHomepage(page, expected) {
  await page.bringToFront();
  const composer = page.locator('[contenteditable="true"]:visible').first();
  const profile = page.locator([
    '[data-testid="accounts-profile-button"]',
    'button[aria-label="打开个人资料菜单"]',
    'button[aria-label="Open profile menu"]'
  ].map((selector) => `${selector}:visible`).join(", ")).first();
  const [composerVisible, profileVisible] = await Promise.all([
    composer.waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false),
    profile.waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false)
  ]);
  let identityMatched = false;
  const identities = [expected.user?.email, expected.user?.name]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLocaleLowerCase());
  if (profileVisible && identities.length) {
    await profile.click();
    const menu = page.locator('[role="menu"]:visible').first();
    await menu.waitFor({ state: "visible", timeout: 15_000 });
    // The menu can become visible before its account details finish rendering.
    identityMatched = await page.waitForFunction((values) =>
      [...document.querySelectorAll('[role="menu"]')].some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          values.some((value) => element.innerText.toLocaleLowerCase().includes(value));
      }), identities, { timeout: 15_000 }
    ).then(() => true, () => false);
    await page.keyboard.press("Escape");
  }
  return { composerVisible, profileVisible, identityMatched };
}

try {
  if (!sessionFile || !edgePath || !playwrightPackage) {
    throw new Error("required paths are missing");
  }

  phase = "read-session";
  const rawSession = await readFile(path.resolve(sessionFile), "utf8");
  const expected = JSON.parse(rawSession);
  if (typeof expected.sessionToken !== "string") {
    throw new Error("sessionToken is missing");
  }

  phase = "launch-isolated-edge";
  const { chromium } = require(playwrightPackage);
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

  phase = "locate-extension";
  const extensionId = await extensionIdFromContext(context);
  checks.extensionLoaded = true;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  phase = "exercise-encrypted-import";
  const password = `Live-${randomBytes(18).toString("base64url")}`;
  await popup.locator("#setup-password").fill(password);
  await popup.locator("#setup-confirm").fill(password);
  await popup.locator("#create-vault-button").click();
  await popup.locator("#vault-view:not(.hidden)").waitFor();
  await popup.locator("#account-label").fill("隔离验证");
  await popup.locator("#session-json").fill(rawSession);
  await popup.locator("#import-button").click();
  await popup.locator(".account-row").waitFor();
  checks.encryptedImport = true;

  phase = "exercise-cookie-switch";
  const switchResult = await popup.evaluate(async ({ password }) => {
    const { encryptedVault } = await chrome.storage.local.get("encryptedVault");
    const { decryptVault } = await import(chrome.runtime.getURL("src/vault.js"));
    const vault = await decryptVault(encryptedVault, password);
    const account = vault.accounts[0];
    for (const [name, value] of [
      ["_account", "synthetic-old-account"],
      ["oai-client-auth-info", "synthetic"]
    ]) {
      const cookie = await chrome.cookies.set({
        url: "https://chatgpt.com/",
        path: "/",
        name,
        value,
        secure: false
      });
      if (!cookie || cookie.secure) {
        throw new Error("legacy cookie setup failed");
      }
    }
    return chrome.runtime.sendMessage({
      type: "switchAccount",
      navigate: false,
      account: {
        sessionToken: account.sessionToken,
        accountId: account.accountId,
        expires: account.expires
      }
    });
  }, { password });
  if (!switchResult?.ok) {
    throw new Error("background switch failed");
  }

  const cookies = await context.cookies("https://chatgpt.com/");
  checks.cookieMatches = reconstructSessionCookie(cookies) === expected.sessionToken;

  phase = "verify-auth-endpoint";
  const authPage = await context.newPage();
  await authPage.goto("https://chatgpt.com/api/auth/session", { waitUntil: "domcontentloaded", timeout: 60_000 });
  let actual = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const body = await authPage.locator("body").innerText().catch(() => "");
    try {
      actual = JSON.parse(body);
      break;
    } catch {
      await authPage.waitForTimeout(500);
    }
  }

  checks.endpointAuthenticated = Boolean(actual?.user && (actual.sessionToken || actual.accessToken));
  const hasExpectedIdentity = [expected.user?.id, expected.user?.email, expected.account?.id]
    .some((value) => typeof value === "string" && value.trim());
  checks.identityMatched = Boolean(
    checks.endpointAuthenticated && hasExpectedIdentity &&
    (!expected.user?.id || actual.user?.id === expected.user.id) &&
    (!expected.user?.email || actual.user?.email === expected.user.email) &&
    (!expected.account?.id || actual.account?.id === expected.account.id)
  );

  phase = "prepare-existing-chatgpt-tabs";
  const homePages = [authPage, await context.newPage()];
  await Promise.all(homePages.map(async (page) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate(() => {
      globalThis.__localAccountSwitcherSmokeMarker = true;
    });
  }));

  phase = "exercise-popup-switch-and-all-tabs";
  await Promise.all([
    ...homePages.map((page) => page.waitForFunction(() => (
      location.origin === "https://chatgpt.com" &&
      location.pathname === "/" &&
      !Object.prototype.hasOwnProperty.call(globalThis, "__localAccountSwitcherSmokeMarker")
    ), undefined, { timeout: 60_000 })),
    popup.locator(".switch-button").click()
  ]);
  checks.allTabsNavigated = true;

  phase = "verify-homepage-identity";
  // Profile menus close on tab blur, so inspect one foreground tab at a time.
  const homepageResults = [];
  for (const page of homePages) {
    homepageResults.push(await verifyHomepage(page, expected));
  }
  checks.homepageComposerVisible = homepageResults.every((result) => result.composerVisible);
  checks.homepageProfileVisible = homepageResults.every((result) => result.profileVisible);
  checks.homepageIdentityMatched = homepageResults.every((result) => result.identityMatched);

  const ok = Object.values(checks).every(Boolean);
  report({ ok, ...checks });
  if (!ok) {
    process.exitCode = 1;
  }
} catch (error) {
  report({ ok: false, ...checks, phase, error: error instanceof Error ? error.name : "UnknownError" });
  process.exitCode = 1;
} finally {
  if (context) {
    await context.close().catch(() => {});
  }
}
