import { PNG } from "pngjs";
import { CDPClient } from "./cdp";
import { ElementSnapshot } from "./model";

type Viewport = { x: number; y: number; width: number; height: number; surfaceWidth: number; dpr: number };

async function settle(cdp: CDPClient): Promise<void> {
  await cdp.evaluate(`new Promise(resolve => {
    const timer = setTimeout(resolve, 120);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  })`);
}

async function viewport(cdp: CDPClient, contextId?: number): Promise<Viewport> {
  return cdp.evaluate(`({
    x: scrollX, y: scrollY, width: document.documentElement.clientWidth,
    height: innerHeight, surfaceWidth: innerWidth, dpr: devicePixelRatio
  })`, contextId);
}

// Keep the browser's color profile when pngjs re-encodes stitched pixels.
export function preserveColorProfile(encoded: Buffer, original: Buffer): Buffer {
  for (let offset = 8; offset + 12 <= original.length;) {
    const length = original.readUInt32BE(offset);
    if (offset + length + 12 > original.length) break;
    if (original.toString("ascii", offset + 4, offset + 8) === "iCCP") {
      return Buffer.concat([encoded.subarray(0, 33), original.subarray(offset, offset + length + 12), encoded.subarray(33)]);
    }
    offset += length + 12;
  }
  return encoded;
}

export async function captureRegion(cdp: CDPClient, rect: ElementSnapshot["rect"], contextId?: number): Promise<Buffer> {
  const original = await viewport(cdp, contextId);
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const width = rect.width - (left - rect.x);
  const height = rect.height - (top - rect.y);
  if (width <= 0 || height <= 0 || original.width <= 0 || original.height <= 0) {
    throw new Error("The selected element has no capturable area.");
  }
  if (width * height * original.dpr ** 2 > 64_000_000) {
    throw new Error("The selected element exceeds the 64 megapixel screenshot limit.");
  }
  let composite: PNG | undefined;
  let firstImage: Buffer | undefined;
  let pixelScale = original.dpr;
  let pixelScaleY = original.dpr;
  let moved = false;
  try {
    for (let y = top; y < top + height; y += original.height) {
      for (let x = left; x < left + width; x += original.width) {
        const tileWidth = Math.min(original.width, left + width - x);
        const tileHeight = Math.min(original.height, top + height - y);
        const current = await viewport(cdp, contextId);
        if (x < current.x || y < current.y
          || x + tileWidth > current.x + current.width
          || y + tileHeight > current.y + current.height) {
          moved = true;
          await cdp.evaluate(`scrollTo({left:${x},top:${y},behavior:"instant"})`, contextId);
        }
        await settle(cdp);
        const visible = await viewport(cdp, contextId);
        if (visible.width !== original.width || visible.height !== original.height) {
          throw new Error("The browser viewport changed during capture. Please try again.");
        }
        // Even a CDP `clip` can reset Electron's device emulation. Crop the visible bitmap on the host instead.
        const result = await cdp.send("Page.captureScreenshot", {
          format: "png", captureBeyondViewport: false,
        });
        const data = Buffer.from(result.data, "base64");
        const surface = PNG.sync.read(data);
        if (!composite) {
          pixelScale = surface.width / visible.surfaceWidth;
          pixelScaleY = surface.height / visible.height;
          const outputWidth = Math.max(1, Math.round(width * pixelScale));
          const outputHeight = Math.max(1, Math.round(height * pixelScaleY));
          if (outputWidth * outputHeight > 64_000_000) throw new Error("Screenshot exceeds the image size limit.");
          composite = new PNG({ width: outputWidth, height: outputHeight });
          firstImage = data;
        }
        const targetX = Math.round((x - left) * pixelScale);
        const targetY = Math.round((y - top) * pixelScaleY);
        const sourceX = Math.round((x - visible.x) * pixelScale);
        const sourceY = Math.round((y - visible.y) * pixelScaleY);
        const copyWidth = Math.min(
          Math.round((x - left + tileWidth) * pixelScale) - targetX,
          composite.width - targetX, surface.width - sourceX,
        );
        const copyHeight = Math.min(
          Math.round((y - top + tileHeight) * pixelScaleY) - targetY,
          composite.height - targetY, surface.height - sourceY,
        );
        if (sourceX < 0 || sourceY < 0 || copyWidth <= 0 || copyHeight <= 0) {
          throw new Error("The selected area could not be brought into the browser viewport.");
        }
        PNG.bitblt(surface, composite, sourceX, sourceY, copyWidth, copyHeight,
          targetX, targetY);
      }
    }
    if (!composite || !firstImage) throw new Error("No screenshot pixels were captured.");
    return preserveColorProfile(PNG.sync.write(composite), firstImage);
  } finally {
    if (moved) {
      await cdp.evaluate(`scrollTo({left:${original.x},top:${original.y},behavior:"instant"})`, contextId).catch(() => {});
      await settle(cdp).catch(() => {});
    }
  }
}
