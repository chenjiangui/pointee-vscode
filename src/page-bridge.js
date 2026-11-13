(function installPointee(config) {
  "use strict";
  if (globalThis.__pointeeVSCode) {
    globalThis.__pointeeVSCode.preferences(config.preferences);
    return;
  }
  const pending = new Map();
  const messageListeners = new Set();
  const storageListeners = new Set();
  const stored = { ...config.preferences };
  let nextId = 0;
  let api;

  function request(type, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("VS Code did not respond. Restart the picker."));
      }, type === "SCREENSHOT" ? 120000 : 20000);
      pending.set(id, { resolve, reject, timer });
      globalThis[config.binding](JSON.stringify({ id, type, ...data }));
    });
  }

  const pointee = {
    changed() {
      if (!api) return;
      const snapshot = api.snapshot();
      request("SELECTION", { snapshot }).catch(() => {});
    },
    screenshot: () => request("SCREENSHOT", { snapshot: api.snapshot() }),
  };
  const chrome = {
    runtime: {
      getURL: path => `pointee-vscode://${path}`,
      onMessage: { addListener: listener => messageListeners.add(listener) },
      sendMessage: message => request(message.type, message),
    },
    storage: {
      local: {
        get(keys, callback) {
          const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(stored);
          const values = Object.fromEntries(names.filter(key => key in stored).map(key => [key, stored[key]]));
          if (callback) queueMicrotask(() => callback(values));
          return Promise.resolve(values);
        },
        set(values) {
          Object.assign(stored, values);
          return request("STORE", { values });
        },
      },
      onChanged: { addListener: listener => storageListeners.add(listener) },
    },
  };
  const navigator = {
    clipboard: {
      writeText: text => request("COPY_TEXT", {
        text,
        snapshot: text.includes("# ") ? api.snapshot() : undefined,
      }),
    },
  };

  // The upstream scripts are enclosed in this isolated-world lexical scope.
  /* __POINTEE_RAIL__ */
  /* __POINTEE_CONTENT__ */
})
