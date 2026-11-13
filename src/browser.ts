import { randomBytes } from "node:crypto";
import { CDPClient, CDPEvent } from "./cdp";
import { ElementSnapshot, validateSnapshot } from "./model";
import { captureRegion } from "./screenshot";
import bridgeSource from "./page-bridge.js?raw";
import inspectorCSS from "./inspector.css?raw";
import shaderSource from "../vendor/pointee/shader-agent.js?raw";

export interface BrowserHost {
  preferences(): Record<string, string>;
  selection(snapshot: ElementSnapshot | null): Promise<void>;
  copy(text: string, snapshot?: ElementSnapshot): Promise<void>;
  screenshot(data: Uint8Array, snapshot: ElementSnapshot): Promise<string>;
  store(values: Record<string, string>): Promise<void>;
  settings(): Promise<void>;
  state(active: boolean): void;
  log(message: string): void;
}

export class BrowserPicker {
  private readonly binding = `__pointee_${randomBytes(12).toString("hex")}`;
  private readonly world = `pointee-vscode-${randomBytes(8).toString("hex")}`;
  private contextId?: number;
  private frameId?: string;
  private styleSheetId?: string;
  private sheets = new Map<string, string>();
  private injection?: Promise<void>;
  private navigation = 0;
  private desiredActive = false;
  private disposed = false;
  private deepScriptId?: string;
  private screenshotInProgress = false;
  private readonly events;
  private readonly closed;

  constructor(readonly cdp: CDPClient, private readonly host: BrowserHost) {
    this.events = cdp.onEvent(event => this.onEvent(event));
    this.closed = cdp.onClose(() => {
      this.desiredActive = false;
      this.contextId = undefined;
      host.state(false);
    });
  }

  get active(): boolean { return this.desiredActive; }

  async initialize(): Promise<void> {
    await this.cdp.attach();
    await this.cdp.send("Runtime.addBinding", {
      name: this.binding, executionContextName: this.world,
    });
    await this.cdp.send("CSS.enable");
    await this.syncDeepCapture();
  }

