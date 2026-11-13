import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceModule } from "./helpers.mjs";
const { validateSnapshot, formatContext } = await sourceModule("src/model.ts");
const { toPagePreferences, DEFAULT_COPY_FIELDS } = await sourceModule("src/preferences.ts");
const snapshot = {
  title: "button", url: "http://localhost:3000", selector: "#save",
  pointer: "```\n# selector: #save\n<button>Save</button>\n```",
  rect: { x: 0, y: 0, width: 100, height: 40 },
};
test("snapshot validation rejects malformed and excessive page payloads", () => {
  assert(validateSnapshot(snapshot));
  assert(!validateSnapshot(null));
  assert(!validateSnapshot({ ...snapshot, pointer: "x".repeat(2_000_001) }));
  assert(!validateSnapshot({ ...snapshot, rect: { ...snapshot.rect, width: Infinity } }));
  assert(!validateSnapshot({ ...snapshot, rect: { ...snapshot.rect, width: -1 } }));
});
test("Markdown context carries source pointer and literal screenshot path", () => {
  const context = formatContext({
    ...snapshot, id: "1", capturedAt: "2026-11-13T00:00:00Z",
    screenshotPath: "/tmp/with spaces/element.png",
  });
  assert(context.includes(snapshot.pointer));
  assert(context.includes('File: "/tmp/with spaces/element.png"'));
});
test("VS Code preferences map to upstream rosters without discarding false", () => {
  const defaultPrefs = toPagePreferences((_key, fallback) => fallback);
  assert.equal(defaultPrefs.copySource, "on");
  assert.equal(defaultPrefs.copyStyles, "off");
  assert.equal(defaultPrefs.redlineGuides, "on");
  const custom = toPagePreferences((key, fallback) => ({
    copyFields: ["selector"], copyHtmlFallback: false, redlineGuides: false,
  }[key] ?? fallback));
  assert.equal(custom.copySource, "off");
  assert.equal(custom.copySelector, "on");
  assert.equal(custom.copyHtmlFallback, "off");
  assert.equal(custom.redlineGuides, "off");
  assert(DEFAULT_COPY_FIELDS.includes("source"));
});
