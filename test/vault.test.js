import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyVaultData,
  decryptVault,
  encryptVault,
  generateLocalUnlockSecret
} from "../src/vault.js";

test("vault round-trip encrypts account secrets", async () => {
  const data = createEmptyVaultData();
  data.accounts.push({
    id: "fake-id",
    label: "本地测试",
    email: "secret@example.invalid",
    sessionToken: "sensitive-fake-token"
  });

  const password = "correct horse battery staple";
  const blob = await encryptVault(data, password);
  const serialized = JSON.stringify(blob);
  assert.equal(serialized.includes("secret@example.invalid"), false);
  assert.equal(serialized.includes("sensitive-fake-token"), false);
  assert.deepEqual(await decryptVault(blob, password), data);
});

test("wrong passwords fail closed", async () => {
  const blob = await encryptVault(createEmptyVaultData(), "a sufficiently long password");
  await assert.rejects(() => decryptVault(blob, "incorrect password"), /口令错误/);
});

test("short encryption passwords are rejected", async () => {
  await assert.rejects(() => encryptVault(createEmptyVaultData(), "short"), /至少需要 10/);
});

test("local unlock secrets are random and can encrypt a vault", async () => {
  const first = generateLocalUnlockSecret();
  const second = generateLocalUnlockSecret();
  assert.notEqual(first, second);
  assert.ok(first.length >= 40);
  const data = createEmptyVaultData();
  assert.deepEqual(await decryptVault(await encryptVault(data, first), first), data);
});
