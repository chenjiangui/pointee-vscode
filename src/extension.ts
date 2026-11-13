import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { BrowserPicker } from "./browser";
import { CDPClient } from "./cdp";
import { ContextHistory } from "./history";
import { ContextRecord, ElementSnapshot, formatContext } from "./model";
import { toPagePreferences } from "./preferences";

const EXTENSION_ID = "pointee.pointee-vscode";
const API_HELP = `Pointee needs VS Code's proposed browser API. Close VS Code completely and launch it with: code --enable-proposed-api ${EXTENSION_ID}`;
let shutdown: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Pointee");
  const history = new ContextHistory();
  const tree = vscode.window.createTreeView("pointee.contexts", { treeDataProvider: history });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "pointee.togglePicker";
  status.name = "Pointee Element Picker";
  const pickers = new Map<vscode.BrowserTab, BrowserPicker>();
  const starting = new Map<vscode.BrowserTab, Promise<BrowserPicker>>();
  let lastTab: vscode.BrowserTab | undefined;
  let available = false;
  let shuttingDown = false;
  shutdown = async () => {
    shuttingDown = true;
    await Promise.all([...starting.values()].map(task => task.catch(() => undefined)));
    await Promise.all([...pickers.values()].map(picker => picker.dispose().catch(() => {})));
    pickers.clear();
  };
  const preferences = () => ({
    ...toPagePreferences((key, fallback) => vscode.workspace.getConfiguration("pointee").get(key, fallback)),
    inspectorMode: context.globalState.get<string>("inspectorMode", "map"),
  });

  function updateStatus(): void {
    const active = [...pickers.values()].some(picker => picker.active);
    status.text = active ? "$(inspect) Pointee: On" : "$(inspect) Pointee";
    status.tooltip = available ? "Toggle element picker in the integrated browser" : API_HELP;
    status.backgroundColor = active ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    void vscode.commands.executeCommand("setContext", "pointee.picking", active);
    status.show();
  }

  function assertAvailable(): void {
    if (!available) throw new Error(API_HELP);
  }

  async function chooseTab(): Promise<vscode.BrowserTab> {
    assertAvailable();
    const tabs = vscode.window.browserTabs;
    if (vscode.window.activeBrowserTab) return vscode.window.activeBrowserTab;
    if (lastTab && tabs.includes(lastTab)) return lastTab;
    if (tabs.length === 1) return tabs[0];
    if (tabs.length > 1) {
      const selected = await vscode.window.showQuickPick(
        tabs.map(tab => ({ label: tab.title || tab.url, description: tab.url, tab })),
        { placeHolder: "Choose the integrated browser tab to inspect" },
      );
      if (selected) return selected.tab;
      throw new Error("No browser tab selected.");
    }
    throw new Error("Open a page with Pointee: Open Integrated Browser first. Simple Browser webviews are not supported.");
  }

  async function getPicker(tab?: vscode.BrowserTab): Promise<BrowserPicker> {
    const target = tab ?? await chooseTab();
    lastTab = target;
    const existing = pickers.get(target);
    if (existing) return existing;
    const pending = starting.get(target);
    if (pending) return pending;
    const start = (async () => {
      const session = await target.startCDPSession();
      const cdp = new CDPClient(session);
      const picker = new BrowserPicker(cdp, {
        preferences,
        selection: async snapshot => {
          if (snapshot) history.add(snapshot);
        },
        copy: async (text, snapshot) => {
          if (snapshot) history.add(snapshot);
          await vscode.env.clipboard.writeText(text);
        },
        screenshot: async (data, snapshot) => {
          const directory = vscode.Uri.joinPath(context.globalStorageUri, "screenshots");
          await vscode.workspace.fs.createDirectory(directory);
          const uri = vscode.Uri.joinPath(directory, `element-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
          await vscode.workspace.fs.writeFile(uri, data);
          history.add(snapshot, uri.fsPath);
          await vscode.env.clipboard.writeText(uri.fsPath);
          return uri.fsPath;
        },
        settings: async () => { await vscode.commands.executeCommand("workbench.action.openSettings", "pointee"); },
        store: async values => {
          if (values.inspectorMode) await context.globalState.update("inspectorMode", values.inspectorMode);
        },
        state: () => updateStatus(),
        log: message => output.appendLine(message),
      });
      cdp.onClose(() => {
        if (pickers.get(target) === picker) pickers.delete(target);
        updateStatus();
      });
      try {
        await picker.initialize();
        if (shuttingDown) throw new Error("Pointee is shutting down.");
        pickers.set(target, picker);
        return picker;
      } catch (error) {
        await picker.dispose();
        throw error;
      }
    })();
    starting.set(target, start);
    try { return await start; } finally { starting.delete(target); }
  }

  const register = (name: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`pointee.${name}`, async (...args) => {
      try { return await handler(...args); }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        output.appendLine(message);
        void vscode.window.showErrorMessage(`Pointee: ${message}`);
        return undefined;
      }
    }));
  };
  register("openBrowser", async (providedUrl?: string) => {
    assertAvailable();
    const value = providedUrl ?? await vscode.window.showInputBox({
      prompt: "Page to open in VS Code's integrated browser", value: "http://localhost:3000",
      validateInput: input => validPageUrl(input) ? null : "Enter an http:// or https:// URL.",
    });
    if (!value) return;
    if (!validPageUrl(value)) throw new Error("Enter an http:// or https:// URL.");
    lastTab = await vscode.window.openBrowserTab(value, { viewColumn: vscode.ViewColumn.Beside });
    return lastTab;
  });
  register("togglePicker", async () => (await getPicker()).toggle());
  register("stopPicker", async () => {
    await Promise.all([...pickers.values()].map(picker => picker.stop()));
  });
  register("copySelection", async () => (await getPicker()).copy());
  register("screenshot", async () => (await getPicker()).capture());
  register("selectParent", async () => (await getPicker()).parent());
  register("editSelection", async () => (await getPicker()).edit());
  register("copyRecord", async (record: ContextRecord = history.latest!) => {
    if (!record) throw new Error("Pick an element first.");
    await vscode.env.clipboard.writeText(formatContext(record));
  });
  register("openContext", (record?: ContextRecord) => history.open(record));
  register("exportContext", (record?: ContextRecord, destination?: vscode.Uri) => history.export(record, destination));
  register("openScreenshot", async (record: ContextRecord = history.latest!) => {
    if (!record?.screenshotPath) throw new Error("This context has no screenshot.");
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(record.screenshotPath));
  });
  register("clearHistory", () => history.clear());
  register("settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "pointee"));

  try {
    available = Array.isArray(vscode.window.browserTabs) && typeof vscode.window.openBrowserTab === "function";
    if (available) {
      context.subscriptions.push(
        vscode.window.onDidChangeActiveBrowserTab(tab => {
          if (tab) lastTab = tab;
          updateStatus();
        }),
        vscode.window.onDidCloseBrowserTab(tab => {
          const picker = pickers.get(tab);
          pickers.delete(tab);
          void picker?.dispose().catch(error => output.appendLine(String(error)));
          if (lastTab === tab) lastTab = undefined;
          updateStatus();
        }),
      );
    }
  } catch (error) { output.appendLine(`Browser API unavailable: ${error}`); }

  context.subscriptions.push(
    output, history, tree, status,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("pointee")) {
        for (const picker of pickers.values()) {
          void picker.updatePreferences().catch(error => output.appendLine(String(error)));
        }
      }
    }),
    {
      dispose() {
        shuttingDown = true;
        for (const picker of pickers.values()) {
          void picker.dispose().catch(() => {});
        }
        pickers.clear();
      },
    },
  );
  updateStatus();
  output.appendLine(available ? "Ready. Browser API is available." : API_HELP);
  return {
    version: 1,
    getLatestContext: (): ContextRecord | undefined => history.latest,
    getContexts: (): readonly ContextRecord[] => history.getChildren(),
    getSelectedElement: async (): Promise<ElementSnapshot> => (await getPicker()).snapshot(),
    isBrowserAvailable: () => available,
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}

function validPageUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}
