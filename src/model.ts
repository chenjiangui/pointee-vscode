export interface ElementSnapshot {
  title: string;
  url: string;
  selector: string;
  pointer: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface ContextRecord extends ElementSnapshot {
  id: string;
  capturedAt: string;
  screenshotPath?: string;
}

export function formatContext(record: ContextRecord): string {
  const lines = [
    "# Element Context",
    "",
    `Captured: ${record.capturedAt}`,
    "",
    record.pointer,
  ];
  if (record.screenshotPath) {
    // A literal path works for terminal agents, including paths containing spaces.
    lines.push("", "## Screenshot", "", `File: ${JSON.stringify(record.screenshotPath)}`);
  }
  return lines.join("\n") + "\n";
}

export function validateSnapshot(value: unknown): value is ElementSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ElementSnapshot;
  return typeof snapshot.title === "string" && snapshot.title.length <= 1000
    && typeof snapshot.url === "string" && snapshot.url.length <= 16_384
    && typeof snapshot.selector === "string" && snapshot.selector.length <= 16_384
    && typeof snapshot.pointer === "string" && snapshot.pointer.length <= 2_000_000
    && !!snapshot.rect && ["x", "y", "width", "height"].every(
      key => Number.isFinite(snapshot.rect[key as keyof ElementSnapshot["rect"]]),
    ) && snapshot.rect.width >= 0 && snapshot.rect.height >= 0;
}
