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
let switchQueue = Promise.resolve();

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
  // HTTPS can access non-Secure cookies too; HTTP is outside our host permission.
  return `https://${host}${path}`;
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

async function getManagedCookies() {
  const cookies = await chrome.cookies.getAll({ domain: "chatgpt.com" });
  return cookies.filter(
    (cookie) => isManagedSessionCookieName(cookie.name) || isAccountBoundCookieName(cookie.name)
  );
}

async function settleAll(operations) {
  const results = await Promise.allSettled(operations);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
}

function validateAccount(account) {
  const token = validateSessionToken(account?.sessionToken);
  const accountId = validateAccountId(account?.accountId);
  const expires = account?.expires;
  let expirationDate;
  if (expires != null && expires !== "") {
    if (typeof expires !== "string" || !Number.isFinite(Date.parse(expires))) {
      throw new Error("会话过期时间格式无效，请更新凭证后重试。");
    }
    expirationDate = expirationDateFromIso(expires);
    if (expirationDate === undefined) {
      throw new Error("这个会话已经过期，请重新登录并更新凭证。");
    }
  }

  return { token, accountId, expirationDate };
}

async function writeSessionCookies({ token, accountId, expirationDate }) {
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
    const written = await chrome.cookies.set(details);
    if (!written) {
      throw new Error("浏览器拒绝写入账号 Cookie。");
    }
  }
}

async function restoreCookie(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    storeId: cookie.storeId
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (cookie.expirationDate != null && !cookie.session) details.expirationDate = cookie.expirationDate;
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  if (!await chrome.cookies.set(details)) {
    throw new Error("无法恢复原登录态，请重新切换或正常登录。");
  }
}

async function replaceSessionCookies(account) {
  const previous = await getManagedCookies();
  try {
    await settleAll(previous.map(removeCookie));
    await writeSessionCookies(account);
    const current = await getManagedCookies();
    const expected = chunkSessionToken(account.token);
    if (account.accountId) expected.push({ name: ACCOUNT_COOKIE_NAME, value: account.accountId });
    if (current.length !== expected.length || expected.some((item) =>
      current.filter((cookie) => cookie.name === item.name && cookie.value === item.value).length !== 1
    )) {
      throw new Error("登录态写入校验失败，请重试。");
    }
  } catch (error) {
    try {
      await settleAll((await getManagedCookies()).map(removeCookie));
      await settleAll(previous.map(restoreCookie));
      const signature = (cookies) => cookies.map((cookie) => JSON.stringify([
        cookie.name, cookie.value, cookie.domain, cookie.path, cookie.storeId, cookie.partitionKey ?? null
      ])).sort();
      if (JSON.stringify(signature(await getManagedCookies())) !== JSON.stringify(signature(previous))) {
        throw new Error("Cookie 恢复校验失败。");
      }
    } catch {
      throw new Error("切换失败且无法完整恢复原登录态，请重新切换或正常登录。");
    }
    throw new Error(`${error instanceof Error ? error.message : "切换失败。"} 已恢复原登录态。`);
  }
}

async function parkChatGptTabs(tabs) {
  await settleAll(tabs.map(async (tab) => {
    await chrome.tabs.update(tab.id, { url: "about:blank" });
    const deadline = Date.now() + 10_000;
    // update() only starts navigation. Wait for the old document and its requests to end.
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.url === "about:blank" && current.status === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("旧 ChatGPT 页面未能停止加载，请重试。");
  }));
}

async function openOrReloadChatGpt(tabs) {
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
  if (activeTab) {
    await settleAll(tabs.map((tab) => {
      const details = { url: CHATGPT_URL };
      if (tab.id === activeTab.id) {
        details.active = true;
      }
      return chrome.tabs.update(tab.id, details);
    }));
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

  const operation = switchQueue.then(async () => {
    const account = validateAccount(message.account);
    const tabs = message.navigate === false ? [] :
      (await chrome.tabs.query({ url: "https://chatgpt.com/*" })).filter((tab) => tab.id != null);
    try {
      await parkChatGptTabs(tabs);
      await replaceSessionCookies(account);
    } catch (error) {
      // Cookie rollback finishes before any old page is allowed to resume requests.
      await Promise.allSettled(tabs.map((tab) =>
        chrome.tabs.update(tab.id, { url: tab.url || CHATGPT_URL })
      ));
      throw error;
    }
    if (message.navigate !== false) {
      try {
        await openOrReloadChatGpt(tabs);
      } catch {
        throw new Error("凭据已写入，但部分页面未能打开，请手动打开 ChatGPT 首页。");
      }
    }
    return { ok: true };
  });
  // Keep each clear/write/navigation sequence together, even after a failed switch.
  switchQueue = operation.catch(() => {});
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "切换失败。" });
    });
  return true;
});
