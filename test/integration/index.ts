import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { CDPClient } from "../../src/cdp";
import { fixture } from "../fixture";
import { readClipboardPNG } from "../native-clipboard";
import { ScreenshotResult } from "../../src/screenshot-delivery";

async function until<T>(check: () => Promise<T> | T, message: string, timeout = 12000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch { /* Navigation can destroy a context. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${message}`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("pointee-vscode.pointee-vscode");
  if (!extension) throw new Error("Pointee extension was not loaded.");
  const api = await extension.activate();
  if (!api.isBrowserAvailable()) throw new Error("Proposed browser API was not enabled.");
  console.log("Pointee activation and proposed browser API: OK");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'nonce-fixture'; script-src 'nonce-fixture'; font-src data:; img-src data:");
    response.end(fixture);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const tabs: vscode.BrowserTab[] = [];
  const clients: CDPClient[] = [];
  const results = join(extension.extensionPath, "test-results", "integration");
  const originalTheme = vscode.workspace.getConfiguration("pointee").inspect<string>("theme")?.globalValue;
  const screenshotDirectory = process.env.POINTEE_TEST_SCREENSHOT_DIRECTORY;
  assert(screenshotDirectory, "test runner provides the isolated screenshot directory");
  const savedScreenshots = async () => {
    try { return (await readdir(screenshotDirectory)).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  await mkdir(results, { recursive: true });
  await Promise.all(["failure.txt", "failure.png"].map(file => rm(join(results, file), { force: true })));

  try {
    const tab = await vscode.commands.executeCommand<vscode.BrowserTab>("pointee.openBrowser", url);
    assert(tab);
    tabs.push(tab);
    const cdp = new CDPClient(await tab.startCDPSession());
    clients.push(cdp);
    await cdp.attach();
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await until(() => cdp.evaluate("document.getElementById('target') !== null"), "fixture loaded");
    await until(() => cdp.evaluate("innerWidth === 1000 && innerHeight === 800"), "stable desktop viewport");
    await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 150)))");
    const baselineBytes = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    await writeFile(join(results, "baseline.png"), baselineBytes);
    const baseline = PNG.sync.read(baselineBytes);
    const targetPoint = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r=document.getElementById("target").getBoundingClientRect();
      return {
        x:Math.round((r.right-12)*${baseline.width}/innerWidth),
        y:Math.round((r.bottom-12)*${baseline.height}/innerHeight)
      };
    })()`);
    const baselinePixel = (targetPoint.y * baseline.width + targetPoint.x) * 4;
    const expectedGreen = [...baseline.data.subarray(baselinePixel, baselinePixel + 3)];
    assert(expectedGreen[1] > expectedGreen[0] + 30 && expectedGreen[1] > expectedGreen[2] + 15,
      "baseline contains the rendered green element");
    assert.equal(await vscode.commands.executeCommand("pointee.togglePicker"), true);
    await until(() => cdp.evaluate("document.documentElement.classList.contains('pnt-point-active')"), "picker activated");

    const click = async (selector: string) => {
      await cdp.send("Page.bringToFront");
      await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"nearest",behavior:"instant"})`);
      await new Promise(resolve => setTimeout(resolve, 180));
      const box = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Missing element");
        const r = el.getBoundingClientRect();
        return { x:r.x+r.width/2, y:r.y+r.height/2 };
      })()`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
      await new Promise(resolve => setTimeout(resolve, 100));
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
    };
    await click("#target");
    await until(() => api.getLatestContext()?.selector === "article#target", "selection reached extension");
    let selected = await api.getSelectedElement();
    assert.match(selected.pointer, /src\/components\/PlanCard.tsx:42:6/);
    assert.match(selected.pointer, /Pro Plan/);
    assert.equal(await cdp.evaluate("(window.pageClicks || 0)"), 0, "picker must intercept page clicks");
    assert.equal(await cdp.evaluate("window.chrome === window.pageChrome"), true, "must not overwrite page globals");
    await click('[data-action="copy"]');
    await until(async () => (await vscode.env.clipboard.readText()).includes("PlanCard.tsx:42:6"), "toolbar clipboard");
    console.log("PASS: real input selection, CSP, isolated globals, source pointer, toolbar -> VS Code clipboard");

    await vscode.workspace.getConfiguration("pointee").update("theme", "dark", vscode.ConfigurationTarget.Global);
    await until(() => cdp.evaluate("document.documentElement.dataset.pntTheme === 'dark'"), "live settings update");
    await vscode.workspace.getConfiguration("pointee").update("theme", originalTheme, vscode.ConfigurationTarget.Global);
    console.log("PASS: native VS Code settings synchronize to the browser");

    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Alt", code: "AltLeft", modifiers: 1 });
    const neighbor = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.getElementById("neighbor").getBoundingClientRect();
      return {x:r.x+20,y:r.y+20};
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...neighbor, modifiers: 1 });
    await until(() => cdp.evaluate("document.documentElement.classList.contains('pnt-redlining')"), "Alt measure mode");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", modifiers: 0 });
    await until(() => cdp.evaluate("!document.documentElement.classList.contains('pnt-redlining')"), "measure mode exits");
    console.log("PASS: Alt measurement mode and cleanup");

    await vscode.commands.executeCommand("pointee.editSelection");
    await until(() => cdp.evaluate("Boolean(document.getElementById('pnt-edit-panel'))"), "edit panel");
    const row = await cdp.evaluate<string>(`(() => {
      const row = [...document.querySelectorAll('#pnt-edit-panel [data-prop]')].find(x => x.dataset.prop === 'font-size' && x.querySelector('input'));
      return row ? row.outerHTML : '';
    })()`);
    assert(row, "font-size editor exists");
    // The test types through the real CDP keyboard into the actual edit input.
    const inputSelector = '#pnt-edit-panel [data-prop="font-size"] input';
    await click(inputSelector);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).select()`);
    await cdp.send("Input.insertText", { text: "22" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until(() => cdp.evaluate("getComputedStyle(document.getElementById('target')).fontSize === '22px'"), "live edit");
    await vscode.commands.executeCommand("pointee.copySelection");
    assert.match(await vscode.env.clipboard.readText(), /font-size:.*16px.*22px/);
    console.log("PASS: live style editing and before/after agent payload");

    const filesBeforeCopy = await savedScreenshots();
    const copiedImage = await vscode.commands.executeCommand<ScreenshotResult>("pointee.screenshot");
    assert.deepEqual(copiedImage, { destination: "clipboard" });
    const clipboardPNG = await readClipboardPNG();
    const png = PNG.sync.read(clipboardPNG);
    const screenshotScale = png.width / 280;
    assert(Math.abs(png.height - 160 * screenshotScale) <= 1, "screenshot preserves element dimensions");
    const pixel = ((png.height - 20) * png.width + png.width - 20) * 4;
    assert.deepEqual([...png.data.subarray(pixel, pixel + 3)], expectedGreen, "real element pixels, no overlay");
    assert.equal(await vscode.env.clipboard.readText(), "", "image clipboard must not contain the old text path");
    assert.equal(api.getLatestContext().screenshotPath, undefined);
    assert.deepEqual(await savedScreenshots(), filesBeforeCopy, "copying an image must not save a screenshot file");
    await writeFile(join(results, "element.png"), clipboardPNG);
    const screen = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(results, "desktop.png"), Buffer.from(screen.data, "base64"));
    console.log("PASS: actual screenshot -> native PNG clipboard, exact pixels, no path text, no screenshot file");

    await cdp.evaluate(`(() => {
      window.pastedScreenshot = null;
      const target = document.createElement("div");
      target.id = "pointee-test-paste";
      target.contentEditable = "true";
      Object.assign(target.style, {position:"fixed",left:"0",top:"0",width:"1px",height:"1px",opacity:"0"});
      target.addEventListener("paste", async event => {
        event.preventDefault();
        const file = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
        if (!file) { window.pastedScreenshot = {type:"missing",types:[...event.clipboardData.types]}; return; }
        const image = await createImageBitmap(file);
        window.pastedScreenshot = {type:file.type,width:image.width,height:image.height};
        image.close();
      });
      document.body.append(target);
      target.focus({preventScroll:true});
    })()`);
    const pasteModifiers = process.platform === "darwin" ? 4 : 2;
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
      modifiers: pasteModifiers, commands: ["paste"],
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: pasteModifiers,
    });
    const pasted = await until(() => cdp.evaluate<{ type: string; width: number; height: number } | null>("window.pastedScreenshot"), "native image paste event");
    assert(pasted);
    assert.equal(pasted.type, "image/png");
    assert.equal(pasted.width, png.width);
    assert.equal(pasted.height, png.height);
    await cdp.evaluate("document.getElementById('pointee-test-paste').remove()");
    console.log("PASS: native clipboard image pastes into the integrated browser as an image/png file");

    const savedImage = await vscode.commands.executeCommand<ScreenshotResult>("pointee.saveScreenshot");
    assert(savedImage?.destination === "file" && !savedImage.fallback);
    assert(savedImage.path.startsWith(screenshotDirectory));
    const savedPNG = PNG.sync.read(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(savedImage.path))));
    assert.equal(savedPNG.width, png.width);
    assert.equal(savedPNG.height, png.height);
    assert.equal(await vscode.env.clipboard.readText(), savedImage.path);
    assert.equal(api.getLatestContext().screenshotPath, savedImage.path);
    console.log("PASS: explicit save retains the original PNG file/path/context workflow");

    await vscode.commands.executeCommand("pointee.stopPicker");
    assert.equal(await cdp.evaluate("getComputedStyle(document.getElementById('target')).fontSize"), "16px", "stopping restores styles");
    assert.equal(await cdp.evaluate("Boolean(document.getElementById('pnt-edit-panel'))"), false);
    assert.equal(await vscode.commands.executeCommand("pointee.togglePicker"), true);
    await click("#target");
    const filesBeforeToolbar = await savedScreenshots();
    await vscode.env.clipboard.writeText("before screenshot toolbar");
    await click('[data-action="shot"]');
    await until(async () => {
      try { return (await readClipboardPNG()).length > 8; } catch { return false; }
    }, "toolbar wrote an image to the native clipboard");
    await until(() => cdp.evaluate("document.getElementById('pnt-toast')?.textContent.includes('Image copied to clipboard')"), "image copy toast");
    assert.deepEqual(await savedScreenshots(), filesBeforeToolbar);
    assert.equal(api.getLatestContext().screenshotPath, undefined);
    console.log("PASS: actual screenshot toolbar copies PNG, displays the correct success state, creates no file");
    await click('[id="price:pro/2026"]');
    await until(() => api.getLatestContext()?.title?.includes("article"), "special ID selection");
    selected = await api.getSelectedElement();
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selected.selector)})?.id`), "price:pro/2026");
    console.log("PASS: restoration and escaped unique selector");

    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); reject(new Error("Reload did not finish.")); }, 10000);
      const listener = cdp.onEvent(event => {
        if (event.method === "Page.loadEventFired" && event.sessionId === cdp.pageSessionId) {
          clearTimeout(timer); listener.dispose(); resolve();
        }
      });
    });
    await cdp.send("Page.reload");
    await loaded;
    await until(() => cdp.evaluate("document.documentElement.classList.contains('pnt-point-active')"), "reactivation after reload");
    await click("#target");
    await vscode.commands.executeCommand("pointee.selectParent");
    await until(async () => (await api.getSelectedElement()).selector === "main#cards", "parent selection");
    console.log("PASS: reload recovery and parent selection");

    await click("#below");
    await until(async () => (await api.getSelectedElement()).selector === "article#below", "below-viewport selection");
    await cdp.evaluate("scrollTo(0,0)");
    assert.deepEqual(await vscode.commands.executeCommand("pointee.screenshot"), { destination: "clipboard" });
    const offscreen = PNG.sync.read(await readClipboardPNG());
    assert(Math.abs(offscreen.height - offscreen.width / 2) <= 1);
    const offscreenPixel = ((offscreen.height - 20) * offscreen.width + offscreen.width - 20) * 4;
    const red = [...offscreen.data.subarray(offscreenPixel, offscreenPixel + 3)];
    assert(red[0] > 150 && red[0] > red[1] * 2 && red[0] > red[2] * 2, "offscreen screenshot contains the red element");
    assert.equal(await cdp.evaluate("scrollY"), 0, "screenshot restores the original scroll position");
    console.log("PASS: below-viewport element screenshot and scroll coordinates");

    await vscode.commands.executeCommand("pointee.stopPicker");
    await cdp.evaluate("scrollTo(0,0)");
    await vscode.commands.executeCommand("pointee.togglePicker");
    // Click the top of the tall wrapper, then select its parent from the child.
    const tallPoint = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const el=document.getElementById("tall");el.scrollIntoView({block:"start"});
      const r=el.getBoundingClientRect();return {x:r.x+30,y:r.y+30};
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...tallPoint });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...tallPoint });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...tallPoint });
    await vscode.commands.executeCommand("pointee.selectParent");
    await until(async () => (await api.getSelectedElement()).selector === "section#tall", "tall element selection");
    const tallScroll = await cdp.evaluate<number>("scrollY");
    assert.deepEqual(await vscode.commands.executeCommand("pointee.screenshot"), { destination: "clipboard" });
    const tallBytes = await readClipboardPNG();
    const tall = PNG.sync.read(tallBytes);
    const tallScale = tall.height / 1000;
    assert(Math.abs(tall.width - 200 * tallScale) <= 1, "stitched screenshot preserves dimensions at native pixel scale");
    const firstPixel = (Math.round(250 * tallScale) * tall.width + 20) * 4;
    const secondPixel = (Math.round(750 * tallScale) * tall.width + 20) * 4;
    const firstBand = [...tall.data.subarray(firstPixel, firstPixel + 3)];
    const secondBand = [...tall.data.subarray(secondPixel, secondPixel + 3)];
    assert(firstBand[0] > firstBand[1] * 2, "first stitched band is red");
    assert(secondBand[2] > secondBand[0] * 2, "second stitched band is blue");
    assert.equal(await cdp.evaluate("scrollY"), tallScroll);
    await writeFile(join(results, "tall-element.png"), tallBytes);
    const tallSaved = await vscode.commands.executeCommand<ScreenshotResult>("pointee.saveScreenshot");
    assert(tallSaved?.destination === "file" && !tallSaved.fallback);
    console.log("PASS: multi-viewport screenshot stitching, color bands, scroll restoration");

    const second = await vscode.commands.executeCommand<vscode.BrowserTab>("pointee.openBrowser", `${url}/second`);
    assert(second);
    tabs.push(second);
    const secondCDP = new CDPClient(await second.startCDPSession());
    clients.push(secondCDP);
    await secondCDP.attach();
    await secondCDP.send("Emulation.setDeviceMetricsOverride", {
      width: 1000, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await until(() => secondCDP.evaluate("Boolean(document.getElementById('target'))"), "second page");
    assert.equal(await vscode.commands.executeCommand("pointee.togglePicker"), true);
    assert.equal(await cdp.evaluate("document.documentElement.classList.contains('pnt-point-active')"), true);
    assert.equal(await secondCDP.evaluate("document.documentElement.classList.contains('pnt-point-active')"), true);
    await vscode.commands.executeCommand("pointee.stopPicker");
    assert.equal(await secondCDP.evaluate("document.documentElement.classList.contains('pnt-point-active')"), false);
    assert.equal(await cdp.evaluate("document.documentElement.classList.contains('pnt-point-active')"), false);
    console.log("PASS: independent multiple tabs and stop-all cleanup");

    const latest = api.getLatestContext();
    await vscode.commands.executeCommand("pointee.copyRecord", latest);
    assert.match(await vscode.env.clipboard.readText(), /# Element Context/);
    await vscode.commands.executeCommand("pointee.openContext", latest);
    assert.equal(vscode.window.activeTextEditor?.document.languageId, "markdown");
    assert.match(vscode.window.activeTextEditor!.document.getText(), /# Element Context/);
    const exported = vscode.Uri.file(join(results, "exported-context.md"));
    await vscode.commands.executeCommand("pointee.exportContext", latest, exported);
    const exportedText = Buffer.from(await vscode.workspace.fs.readFile(exported)).toString("utf8");
    assert.match(exportedText, /# Element Context/);
    assert(exportedText.includes(latest.screenshotPath));
    await vscode.commands.executeCommand("pointee.clearHistory");
    assert.equal(api.getContexts().length, 0);
    console.log("PASS: context history, copy, Markdown document, export to file, clear");
  } catch (error) {
    await writeFile(join(results, "failure.txt"), String(error));
    if (clients[0]) {
      const debug = await clients[0].evaluate(`({
        width:innerWidth,height:innerHeight,
        label:document.getElementById("pnt-label")?.textContent,
        toolbar:Boolean(document.getElementById("pnt-toolbar")),
        active:document.documentElement.className
      })`).catch(String);
      console.log("Failure DOM:", JSON.stringify(debug));
      const screen = await clients[0].send("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
      if (screen) await writeFile(join(results, "failure.png"), Buffer.from(screen.data, "base64"));
    }
    throw error;
  } finally {
    await vscode.workspace.getConfiguration("pointee").update("theme", originalTheme, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("pointee.stopPicker");
    await Promise.all(clients.map(client => client.dispose().catch(() => {})));
    await Promise.all(tabs.map(tab => tab.close().then(undefined, () => {})));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
