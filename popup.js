import {
  assertCredentialMatchesAccount,
  createCredentialExport,
  makeDisplayLabel,
  parseSessionJson
} from "./src/core.js";
import {
  createEmptyVaultData,
  decryptVault,
  encryptVault,
  generateLocalUnlockSecret
} from "./src/vault.js";

const STORAGE_KEY = "encryptedVault";
const LOCAL_UNLOCK_KEY = "localUnlockKey";

const elements = Object.fromEntries(
  [
    "status",
    "loading-view",
    "setup-view",
    "unlock-view",
    "vault-view",
    "lock-button",
    "setup-password",
    "setup-confirm",
    "create-vault-button",
    "create-passwordless-button",
    "unlock-password",
    "unlock-button",
    "erase-locked-button",
    "account-count",
    "account-list",
    "empty-message",
    "account-label",
    "session-json",
    "import-button",
    "erase-vault-button",
    "remove-password-button",
    "credential-form",
    "credential-form-title",
    "credential-form-help",
    "cancel-update-button"
  ].map((id) => [id, document.getElementById(id)])
);

let vaultData = null;
let vaultPassword = "";
let passwordlessMode = false;
let currentView = "loading-view";
let updatingAccountId = null;

function showOnly(view) {
  currentView = view;
  for (const id of ["loading-view", "setup-view", "unlock-view", "vault-view"]) {
    elements[id].classList.toggle("hidden", id !== view);
  }
  renderPasswordMode();
}

function renderPasswordMode() {
  const vaultVisible = currentView === "vault-view";
  elements["lock-button"].classList.toggle("hidden", !vaultVisible || passwordlessMode);
  elements["remove-password-button"].classList.toggle("hidden", !vaultVisible || passwordlessMode);
}

function setStatus(message = "", isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("hidden", !message);
  elements.status.classList.toggle("error", isError);
}

function setBusy(button, busy) {
  button.disabled = busy;
}

function displayExpiry(expires) {
  if (!expires) {
    return "有效期未知";
  }
  try {
    return `有效期至 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(expires))}`;
  } catch {
    return "有效期未知";
  }
}

function closeAccountMenus(except = null) {
  for (const menu of elements["account-list"].querySelectorAll("details[open]")) {
    if (menu !== except) {
      menu.removeAttribute("open");
    }
  }
}

function createAccountMenuButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.setAttribute("role", "menuitem");
  button.addEventListener("click", onClick);
  return button;
}

function renderAccounts() {
  elements["account-list"].replaceChildren();
  const accounts = vaultData?.accounts ?? [];
  elements["account-count"].textContent = String(accounts.length);
  elements["empty-message"].classList.toggle("hidden", accounts.length !== 0);

  for (const account of accounts) {
    const row = document.createElement("article");
    row.className = "account-row";

    const copy = document.createElement("div");
    copy.className = "account-copy";
    const name = document.createElement("div");
    name.className = "account-name";
    name.textContent = account.label;
    const meta = document.createElement("div");
    meta.className = "account-meta";
    meta.textContent = [account.email, displayExpiry(account.expires)].filter(Boolean).join(" · ");
    copy.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "switch-button";
    switchButton.textContent = "切换";
    switchButton.addEventListener("click", () => switchAccount(account, switchButton));

    const menu = document.createElement("details");
    menu.className = "account-menu";
    menu.addEventListener("toggle", () => {
      if (menu.open) {
        closeAccountMenus(menu);
      }
    });
    const menuToggle = document.createElement("summary");
    menuToggle.className = "account-menu-toggle";
    menuToggle.textContent = "...";
    menuToggle.title = "账号操作";
    menuToggle.setAttribute("aria-label", `${account.label}的账号操作`);
    const menuItems = document.createElement("div");
    menuItems.className = "account-menu-items";
    menuItems.setAttribute("role", "menu");
    const updateButton = createAccountMenuButton("更新凭证", "account-menu-item", () => {
      menu.removeAttribute("open");
      beginCredentialUpdate(account);
    });
    const exportButton = createAccountMenuButton("导出凭证", "account-menu-item", () => {
      menu.removeAttribute("open");
      exportCredential(account);
    });
    const deleteButton = createAccountMenuButton("删除账号", "account-menu-item danger", () => {
      menu.removeAttribute("open");
      deleteAccount(account.id);
    });
    menuItems.append(updateButton, exportButton, deleteButton);
    menu.append(menuToggle, menuItems);
    actions.append(switchButton, menu);

    row.append(copy, actions);
    elements["account-list"].append(row);
  }
}

