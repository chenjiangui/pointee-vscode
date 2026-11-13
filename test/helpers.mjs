import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function sourceModule(path) {
  const result = await build({
    entryPoints: [path], bundle: true, write: false,
    platform: "node", format: "cjs", target: "node20",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
