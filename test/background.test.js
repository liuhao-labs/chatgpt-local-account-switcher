import assert from "node:assert/strict";
import test from "node:test";

test("switch clears only session/account state and preserves device cookies", async () => {
  const removed = [];
  const written = [];
  let messageListener;

  globalThis.chrome = {
    storage: {
      local: {
        setAccessLevel: async () => {}
      }
    },
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: () => {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    cookies: {
      async getAll() {
        return [
          { name: "__Secure-next-auth.session-token.0", domain: ".chatgpt.com", path: "/", secure: true, storeId: "0" },
          { name: "_account", domain: "chatgpt.com", path: "/", secure: false, storeId: "0" },
          { name: "__Secure-oai-is", domain: ".chatgpt.com", path: "/", secure: true, storeId: "0" },
          { name: "oai-client-auth-info", domain: "chatgpt.com", path: "/", secure: false, storeId: "0" },
          { name: "_puid", domain: ".chatgpt.com", path: "/", secure: true, storeId: "0", partitionKey: { topLevelSite: "https://chatgpt.com" } },
          { name: "cf_clearance", domain: ".chatgpt.com", path: "/", secure: true, storeId: "0" },
          { name: "oai-did", domain: ".chatgpt.com", path: "/", secure: true, storeId: "0" }
        ];
      },
      async remove(details) {
        removed.push(details);
        return details;
      },
      async set(details) {
        written.push(details);
        return details;
      }
    },
    tabs: {
      async query() {
        throw new Error("navigate:false must not query tabs");
      }
    }
  };

  await import(`../background.js?test=${Date.now()}`);
  assert.equal(typeof messageListener, "function");

  const response = await new Promise((resolve) => {
    const keepChannelOpen = messageListener(
      {
        type: "switchAccount",
        navigate: false,
        account: {
          sessionToken: "t".repeat(120),
          accountId: "account_test",
          expires: new Date(Date.now() + 86_400_000).toISOString()
        }
      },
      { id: "test-extension-id" },
      resolve
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(
    removed.map((item) => item.name).sort(),
    [
      "__Secure-next-auth.session-token.0",
      "__Secure-oai-is",
      "_account",
      "_puid",
      "oai-client-auth-info"
    ].sort()
  );
  assert.equal(removed.some((item) => item.name === "cf_clearance"), false);
  assert.equal(removed.some((item) => item.name === "oai-did"), false);
  assert.deepEqual(
    removed.find((item) => item.name === "_puid")?.partitionKey,
    { topLevelSite: "https://chatgpt.com" }
  );

  const sessionCookie = written.find((item) => item.name === "__Secure-next-auth.session-token");
  assert.equal(sessionCookie.domain, ".chatgpt.com");
  assert.equal(sessionCookie.httpOnly, true);
  assert.equal(sessionCookie.secure, true);
  assert.equal(sessionCookie.sameSite, "lax");

  const accountCookie = written.find((item) => item.name === "_account");
  assert.equal(Object.hasOwn(accountCookie, "domain"), false);
  assert.equal(accountCookie.httpOnly, false);
  assert.equal(accountCookie.secure, true);
});
