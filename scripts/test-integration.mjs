import { runTests, downloadAndUnzipVSCode } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = `${process.env.HOME}/Applications/Visual Studio Code.app/Contents/MacOS/Code`;
let executable = process.env.VSCODE_EXECUTABLE_PATH || (existsSync(local) ? local : undefined);
if (!executable) {
  const downloaded = await downloadAndUnzipVSCode("1.145.2");
  executable = existsSync(downloaded) ? downloaded : join(dirname(downloaded), "Code");
}
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: `${root}/dist/index.js`,
  vscodeExecutablePath: executable,
  launchArgs: [
    "--enable-proposed-api=pointee.pointee-vscode",
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
  ],
});
