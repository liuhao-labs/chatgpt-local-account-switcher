const VAULT_VERSION = 1;
const KDF_ITERATIONS = 600_000;
const MIN_KDF_ITERATIONS = 200_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const AAD = new TextEncoder().encode("chatgpt-local-account-switcher:v1");

function webCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("当前环境不支持 Web Crypto，无法安全保存凭据。");
  }
  return globalThis.crypto;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 15_000_000) {
    throw new Error("保险库编码无效。");
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("保险库编码无效。");
  }
}

async function deriveKey(password, salt, iterations, usages) {
  const cryptoApi = webCrypto();
  const material = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function assertVaultData(data) {
  if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.accounts)) {
    throw new Error("保险库内容无效。");
  }
  if (data.accounts.length > 100) {
    throw new Error("保险库账号数量超过上限。");
  }
  return data;
}

export function createEmptyVaultData() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accounts: []
  };
}

export function generateLocalUnlockSecret() {
  const secret = webCrypto().getRandomValues(new Uint8Array(32));
  return bytesToBase64(secret);
}

export async function encryptVault(data, password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("保险库口令至少需要 10 个字符。");
  }
  assertVaultData(data);

  const cryptoApi = webCrypto();
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
    key,
    plaintext
  );

  return {
    version: VAULT_VERSION,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt)
    },
    cipher: {
      name: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    }
  };
}

export async function decryptVault(blob, password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("请输入保险库口令。");
  }
  if (
    !blob ||
    typeof blob !== "object" ||
    blob.version !== VAULT_VERSION ||
    blob.kdf?.name !== "PBKDF2" ||
    blob.kdf?.hash !== "SHA-256" ||
    blob.cipher?.name !== "AES-GCM"
  ) {
    throw new Error("保险库格式不受支持。");
  }

  const iterations = blob.kdf.iterations;
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error("保险库的密钥派生参数无效。");
  }

  try {
    const salt = base64ToBytes(blob.kdf.salt);
    const iv = base64ToBytes(blob.cipher.iv);
    const ciphertext = base64ToBytes(blob.cipher.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) {
      throw new Error("invalid lengths");
    }
    const key = await deriveKey(password, salt, iterations, ["decrypt"]);
    const plaintext = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
      key,
      ciphertext
    );
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    return assertVaultData(data);
  } catch {
    throw new Error("口令错误，或保险库已经损坏。");
  }
}
