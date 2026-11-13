export interface Disposable { dispose(): void; }

export interface CDPTransport {
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  onDidClose(listener: () => void): Disposable;
  sendMessage(message: unknown): PromiseLike<void>;
  close(): PromiseLike<void>;
}

export interface CDPEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

export class CDPClient {
  private nextId = 0;
  private pending = new Map<number, {
    resolve(value: any): void;
    reject(reason: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(event: CDPEvent) => void>();
  private closedListeners = new Set<() => void>();
  private subscriptions: Disposable[];
  private closed = false;
  pageSessionId?: string;
  browserSessionId?: string;

  constructor(private readonly transport: CDPTransport, private readonly timeout = 15_000) {
    this.subscriptions = [
      transport.onDidReceiveMessage(message => this.receive(message)),
      transport.onDidClose(() => this.finish()),
    ];
  }

  onEvent(listener: (event: CDPEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  onClose(listener: () => void): Disposable {
    this.closedListeners.add(listener);
    return { dispose: () => this.closedListeners.delete(listener) };
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId = this.pageSessionId): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser session is closed."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.transport.sendMessage({
        id, method, params, ...(sessionId ? { sessionId } : {}),
      })).catch(error => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async attach(): Promise<void> {
    // VS Code's channel starts at a tab-scoped browser target, not a page target.
    const browser = await this.send<{ sessionId: string }>("Target.attachToBrowserTarget");
    this.browserSessionId = browser.sessionId;
    const targets = await this.send<{ targetInfos: { targetId: string; type: string }[] }>(
      "Target.getTargets", {}, browser.sessionId,
    );
    const page = targets.targetInfos.find(target => target.type === "page");
    if (!page) throw new Error("No page target in this integrated browser tab.");
    const attached = await this.send<{ sessionId: string }>(
      "Target.attachToTarget", { targetId: page.targetId, flatten: true }, browser.sessionId,
    );
    this.pageSessionId = attached.sessionId;
    await Promise.all([this.send("Page.enable"), this.send("Runtime.enable"), this.send("DOM.enable")]);
  }

  async evaluate<T = unknown>(expression: string, contextId?: number): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
      ...(contextId !== undefined ? { contextId } : {}),
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value as T;
  }

  private receive(raw: unknown): void {
    let message: any = raw;
    if (typeof message === "string") {
      try { message = JSON.parse(message); } catch { return; }
    }
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP request failed"));
      else pending.resolve(message.result);
    } else if (typeof message.method === "string") {
      for (const listener of this.listeners) listener({
        method: message.method, params: message.params ?? {}, sessionId: message.sessionId,
      });
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser session closed."));
    }
    this.pending.clear();
    for (const listener of this.closedListeners) listener();
    this.listeners.clear();
    this.closedListeners.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.finish();
    await this.transport.close();
  }
}
