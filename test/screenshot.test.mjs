import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { sourceModule } from "./helpers.mjs";
const { captureRegion, preserveColorProfile } = await sourceModule("src/screenshot.ts");

function fakeBrowser(failAt = Infinity) {
  const state = { x: 0, y: 42, width: 200, height: 300, surfaceWidth: 200, dpr: 2 };
  const requests = [];
  return {
    state, requests,
    async evaluate(expression) {
      if (expression.startsWith("({")) return { ...state };
      if (expression.startsWith("scrollTo")) {
        new Function("scrollTo", expression)(position => {
          state.x = position.left; state.y = Math.min(800, position.top);
        });
      }
    },
    async send(method, params) {
      assert.equal(method, "Page.captureScreenshot");
      requests.push(params);
      if (requests.length === failAt) throw new Error("capture failed");
      assert.equal(params.clip, undefined, "must not trigger Electron's clip reflow");
      const { x, y, width, height } = state;
      const png = new PNG({ width: width * 2, height: height * 2 });
      for (let py = 0; py < png.height; py++) {
        for (let px = 0; px < png.width; px++) {
          const index = (py * png.width + px) * 4;
          png.data[index] = y + py / 2 < 500 ? 220 : 10;
          png.data[index + 1] = 50;
          png.data[index + 2] = y + py / 2 < 500 ? 10 : 220;
          png.data[index + 3] = 255;
        }
      }
      return { data: PNG.sync.write(png).toString("base64") };
    },
  };
}
test("screenshot stitches horizontal and vertical tiles and restores scrolling", async () => {
  const cdp = fakeBrowser();
  const buffer = await captureRegion(cdp, { x: 0, y: 0, width: 300, height: 1000 });
  const png = PNG.sync.read(buffer);
  assert.equal(png.width, 600);
  assert.equal(png.height, 2000);
  for (const [x, y, expected] of [[20, 200, [220, 50, 10]], [580, 1500, [10, 50, 220]]]) {
    const index = (y * png.width + x) * 4;
    assert.deepEqual([...png.data.subarray(index, index + 3)], expected);
  }
  assert.equal(cdp.requests.length, 8);
  assert(cdp.requests.every(request => request.captureBeyondViewport === false));
  assert.deepEqual({ x: cdp.state.x, y: cdp.state.y }, { x: 0, y: 42 });
});
test("screenshot restores scroll after capture fails and bounds memory", async () => {
  const cdp = fakeBrowser(2);
  await assert.rejects(captureRegion(cdp, { x: 0, y: 0, width: 200, height: 900 }), /capture failed/);
  assert.equal(cdp.state.y, 42);
  await assert.rejects(captureRegion(cdp, { x: 0, y: 0, width: 8000, height: 8000 }), /megapixel/);
  await assert.rejects(captureRegion(cdp, { x: 0, y: 0, width: 0, height: 10 }), /no capturable area/);
});
test("ICC profile chunks are preserved without interpreting or modifying their bytes", () => {
  const header = Buffer.alloc(33);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  const profile = Buffer.alloc(16);
  profile.writeUInt32BE(4, 0);
  profile.write("iCCP", 4);
  profile.write("test", 8);
  const source = Buffer.concat([header, profile]);
  const encoded = Buffer.alloc(50, 7);
  const restored = preserveColorProfile(encoded, source);
  assert(restored.subarray(33, 49).equals(profile));
  assert(restored.subarray(49).equals(encoded.subarray(33)));
  assert(preserveColorProfile(encoded, Buffer.alloc(8)).equals(encoded));
});
