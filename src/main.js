const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session
} = require("electron");

const PARTITION = "persist:genshin-chrome-preview";
const START_URL = "https://example.com";
const DEFAULT_RULE = `function rewrite(request) {
  const url = new URL(request.url);

  if (url.hostname !== "api.example.com") {
    return null;
  }

  url.protocol = "http:";
  url.hostname = "localhost";
  url.port = "3000";

  return { url: url.toString() };
}`;

if (process.env.GENSHIN_CHROME_USER_DATA_DIR) {
  app.setPath("userData", process.env.GENSHIN_CHROME_USER_DATA_DIR);
}

let mainWindow;
let pageView;
let ruleWorker;
let messageId = 0;
let ruleEnabled = true;
let ruleValid = true;
let activeRuleSource = DEFAULT_RULE;
const pendingWorkerCalls = new Map();

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startRuleWorker() {
  ruleWorker = new Worker(path.join(__dirname, "rule-worker.js"));

  ruleWorker.on("message", (message) => {
    const pending = pendingWorkerCalls.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingWorkerCalls.delete(message.id);

    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  });

  ruleWorker.on("error", (error) => {
    emit("rule:status", { valid: false, message: error.message });
  });

  callRuleWorker("compile", { source: activeRuleSource }, 1000).catch((error) => {
    emit("rule:status", { valid: false, message: error.message });
  });
}

function callRuleWorker(type, payload, timeout = 500) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => {
      pendingWorkerCalls.delete(id);
      reject(new Error("规则执行超时"));
    }, timeout);

    pendingWorkerCalls.set(id, { resolve, reject, timer });
    ruleWorker.postMessage({ id, type, ...payload });
  });
}

function normalizeAddress(value) {
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    ? value
    : `https://${value}`;
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("仅支持 HTTP 和 HTTPS 地址");
  }

  return url.toString();
}

function pushRequestLog(details, outcome, rewrittenURL, error) {
  emit("request:log", {
    id: details.id,
    method: details.method,
    resourceType: details.resourceType,
    url: details.url,
    rewrittenURL,
    outcome,
    error,
    time: Date.now()
  });
}

function installRequestInterceptor(targetSession) {
  targetSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    async (details, callback) => {
      if (!ruleEnabled) {
        pushRequestLog(details, "pass");
        callback({});
        return;
      }

      try {
        const result = await callRuleWorker("rewrite", {
          request: {
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            referrer: details.referrer,
            timestamp: details.timestamp
          }
        });

        if (result?.cancel) {
          pushRequestLog(details, "blocked");
          callback({ cancel: true });
          return;
        }

        if (result?.url && result.url !== details.url) {
          const rewrittenURL = normalizeAddress(result.url);
          pushRequestLog(details, "rewritten", rewrittenURL);
          callback({ redirectURL: rewrittenURL });
          return;
        }

        pushRequestLog(details, "pass");
        callback({});
      } catch (error) {
        pushRequestLog(details, "error", undefined, error.message);
        callback({});
      }
    }
  );
}

function sendNavigationState() {
  if (!pageView || pageView.webContents.isDestroyed()) return;

  const history = pageView.webContents.navigationHistory;
  emit("browser:state", {
    url: pageView.webContents.getURL(),
    title: pageView.webContents.getTitle(),
    loading: pageView.webContents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: true,
    backgroundColor: "#10120f",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const targetSession = session.fromPartition(PARTITION, { cache: true });
  installRequestInterceptor(targetSession);

  pageView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.contentView.addChildView(pageView);
  pageView.setBackgroundColor("#f4f1e8");
  pageView.setBounds({ x: 405, y: 128, width: 1011, height: 736 });

  pageView.webContents.setWindowOpenHandler(({ url }) => {
    try {
      pageView.webContents.loadURL(normalizeAddress(url));
    } catch (error) {
      emit("browser:error", { errorDescription: error.message, url });
    }
    return { action: "deny" };
  });

  const preventUnsafeNavigation = (event, url) => {
    try {
      normalizeAddress(url);
    } catch (error) {
      event.preventDefault();
      emit("browser:error", { errorDescription: error.message, url });
    }
  };
  pageView.webContents.on("will-navigate", preventUnsafeNavigation);
  pageView.webContents.on("will-redirect", preventUnsafeNavigation);

  for (const eventName of [
    "did-start-loading",
    "did-stop-loading",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated"
  ]) {
    pageView.webContents.on(eventName, sendNavigationState);
  }

  pageView.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        emit("browser:error", { errorDescription, url: validatedURL });
      }
    }
  );

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  pageView.webContents.loadURL(START_URL);

  mainWindow.on("closed", () => {
    if (pageView && !pageView.webContents.isDestroyed()) {
      pageView.webContents.close();
    }
    mainWindow = null;
    pageView = null;
  });
}

ipcMain.handle("browser:navigate", (_event, address) => {
  const url = normalizeAddress(String(address).trim());
  return pageView.webContents.loadURL(url).then(() => url);
});

ipcMain.on("browser:action", (_event, action) => {
  const history = pageView.webContents.navigationHistory;
  if (action === "back" && history.canGoBack()) history.goBack();
  if (action === "forward" && history.canGoForward()) history.goForward();
  if (action === "reload") pageView.webContents.reload();
  if (action === "stop") pageView.webContents.stop();
  if (action === "devtools") {
    if (pageView.webContents.isDevToolsOpened()) pageView.webContents.closeDevTools();
    else pageView.webContents.openDevTools({ mode: "detach" });
  }
});

ipcMain.on("view:bounds", (_event, bounds) => {
  if (!pageView || pageView.webContents.isDestroyed()) return;

  const safeBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  };
  pageView.setBounds(safeBounds);
});

ipcMain.handle("rule:update", async (_event, payload) => {
  const source = String(payload.source);

  try {
    await callRuleWorker("compile", { source }, 1000);
    activeRuleSource = source;
    ruleValid = true;
    ruleEnabled = Boolean(payload.enabled);
    return {
      valid: true,
      enabled: ruleEnabled,
      message: ruleEnabled ? "规则已启用" : "规则有效，当前已暂停"
    };
  } catch (error) {
    ruleValid = false;
    ruleEnabled = false;
    return { valid: false, enabled: false, message: error.message };
  }
});

ipcMain.handle("rule:toggle", (_event, enabled) => {
  if (enabled && !ruleValid) {
    return {
      valid: false,
      enabled: false,
      message: "请先修复并应用当前规则"
    };
  }

  ruleEnabled = Boolean(enabled);
  return {
    valid: true,
    enabled: ruleEnabled,
    message: ruleEnabled ? "规则已启用" : "规则已暂停"
  };
});

app.whenReady().then(() => {
  startRuleWorker();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (ruleWorker) ruleWorker.terminate();
});
