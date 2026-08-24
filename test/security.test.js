import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest has a narrow permission surface", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual([...manifest.permissions].sort(), ["cookies", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("extension pages contain no inline script and source avoids risky sinks", async () => {
  const html = await readFile(path.join(root, "popup.html"), "utf8");
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false);

  for (const filename of ["popup.js", "background.js", "src/core.js", "src/vault.js"]) {
    const source = await readFile(path.join(root, filename), "utf8");
    assert.equal(source.includes("innerHTML"), false, filename);
    assert.equal(source.includes("eval("), false, filename);
    assert.equal(source.includes("new Function"), false, filename);
    assert.equal(source.includes("console.log"), false, filename);
    assert.equal(source.includes("fetch("), false, filename);
  }
});
