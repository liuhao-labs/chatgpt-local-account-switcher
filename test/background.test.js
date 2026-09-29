import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

const SESSION_COOKIE = "__Secure-next-auth.session-token";
let fixtureId = 0;

async function createBackgroundFixture(options = {}) {
  const jar = new Map((options.cookies ?? []).map((cookie) => [cookie.name, cookie]));
  const tabState = new Map((options.tabs ?? []).map((tab) => [tab.id, {
    url: `https://chatgpt.com/c/fake_${tab.id}`, status: "complete", ...tab
  }]));
  const removed = [];
  const written = [];
  const navigated = [];
  const events = [];
  let messageListener;
  let reads = 0;
  let tabQueries = 0;

  globalThis.chrome = {
    storage: { local: { async setAccessLevel() {} } },
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    cookies: {
      async getAll() {
        reads += 1;
        events.push("cookies:getAll");
        await options.onRead?.({ jar, reads });
        return [...jar.values()];
      },
      async remove(details) {
        events.push(`cookies:remove:${details.name}`);
        removed.push(details);
        jar.delete(details.name);
        return details;
      },
      async set(details) {
        events.push(`cookies:set:${details.name}`);
        written.push(details);
        if (options.rejectWrite?.(details)) {
          return null;
        }
        const cookie = {
          name: details.name, value: details.value,
          domain: details.domain ?? new URL(details.url).hostname,
          path: details.path ?? "/", hostOnly: !Object.hasOwn(details, "domain"),
          secure: details.secure ?? false, httpOnly: details.httpOnly ?? false,
          sameSite: details.sameSite ?? "unspecified", storeId: details.storeId ?? "0",
          session: details.expirationDate == null
        };
        if (details.expirationDate != null) cookie.expirationDate = details.expirationDate;
        if (details.partitionKey) cookie.partitionKey = details.partitionKey;
        jar.set(cookie.name, cookie);
        await options.onWrite?.(details, { jar });
        return cookie;
      }
    },
    tabs: {
      async query(details) {
        assert.deepEqual(details, { url: "https://chatgpt.com/*" });
        tabQueries += 1;
        return [...tabState.values()].filter((tab) => tab.url.startsWith("https://chatgpt.com/"))
          .map((tab) => ({ ...tab }));
      },
      async get(id) {
        events.push(`tabs:get:${id}`);
        const tab = { ...tabState.get(id) };
        return await options.onTabGet?.(tab, { jar }) ?? tab;
      },
      async update(id, details) {
        const navigation = { id, ...details };
        events.push(`tabs:update:${id}:${details.url}`);
        navigated.push(navigation);
        await options.onNavigate?.(navigation);
        tabState.set(id, { ...tabState.get(id), ...details, status: "complete" });
        return navigation;
      },
      async create(details) {
        events.push(`tabs:create:${details.url}`);
        navigated.push(details);
        await options.onNavigate?.(details);
        const tab = { id: 100 + navigated.length, ...details, status: "complete" };
        tabState.set(tab.id, tab);
        return tab;
      }
    }
  };

  await import(`../background.js?fixture=${fixtureId++}`);
  return {
    jar, removed, written, navigated, events,
    get reads() { return reads; },
    get tabQueries() { return tabQueries; },
    send(account, navigate = false) {
      return new Promise((resolve) => {
        assert.equal(messageListener(
          { type: "switchAccount", account, navigate },
          { id: "test-extension-id" },
          resolve
        ), true);
      });
    }
  };
}

