export type ScreenshotDestination = "clipboard" | "file";

export type ScreenshotResult =
  | { destination: "clipboard" }
  | { destination: "file"; path: string; fallback: boolean };

interface ScreenshotDelivery {
  copyImage(data: Uint8Array): Promise<void>;
  saveFile(data: Uint8Array): Promise<string>;
  copyPath(path: string): Promise<void>;
  onClipboardError?(error: unknown): void;
}

export async function deliverScreenshot(
  data: Uint8Array,
  delivery: ScreenshotDelivery,
  destination: ScreenshotDestination = "clipboard",
): Promise<ScreenshotResult> {
  let fallback = false;
  if (destination === "clipboard") {
    try {
      await delivery.copyImage(data);
      return { destination: "clipboard" };
    } catch (error) {
      fallback = true;
      delivery.onClipboardError?.(error);
    }
  }
  const path = await delivery.saveFile(data);
  await delivery.copyPath(path);
  return { destination: "file", path, fallback };
}
