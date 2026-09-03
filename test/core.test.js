import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIMARY_SESSION_COOKIE,
  SESSION_COOKIE_CHUNK_SIZE,
  assertCredentialMatchesAccount,
  chunkSessionToken,
  createCredentialExport,
  isAccountBoundCookieName,
  isManagedSessionCookieName,
  parseSessionJson
} from "../src/core.js";

const future = new Date(Date.now() + 86_400_000).toISOString();
const fakeToken = ["a".repeat(80), "b".repeat(80), "c".repeat(80), "d".repeat(80), "e".repeat(80)].join(".");

test("session JSON is normalized without retaining accessToken", () => {
  const parsed = parseSessionJson(JSON.stringify({
    WARNING_BANNER: "do not share",
    user: { id: "user_fake", name: "测试账号", email: "safe@example.invalid" },
    account: { id: "acct_fake", name: "个人" },
    expires: future,
    accessToken: "must-not-survive",
    sessionToken: fakeToken,
    authProvider: "fake"
  }));

  assert.equal(parsed.sessionToken, fakeToken);
  assert.equal(parsed.accountId, "acct_fake");
  assert.equal(parsed.email, "safe@example.invalid");
  assert.equal(Object.hasOwn(parsed, "accessToken"), false);
  assert.equal(Object.hasOwn(parsed, "WARNING_BANNER"), false);
});

test("credential exports round-trip without adding an accessToken", () => {
  const account = {
    label: "测试导出",
    sessionToken: fakeToken,
    expires: future,
    accountId: "acct_fake",
    accountName: "个人",
    userId: "user_fake",
    userName: "测试账号",
    email: "safe@example.invalid",
    authProvider: "fake"
  };
  const payload = createCredentialExport(account, { now: Date.parse("2026-09-03T00:00:00Z") });
  assert.equal(payload.exportedBy, "chatgpt-local-account-switcher");
  assert.equal(payload.label, "测试导出");
  assert.equal(payload.sessionToken, fakeToken);
  assert.equal(Object.hasOwn(payload, "accessToken"), false);

  const parsed = parseSessionJson(JSON.stringify(payload), { now: Date.parse("2026-09-03T00:00:00Z") });
  assert.equal(parsed.exportLabel, "测试导出");
  assert.equal(parsed.accountId, "acct_fake");
  assert.equal(parsed.userId, "user_fake");
  assert.equal(parsed.sessionToken, fakeToken);
});

test("credential updates reject another account", () => {
  assert.equal(
    assertCredentialMatchesAccount(
      { accountId: "acct_fake", userId: "user_fake", email: "safe@example.invalid" },
      { accountId: "acct_fake", userId: "user_changed", email: "changed@example.invalid" }
    ),
    true
  );
  assert.throws(
    () => assertCredentialMatchesAccount({ accountId: "acct_fake" }, { accountId: "acct_other" }),
    /另一个账号/
  );
  assert.throws(
    () => assertCredentialMatchesAccount({ accountId: "acct_fake" }, { accountId: "" }),
    /缺少账号标识/
  );
});

test("expired and malformed sessions are rejected", () => {
  assert.throws(
    () => parseSessionJson(JSON.stringify({ sessionToken: fakeToken, expires: "2000-01-01T00:00:00Z" })),
    /过期/
  );
  assert.throws(() => parseSessionJson("{bad json"), /解析 JSON/);
  assert.throws(() => parseSessionJson({ sessionToken: `${fakeToken}\nunsafe`, expires: future }), /格式/);
});

test("long tokens use Auth.js-compatible 3936-byte chunks", () => {
  const exact = "x".repeat(SESSION_COOKIE_CHUNK_SIZE);
  assert.deepEqual(chunkSessionToken(exact), [{ name: PRIMARY_SESSION_COOKIE, value: exact }]);

  const long = "z".repeat(SESSION_COOKIE_CHUNK_SIZE * 2 + 17);
  const chunks = chunkSessionToken(long);
  assert.deepEqual(chunks.map((chunk) => chunk.name), [
    `${PRIMARY_SESSION_COOKIE}.0`,
    `${PRIMARY_SESSION_COOKIE}.1`,
    `${PRIMARY_SESSION_COOKIE}.2`
  ]);
  assert.equal(chunks.map((chunk) => chunk.value).join(""), long);
  assert.equal(chunks[0].value.length, SESSION_COOKIE_CHUNK_SIZE);
});

test("only exact session-cookie names and numeric chunks are managed", () => {
  assert.equal(isManagedSessionCookieName(PRIMARY_SESSION_COOKIE), true);
  assert.equal(isManagedSessionCookieName(`${PRIMARY_SESSION_COOKIE}.12`), true);
  assert.equal(isManagedSessionCookieName(`${PRIMARY_SESSION_COOKIE}.backup`), false);
  assert.equal(isManagedSessionCookieName("cf_clearance"), false);
  assert.equal(isManagedSessionCookieName("oai-did"), false);
});

test("only account-bound auxiliary cookies are cleared during a switch", () => {
  for (const name of ["_account", "__Secure-oai-is", "oai-client-auth-info", "_puid"]) {
    assert.equal(isAccountBoundCookieName(name), true, name);
  }
  for (const name of ["cf_clearance", "oai-did", "_cfuvid", "g_state", "oai-sc"]) {
    assert.equal(isAccountBoundCookieName(name), false, name);
  }
});
