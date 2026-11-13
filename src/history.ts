import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { ContextRecord, ElementSnapshot, formatContext } from "./model";

export class ContextHistory implements vscode.TreeDataProvider<ContextRecord>, vscode.Disposable {
  private records: ContextRecord[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  get latest(): ContextRecord | undefined { return this.records[0]; }

  add(snapshot: ElementSnapshot, screenshotPath?: string): ContextRecord {
    const existing = this.latest;
    const reuse = existing?.url === snapshot.url && existing.selector === snapshot.selector;
    const record: ContextRecord = {
      ...snapshot,
      id: reuse ? existing.id : randomUUID(),
      capturedAt: new Date().toISOString(),
      screenshotPath: screenshotPath ?? (reuse && existing.pointer === snapshot.pointer ? existing.screenshotPath : undefined),
    };
    if (reuse) this.records[0] = record;
    else this.records.unshift(record);
    const limit = vscode.workspace.getConfiguration("pointee").get<number>("historyLimit", 20);
    this.records = this.records.slice(0, Math.max(1, Math.min(100, limit)));
    this.refresh();
    return record;
  }

  clear(): void { this.records = []; this.refresh(); }
  private refresh(): void {
    this.changed.fire();
    void vscode.commands.executeCommand("setContext", "pointee.hasContexts", this.records.length > 0);
  }

  getChildren(): ContextRecord[] { return this.records; }
  getTreeItem(record: ContextRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(record.title || record.selector);
    item.id = record.id;
    item.description = new URL(record.url).host || record.url;
    item.tooltip = `${record.selector}\n${record.url}\n${record.capturedAt}`;
    item.iconPath = new vscode.ThemeIcon(record.screenshotPath ? "device-camera" : "symbol-misc");
    item.contextValue = record.screenshotPath ? "pointee.contextWithScreenshot" : "pointee.context";
    item.command = { command: "pointee.openContext", title: "Open Context", arguments: [record] };
    return item;
  }

  async open(record = this.latest): Promise<void> {
    if (!record) throw new Error("Pick an element first.");
    const document = await vscode.workspace.openTextDocument({ content: formatContext(record), language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  async export(record = this.latest, destination?: vscode.Uri): Promise<void> {
    if (!record) throw new Error("Pick an element first.");
    const uri = destination ?? await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), "element-context.md"),
      filters: { Markdown: ["md"] },
      title: "Export Element Context",
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(formatContext(record)));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  dispose(): void { this.changed.dispose(); }
}