async function saveVault() {
  vaultData.updatedAt = new Date().toISOString();
  const encryptedVault = await encryptVault(vaultData, vaultPassword);
  await chrome.storage.local.set({ [STORAGE_KEY]: encryptedVault });
}

async function createVault() {
  const password = elements["setup-password"].value;
  const confirmation = elements["setup-confirm"].value;
  if (password !== confirmation) {
    setStatus("两次输入的口令不一致。", true);
    return;
  }

  setBusy(elements["create-vault-button"], true);
  try {
    vaultData = createEmptyVaultData();
    vaultPassword = password;
    passwordlessMode = false;
    await saveVault();
    await chrome.storage.local.remove(LOCAL_UNLOCK_KEY);
    elements["setup-password"].value = "";
    elements["setup-confirm"].value = "";
    showOnly("vault-view");
    renderAccounts();
    setStatus("本地加密保险库已创建。");
  } catch (error) {
    vaultData = null;
    vaultPassword = "";
    passwordlessMode = false;
    setStatus(error instanceof Error ? error.message : "创建失败。", true);
  } finally {
    setBusy(elements["create-vault-button"], false);
  }
}

async function createPasswordlessVault() {
  if (!window.confirm("直接使用会让任何能使用这个浏览器配置的人访问已保存账号。仍要继续吗？")) {
    return;
  }

  setBusy(elements["create-passwordless-button"], true);
  try {
    vaultData = createEmptyVaultData();
    vaultPassword = generateLocalUnlockSecret();
    const encryptedVault = await encryptVault(vaultData, vaultPassword);
    await chrome.storage.local.set({
      [STORAGE_KEY]: encryptedVault,
      [LOCAL_UNLOCK_KEY]: vaultPassword
    });
    passwordlessMode = true;
    showOnly("vault-view");
    renderAccounts();
    setStatus("本地账号列表已创建。");
  } catch (error) {
    vaultData = null;
    vaultPassword = "";
    passwordlessMode = false;
    setStatus(error instanceof Error ? error.message : "创建失败。", true);
  } finally {
    setBusy(elements["create-passwordless-button"], false);
  }
}

async function unlockVault() {
  const password = elements["unlock-password"].value;
  setBusy(elements["unlock-button"], true);
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    vaultData = await decryptVault(stored[STORAGE_KEY], password);
    vaultPassword = password;
    passwordlessMode = false;
    await chrome.storage.local.remove(LOCAL_UNLOCK_KEY);
    elements["unlock-password"].value = "";
    showOnly("vault-view");
    renderAccounts();
    setStatus("");
  } catch (error) {
    vaultData = null;
    vaultPassword = "";
    passwordlessMode = false;
    setStatus(error instanceof Error ? error.message : "解锁失败。", true);
  } finally {
    setBusy(elements["unlock-button"], false);
  }
}

function buildAccountRecord(session, existing, requestedLabel) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? crypto.randomUUID(),
    label: makeDisplayLabel(session, requestedLabel || session.exportLabel || existing?.label),
    sessionToken: session.sessionToken,
    expires: session.expires,
    accountId: session.accountId,
    accountName: session.accountName,
    userId: session.userId,
    userName: session.userName,
    email: session.email,
    authProvider: session.authProvider,
    importedAt: existing?.importedAt ?? now,
    updatedAt: now
  };
}

