import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { sourceModule } from "./helpers.mjs";
const { writeImageClipboard, runClipboardCommand } = await sourceModule("src/image-clipboard.ts");
const { deliverScreenshot } = await sourceModule("src/screenshot-delivery.ts");
const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));

test("macOS copies PNG/TIFF from stdin without writing a temporary file", async () => {
  const calls = [];
  await writeImageClipboard(png, {
    platform: "darwin",
    run: async (...args) => { calls.push(args); },
  });
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert(calls[0][2].equals(png));
  const script = calls[0][1].at(-1);
  assert.match(script, /fileHandleWithStandardInput/);
  assert.match(script, /NSPasteboardTypePNG/);
  assert.match(script, /NSPasteboardTypeTIFF/);
  assert(!script.includes("initWithContentsOfFile"));
});

test("Windows uses STA and sends image data on stdin, not in command arguments", async () => {
  const calls = [];
  await writeImageClipboard(png, {
    platform: "win32",
    run: async (...args) => { calls.push(args); },
  });
  assert.equal(calls[0][0], "powershell.exe");
  assert(calls[0][1].includes("-STA"));
  const script = Buffer.from(calls[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /SetDataObject/);
  assert.match(script, /'PNG'/);
  assert.equal(calls[0][2].toString("ascii"), png.toString("base64"));
});

test("Linux prefers Wayland when available and falls back to X11", async () => {
  const calls = [];
  await writeImageClipboard(png, {
    platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" },
    run: async (...args) => {
      calls.push(args);
      if (args[0] === "wl-copy") throw new Error("not installed");
    },
  });
  assert.deepEqual(calls.map(call => call[0]), ["wl-copy", "xclip"]);
  assert(calls[1][1].includes("image/png"));
  assert(calls[1][2].equals(png));
  await assert.rejects(writeImageClipboard(png, {
    platform: "linux", env: {}, run: async () => { throw new Error("no display"); },
  }), /Install wl-clipboard.*xclip/);
});

test("invalid images never start a helper", async () => {
  let called = false;
  await assert.rejects(writeImageClipboard(Buffer.from("not an image"), {
    run: async () => { called = true; },
  }), /Only PNG/);
  assert.equal(called, false);
});

test("helper streams binary input and rejects failures, missing executables, and timeouts", async () => {
  await runClipboardCommand(process.execPath, [
    "-e", `const chunks=[];process.stdin.on("data",x=>chunks.push(x));process.stdin.on("end",()=>{if(!Buffer.concat(chunks).equals(Buffer.from("${png.toString("base64")}","base64")))process.exit(2)});`,
  ], png);
  await assert.rejects(runClipboardCommand(process.execPath, [
    "-e", 'process.stderr.write("clipboard failure");process.exit(4)',
  ], png), /clipboard failure/);
  await assert.rejects(runClipboardCommand("/__pointee_missing_clipboard_helper__", [], png), /ENOENT/);
  await assert.rejects(runClipboardCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], png, 100), /timed out/);
});

function delivery(copyImage = async () => {}) {
  const calls = [];
  return {
    calls,
    copyImage: async data => { calls.push(["image", data]); await copyImage(); },
    saveFile: async data => { calls.push(["file", data]); return "/tmp/element.png"; },
    copyPath: async path => { calls.push(["path", path]); },
  };
}

test("successful image copying creates no file and never replaces the image with a text path", async () => {
  const target = delivery();
  assert.deepEqual(await deliverScreenshot(png, target), { destination: "clipboard" });
  assert.deepEqual(target.calls.map(call => call[0]), ["image"]);
});

test("image clipboard failure saves a fallback file and reports the actual outcome", async () => {
  const target = delivery(async () => { throw new Error("clipboard denied"); });
  assert.deepEqual(await deliverScreenshot(png, target), {
    destination: "file", path: "/tmp/element.png", fallback: true,
  });
  assert.deepEqual(target.calls.map(call => call[0]), ["image", "file", "path"]);
});

test("explicit file saving bypasses the image clipboard and propagates save failures", async () => {
  const target = delivery();
  assert.deepEqual(await deliverScreenshot(png, target, "file"), {
    destination: "file", path: "/tmp/element.png", fallback: false,
  });
  assert.deepEqual(target.calls.map(call => call[0]), ["file", "path"]);
  await assert.rejects(deliverScreenshot(png, {
    ...delivery(async () => { throw new Error("clipboard failed"); }),
    saveFile: async () => { throw new Error("disk full"); },
  }), /disk full/);
});
