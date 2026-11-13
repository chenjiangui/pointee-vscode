import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { sourceModule } from "./helpers.mjs";
const { fixture } = await sourceModule("test/fixture.ts");
const { toPagePreferences } = await sourceModule("src/preferences.ts");
const bridge = await readFile("dist/page-bridge.js", "utf8");
const css = await readFile("dist/inspector.css", "utf8");
const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
await mkdir("test-results/ui", { recursive: true });
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let copied = "";
    let selected;
    await page.setContent(fixture);
    await page.addStyleTag({ content: css });
    await page.exposeFunction("__testPointee", async raw => {
      const request = JSON.parse(raw);
      if (request.type === "SELECTION") selected = request.snapshot;
      if (request.type === "COPY_TEXT") copied = request.text;
      await page.evaluate(({ id }) => globalThis.__pointeeVSCode.reply(id, null, null), request);
    });
    await page.evaluate(`(${bridge})(${JSON.stringify({
      binding: "__testPointee",
      preferences: toPagePreferences((_key, fallback) => fallback),
    })})`);
    await page.evaluate(() => globalThis.__pointeeVSCode.toggle(true));
    await page.locator("#target").click({ position: { x: 30, y: 30 } });
    await page.waitForSelector("#pnt-toolbar");
    await page.waitForTimeout(500);
    assert(selected?.pointer.includes("PlanCard.tsx:42:6"), `${name}: selection transport`);
    await page.locator('[data-action="copy"]').click();
    await page.waitForTimeout(100);
    assert(copied.includes("Pro Plan"), `${name}: copy action`);
    const bounds = await page.evaluate(() => {
      return ["pnt-toolbar", "pnt-label"].map(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { id, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
    });
    for (const box of bounds) {
      assert(box.x >= -1 && box.right <= viewport.width + 1, `${name}: ${box.id} is horizontally visible`);
      assert(box.y >= -1 && box.bottom <= viewport.height + 1, `${name}: ${box.id} is vertically visible`);
    }
    await page.screenshot({ path: `test-results/ui/${name}-selection.png` });
    await page.locator('[data-action="edit"]').click();
    await page.waitForSelector("#pnt-edit-panel");
    await page.waitForTimeout(500);
    const panel = await page.locator("#pnt-edit-panel").boundingBox();
    assert(panel.x >= -1 && panel.x + panel.width <= viewport.width + 1, `${name}: edit panel fits`);
    await page.screenshot({ path: `test-results/ui/${name}-editing.png` });
    await page.evaluate(() => globalThis.__pointeeVSCode.toggle(false));
    assert.equal(await page.locator("#pnt-toolbar").count(), 0);
    await page.evaluate(() => {
      document.querySelector("main").insertAdjacentHTML("beforeend", `
        <h3>Mixed siblings</h3>
        <article data-test="duplicate">First duplicate</article>
        <article data-test="duplicate">Second duplicate</article>
        <article data-testid="">Empty test ID</article>
        <article id="duplicate-id">First ID</article>
        <article id="duplicate-id">Second ID</article>
      `);
    });
    for (const [selector, index] of [['[data-test="duplicate"]', 1], ['[data-testid=""]', 0], ['[id="duplicate-id"]', 1]]) {
      await page.evaluate(() => globalThis.__pointeeVSCode.toggle(true));
      const target = page.locator(selector).nth(index);
      await target.click({ position: { x: 20, y: 30 } });
      const pointer = await page.evaluate(() => globalThis.__pointeeVSCode.snapshot());
      assert(pointer);
      assert.equal(await page.locator(pointer.selector).count(), 1, `${name}: selector is unique`);
      assert.equal(await page.locator(pointer.selector).textContent(), await target.textContent(), `${name}: selector resolves the selected node`);
      await page.evaluate(() => globalThis.__pointeeVSCode.toggle(false));
    }
    assert.deepEqual(errors, [], `${name}: no runtime errors`);
    await page.close();
    console.log(`PASS: ${name} selection, clipboard, inspector bounds, edit panel, teardown, screenshot, duplicate/empty IDs`);
  }
} finally { await browser.close(); }
