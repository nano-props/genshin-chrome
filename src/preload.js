const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("workbench", {
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  browserAction: (action) => ipcRenderer.send("browser:action", action),
  updateViewBounds: (bounds) => ipcRenderer.send("view:bounds", bounds),
  updateRule: (payload) => ipcRenderer.invoke("rule:update", payload),
  toggleRule: (enabled) => ipcRenderer.invoke("rule:toggle", enabled),
  onBrowserState: (listener) => subscribe("browser:state", listener),
  onBrowserError: (listener) => subscribe("browser:error", listener),
  onRequestLog: (listener) => subscribe("request:log", listener),
  onRuleStatus: (listener) => subscribe("rule:status", listener)
});