  private async syncDeepCapture(): Promise<void> {
    const wanted = this.host.preferences().editDeepShaderCapture === "on";
    if (wanted && !this.deepScriptId) {
      const result = await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: shaderSource });
      this.deepScriptId = result.identifier;
    } else if (!wanted && this.deepScriptId) {
      await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.deepScriptId });
      this.deepScriptId = undefined;
    }
  }

  private onEvent(event: CDPEvent): void {
    if (event.sessionId !== this.cdp.pageSessionId) return;
    const { method, params } = event;
    if (method === "CSS.styleSheetAdded" && !params.header.isInline && params.header.sourceURL) {
      this.sheets.set(params.header.sourceURL, params.header.styleSheetId);
    } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
      this.navigation++;
      this.frameId = params.frame.id;
      this.contextId = undefined;
      this.styleSheetId = undefined;
      this.sheets.clear();
      void this.host.selection(null).catch(error => this.host.log(String(error)));
    } else if (method === "Runtime.executionContextDestroyed" && params.executionContextId === this.contextId) {
      this.contextId = undefined;
    } else if (method === "Page.loadEventFired" && this.desiredActive) {
      void this.ensureInjected().then(() => this.applyActive()).catch(error => {
        this.host.log(`Reactivating picker after navigation: ${error}`);
      });
    } else if (method === "Runtime.bindingCalled" && params.name === this.binding
      && params.executionContextId === this.contextId) {
      void this.handleBinding(params.payload, params.executionContextId).catch(error => this.host.log(String(error)));
    }
  }

  private async ensureInjected(): Promise<void> {
    if (this.disposed) throw new Error("Picker is disposed.");
    if (this.injection) return this.injection;
    this.injection = this.inject().finally(() => { this.injection = undefined; });
    return this.injection;
  }

  private async inject(): Promise<void> {
    if (this.contextId) {
      const exists = await this.cdp.evaluate<boolean>("Boolean(globalThis.__pointeeVSCode)", this.contextId).catch(() => false);
      if (exists) return;
    }
    const generation = this.navigation;
    const tree = await this.cdp.send("Page.getFrameTree");
    const frameId = tree.frameTree.frame.id;
    const world = await this.cdp.send("Page.createIsolatedWorld", {
      frameId, worldName: this.world, grantUniveralAccess: false,
    });
    if (generation !== this.navigation) throw new Error("Page navigated while starting the picker. Try again.");
    this.contextId = world.executionContextId;
    this.frameId = frameId;
    // Inspector stylesheets bypass page CSP without weakening the page's policy.
    const sheet = await this.cdp.send("CSS.createStyleSheet", { frameId });
    this.styleSheetId = sheet.styleSheetId;
    await this.cdp.send("CSS.setStyleSheetText", {
      styleSheetId: sheet.styleSheetId, text: inspectorCSS,
    });
    await this.cdp.evaluate(`(${bridgeSource})(${JSON.stringify({
      binding: this.binding, preferences: this.host.preferences(),
    })})`, this.contextId);
  }

  private async call<T = unknown>(expression: string): Promise<T> {
    await this.ensureInjected();
    return this.cdp.evaluate<T>(`globalThis.__pointeeVSCode.${expression}`, this.contextId);
  }

  private async applyActive(): Promise<void> {
    await this.call(`toggle(${this.desiredActive})`);
  }

  async toggle(): Promise<boolean> {
    const next = !this.desiredActive;
    this.desiredActive = next;
    try { await this.applyActive(); }
    catch (error) {
      this.desiredActive = false;
      this.host.state(false);
      throw error;
    }
    this.host.state(next);
    return next;
  }

  async stop(): Promise<void> {
    this.desiredActive = false;
    if (this.contextId) await this.call("toggle(false)");
    this.host.state(false);
  }

  async updatePreferences(): Promise<void> {
    await this.syncDeepCapture();
    if (this.contextId) await this.call(`preferences(${JSON.stringify(this.host.preferences())})`);
  }

  async snapshot(): Promise<ElementSnapshot> {
    const snapshot = await this.call<unknown>("snapshot()");
    if (!validateSnapshot(snapshot)) throw new Error("Select an element in the browser first.");
    return snapshot;
  }

  async copy(): Promise<void> {
    const snapshot = await this.snapshot();
    if (!snapshot.pointer) throw new Error("Nothing to copy. Enable context fields in Pointee settings.");
    await this.host.copy(snapshot.pointer, snapshot);
  }

  async parent(): Promise<void> {
    await this.snapshot();
    await this.call("parent()");
  }

  async edit(): Promise<void> {
    await this.snapshot();
    await this.call("edit()");
  }

  async capture(snapshot?: ElementSnapshot): Promise<string> {
    if (this.screenshotInProgress) throw new Error("A screenshot is already being captured.");
    this.screenshotInProgress = true;
    const generation = this.navigation;
    try {
      const current = snapshot ?? await this.snapshot();
      if (!validateSnapshot(current) || !current.rect.width || !current.rect.height) {
        throw new Error("The selected element has no visible area.");
      }
      const { width, height } = current.rect;
      if (width > 32768 || height > 32768 || width * height > 64_000_000) {
        throw new Error("This element is too large to capture. Select a smaller element.");
      }
      await this.call("hide(true)");
      try {
        const data = await captureRegion(this.cdp, current.rect, this.contextId);
        if (generation !== this.navigation) throw new Error("Page navigated during screenshot capture.");
        return await this.host.screenshot(data, current);
      } finally {
        if (this.contextId) await this.call("hide(false)").catch(error => this.host.log(`Restore overlay: ${error}`));
      }
    } finally { this.screenshotInProgress = false; }
  }

  private async handleBinding(payload: unknown, contextId: number): Promise<void> {
    if (typeof payload !== "string" || payload.length > 2_100_000) return;
    let message: any;
    try { message = JSON.parse(payload); } catch { return; }
    if (!message || !Number.isSafeInteger(message.id) || typeof message.type !== "string") return;
    let value: unknown;
    let error: string | undefined;
    try {
      const snapshot = validateSnapshot(message.snapshot) ? message.snapshot : undefined;
      switch (message.type) {
        case "SELECTION":
          await this.host.selection(snapshot ?? null);
          break;
        case "COPY_TEXT":
          if (typeof message.text !== "string" || message.text.length > 2_000_000) throw new Error("Invalid clipboard payload.");
          await this.host.copy(message.text, snapshot ? { ...snapshot, pointer: message.text } : undefined);
          break;
        case "SCREENSHOT":
          if (!snapshot) throw new Error("Select an element first.");
          value = await this.capture(snapshot);
          break;
        case "DEACTIVATE":
          this.desiredActive = false;
          this.host.state(false);
          break;
        case "OPEN_SETTINGS":
          await this.host.settings();
          break;
        case "STORE":
          // Upstream only persists its Map/Layers preference from the page.
          if (message.values?.inspectorMode === "map" || message.values?.inspectorMode === "layers") {
            await this.host.store({ inspectorMode: message.values.inspectorMode });
          }
          break;
        case "INJECT_SHADER_AGENT":
          await this.cdp.evaluate(shaderSource);
          value = { ok: true };
          break;
        case "FETCH_STYLESHEETS": {
          const urls = Array.isArray(message.urls) ? message.urls.slice(0, 12) : [];
          // Read only CSS already loaded in this page; never fetch arbitrary page-provided URLs from the host.
          const sheets = await Promise.all(urls.map(async (url: unknown) => {
            const id = typeof url === "string" ? this.sheets.get(url) : undefined;
            if (!id) return { url, error: "Stylesheet not loaded in this page" };
            try {
              const { text } = await this.cdp.send("CSS.getStyleSheetText", { styleSheetId: id });
              return text.length <= 4 * 1024 * 1024 ? { url, text } : { url, error: "Stylesheet too large" };
            } catch { return { url, error: "Stylesheet unavailable" }; }
          }));
          value = { sheets };
          break;
        }
        default: throw new Error("Unsupported Pointee request.");
      }
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    if (contextId !== this.contextId || this.disposed) return;
    await this.cdp.evaluate(
      `globalThis.__pointeeVSCode?.reply(${JSON.stringify(message.id)},${JSON.stringify(value) ?? "null"},${JSON.stringify(error) ?? "null"})`,
      contextId,
    ).catch(reason => this.host.log(`Reply after navigation: ${reason}`));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.stop().catch(() => {});
    if (this.deepScriptId) await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: this.deepScriptId,
    }).catch(() => {});
    await this.cdp.send("Runtime.removeBinding", { name: this.binding }).catch(() => {});
    this.disposed = true;
    this.events.dispose();
    this.closed.dispose();
    await this.cdp.dispose();
  }
}
