export const SESSION_COOKIE_PREFIXES = Object.freeze([
  "__Secure-next-auth.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "authjs.session-token"
]);

export const PRIMARY_SESSION_COOKIE = "__Secure-next-auth.session-token";
export const SESSION_COOKIE_CHUNK_SIZE = 3936;
export const ACCOUNT_COOKIE_NAME = "_account";
export const ACCOUNT_BOUND_COOKIE_NAMES = Object.freeze([
  ACCOUNT_COOKIE_NAME,
  "__Secure-oai-is",
  "oai-client-auth-info",
  "_puid"
]);

const MAX_JSON_LENGTH = 200_000;
const MAX_TOKEN_LENGTH = 20_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const EXPORT_SOURCE = "chatgpt-local-account-switcher";

function cleanText(value, maxLength = 200) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

export function validateSessionToken(value) {
  if (typeof value !== "string") {
    throw new Error("会话数据中缺少 sessionToken。请复制完整的 /api/auth/session JSON。");
  }

  const token = value.trim();
  if (token.length < 80 || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    throw new Error("sessionToken 格式不符合预期，未执行导入。");
  }
  return token;
}

export function validateAccountId(value) {
  if (value == null || value === "") {
    return "";
  }
  const accountId = cleanText(String(value), 200);
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    return "";
  }
  return accountId;
}

export function parseSessionJson(source, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let payload;

  if (typeof source === "string") {
    if (source.length === 0 || source.length > MAX_JSON_LENGTH) {
      throw new Error("会话 JSON 为空或过大。");
    }
    try {
      payload = JSON.parse(source);
    } catch {
      throw new Error("无法解析 JSON，请确认复制的是 /api/auth/session 的完整内容。");
    }
  } else {
    payload = source;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("会话 JSON 的顶层必须是对象。");
  }

  const sessionToken = validateSessionToken(
    payload.sessionToken ?? payload.session_token ?? payload.session?.sessionToken
  );

  let expires = null;
  if (payload.expires != null && payload.expires !== "") {
    const expiresMs = Date.parse(payload.expires);
    if (!Number.isFinite(expiresMs)) {
      throw new Error("会话过期时间格式无效。");
    }
    if (expiresMs <= now) {
      throw new Error("这个会话已经过期，请重新登录后再复制。");
    }
    expires = new Date(expiresMs).toISOString();
  }

  const user = payload.user && typeof payload.user === "object" ? payload.user : {};
  const account = payload.account && typeof payload.account === "object" ? payload.account : {};

  return {
    schemaVersion: 1,
    sessionToken,
    expires,
    exportLabel: cleanText(payload.label, 80),
    accountId: validateAccountId(account.id ?? payload.accountId),
    accountName: cleanText(account.name ?? account.label, 120),
    userId: cleanText(user.id, 200),
    userName: cleanText(user.name, 120),
    email: cleanText(user.email, 254),
    authProvider: cleanText(payload.authProvider ?? payload.auth_provider, 80)
  };
}

export function assertCredentialMatchesAccount(account, session) {
  const identityFields = [
    ["accountId", "账号"],
    ["userId", "用户"],
    ["email", "邮箱"]
  ];

  for (const [field, label] of identityFields) {
    const current = cleanText(account?.[field], 254);
    if (!current) {
      continue;
    }
    const incoming = cleanText(session?.[field], 254);
    if (!incoming) {
      throw new Error(`新凭证缺少${label}标识，无法确认属于当前账号。`);
    }
    if (incoming !== current) {
      throw new Error(`新凭证属于另一个${label}，未覆盖原记录。`);
    }
    return true;
  }

  throw new Error("当前记录缺少可比对的账号标识，请删除后重新添加。");
}

export function createCredentialExport(account, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const exportedAt = new Date(now);
  if (!Number.isFinite(exportedAt.getTime())) {
    throw new Error("导出时间无效。");
  }

  const expires = account?.expires ? new Date(account.expires) : null;
  if (expires && !Number.isFinite(expires.getTime())) {
    throw new Error("凭证过期时间无效。");
  }

  return {
    schemaVersion: 1,
    exportedBy: EXPORT_SOURCE,
    exportedAt: exportedAt.toISOString(),
    label: cleanText(account?.label, 80),
    user: {
      id: cleanText(account?.userId, 200),
      name: cleanText(account?.userName, 120),
      email: cleanText(account?.email, 254)
    },
    account: {
      id: validateAccountId(account?.accountId),
      name: cleanText(account?.accountName, 120)
    },
    expires: expires ? expires.toISOString() : null,
    authProvider: cleanText(account?.authProvider, 80),
    sessionToken: validateSessionToken(account?.sessionToken)
  };
}

export function makeDisplayLabel(session, requestedLabel = "") {
  return (
    cleanText(requestedLabel, 80) ||
    cleanText(session.accountName, 80) ||
    cleanText(session.userName, 80) ||
    cleanText(session.email, 80) ||
    "未命名账号"
  );
}

export function chunkSessionToken(token, prefix = PRIMARY_SESSION_COOKIE) {
  const value = validateSessionToken(token);
  if (value.length <= SESSION_COOKIE_CHUNK_SIZE) {
    return [{ name: prefix, value }];
  }

  const chunks = [];
  for (let offset = 0, index = 0; offset < value.length; offset += SESSION_COOKIE_CHUNK_SIZE, index += 1) {
    chunks.push({
      name: `${prefix}.${index}`,
      value: value.slice(offset, offset + SESSION_COOKIE_CHUNK_SIZE)
    });
  }
  return chunks;
}

export function isManagedSessionCookieName(name) {
  return SESSION_COOKIE_PREFIXES.some(
    (prefix) => name === prefix || new RegExp(`^${escapeRegExp(prefix)}\\.\\d+$`).test(name)
  );
}

export function isAccountBoundCookieName(name) {
  return ACCOUNT_BOUND_COOKIE_NAMES.includes(name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function expirationDateFromIso(expires) {
  if (!expires) {
    return undefined;
  }
  const timestamp = Date.parse(expires) / 1000;
  return Number.isFinite(timestamp) && timestamp > Date.now() / 1000 ? timestamp : undefined;
}