function resetCredentialForm() {
  updatingAccountId = null;
  elements["credential-form-title"].textContent = "添加账号";
  elements["credential-form-help"].textContent =
    "登录对应账号后，打开 https://chatgpt.com/api/auth/session，复制完整 JSON。扩展不会保存 accessToken。";
  elements["account-label"].value = "";
  elements["session-json"].value = "";
  elements["import-button"].textContent = "保存账号";
  elements["cancel-update-button"].classList.add("hidden");
}

function beginCredentialUpdate(account) {
  updatingAccountId = account.id;
  elements["credential-form-title"].textContent = `更新“${account.label}”`;
  elements["credential-form-help"].textContent =
    "登录这个账号并复制最新的会话 JSON。账号标识不一致时不会覆盖。";
  elements["account-label"].value = account.label;
  elements["session-json"].value = "";
  elements["import-button"].textContent = "保存更新";
  elements["cancel-update-button"].classList.remove("hidden");
  setStatus("");
  elements["credential-form"].scrollIntoView({ behavior: "smooth", block: "start" });
  elements["session-json"].focus();
}

async function importAccount() {
  setBusy(elements["import-button"], true);
  try {
    const session = parseSessionJson(elements["session-json"].value);
    const requestedLabel = elements["account-label"].value;
    let targetIndex;
    let existing;
    let statusMessage;

    if (updatingAccountId) {
      targetIndex = vaultData.accounts.findIndex((account) => account.id === updatingAccountId);
      if (targetIndex < 0) {
        throw new Error("要更新的账号已不存在。");
      }
      existing = vaultData.accounts[targetIndex];
      assertCredentialMatchesAccount(existing, session);
      statusMessage = "凭证已更新。";
    } else {
      targetIndex = vaultData.accounts.findIndex(
        (account) =>
          account.sessionToken === session.sessionToken ||
          (session.accountId && account.accountId === session.accountId) ||
          (session.email && account.email === session.email)
      );
      existing = targetIndex >= 0 ? vaultData.accounts[targetIndex] : null;
      statusMessage = existing ? "现有账号凭证已更新。" : "账号已保存。";
    }

    const record = buildAccountRecord(session, existing, requestedLabel);
    const previousAccounts = vaultData.accounts;
    vaultData.accounts = [...previousAccounts];
    if (targetIndex >= 0) {
      vaultData.accounts.splice(targetIndex, 1, record);
    } else {
      vaultData.accounts.push(record);
    }

    try {
      await saveVault();
    } catch (error) {
      vaultData.accounts = previousAccounts;
      throw error;
    }
    resetCredentialForm();
    renderAccounts();
    setStatus(statusMessage);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导入失败。", true);
  } finally {
    setBusy(elements["import-button"], false);
  }
}

async function switchAccount(account, button) {
  setBusy(button, true);
  setStatus("正在替换本地登录态…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "switchAccount",
      navigate: true,
      account: {
        sessionToken: account.sessionToken,
        accountId: account.accountId,
        expires: account.expires
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "切换失败。");
    }
    setStatus("切换完成，正在打开 ChatGPT…");
    setTimeout(() => window.close(), 350);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "切换失败。", true);
    setBusy(button, false);
  }
}

