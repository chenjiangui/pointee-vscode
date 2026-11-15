# Pointee for VS Code

English | [简体中文](README.zh-CN.md)

Pick elements in **VS Code's Integrated Browser** and send locatable page context to any AI agent. This is not a Chrome extension or a wrapper around an external browser.

Based on the MIT-licensed code from [Jingquank/pointee](https://github.com/Jingquank/pointee) 3.0. It retains the upstream picker, Inspector, live editing, and distance measurement interactions; the extension host handles the clipboard, context history, file export, and screenshots of the browser's actual rendering. This project is not an official extension published by the upstream author.

## Installation

Requires **VS Code 1.145.0 or later**. Integration tests that exercise the actual Integrated Browser were written against a local installation of VS Code 1.145.2.

1. Install [Pointee for VS Code](https://marketplace.visualstudio.com/items?itemName=pointee-vscode.pointee-vscode) from the Extensions view, or run `Extensions: Install from VSIX...` in the Command Palette and select a local `pointee-vscode-0.1.1.vsix` package.
2. **Fully quit all VS Code processes**, then launch it from a terminal:

   ```sh
   code --enable-proposed-api pointee-vscode.pointee-vscode .
   ```

3. Run `Pointee: Open Integrated Browser` and enter your development page URL.
4. Click `Pointee` in the status bar, or press `Cmd+Alt+P` on macOS / `Ctrl+Alt+P` on Windows or Linux.
5. Hover to inspect, click to select, then click **Copy Code** on the page. Paste into Codex, Claude Code, Cursor, or another agent and describe the changes you want.

**You must explicitly enable the proposed API.** VS Code's `browser` API is not yet a stable extension API, and neither Marketplace nor VSIX installation automatically grants access to it. Reloading the window alone is usually not enough to change launch arguments. There is no need to modify the VS Code installation directory or enable a remote debugging port. The F5 debug configuration already includes the required arguments.

## Features

- **Picking**: Upstream box-model highlights, dimensions, fonts, colors, Map / Layers, and parent elements.
- **Copying**: Page URL, unique CSS selector, text, HTML, neighboring/repeated structures, and source locations exposed by development tools. Optional layout, style, and props fields.
- **Editing**: Upstream style, text, and design token editors; undo, redo, reset; copy the actual before/after diff. Changes are previewed only on the page and do not write to source files.
- **Distance measurement**: After selecting an element, hold Alt / Option and hover over other elements.
- **Screenshots**: Capture the browser's actual rendering through CDP, including canvas/WebGL, while automatically hiding the picker. **By default, the image is copied directly to the system clipboard without saving a file**; paste with Cmd+V / Ctrl+V into an agent that supports image input. This differs from v0.1.0, which copied a file path.
- **Saving screenshots**: When you need an image file, run `Pointee: Save Element Screenshot` to save a PNG, copy its absolute path, and attach it to the current context record. If the image clipboard is unavailable, the extension automatically falls back to this behavior and explicitly notifies you.
- **Context history**: The `Pointee` view in the Explorer. Selections are recorded automatically; copy the full context, open Markdown, export a `.md` file, or open an attached screenshot.
- **Tabs**: Supports existing and new Integrated Browser tabs and restores picking after a reload. `Pointee: Stop Picking` stops picking in all tabs and reverts the current page preview changes.
- **Settings**: Search for `pointee` in VS Code settings to adjust the theme, copied fields/HTML depth, editor options, and measurement parameters. Changes are synchronized to the page immediately.

Example copied context:

````text
```
# source: src/components/PlanCard.tsx:42:6
# page: localhost:3000/pricing
# selector: article#pro
# text: Pro Plan
<article id="pro" data-testid="plan-card">...</article>
```
````

Source locations are read from existing development-tool annotations such as `data-inspector-*`, `data-v-inspector`, and `data-source-loc` / `data-source-file`. The extension does not guess source files or line numbers from the DOM. Selectors and HTML are still available when annotations are absent.

## Image Clipboard

- macOS uses the system AppKit clipboard and provides both PNG and TIFF representations for pasting into different applications.
- Windows uses the system PowerShell / Windows Forms clipboard.
- Linux Wayland desktops require `wl-copy` (`wl-clipboard`); X11 desktops require `xclip`. If unavailable, the extension saves a file and copies its path rather than pretending the image was copied.
- Images are piped in memory to native clipboard tools. No temporary image files are written, and there is no dependency on the page's Clipboard API, HTTPS, or page-focus permissions. System-tool failure details are available in the `Pointee` Output panel.
- Reading PNG data back from the system clipboard has been verified on macOS. The Windows/Linux implementations have command and error-fallback tests but have not yet been verified on actual systems.
- Images and text share the system clipboard; copying code afterward replaces the image. Copying only an image does not attach a PNG path to context history. Use “Save Element Screenshot” if you need to keep the image persistently.

## Scope and Privacy

- Supports only the **Integrated Browser** in desktop VS Code. `Simple Browser`, ordinary webviews, external Chrome, and vscode.dev are not supported. If the API is unavailable, the extension reports it explicitly rather than silently switching browsers.
- Like the upstream default content script, picking is limited to the top-level document; it does not enter iframes or closed Shadow DOM. Private React/Vue runtime objects live in the page's JavaScript world, so the isolated picker cannot guarantee access to them. Source annotations and `data-component` can be read directly.
- WebGL uniform editing is an upstream best-effort feature. For single-frame canvas content, enable `editDeepShaderCapture` and reload a page where the picker has previously been enabled. After stopping deep capture, a page reload is required to fully restore WebGL prototypes already wrapped by the upstream shader agent.
- Remote image-path mapping in VS Code Remote is not supported. The extension runs in the local UI host; screenshot paths are local and are not automatically uploaded to a remote agent.
- Screenshots of tall elements briefly scroll the page, capture tiles, stitch them locally, and restore the original scroll position. The limit is 64 million pixels. Fixed/sticky positioning, scroll-driven animations, and lazy-loaded content may affect screenshots spanning multiple viewports. PNGs retain the browser's ICC color profile; device emulation settings are not changed for screenshots.
- Nothing is automatically sent to an agent. The extension does not modify agent configuration, start an HTTP server, or depend on other browser/MCP extensions.
- Page data enters in-memory history only after an explicit selection; history is lost when VS Code restarts. Default screenshots go only to the system clipboard and do not create image files. When explicitly saved or saved as a clipboard-failure fallback, PNGs are stored in the extension's `globalStorage/pointee-vscode.pointee-vscode/screenshots` directory. **Clearing history does not delete these images**; retrieve their absolute paths from context records and delete them manually. Existing v0.1.0 screenshots are not deleted automatically.
- Clipboard/Markdown content may contain sensitive information visible on the page; review it before sending. Password-input values are not actively read, but DOM attributes and text may themselves contain application data.
- Cross-origin stylesheets are read through CDP from **CSS already loaded by the current page**. Arbitrary URLs supplied by the page are not passed to the extension host for fetching. No telemetry, accounts, or external services.

## Development

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run package
```

Open the project in VS Code and press F5 to launch the Extension Development Host. After making changes, run `npm run build` and reload the development host. `npm run watch` watches the TypeScript extension code; changes to page adapter scripts or vendor files require another build.

`npm run test:integration` launches an isolated VS Code test instance, opens the actual Integrated Browser, and sends CDP mouse/keyboard input. It does not write to your everyday VS Code settings or install extensions there. Set `VSCODE_EXECUTABLE_PATH` to use a local editor executable; otherwise, it first tries the macOS user Applications directory, then downloads the specified test version. Screenshot evidence is saved in `test-results/integration/`.

Integration tests operate on the actual system clipboard to verify PNG readback and pasting. Linux also requires the corresponding clipboard read/write tools (`wl-copy`/`wl-paste` or `xclip`).

`npm run test:ui` uses Playwright to check the upstream UI at desktop/mobile sizes and generate screenshots. It requires an installed Chromium browser, or a Chromium-based browser specified with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

`vendor/pointee/UPSTREAM.json` pins the upstream commit. Original files remain unchanged; `scripts/build.mjs` uses the TypeScript AST to install controlled adaptation hooks and fails the build if a hook cannot be found. Refresh the vendor files with `node scripts/vendor.mjs`.

For Marketplace publishing, authenticate as the publisher and run `npm run publish:marketplace`. This explicitly allows only the `browser` proposal; users must still enable it when launching VS Code.

## Extension API

Other VS Code extensions can invoke the registered `pointee.*` commands, or activate the extension and access:

```ts
const pointee = await vscode.extensions
  .getExtension("pointee-vscode.pointee-vscode")?.activate();
const selected = await pointee?.getSelectedElement();
const latest = pointee?.getLatestContext();
```

Context includes `url`, `selector`, `pointer`, and `rect`; records also include `capturedAt` and an optional `screenshotPath`. The extension does not execute DOM text as agent instructions.

Starting with v0.1.1, `pointee.screenshot` copies the image by default and returns `{ destination: "clipboard" }`; `pointee.saveScreenshot` returns `{ destination: "file", path, fallback: false }`. When the default clipboard operation fails and falls back to saving a file, it returns a file result with `fallback: true`.

## License

MIT. See `vendor/pointee/LICENSE` for upstream code and attribution; the bundled Geist fonts are covered by `vendor/pointee/fonts/OFL.txt`.
