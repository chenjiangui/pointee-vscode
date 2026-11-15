import { spawn } from "node:child_process";

type ClipboardRunner = (command: string, args: string[], input: Buffer) => Promise<void>;
interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ClipboardRunner;
}

const MAC_SCRIPT = `
ObjC.import("AppKit");
function run() {
  const png = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const image = $.NSImage.alloc.initWithData(png);
  if (image.isNil()) throw new Error("Invalid PNG image");
  const tiff = image.TIFFRepresentation;
  const clipboard = $.NSPasteboard.generalPasteboard;
  clipboard.clearContents;
  if (!clipboard.setDataForType(png, $.NSPasteboardTypePNG)) throw new Error("Cannot write PNG to clipboard");
  if (!tiff.isNil()) clipboard.setDataForType(tiff, $.NSPasteboardTypeTIFF);
}
`;

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream = [IO.MemoryStream]::new($bytes)
$image = $null
try {
  $image = [Drawing.Image]::FromStream($stream)
  $stream.Position = 0
  $data = [Windows.Forms.DataObject]::new()
  $data.SetData([Windows.Forms.DataFormats]::Bitmap, $true, $image)
  $data.SetData('PNG', $false, $stream)
  [Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
} finally {
  if ($null -ne $image) { $image.Dispose() }
  $stream.Dispose()
}
`;

export async function runClipboardCommand(command: string, args: string[], input: Buffer, timeoutMs = 15_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let finished = false;
    let stderr = "";
    let inputError: Error | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stderr.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Image clipboard helper timed out."));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
    });
    child.stdin.on("error", error => { inputError = error; });
    child.once("error", error => finish(error));
    // wl-copy/xclip can fork a clipboard owner which keeps the pipe open after the parent exits.
    child.once("exit", (code, signal) => {
      finish(code === 0
        ? inputError
        : new Error(stderr.trim() || `Image clipboard helper exited (${signal ?? code}).`));
    });
    child.stdin.end(input);
  });
}

export async function writeImageClipboard(data: Uint8Array, options: ClipboardOptions = {}): Promise<void> {
  const png = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Only PNG images can be copied to the image clipboard.");
  }
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runClipboardCommand;
  if (platform === "darwin") {
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT], png);
  } else if (platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA",
      "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
    ], Buffer.from(png.toString("base64"), "ascii"));
  } else if (platform === "linux") {
    const wayland = ["wl-copy", ["--type", "image/png"]] as const;
    const x11 = ["xclip", ["-selection", "clipboard", "-t", "image/png", "-i"]] as const;
    const candidates = (options.env ?? process.env).WAYLAND_DISPLAY ? [wayland, x11] : [x11, wayland];
    const failures: string[] = [];
    for (const [command, args] of candidates) {
      try { await run(command, [...args], png); return; }
      catch (error) { failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new Error(`Image clipboard unavailable. Install wl-clipboard (Wayland) or xclip (X11). ${failures.join("; ")}`);
  } else {
    throw new Error(`Image clipboard is not supported on ${platform}.`);
  }
}
