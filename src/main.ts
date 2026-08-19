import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron'
import type { AppConfig } from '#/config-types.ts'
import { browserChannels } from '#/browser-types.ts'
import type { BrowserAction, BrowserState, ViewBounds } from '#/browser-types.ts'
import { ensureLocalConfig } from '#/local-config.ts'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDirectory, '..')
const appIconPath = path.join(projectRoot, 'resources', 'app-icon.png')
const configPath = ensureLocalConfig().config
const configUrl = pathToFileURL(configPath).href

async function loadConfig() {
  try {
    return (await import(configUrl)).default as AppConfig
  } catch (error) {
    failFast(error)
    throw error
  }
}

const config = await loadConfig()

if (config.browser.remoteDebuggingPort !== null) {
  app.commandLine.appendSwitch('remote-debugging-port', String(config.browser.remoteDebuggingPort))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

if (process.env.GENSHIN_CHROME_USER_DATA_DIR) {
  app.setPath('userData', process.env.GENSHIN_CHROME_USER_DATA_DIR)
}

let mainWindow: InstanceType<typeof BrowserWindow> | null = null
let pageView: InstanceType<typeof WebContentsView> | null = null
const interceptedSessions = new WeakSet<Electron.Session>()

function normalizeAddress(value: string) {
  const trimmed = value.trim()
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(candidate)

  if (!config.browser.allowedProtocols.includes(url.protocol)) {
    throw new Error(`不支持 ${url.protocol} 地址`)
  }

  return url.toString()
}

function installRequestInterceptor(targetSession: Electron.Session) {
  if (!config.requests.enabled || interceptedSessions.has(targetSession)) return
  interceptedSessions.add(targetSession)

  targetSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) => {
      try {
        const result = config.requests.rewrite({
          id: details.id,
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          referrer: details.referrer,
          timestamp: details.timestamp,
        })

        if (result?.cancel) {
          callback({ cancel: true })
          return
        }

        if (result?.url && result.url !== details.url) {
          callback({ redirectURL: normalizeAddress(result.url) })
          return
        }

        callback({})
      } catch (error) {
        failFast(error)
      }
    },
  )
}

function currentPageView() {
  if (!pageView || pageView.webContents.isDestroyed()) {
    throw new Error('浏览器视图尚未准备好')
  }
  return pageView
}

function loadTarget(address: string) {
  const url = normalizeAddress(address)
  return currentPageView()
    .webContents.loadURL(url)
    .then(() => url)
}

function reportError(error: unknown) {
  console.error(error)
}

async function openConfig() {
  const error = await shell.openPath(configPath)
  if (error) throw new Error(error)
}

function failFast(error: unknown) {
  reportError(error)
  app.exit(1)
}

function loadRemoteTarget(address: string) {
  try {
    void loadTarget(address).catch(reportError)
  } catch (error) {
    reportError(error)
  }
}

function loadShell(window: InstanceType<typeof BrowserWindow>) {
  return process.env.VITE_DEV_SERVER_URL
    ? window.loadURL(process.env.VITE_DEV_SERVER_URL)
    : window.loadFile(path.join(projectRoot, 'dist', 'index.html'))
}

function sendNavigationState() {
  if (!pageView || pageView.webContents.isDestroyed()) return
  const history = pageView.webContents.navigationHistory

  const state: BrowserState = {
    url: pageView.webContents.getURL(),
    loading: pageView.webContents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(browserChannels.state, state)
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    ...config.window,
    icon: appIconPath,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.ts'),
      contextIsolation: true,
      nodeIntegration: false,
      // This window only loads the bundled local toolbar. The remote target stays sandboxed below.
      sandbox: false,
    },
  })

  const targetSession = session.fromPartition(config.session.partition, {
    cache: config.session.cache,
  })
  installRequestInterceptor(targetSession)

  pageView = new WebContentsView({
    webPreferences: {
      partition: config.session.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: config.browser.allowRunningInsecureContent,
    },
  })

  mainWindow.contentView.addChildView(pageView)
  pageView.setBackgroundColor(config.window.backgroundColor)

  pageView.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    loadRemoteTarget(url)
    return { action: 'deny' }
  })

  const preventUnsafeNavigation = (event: Electron.Event, url: string) => {
    try {
      normalizeAddress(url)
    } catch (error) {
      event.preventDefault()
      reportError(error)
    }
  }

  pageView.webContents.on('will-navigate', preventUnsafeNavigation)
  pageView.webContents.on('will-redirect', preventUnsafeNavigation)
  pageView.webContents.on('did-start-loading', sendNavigationState)
  pageView.webContents.on('did-stop-loading', sendNavigationState)
  pageView.webContents.on('did-navigate', sendNavigationState)
  pageView.webContents.on('did-navigate-in-page', sendNavigationState)

  mainWindow.on('closed', () => {
    if (pageView && !pageView.webContents.isDestroyed()) pageView.webContents.close()
    mainWindow = null
    pageView = null
  })

  await loadShell(mainWindow)
  await loadTarget(config.startUrl)
  mainWindow.show()
}

ipcMain.handle(browserChannels.navigate, (_event: Electron.IpcMainInvokeEvent, address: unknown) => {
  return loadTarget(String(address))
})

ipcMain.on(browserChannels.action, (_event: Electron.IpcMainEvent, action: BrowserAction) => {
  if (action === 'open-config') {
    void openConfig().catch(failFast)
    return
  }

  const view = currentPageView()
  const history = view.webContents.navigationHistory
  if (action === 'back' && history.canGoBack()) history.goBack()
  if (action === 'forward' && history.canGoForward()) history.goForward()
  if (action === 'reload') view.webContents.reload()
  if (action === 'devtools') {
    if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools()
    else view.webContents.openDevTools({ mode: config.browser.devToolsMode })
  }
})

ipcMain.on(browserChannels.bounds, (_event: Electron.IpcMainEvent, bounds: ViewBounds) => {
  if (!pageView || pageView.webContents.isDestroyed()) return
  pageView.setBounds({
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  })
})

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock!.setIcon(appIconPath)
  void createWindow().catch(failFast)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(failFast)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
