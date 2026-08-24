import {
  ACCOUNT_COOKIE_NAME,
  chunkSessionToken,
  expirationDateFromIso,
  isAccountBoundCookieName,
  isManagedSessionCookieName,
  validateAccountId,
  validateSessionToken
} from "./src/core.js";

const CHATGPT_URL = "https://chatgpt.com/";

async function restrictStorageAccess() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

restrictStorageAccess().catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  restrictStorageAccess().catch(() => {});
});

function cookieUrl(cookie) {
  const host = cookie.domain.replace(/^\./, "");
  const path = cookie.path?.startsWith("/") ? cookie.path : "/";
  return `${cookie.secure ? "https" : "http"}://${host}${path}`;
}

async function removeCookie(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId
  };
  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }
  await chrome.cookies.remove(details);
}

async function clearManagedCookies() {
  const cookies = await chrome.cookies.getAll({ domain: "chatgpt.com" });
  const managed = cookies.filter(
    (cookie) => isManagedSessionCookieName(cookie.name) || isAccountBoundCookieName(cookie.name)
  );
  await Promise.all(managed.map(removeCookie));
}

async function setSessionCookies(account) {
  const token = validateSessionToken(account?.sessionToken);
  const accountId = validateAccountId(account?.accountId);
  const expirationDate = expirationDateFromIso(account?.expires);

  await clearManagedCookies();

  for (const chunk of chunkSessionToken(token)) {
    const details = {
      url: CHATGPT_URL,
      domain: ".chatgpt.com",
      path: "/",
      name: chunk.name,
      value: chunk.value,
      secure: true,
      httpOnly: true,
      sameSite: "lax"
    };
    if (expirationDate) {
      details.expirationDate = expirationDate;
    }
    const written = await chrome.cookies.set(details);
    if (!written) {
      throw new Error("浏览器拒绝写入会话 Cookie。");
    }
  }

  if (accountId) {
    const details = {
      url: CHATGPT_URL,
      path: "/",
      name: ACCOUNT_COOKIE_NAME,
      value: accountId,
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    };
    if (expirationDate) {
      details.expirationDate = expirationDate;
    }
    await chrome.cookies.set(details);
  }
}

async function openOrReloadChatGpt() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
  if (activeTab?.id != null) {
    await chrome.tabs.update(activeTab.id, { url: CHATGPT_URL, active: true });
    return;
  }
  await chrome.tabs.create({ url: CHATGPT_URL, active: true });
}

async function handleMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) {
    throw new Error("拒绝非扩展页面的请求。");
  }
  if (message?.type !== "switchAccount") {
    throw new Error("未知请求。");
  }

  await setSessionCookies(message.account);
  if (message.navigate !== false) {
    await openOrReloadChatGpt();
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "切换失败。" });
    });
  return true;
});
