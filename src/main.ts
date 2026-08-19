import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron'
import { browserChannels } from '#/browser-types.ts'
import type { BrowserAction, BrowserState, ViewBounds } from '#/browser-types.ts'
import { ensureLocalConfig, resolveAppConfig } from '#/local-config.ts'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDirectory, '..')
const configPath = ensureLocalConfig().config
const configUrl = pathToFileURL(configPath).href

async function loadConfig() {
  try {
    return resolveAppConfig((await import(configUrl)).default)
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

function loadTargetInView(targetView: InstanceType<typeof WebContentsView>, address: string) {
  const url = normalizeAddress(address)
  return targetView.webContents.loadURL(url).then(() => url)
}

function loadTarget(address: string) {
  return loadTargetInView(currentPageView(), address)
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

function loadRemoteTarget(address: string, targetView: InstanceType<typeof WebContentsView>) {
  try {
    void loadTargetInView(targetView, address).catch(reportError)
  } catch (error) {
    reportError(error)
  }
}

function loadShell(window: InstanceType<typeof BrowserWindow>) {
  return process.env.VITE_DEV_SERVER_URL
    ? window.loadURL(process.env.VITE_DEV_SERVER_URL)
    : window.loadFile(path.join(projectRoot, 'dist', 'index.html'))
}

function sendNavigationState(
  targetView: InstanceType<typeof WebContentsView>,
  targetWindow: InstanceType<typeof BrowserWindow>,
) {
  if (targetView.webContents.isDestroyed() || targetWindow.isDestroyed()) return
  const history = targetView.webContents.navigationHistory

  const state: BrowserState = {
    url: targetView.webContents.getURL(),
    loading: targetView.webContents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  }
  targetWindow.webContents.send(browserChannels.state, state)
}

async function createWindow() {
  const window = new BrowserWindow({
    ...config.window,
    show: true,
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
  mainWindow = window

  const targetSession = session.fromPartition(config.session.partition, {
    cache: config.session.cache,
  })
  installRequestInterceptor(targetSession)

  const targetView = new WebContentsView({
    webPreferences: {
      partition: config.session.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: config.browser.allowRunningInsecureContent,
    },
  })
  pageView = targetView

  window.contentView.addChildView(targetView)
  targetView.setBackgroundColor(config.window.backgroundColor)

  targetView.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    loadRemoteTarget(url, targetView)
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

  targetView.webContents.on('will-navigate', preventUnsafeNavigation)
  targetView.webContents.on('will-redirect', preventUnsafeNavigation)
  const reportNavigationState = () => sendNavigationState(targetView, window)
  targetView.webContents.on('did-start-loading', reportNavigationState)
  targetView.webContents.on('did-stop-loading', reportNavigationState)
  targetView.webContents.on('did-navigate', reportNavigationState)
  targetView.webContents.on('did-navigate-in-page', reportNavigationState)

  window.on('closed', () => {
    if (!targetView.webContents.isDestroyed()) targetView.webContents.close()
    if (mainWindow === window) {
      mainWindow = null
      pageView = null
    }
  })

  await loadShell(window)
  if (window.isDestroyed()) return

  loadRemoteTarget(config.startUrl, targetView)
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (process.platform === 'darwin' && app.isHidden()) app.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return true
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
  void createWindow().catch(failFast)
  app.on('activate', () => {
    if (!revealMainWindow()) void createWindow().catch(failFast)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
