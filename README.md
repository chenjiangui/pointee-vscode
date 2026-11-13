# Pointee for VS Code

在 **VS Code 内置浏览器（Integrated Browser）** 中拾取元素，把可定位的页面上下文发给任意 AI agent。不是 Chrome 插件，也不是套一层外部浏览器。

基于 [Jingquank/pointee](https://github.com/Jingquank/pointee) 3.0 的 MIT 代码，保留原版拾取器、Inspector、实时编辑和测距交互；扩展宿主负责剪贴板、上下文历史、文件导出和真实浏览器截图。本项目不是原作者发布的官方扩展。

## 安装

需要 **VS Code 1.145.0 或更新版本**。已针对本机 VS Code 1.145.2 编写真实内置浏览器集成测试。

1. 在命令面板执行 `Extensions: Install from VSIX...`，选择项目中的 `pointee-vscode-0.1.0.vsix`。
2. **完全退出所有 VS Code 进程**，再从终端启动：

   ```sh
   code --enable-proposed-api pointee.pointee-vscode .
   ```

3. 执行 `Pointee: Open Integrated Browser`，输入开发页面地址。
4. 点击状态栏 `Pointee`，或按 macOS `Cmd+Alt+P` / Windows、Linux `Ctrl+Alt+P`。
5. 悬停检查、点击选中，再点页面里的 **Copy Code**。在 Codex、Claude Code、Cursor 或其他 agent 中粘贴，并写上你希望怎样修改。

**必须显式启用 proposed API。** VS Code 的 `browser` API 尚不是稳定扩展 API，普通安装 VSIX 不会自动授予它。只重新加载窗口通常不足以改变启动参数；无需修改 VS Code 安装目录或开启远程调试端口。F5 调试配置已携带所需参数。此版本适合本地 VSIX 安装，不承诺 Marketplace 发布。

## 功能

- **拾取**：原版盒模型高亮、尺寸、字体、颜色、Map / Layers、元素父级。
- **复制**：页面 URL、唯一 CSS 选择器、文本、HTML、邻居/重复结构、开发工具暴露的源码位置。可选布局、样式和 props 字段。
- **编辑**：原版样式、文本和设计 token 编辑器；撤销、重做、重置；复制真实的修改前后差异。修改只在页面中预览，不写入源码文件。
- **测距**：选中后按住 Alt / Option 悬停其他元素。
- **截图**：通过 CDP 截取浏览器真实渲染结果，包含 canvas/WebGL，自动隐藏拾取器。保存 PNG 并复制**文件绝对路径**，不是系统图片剪贴板；可以直接把路径发给支持读取本地图片的 agent。
- **上下文历史**：资源管理器中的 `Pointee` 视图。选中后自动记录；可复制整个上下文、打开 Markdown、导出 `.md` 或打开附带截图。
- **标签页**：支持已有/新建内置浏览器标签页、刷新后恢复拾取。`Pointee: Stop Picking` 停止所有标签页，并撤销本次页面预览修改。
- **设置**：VS Code 设置中搜索 `pointee`，调整主题、复制字段/HTML 深度、编辑器和测距参数，立即同步至页面。

复制示例：

````text
```
# source: src/components/PlanCard.tsx:42:6
# page: localhost:3000/pricing
# selector: article#pro
# text: Pro Plan
<article id="pro" data-testid="plan-card">...</article>
```
````

源码定位读取 `data-inspector-*`、`data-v-inspector`、`data-source-loc` / `data-source-file` 等现有开发工具标注，不会根据 DOM 猜测源码文件或行号。未提供标注时仍有选择器和 HTML。

## 范围与隐私

- 只支持桌面版 VS Code 的 **Integrated Browser**。`Simple Browser`、普通 webview、外部 Chrome 和 vscode.dev 不支持。API 不可用时会明确提示，不会悄悄切换到另一个浏览器。
- 与上游默认 content script 一样，拾取限于顶层文档；不进入 iframe 或封闭 Shadow DOM。React/Vue 私有运行时对象处于页面的 JavaScript world 中，隔离拾取器不能保证读取它们；源码标注和 `data-component` 可直接读取。
- WebGL uniform 编辑为上游的尽力支持功能。单帧 canvas 需要打开 `editDeepShaderCapture` 并刷新已启用过拾取器的页面；停止深度捕获后，已经被上游 shader agent 包装过的 WebGL 原型需要刷新页面才能彻底恢复。
- 不支持 VS Code Remote 中的远程图片路径映射。扩展运行在本地 UI 宿主，截图路径位于本机，不会自动上传到远程 agent。
- 长元素截图会短暂滚动页面，分块截取后在本机拼接，并恢复原滚动位置。最多 6400 万像素；固定/粘性定位、滚动驱动动画和懒加载内容可能影响跨视口截图结果。PNG 保留浏览器的 ICC 颜色配置，不会为了截图修改设备模拟设置。
- 不自动发送任何内容给 agent，不修改 agent 配置，不启动监听 HTTP 服务，不依赖其他浏览器/MCP 扩展。
- 页面数据仅在显式选中后进入内存历史；历史在 VS Code 重启后消失。PNG 保存在扩展的 `globalStorage/pointee.pointee-vscode/screenshots` 中，**清空历史不删除图片**，可从上下文记录中取得绝对路径并手动删除。
- 剪贴板/Markdown 可能包含页面中可见的敏感信息，发送前请检查。密码控件的 value 不会被主动读取，但 DOM 自身的属性和文本可能包含应用数据。
- 跨域样式表通过 CDP 读取**当前页面已加载的 CSS**，不会把页面提供的任意 URL 交给扩展宿主请求。无遥测、账号或外部服务。

## 开发

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run package
```

在 VS Code 打开项目后按 F5 启动扩展开发宿主。修改后运行 `npm run build`，再重新加载开发宿主。`npm run watch` 监听 TypeScript 扩展代码；改动页面适配脚本或 vendor 文件后需重新运行 build。

`npm run test:integration` 启动隔离的 VS Code 测试实例，真实打开内置浏览器并发送 CDP 鼠标/键盘输入；不会写入你日常 VS Code 的设置或安装扩展。可用 `VSCODE_EXECUTABLE_PATH` 指定本机编辑器可执行文件，否则优先使用 macOS 用户应用目录，再下载指定的测试版本。截图证据在 `test-results/integration/`。

`npm run test:ui` 使用 Playwright 检查桌面/移动尺寸下的原版界面并生成截图，需要已安装 Chromium 或用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium 系浏览器。

`vendor/pointee/UPSTREAM.json` 固定上游提交。原文件保持不改动，`scripts/build.mjs` 使用 TypeScript AST 安装受控适配钩子，构建时找不到钩子会失败。刷新 vendor 使用 `node scripts/vendor.mjs`。

## 扩展接口

其他 VS Code 扩展可调用已注册的 `pointee.*` 命令，或者激活扩展后读取：

```ts
const pointee = await vscode.extensions
  .getExtension("pointee.pointee-vscode")?.activate();
const selected = await pointee?.getSelectedElement();
const latest = pointee?.getLatestContext();
```

上下文含 `url`、`selector`、`pointer`、`rect`，记录另含 `capturedAt` 和可选 `screenshotPath`。扩展不把 DOM 文本当成 agent 指令执行。

## License

MIT。上游代码及署名见 `vendor/pointee/LICENSE`；内嵌 Geist 字体遵循 `vendor/pointee/fonts/OFL.txt`。
