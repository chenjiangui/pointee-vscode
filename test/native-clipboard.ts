import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function readClipboardPNG(): Promise<Buffer> {
  if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
      ObjC.import("AppKit");
      const data = $.NSPasteboard.generalPasteboard.dataForType($.NSPasteboardTypePNG);
      if (data.isNil()) throw new Error("No PNG on the system clipboard");
      data.base64EncodedStringWithOptions(0).js;
    `], { maxBuffer: 32 * 1024 * 1024 });
    return Buffer.from(stdout.trim(), "base64");
  }
  if (process.platform === "win32") {
    const script = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Windows.Forms
      $data = [Windows.Forms.Clipboard]::GetDataObject()
      $png = $data.GetData('PNG')
      if ($null -eq $png) { throw 'No PNG on the system clipboard' }
      [Console]::Write([Convert]::ToBase64String($png.ToArray()))
    `;
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { maxBuffer: 32 * 1024 * 1024 });
    return Buffer.from(stdout.trim(), "base64");
  }
  const candidates: [string, string[]][] = [
    ["wl-paste", ["--type", "image/png", "--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  if (!process.env.WAYLAND_DISPLAY) candidates.reverse();
  for (const [command, args] of candidates) {
    try {
      const { stdout } = await exec(command, args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch { /* Try the other clipboard backend. */ }
  }
  throw new Error("Cannot read the system image clipboard.");
}