function exportCredential(account) {
  if (!window.confirm(`导出的 JSON 可直接登录“${account.label}”。任何获得文件的人都能使用这个账号，确定导出吗？`)) {
    return;
  }

  try {
    const payload = createCredentialExport(account);
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = payload.exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    link.href = url;
    link.download = `chatgpt-credential-${timestamp}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus("凭证已导出。导出文件可直接登录，请妥善保管。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导出失败。", true);
  }
}

async function deleteAccount(id) {
  const account = vaultData.accounts.find((item) => item.id === id);
  if (!account || !window.confirm(`从本地账号列表中删除“${account.label}”？`)) {
    return;
  }
  const previousAccounts = vaultData.accounts;
  vaultData.accounts = previousAccounts.filter((item) => item.id !== id);
  try {
    await saveVault();
    if (updatingAccountId === id) {
      resetCredentialForm();
    }
    renderAccounts();
    setStatus("账号已从本地列表删除。当前浏览器登录态未改变。");
  } catch (error) {
    vaultData.accounts = previousAccounts;
    setStatus(error instanceof Error ? error.message : "删除失败。", true);
  }
}

function lockVault() {
  vaultData = null;
  vaultPassword = "";
  passwordlessMode = false;
  resetCredentialForm();
  setStatus("");
  showOnly("unlock-view");
  elements["unlock-password"].focus();
}

async function eraseVault() {
  if (!window.confirm("永久删除这个浏览器配置中保存的全部账号？此操作不会退出当前 ChatGPT 登录。")) {
    return;
  }
  await chrome.storage.local.remove([STORAGE_KEY, LOCAL_UNLOCK_KEY]);
  vaultData = null;
  vaultPassword = "";
  passwordlessMode = false;
  resetCredentialForm();
  showOnly("setup-view");
  setStatus("本地账号已清空。当前浏览器登录态未改变。");
}

async function removeVaultPassword() {
  if (!window.confirm("取消密码后，任何能使用或复制此浏览器配置的人都能解锁账号保险库。确定继续吗？")) {
    return;
  }

  setBusy(elements["remove-password-button"], true);
  try {
    const localUnlockKey = generateLocalUnlockSecret();
    const encryptedVault = await encryptVault(vaultData, localUnlockKey);
    await chrome.storage.local.set({
      [STORAGE_KEY]: encryptedVault,
      [LOCAL_UNLOCK_KEY]: localUnlockKey
    });
    vaultPassword = localUnlockKey;
    passwordlessMode = true;
    renderPasswordMode();
    setStatus("设置已更新；以后打开扩展将直接显示账号。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "取消密码失败。", true);
  } finally {
    setBusy(elements["remove-password-button"], false);
  }
}

elements["create-vault-button"].addEventListener("click", createVault);
elements["create-passwordless-button"].addEventListener("click", createPasswordlessVault);
elements["unlock-button"].addEventListener("click", unlockVault);
elements["unlock-password"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    unlockVault();
  }
});
elements["import-button"].addEventListener("click", importAccount);
elements["lock-button"].addEventListener("click", lockVault);
elements["erase-vault-button"].addEventListener("click", eraseVault);
elements["erase-locked-button"].addEventListener("click", eraseVault);
elements["remove-password-button"].addEventListener("click", removeVaultPassword);
elements["cancel-update-button"].addEventListener("click", resetCredentialForm);

document.addEventListener("click", (event) => {
  for (const menu of elements["account-list"].querySelectorAll("details[open]")) {
    if (!menu.contains(event.target)) {
      menu.removeAttribute("open");
    }
  }
});

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, LOCAL_UNLOCK_KEY]);
    if (!stored[STORAGE_KEY]) {
      showOnly("setup-view");
      return;
    }
    if (!stored[LOCAL_UNLOCK_KEY]) {
      showOnly("unlock-view");
      return;
    }

    try {
      vaultData = await decryptVault(stored[STORAGE_KEY], stored[LOCAL_UNLOCK_KEY]);
      vaultPassword = stored[LOCAL_UNLOCK_KEY];
      passwordlessMode = true;
      showOnly("vault-view");
      renderAccounts();
    } catch {
      vaultData = null;
      vaultPassword = "";
      passwordlessMode = false;
      showOnly("unlock-view");
      setStatus("自动解锁信息无效，请输入保险库口令；成功后会修复本机状态。", true);
    }
  } catch {
    setStatus("无法读取浏览器本地存储。", true);
    showOnly("setup-view");
  }
}

initialize();