function fakeCookie(name, value, overrides = {}) {
  return {
    name, value, domain: ".chatgpt.com", path: "/", hostOnly: false,
    secure: true, httpOnly: true, sameSite: "lax", storeId: "0", session: true,
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("switch clears only session/account state and preserves device cookies", async () => {
  const devices = [fakeCookie("cf_clearance", "fake-clearance"), fakeCookie("oai-did", "fake-device")];
  const fixture = await createBackgroundFixture({ cookies: [
    fakeCookie(`${SESSION_COOKIE}.0`, "old".repeat(50)),
    fakeCookie("_account", "account_old", { domain: "chatgpt.com", hostOnly: true, secure: false }),
    fakeCookie("__Secure-oai-is", "fake-old-state"),
    fakeCookie("oai-client-auth-info", "fake-old-info", { domain: "chatgpt.com", hostOnly: true, secure: false }),
    fakeCookie("_puid", "fake-old-puid", { partitionKey: { topLevelSite: "https://chatgpt.com" } }),
    ...devices
  ] });
  const { removed, written } = fixture;
  const response = await fixture.send({
    sessionToken: "t".repeat(120), accountId: "account_test",
    expires: new Date(Date.now() + 86_400_000).toISOString()
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
  assert.ok(removed.every((item) => item.url.startsWith("https://chatgpt.com/")));
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
  assert.equal(fixture.tabQueries, 0);
  assert.deepEqual(fixture.navigated, []);
  for (const cookie of devices) assert.deepEqual(fixture.jar.get(cookie.name), cookie);
});

test("expired and invalid saved sessions leave the current cookies untouched", async () => {
  const existingCookie = {
    name: SESSION_COOKIE, value: "current".repeat(20),
    domain: ".chatgpt.com", path: "/", secure: true, storeId: "0"
  };
  const fixture = await createBackgroundFixture({ cookies: [existingCookie] });

  for (const expires of ["2000-01-01T00:00:00Z", "not-a-date", " ", 123, false]) {
    const response = await fixture.send({ sessionToken: "a".repeat(120), expires }, true);
    assert.equal(response.ok, false);
    assert.match(response.error, /过期/);
    assert.deepEqual([...fixture.jar.values()], [existingCookie]);
  }
  assert.equal(fixture.reads, 0);
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(fixture.written, []);
  assert.deepEqual(fixture.navigated, []);
});

test("legacy records without an expiry still switch using session cookies", async () => {
  const fixture = await createBackgroundFixture();
  for (const expires of [undefined, null, ""]) {
    assert.deepEqual(await fixture.send({ sessionToken: "a".repeat(120), expires }), { ok: true });
    assert.equal(Object.hasOwn(fixture.jar.get(SESSION_COOKIE), "expirationDate"), false);
  }
});

test("concurrent switches keep complete cookie and navigation transactions together", { timeout: 2_000 }, async () => {
  const navigationStarted = deferred();
  const finishNavigation = deferred();
  let navigationCount = 0;
  const fixture = await createBackgroundFixture({
    async onNavigate() {
      navigationCount += 1;
      if (navigationCount === 1) {
        navigationStarted.resolve();
        await finishNavigation.promise;
      }
    }
  });
  const firstToken = "a".repeat(9000);
  const lastToken = "b".repeat(5000);
  const first = fixture.send({ sessionToken: firstToken, accountId: "account_first" }, true);
  const last = fixture.send({ sessionToken: lastToken, accountId: "account_last" }, true);

  await navigationStarted.promise;
  await setImmediate();
  const tokenCookies = () => [...fixture.jar.values()]
    .filter((cookie) => cookie.name.startsWith(`${SESSION_COOKIE}.`))
    .sort((a, b) => Number(a.name.split(".").at(-1)) - Number(b.name.split(".").at(-1)));
  try {
    assert.equal(tokenCookies().map((cookie) => cookie.value).join(""), firstToken);
    assert.equal(fixture.jar.get("_account").value, "account_first");
    assert.equal(fixture.reads, 2);
  } finally {
    finishNavigation.resolve();
  }

  assert.deepEqual(await Promise.all([first, last]), [{ ok: true }, { ok: true }]);
  assert.equal(tokenCookies().length, 2);
  assert.equal(tokenCookies().map((cookie) => cookie.value).join(""), lastToken);
  assert.equal(fixture.jar.get("_account").value, "account_last");
  assert.equal(fixture.navigated.filter((item) => item.url === "https://chatgpt.com/").length, 2);
});

test("a rejected switch does not prevent a queued switch from succeeding", async () => {
  let rejectNextWrite = true;
  const fixture = await createBackgroundFixture({
    rejectWrite() {
      if (rejectNextWrite) {
        rejectNextWrite = false;
        return true;
      }
      return false;
    }
  });
  const responses = await Promise.all([
    fixture.send({ sessionToken: "a".repeat(120) }, true),
    fixture.send({ sessionToken: "b".repeat(120) }, true)
  ]);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /会话 Cookie/);
  assert.deepEqual(responses[1], { ok: true });
  assert.equal(fixture.jar.get(SESSION_COOKIE).value, "b".repeat(120));
  assert.equal(fixture.navigated.length, 1);
});

test("a rejected account cookie write reports failure and does not navigate", async () => {
  const fixture = await createBackgroundFixture({ rejectWrite: (details) => details.name === "_account" });
  const response = await fixture.send({ sessionToken: "a".repeat(120), accountId: "account_fake" }, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /账号 Cookie/);
  assert.equal(fixture.jar.has("_account"), false);
  assert.deepEqual(fixture.navigated, []);
});

test("switch refreshes every ChatGPT tab and activates the already active tab", async () => {
  const fixture = await createBackgroundFixture({ tabs: [
    { id: 11, active: false }, { id: 22, active: true }, { id: 33, active: false }
  ] });
  assert.deepEqual(await fixture.send({ sessionToken: "a".repeat(120) }, true), { ok: true });
  assert.deepEqual(fixture.navigated, [
    { id: 11, url: "about:blank" },
    { id: 22, url: "about:blank" },
    { id: 33, url: "about:blank" },
    { id: 11, url: "https://chatgpt.com/" },
    { id: 22, url: "https://chatgpt.com/", active: true },
    { id: 33, url: "https://chatgpt.com/" }
  ]);
});

test("switch activates the first ChatGPT tab when none is active", async () => {
  const fixture = await createBackgroundFixture({ tabs: [
    { id: 11, active: false }, { id: 22, active: false }
  ] });
  assert.deepEqual(await fixture.send({ sessionToken: "a".repeat(120) }, true), { ok: true });
  assert.deepEqual(fixture.navigated, [
    { id: 11, url: "about:blank" },
    { id: 22, url: "about:blank" },
    { id: 11, url: "https://chatgpt.com/", active: true },
    { id: 22, url: "https://chatgpt.com/" }
  ]);
});

test("switch creates an active ChatGPT tab when none is open", async () => {
  const fixture = await createBackgroundFixture();
  assert.deepEqual(await fixture.send({ sessionToken: "a".repeat(120) }, true), { ok: true });
  assert.deepEqual(fixture.navigated, [{ url: "https://chatgpt.com/", active: true }]);
});

test("a failed tab update waits for the remaining tabs before the next switch", { timeout: 2_000 }, async () => {
  const navigationStarted = deferred();
  const finishNavigation = deferred();
  const fixture = await createBackgroundFixture({
    tabs: [{ id: 11, active: true }, { id: 22, active: false }],
    async onNavigate(details) {
      if (details.url !== "https://chatgpt.com/") return;
      if (details.id === 11) {
        throw new Error("tab closed");
      }
      navigationStarted.resolve();
      await finishNavigation.promise;
    }
  });
  const first = fixture.send({ sessionToken: "a".repeat(120) }, true);
  const last = fixture.send({ sessionToken: "b".repeat(120) }, false);
  await navigationStarted.promise;
  await setImmediate();
  try {
    assert.equal(fixture.jar.get(SESSION_COOKIE).value, "a".repeat(120));
    assert.equal(fixture.reads, 2);
  } finally {
    finishNavigation.resolve();
  }
  assert.equal((await first).ok, false);
  assert.deepEqual(await last, { ok: true });
  assert.equal(fixture.jar.get(SESSION_COOKIE).value, "b".repeat(120));
});

test("cookie reads and writes wait until the old document has completely stopped", async () => {
  let oldDocumentActive = true;
  let getCount = 0;
  let staleRefreshes = 0;
  const fixture = await createBackgroundFixture({
    tabs: [{ id: 11, active: true }],
    onTabGet(tab) {
      getCount += 1;
      if (getCount === 1) return { ...tab, status: "loading" };
      oldDocumentActive = false;
      return tab;
    },
    onRead() {
      assert.equal(oldDocumentActive, false, "cookie snapshot must wait for parking to finish");
    },
    onWrite(details, { jar }) {
      if (oldDocumentActive) {
        staleRefreshes += 1;
        jar.set(SESSION_COOKIE, fakeCookie(SESSION_COOKIE, "old".repeat(50)));
      }
    }
  });
  assert.deepEqual(await fixture.send({ sessionToken: "n".repeat(5000) }, true), { ok: true });
  assert.equal(getCount, 2);
  assert.equal(staleRefreshes, 0);
  assert.ok(fixture.events.lastIndexOf("tabs:get:11") < fixture.events.indexOf("cookies:getAll"));
  assert.equal(fixture.jar.has(SESSION_COOKIE), false);
  assert.equal(fixture.jar.get(`${SESSION_COOKIE}.0`).value + fixture.jar.get(`${SESSION_COOKIE}.1`).value, "n".repeat(5000));
});

test("rollback retains an old session refresh that finished while tabs were parking", async () => {
  const original = fakeCookie(SESSION_COOKIE, "old".repeat(50));
  const refreshed = fakeCookie(SESSION_COOKIE, "refreshed".repeat(50));
  const fixture = await createBackgroundFixture({
    cookies: [original], tabs: [{ id: 11, active: true }],
    onTabGet(tab, { jar }) {
      jar.set(SESSION_COOKIE, refreshed);
      return tab;
    },
    rejectWrite: (details) => details.value === "n".repeat(120)
  });
  const response = await fixture.send({ sessionToken: "n".repeat(120) }, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /已恢复原登录态/);
  assert.deepEqual(fixture.jar.get(SESSION_COOKIE), refreshed);
  assert.deepEqual(fixture.navigated, [
    { id: 11, url: "about:blank" }, { id: 11, url: "https://chatgpt.com/c/fake_11" }
  ]);
});

test("partial chunk failure restores cookie metadata before resuming the original page", async () => {
  const originalCookies = [
    fakeCookie(SESSION_COOKIE, "old".repeat(50), {
      session: false, expirationDate: Math.floor(Date.now() / 1000) + 86_400
    }),
    fakeCookie("_account", "old-account", {
      domain: "chatgpt.com", hostOnly: true, secure: false, httpOnly: false, sameSite: "strict"
    }),
    fakeCookie("_puid", "old-puid", {
      partitionKey: { topLevelSite: "https://chatgpt.com", hasCrossSiteAncestor: false }
    }),
    fakeCookie("cf_clearance", "fake-clearance"),
    fakeCookie("oai-did", "fake-device")
  ];
  let resumedAfterRestore = false;
  const fixture = await createBackgroundFixture({
    cookies: originalCookies, tabs: [{ id: 11, active: true }],
    rejectWrite: (details) => details.name === `${SESSION_COOKIE}.1` && details.value.startsWith("n"),
    onNavigate(details) {
      if (details.url === "https://chatgpt.com/c/fake_11") {
        for (const original of originalCookies) assert.deepEqual(fixture.jar.get(original.name), original);
        assert.equal(fixture.jar.size, originalCookies.length);
        resumedAfterRestore = true;
      }
    }
  });
  const response = await fixture.send({ sessionToken: "n".repeat(5000), accountId: "new-account" }, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /已恢复原登录态/);
  assert.equal(resumedAfterRestore, true);
  for (const original of originalCookies) assert.deepEqual(fixture.jar.get(original.name), original);
  assert.equal(fixture.jar.size, originalCookies.length);
  assert.ok(fixture.written.some((details) => details.name === `${SESSION_COOKIE}.0`));
  assert.ok(fixture.written.some((details) => details.name === `${SESSION_COOKIE}.1`));
  const restoredAccount = fixture.written.find((details) => details.name === "_account");
  assert.equal(restoredAccount.secure, false);
  assert.equal(Object.hasOwn(restoredAccount, "domain"), false);
  assert.equal(restoredAccount.url, "https://chatgpt.com/");
  assert.deepEqual(fixture.written.find((details) => details.name === "_puid").partitionKey, originalCookies[2].partitionKey);
  assert.ok(fixture.removed.every((details) => details.url.startsWith("https://chatgpt.com/")));
  assert.ok(fixture.written.every((details) => details.url.startsWith("https://chatgpt.com/")));
  assert.equal(fixture.removed.some((details) => ["cf_clearance", "oai-did"].includes(details.name)), false);
});

test("a cookie readback mismatch restores the old session and reports failure", async () => {
  const original = fakeCookie(SESSION_COOKIE, "old".repeat(50));
  const fixture = await createBackgroundFixture({
    cookies: [original], tabs: [{ id: 11, active: true }],
    onRead({ jar, reads }) {
      if (reads === 2) jar.set(SESSION_COOKIE, fakeCookie(SESSION_COOKIE, "unexpected".repeat(20)));
    }
  });
  const response = await fixture.send({ sessionToken: "n".repeat(120) }, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /写入校验失败.*已恢复原登录态/);
  assert.deepEqual([...fixture.jar.values()], [original]);
  assert.equal(fixture.navigated.at(-1).url, "https://chatgpt.com/c/fake_11");
});

test("an incomplete rollback is reported instead of claiming the old session was restored", async () => {
  const original = fakeCookie(SESSION_COOKIE, "old".repeat(50));
  const fixture = await createBackgroundFixture({
    cookies: [original],
    rejectWrite: (details) => details.value === "n".repeat(120),
    onRead({ jar, reads }) {
      if (reads === 3) jar.set(`${SESSION_COOKIE}.9`, fakeCookie(`${SESSION_COOKIE}.9`, "unexpected"));
    }
  });
  const response = await fixture.send({ sessionToken: "n".repeat(120) });
  assert.equal(response.ok, false);
  assert.match(response.error, /无法完整恢复原登录态/);
  assert.doesNotMatch(response.error, /已恢复原登录态/);
});

test("a parking failure leaves cookies untouched and restores the original tab URLs", async () => {
  const original = fakeCookie(SESSION_COOKIE, "old".repeat(50));
  const fixture = await createBackgroundFixture({
    cookies: [original], tabs: [{ id: 11, active: true }, { id: 22, active: false }],
    onTabGet(tab) {
      if (tab.id === 11) throw new Error("unable to stop old page");
      return tab;
    }
  });
  const response = await fixture.send({ sessionToken: "n".repeat(120) }, true);
  assert.equal(response.ok, false);
  assert.deepEqual([...fixture.jar.values()], [original]);
  assert.equal(fixture.reads, 0);
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(fixture.written, []);
  assert.deepEqual(fixture.navigated, [
    { id: 11, url: "about:blank" }, { id: 22, url: "about:blank" },
    { id: 11, url: "https://chatgpt.com/c/fake_11" }, { id: 22, url: "https://chatgpt.com/c/fake_22" }
  ]);
});
