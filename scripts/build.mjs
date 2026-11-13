import { build, context } from "esbuild";
import ts from "typescript";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const content = await read("vendor/pointee/content.js");
const ast = ts.createSourceFile("content.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map();
let ownRoots;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "OUR_ROOTS"
    && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
    ownRoots = node.initializer.elements.map(element => {
      if (!ts.isStringLiteral(element)) throw new Error("Unexpected inspector root");
      return element.text;
    });
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const edits = [];
function replaceFunction(name, source) {
  const node = functions.get(name);
  if (!node) throw new Error(`Upstream hook missing: ${name}`);
  edits.push({ start: node.getStart(ast), end: node.end, source });
}
function appendFunction(name, source) {
  const node = functions.get(name);
  if (!node?.body) throw new Error(`Upstream hook missing: ${name}`);
  edits.push({ start: node.body.end - 1, end: node.body.end - 1, source });
}

replaceFunction("copyScreenshot", `async function copyScreenshot(el, btnEl) {
  if (!el) return;
  flashButton(btnEl);
  const cancelLoading = setButtonLoading(btnEl);
  try {
    await pointee.screenshot();
    cancelLoading();
    setButtonSuccess(btnEl, "Saved!");
    showToast("Screenshot saved; path copied");
  } catch (error) {
    cancelLoading();
    resetButton(btnEl);
    showToast("Failed to capture: " + error.message, true);
  }
}`);
replaceFunction("copyElement", `async function copyElement(el, btnEl) {
  try {
    commitEditGesture();
    const info = editedElements().length ? buildEditsBlock() : buildElementInfo(el);
    if (!info) { resetButton(btnEl); showToast(EMPTY_PAYLOAD_NOTE, true); return; }
    await navigator.clipboard.writeText(info);
    setButtonSuccess(btnEl, "Copied!");
  } catch (error) {
    resetButton(btnEl);
    showToast("Failed to copy: " + error.message, true);
  }
}`);
// The original selector builder does not escape utility classes or mixed-tag sibling indices.
replaceFunction("buildSelector", `function buildSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1)
    return tag + "#" + CSS.escape(el.id);
  let selector = tag;
  for (const attr of ["data-testid", "data-test"]) {
    const value = el.getAttribute(attr);
    if (value) {
      selector += "[" + attr + "=" + CSS.escape(value) + "]";
      if (document.querySelectorAll(selector).length === 1) return selector;
      break;
    }
  }
  const parent = el.parentElement;
  const index = parent ? Array.from(parent.children).indexOf(el) + 1 : 1;
  return selector + (parent ? ":nth-child(" + index + ")" : "");
}`);
replaceFunction("buildSelectorPath", `function buildSelectorPath(el) {
  const parts = [];
  for (let node = el; node; node = node.parentElement) {
    parts.unshift(buildSelector(node));
    const path = parts.join(" > ");
    if (document.querySelectorAll(path).length === 1) return path;
  }
  return parts.join(" > ");
}`);
replaceFunction("toProjectPath", `function toProjectPath(path) {
  const normalized = path.replace(/\\\\/g, "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\\//.test(normalized) && !normalized.startsWith("file:")) return path;
  const match = normalized.match(/\\/(?:src|app|pages|components|lib|routes)\\//);
  return match ? normalized.slice(match.index + 1) : path;
}`);
replaceFunction("getPageString", `function getPageString() { return location.href; }`);
for (const name of ["onClick", "selectParent", "deselectElement"]) {
  appendFunction(name, "\npointee.changed();\n");
}
const outer = ast.statements.find(ts.isExpressionStatement)?.expression;
if (!outer || !ts.isCallExpression(outer)) throw new Error("Unexpected upstream wrapper");
const wrapper = ts.isParenthesizedExpression(outer.expression) ? outer.expression.expression : outer.expression;
if (!ts.isArrowFunction(wrapper) || !ts.isBlock(wrapper.body)) throw new Error("Unexpected upstream body");
edits.push({
  start: wrapper.body.end - 1, end: wrapper.body.end - 1,
  source: `
  api = globalThis.__pointeeVSCode = {
    reply(id, value, error) {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id); clearTimeout(item.timer);
      if (error) item.reject(new Error(error)); else item.resolve(value);
    },
    preferences(values) {
      const changes = {};
      for (const [key, newValue] of Object.entries(values)) {
        if (stored[key] !== newValue) {
          changes[key] = { oldValue: stored[key], newValue };
          stored[key] = newValue;
        }
      }
      for (const listener of storageListeners) listener(changes, "local");
    },
    toggle(active) {
      for (const listener of messageListeners) listener({ type: "TOGGLE_POINT", active });
      return probeActive;
    },
    snapshot() {
      const el = selectedElement;
      if (!el || !el.isConnected) return null;
      commitEditGesture();
      const rect = el.getBoundingClientRect();
      return {
        title: briefName(el), url: location.href, selector: buildSelectorPath(el),
        pointer: editedElements().length ? buildEditsBlock() : buildElementInfo(el),
        rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }
      };
    },
    parent: () => selectParent(),
    edit: () => { if (selectedElement) enterEditMode(); },
    hide(hidden) {
      document.documentElement.toggleAttribute("data-pnt-vscode-capturing", hidden);
      if (hidden) lightPage(null);
      void document.documentElement.offsetHeight;
    },
    state: () => ({ active: probeActive, selected: Boolean(selectedElement), editing })
  };
  `,
});
let adapted = content;
for (const edit of edits.sort((a, b) => b.start - a.start)) {
  adapted = adapted.slice(0, edit.start) + edit.source + adapted.slice(edit.end);
}
// Rail expects window.PntRail; it can safely live inside the isolated world.
const railSource = await read("vendor/pointee/rail.js");
const pageBridge = (await read("src/page-bridge.js"))
  .replace("/* __POINTEE_RAIL__ */", () => railSource)
  .replace("/* __POINTEE_CONTENT__ */", () => adapted);
new Function(`return (${pageBridge})`);

let css = await read("vendor/pointee/tokens.css");
for (const font of ["Geist", "GeistMono"]) {
  const filename = `${font}-Variable.woff2`;
  const bytes = await readFile(new URL(`vendor/pointee/fonts/${filename}`, root));
  css = css.replace(`chrome-extension://__MSG_@@extension_id__/fonts/${filename}`,
    `data:font/woff2;base64,${bytes.toString("base64")}`);
}
css += "\n" + await read("vendor/pointee/content.css");
if (!ownRoots?.length) throw new Error("Upstream inspector root list missing");
css += `\n:root[data-pnt-vscode-capturing] :is(${ownRoots.map(id => "#" + id).join(",")}) { display: none !important; }\n`;
const inspectorRoots = ownRoots.map(id => "#" + id).join(",");
css += `\n:is(${inspectorRoots}), :is(${inspectorRoots}) * { letter-spacing: 0 !important; }\n`;
const rawAssets = {
  "page-bridge.js": pageBridge,
  "inspector.css": css,
  "shader-agent.js": await read("vendor/pointee/shader-agent.js"),
};
const options = {
  entryPoints: ["src/extension.ts", "test/integration/index.ts"],
  outdir: "dist", outbase: ".", bundle: true, platform: "node", format: "cjs",
  target: "node20", external: ["vscode"], sourcemap: true,
  entryNames: "[name]",
  plugins: [{
    name: "pointee-assets",
    setup(plugin) {
      plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: args.path.split("/").pop(), namespace: "raw" }));
      plugin.onLoad({ filter: /.*/, namespace: "raw" }, args => {
        const key = args.path.replace("?raw", "");
        if (!(key in rawAssets)) throw new Error(`Unknown asset: ${key}`);
        return { contents: rawAssets[key], loader: "text" };
      });
    },
  }],
};
await mkdir(new URL("dist", root), { recursive: true });
await writeFile(new URL("dist/page-bridge.js", root), pageBridge);
await writeFile(new URL("dist/inspector.css", root), css);
if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
  console.log("Watching extension sources");
} else await build(options);
