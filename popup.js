import { makeDisplayLabel, parseSessionJson } from "./src/core.js";
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
    "passwordless-banner",
    "remove-password-button",
    "set-password-button",
    "set-password-panel",
    "new-password",
    "new-password-confirm",
    "save-new-password-button",
    "cancel-new-password-button"
  ].map((id) => [id, document.getElementById(id)])
);

let vaultData = null;
let vaultPassword = "";
let passwordlessMode = false;
let currentView = "loading-view";

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
  elements["passwordless-banner"].classList.toggle("hidden", !vaultVisible || !passwordlessMode);
  elements["remove-password-button"].classList.toggle("hidden", !vaultVisible || passwordlessMode);
  elements["set-password-button"].classList.toggle("hidden", !vaultVisible || !passwordlessMode);
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
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-button";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => deleteAccount(account.id));
    actions.append(switchButton, deleteButton);

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
  if (!window.confirm("免密码模式会让任何能使用这个浏览器配置的人直接访问已保存账号。仍要继续吗？")) {
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
    setStatus("免密码保险库已创建。会话仍以密文保存。");
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

async function importAccount() {
  setBusy(elements["import-button"], true);
  try {
    const session = parseSessionJson(elements["session-json"].value);
    const requestedLabel = elements["account-label"].value;
    const duplicateIndex = vaultData.accounts.findIndex(
      (account) =>
        account.sessionToken === session.sessionToken ||
        (session.accountId && account.accountId === session.accountId) ||
        (session.email && account.email === session.email)
    );

    const existing = duplicateIndex >= 0 ? vaultData.accounts[duplicateIndex] : null;
    const record = {
      id: existing?.id ?? crypto.randomUUID(),
      label: makeDisplayLabel(session, requestedLabel || existing?.label),
      sessionToken: session.sessionToken,
      expires: session.expires,
      accountId: session.accountId,
      accountName: session.accountName,
      userId: session.userId,
      userName: session.userName,
      email: session.email,
      authProvider: session.authProvider,
      importedAt: new Date().toISOString()
    };

    if (duplicateIndex >= 0) {
      vaultData.accounts.splice(duplicateIndex, 1, record);
    } else {
      vaultData.accounts.push(record);
    }
    await saveVault();
    elements["session-json"].value = "";
    elements["account-label"].value = "";
    renderAccounts();
    setStatus(duplicateIndex >= 0 ? "账号会话已更新并重新加密。" : "账号已加密保存。accessToken 未被保存。");
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

async function deleteAccount(id) {
  const account = vaultData.accounts.find((item) => item.id === id);
  if (!account || !window.confirm(`从加密保险库中删除“${account.label}”？`)) {
    return;
  }
  vaultData.accounts = vaultData.accounts.filter((item) => item.id !== id);
  try {
    await saveVault();
    renderAccounts();
    setStatus("账号已从保险库删除。当前浏览器登录态未改变。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "删除失败。", true);
  }
}

function lockVault() {
  vaultData = null;
  vaultPassword = "";
  passwordlessMode = false;
  elements["session-json"].value = "";
  elements["account-label"].value = "";
  setStatus("");
  showOnly("unlock-view");
  elements["unlock-password"].focus();
}

async function eraseVault() {
  if (!window.confirm("永久删除这个浏览器配置中的加密保险库？此操作不会退出当前 ChatGPT 登录。")) {
    return;
  }
  await chrome.storage.local.remove([STORAGE_KEY, LOCAL_UNLOCK_KEY]);
  vaultData = null;
  vaultPassword = "";
  passwordlessMode = false;
  elements["session-json"].value = "";
  showOnly("setup-view");
  setStatus("本地保险库已删除。当前浏览器登录态未改变。");
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
    setStatus("保险库密码已取消；下次打开扩展将自动解锁。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "取消密码失败。", true);
  } finally {
    setBusy(elements["remove-password-button"], false);
  }
}

function showNewPasswordPanel() {
  elements["set-password-panel"].classList.remove("hidden");
  elements["new-password"].focus();
}

function hideNewPasswordPanel() {
  elements["new-password"].value = "";
  elements["new-password-confirm"].value = "";
  elements["set-password-panel"].classList.add("hidden");
}

async function saveNewPassword() {
  const password = elements["new-password"].value;
  const confirmation = elements["new-password-confirm"].value;
  if (password !== confirmation) {
    setStatus("两次输入的新口令不一致。", true);
    return;
  }

  setBusy(elements["save-new-password-button"], true);
  try {
    const encryptedVault = await encryptVault(vaultData, password);
    await chrome.storage.local.set({ [STORAGE_KEY]: encryptedVault });
    await chrome.storage.local.remove(LOCAL_UNLOCK_KEY);
    vaultPassword = password;
    passwordlessMode = false;
    hideNewPasswordPanel();
    renderPasswordMode();
    setStatus("保险库密码保护已重新启用。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "设置新口令失败。", true);
  } finally {
    setBusy(elements["save-new-password-button"], false);
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
elements["set-password-button"].addEventListener("click", showNewPasswordPanel);
elements["save-new-password-button"].addEventListener("click", saveNewPassword);
elements["cancel-new-password-button"].addEventListener("click", hideNewPasswordPanel);

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
