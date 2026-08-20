import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, session } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { browserChannels } from '#/browser-types.ts'
import type { BrowserAction, BrowserState, ViewBounds } from '#/browser-types.ts'
import { createConfigEditorController } from '#/config-editor.ts'
import { commandShortcutKey } from '#/keyboard-shortcuts.ts'
import { ensureLocalConfig, resolveAppConfig } from '#/local-config.ts'
import { addRecentPage, readRecentPages, recentPageLabel, writeRecentPages } from '#/recent-pages.ts'
import { defaultWindowSize, minimumWindowWidth, readWindowBounds, trackWindowBounds } from '#/window-state.ts'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDirectory, '..')
const configPaths = ensureLocalConfig()
const configPath = configPaths.config
const configUrl = pathToFileURL(configPath).href
const configEditor = createConfigEditorController({
  configPaths,
  preloadPath: path.join(currentDirectory, 'config-editor-preload.ts'),
  rendererDirectory: path.join(projectRoot, 'dist'),
  devServerUrl: process.env.VITE_DEV_SERVER_URL,
  windowStatePath: () => path.join(app.getPath('userData'), 'state', 'config-editor-window.json'),
})

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
let recentPages: string[] = []
const interceptedSessions = new WeakSet<Electron.Session>()

function windowStatePath() {
  return path.join(app.getPath('userData'), 'state', 'window.json')
}

function recentPagesStatePath() {
  return path.join(app.getPath('userData'), 'state', 'recent-pages.json')
}

function initialWindowOptions() {
  return readWindowBounds(windowStatePath()) ?? defaultWindowSize
}

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

function recentPagesSubmenu(): MenuItemConstructorOptions[] {
  if (!recentPages.length) return [{ label: '无最近项目', enabled: false }]

  return [
    ...recentPages.map((url, index): MenuItemConstructorOptions => ({
      id: `recent-page-${index}`,
      label: recentPageLabel(url),
      toolTip: url,
      click: () => openRecentPage(url),
    })),
    { type: 'separator' },
    {
      id: 'clear-recent-pages',
      label: '清除菜单',
      click: () => {
        recentPages = []
        try {
          writeRecentPages(recentPagesStatePath(), recentPages)
        } catch (error) {
          reportError(error)
        }
        installApplicationMenu()
      },
    },
  ]
}

function reloadCurrentPage(ignoreCache = false) {
  if (!pageView || pageView.webContents.isDestroyed()) return
  if (ignoreCache) pageView.webContents.reloadIgnoringCache()
  else pageView.webContents.reload()
}

function installApplicationMenu() {
  const template: MenuItemConstructorOptions[] = []
  if (process.platform === 'darwin') template.push({ role: 'appMenu' })
  template.push(
    {
      label: '文件',
      submenu: [
        { id: 'recent-pages', label: '最近打开', submenu: recentPagesSubmenu() },
        { type: 'separator' },
        {
          id: 'copy-config-path',
          label: '复制配置路径',
          click: () => clipboard.writeText(configPaths.directory),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '显示',
      submenu: [
        { label: '重新加载页面', accelerator: 'CmdOrCtrl+R', click: () => reloadCurrentPage() },
        {
          label: '强制重新加载页面',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => reloadCurrentPage(true),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function recordRecentPage(url: string) {
  try {
    const parsed = new URL(url)
    if (!config.browser.allowedProtocols.includes(parsed.protocol)) return
    const nextPages = addRecentPage(recentPages, parsed.href)
    if (nextPages.every((page, index) => page === recentPages[index])) return
    recentPages = nextPages
    installApplicationMenu()
    try {
      writeRecentPages(recentPagesStatePath(), recentPages)
    } catch (error) {
      reportError(error)
    }
  } catch (error) {
    reportError(error)
  }
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

function installBrowserShortcuts(
  contents: Electron.WebContents,
  targetWindow: InstanceType<typeof BrowserWindow>,
  targetView: InstanceType<typeof WebContentsView>,
) {
  contents.on('before-input-event', (event, input) => {
    const shortcut = commandShortcutKey(input)
    if (shortcut !== 'l' && shortcut !== 'r') return

    event.preventDefault()
    if (shortcut === 'l') targetWindow.webContents.send(browserChannels.editAddress)
    if (shortcut === 'r' && !targetView.webContents.isDestroyed()) targetView.webContents.reload()
  })
}

async function createWindow(initialAddress = config.startUrl) {
  const initialOptions = initialWindowOptions()
  const window = new BrowserWindow({
    backgroundColor: config.window.backgroundColor,
    ...initialOptions,
    minWidth: minimumWindowWidth,
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
  installBrowserShortcuts(window.webContents, window, targetView)
  installBrowserShortcuts(targetView.webContents, window, targetView)

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
  targetView.webContents.on('did-navigate', (_event, url) => {
    reportNavigationState()
    recordRecentPage(url)
  })
  targetView.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    reportNavigationState()
    if (isMainFrame) recordRecentPage(url)
  })

  trackWindowBounds(window, windowStatePath(), reportError)

  window.on('closed', () => {
    if (!targetView.webContents.isDestroyed()) targetView.webContents.close()
    if (mainWindow === window) {
      mainWindow = null
      pageView = null
    }
  })

  await loadShell(window)
  if (window.isDestroyed()) return

  loadRemoteTarget(initialAddress, targetView)
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (process.platform === 'darwin' && app.isHidden()) app.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return true
}

function openRecentPage(url: string) {
  if (!revealMainWindow()) {
    void createWindow(url).catch(reportError)
    return
  }
  loadRemoteTarget(url, currentPageView())
}

ipcMain.handle(browserChannels.navigate, (_event: Electron.IpcMainInvokeEvent, address: unknown) => {
  return loadTarget(String(address))
})

ipcMain.on(browserChannels.action, (_event: Electron.IpcMainEvent, action: BrowserAction) => {
  if (action === 'open-config') {
    void configEditor.open().catch(reportError)
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
  try {
    recentPages = readRecentPages(recentPagesStatePath())
  } catch (error) {
    reportError(error)
  }
  installApplicationMenu()
  void createWindow().catch(failFast)
  app.on('activate', () => {
    if (!revealMainWindow()) void createWindow().catch(failFast)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
