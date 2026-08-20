import fs from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  ensureLocalConfig,
  resolveAppConfig,
  resolveLocalConfigPaths,
  saveLocalConfigSource,
  validateLocalConfigSource,
} from '#/local-config.ts'
import { addRecentPage, MAX_RECENT_PAGES, readRecentPages, recentPageLabel, writeRecentPages } from '#/recent-pages.ts'
import { defaultWindowSize, minimumWindowWidth, readWindowBounds, writeWindowBounds } from '#/window-state.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type TestServer = {
  server: Server
  url: string
  close: () => Promise<void>
}

function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  return new Promise<TestServer>((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      })
    })
  })
}

function html(response: ServerResponse, body: string) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

test.describe('Genshin Chrome smoke tests', () => {
  let app: ElectronApplication
  let shell: Page
  let sourceServer: TestServer
  let replacementServer: TestServer
  let replacementHits = 0
  let pageAHits = 0
  let pageBHits = 0
  let slowStartHits = 0
  let slowStartCompleted = false
  let windowVisibleWhileStartPending = false
  let temporaryDirectory: string
  let configHome: string
  let configDirectory: string
  let userDataDirectory: string
  let windowStateFile: string
  let configEditorWindowStateFile: string

  async function waitForTarget(url: string) {
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, expectedUrl) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.getURL() === expectedUrl && !contents.isLoading()),
          url,
        ),
      )
      .toBe(true)
  }

  function displayedAddress() {
    return shell.getByRole('button', { name: /^编辑网页地址/ })
  }

  async function editAddress() {
    await displayedAddress().click()
    const input = shell.getByLabel('网页地址')
    await expect(input).toBeVisible()
    return input
  }

  test.beforeAll(async () => {
    replacementServer = await startServer((request, response) => {
      if (request.url === '/rewritten') {
        replacementHits += 1
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'application/json',
        })
        response.end(JSON.stringify({ source: 'replacement' }))
        return
      }
      response.writeHead(404).end()
    })

    sourceServer = await startServer((request, response) => {
      if (request.url === '/slow-start') {
        slowStartHits += 1
        setTimeout(() => {
          slowStartCompleted = true
          html(response, '<!doctype html><title>Slow start fixture</title>')
        }, 1_500)
        return
      }
      if (request.url === '/rewrite-page') {
        html(
          response,
          `<!doctype html><title>Rewrite fixture</title><script>
          fetch('/api-data').then(response => response.json()).then(data => {
            document.body.dataset.result = data.source
          })
        </script>`,
        )
        return
      }
      if (request.url === '/page-a' || request.url === '/page-b') {
        if (request.url === '/page-a') pageAHits += 1
        if (request.url === '/page-b') pageBHits += 1
        html(response, `<!doctype html><title>${request.url.slice(1)}</title>`)
        return
      }
      response.writeHead(404).end()
    })

    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-smoke-'))
    configHome = path.join(temporaryDirectory, 'xdg')
    configDirectory = path.join(configHome, 'genshin-chrome')
    fs.mkdirSync(configDirectory, { recursive: true })
    fs.writeFileSync(path.join(configDirectory, 'package.json'), '{"type":"module"}\n')
    fs.writeFileSync(
      path.join(configDirectory, 'config.js'),
      `
      export default {
        startUrl: ${JSON.stringify(`${sourceServer.url}/slow-start`)},
        session: { partition: "persist:genshin-chrome-test", cache: false },
        window: { backgroundColor: "#f5f5f7" },
        browser: {
          allowedProtocols: ["http:", "https:"],
          allowRunningInsecureContent: false,
          devToolsMode: "detach",
          remoteDebuggingPort: null
        },
        requests: {
          enabled: true,
          rewrite(request) {
            if (request.url.endsWith("/api-data")) {
              return { url: ${JSON.stringify(`${replacementServer.url}/rewritten`)} };
            }
            return null;
          }
        }
      };
    `,
    )

    userDataDirectory = path.join(temporaryDirectory, 'user-data')
    windowStateFile = path.join(userDataDirectory, 'state', 'window.json')
    configEditorWindowStateFile = path.join(userDataDirectory, 'state', 'config-editor-window.json')
    writeWindowBounds(windowStateFile, { x: 100, y: 100, width: 900, height: 640 })

    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        GENSHIN_CHROME_USER_DATA_DIR: userDataDirectory,
      },
    })
    await expect
      .poll(() => app.windows().map((page) => page.url()))
      .toEqual(expect.arrayContaining([expect.stringContaining('dist/index.html')]))
    shell = app.windows().find((page) => page.url().includes('dist/index.html'))!
    await shell.waitForLoadState('domcontentloaded')
    windowVisibleWhileStartPending = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().some((window) => window.isVisible())
    })
    await waitForTarget(`${sourceServer.url}/slow-start`)
  })

  test.afterAll(async () => {
    await app?.close()
    await sourceServer?.close()
    await replacementServer?.close()
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  test('keeps only navigation, address, and debugging controls', async () => {
    expect(windowVisibleWhileStartPending).toBe(true)
    expect(slowStartCompleted).toBe(true)
    await expect(shell.getByRole('button', { name: '后退' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '前进' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '刷新' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '打开配置' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '打开调试' })).toBeVisible()
    const inlineReload = shell.locator('.address-control').getByRole('button', { name: '刷新' })
    await expect(inlineReload).toBeVisible()
    await expect(shell.locator('.navigation-controls').getByRole('button', { name: '刷新' })).toHaveCount(0)
    await expect(displayedAddress()).toBeVisible()
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/slow-start`)
    await expect(displayedAddress()).toHaveAttribute(
      'aria-label',
      `编辑网页地址，当前地址：${sourceServer.url}/slow-start`,
    )
    await expect(shell.locator('button')).toHaveCount(6)
    await expect(shell.locator('textarea, [role=switch], aside')).toHaveCount(0)

    await inlineReload.focus()
    await expect(inlineReload).toBeFocused()
    await expect(inlineReload).toHaveCSS('outline-width', '2px')
    await expect(inlineReload).toHaveCSS('outline-offset', '-2px')

    const address = await editAddress()
    await expect(address).toHaveValue(`${sourceServer.url}/slow-start`)
    await address.press('Escape')
    await expect(displayedAddress()).toBeFocused()

    await app.evaluate(({ webContents }, targetUrl) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL() === targetUrl)
      target?.focus()
      target?.sendInputEvent({
        type: 'keyDown',
        keyCode: 'L',
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
      })
    }, `${sourceServer.url}/slow-start`)
    const shortcutAddress = shell.getByLabel('网页地址')
    await expect(shortcutAddress).toBeFocused()
    await shortcutAddress.fill('shortcut draft')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'L',
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
      })
    })
    await expect(shortcutAddress).toHaveValue('shortcut draft')
    await expect
      .poll(() =>
        shortcutAddress.evaluate((element) => {
          const input = element as HTMLInputElement
          return [input.selectionStart, input.selectionEnd]
        }),
      )
      .toEqual([0, 'shortcut draft'.length])
    await shortcutAddress.press('Escape')
  })

  test('restores the existing window when the Dock activates the app', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.isDevToolsOpened())
        ?.minimize()
    })
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isMinimized())),
      )
      .toBe(true)

    await app.evaluate(({ app }) => app.emit('activate', {} as Electron.Event, false))
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible() && !window.isMinimized()),
        ),
      )
      .toBe(true)

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.isDevToolsOpened())
        ?.hide()
    })
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => !window.isVisible())),
      )
      .toBe(true)

    await app.evaluate(({ app }) => app.emit('activate', {} as Electron.Event, false))
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())),
      )
      .toBe(true)

    const hitsBeforeShortcut = slowStartHits
    await shell.evaluate(() => {
      document.documentElement.dataset.shellInstance = 'dock-reload-check'
    })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.isDevToolsOpened())
        ?.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'R',
          modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
        })
    })
    await expect.poll(() => slowStartHits).toBe(hitsBeforeShortcut + 1)
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/slow-start`)
    expect(await shell.evaluate(() => document.documentElement.dataset.shellInstance)).toBe('dock-reload-check')
  })

  test('restores and remembers the window bounds outside config.js', async () => {
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds()))
      .toEqual({ x: 100, y: 100, width: 900, height: 640 })

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 120, y: 140, width: 960, height: 700 }),
    )
    await expect.poll(() => readWindowBounds(windowStateFile)).toEqual({ x: 120, y: 140, width: 960, height: 700 })
  })

  test('keeps the address centered while toolbar spacing contracts smoothly', async () => {
    const originalBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize()[0]))
      .toBe(minimumWindowWidth)

    async function measureToolbar(width: number) {
      await app.evaluate(({ BrowserWindow }, targetWidth) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setBounds({ ...window.getBounds(), width: targetWidth })
      }, width)
      await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(width)

      return shell.evaluate(() => {
        const navigation = document.querySelector('.navigation-controls')!.getBoundingClientRect()
        const lastNavigationButton = document
          .querySelector('.navigation-controls .toolbar-button:last-child')!
          .getBoundingClientRect()
        const address = document.querySelector('.address-control')!.getBoundingClientRect()
        const actions = document.querySelector('.toolbar-actions')!.getBoundingClientRect()

        return {
          addressWidth: address.width,
          centerOffset: (address.left + address.right) / 2 - window.innerWidth / 2,
          leftGap: address.left - lastNavigationButton.right,
          navigationOverflow: lastNavigationButton.right - navigation.right,
          rightGap: actions.left - address.right,
          viewportWidth: window.innerWidth,
        }
      })
    }

    try {
      const measurements = []
      for (const width of [1_100, 900, 761, 760, 700, 650, 640]) measurements.push(await measureToolbar(width))

      for (const measurement of measurements) {
        expect(Math.abs(measurement.centerOffset)).toBeLessThanOrEqual(0.5)
        expect(measurement.leftGap).toBeGreaterThanOrEqual(6)
        expect(measurement.rightGap).toBeGreaterThan(measurement.leftGap)
        expect(measurement.addressWidth).toBeLessThanOrEqual(760)
        expect(Math.abs(measurement.navigationOverflow)).toBeLessThanOrEqual(0.5)
      }

      for (const measurement of measurements.slice(4)) {
        const expectedGap = Math.min(40, Math.max(6, measurement.viewportWidth * 0.04))
        expect(Math.abs(measurement.leftGap - expectedGap)).toBeLessThanOrEqual(0.5)
      }

      for (let index = 1; index < measurements.length; index += 1) {
        expect(measurements[index]!.leftGap).toBeLessThanOrEqual(measurements[index - 1]!.leftGap)
        expect(measurements[index]!.rightGap).toBeLessThanOrEqual(measurements[index - 1]!.rightGap)
      }

      expect(Math.abs(measurements[2]!.leftGap - measurements[3]!.leftGap)).toBeLessThan(1)
      expect(Math.abs(measurements[2]!.rightGap - measurements[3]!.rightGap)).toBeLessThan(1)
    } finally {
      await app.evaluate(
        ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds),
        originalBounds,
      )
    }
  })

  test('navigates, rewrites requests, and opens DevTools', async () => {
    let address = await editAddress()

    await address.fill(`${sourceServer.url}/rewrite-page`)
    await address.press('Enter')
    await waitForTarget(`${sourceServer.url}/rewrite-page`)
    await expect.poll(() => replacementHits).toBe(1)

    const pageAHitsBeforeNavigation = pageAHits
    address = await editAddress()
    await address.fill(`${sourceServer.url}/page-a`)
    await address.press('Enter')
    await expect.poll(() => pageAHits).toBeGreaterThan(pageAHitsBeforeNavigation)
    await waitForTarget(`${sourceServer.url}/page-a`)

    const pageBHitsBeforeNavigation = pageBHits
    address = await editAddress()
    await address.fill(`${sourceServer.url}/page-b`)
    await address.press('Enter')
    await expect.poll(() => pageBHits).toBeGreaterThan(pageBHitsBeforeNavigation)
    await waitForTarget(`${sourceServer.url}/page-b`)
    const pageBHitsBeforeReload = pageBHits
    await shell.getByRole('button', { name: '刷新' }).click()
    await expect.poll(() => pageBHits).toBeGreaterThan(pageBHitsBeforeReload)
    await waitForTarget(`${sourceServer.url}/page-b`)
    await expect(shell.getByRole('button', { name: '后退' })).toBeEnabled()
    await shell.getByRole('button', { name: '后退' }).click()
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/page-a`)
    await expect(shell.getByRole('button', { name: '前进' })).toBeEnabled()
    await shell.getByRole('button', { name: '前进' }).click()
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/page-b`)
    expect(pageBHits).toBeGreaterThan(0)

    address = await editAddress()
    await address.fill('user draft')
    await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-b'))
      await target?.loadURL(url)
    }, `${sourceServer.url}/page-a`)
    await waitForTarget(`${sourceServer.url}/page-a`)
    await expect(address).toHaveValue('user draft')
    await address.blur()
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/page-a`)

    await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-a'))
      await target?.executeJavaScript(`window.open(${JSON.stringify(url)}); true`)
    }, `${sourceServer.url}/page-b`)
    await waitForTarget(`${sourceServer.url}/page-b`)
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/page-b`)

    await app.evaluate(async ({ webContents }) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-b'))
      await target?.executeJavaScript("window.open('mailto:test@example.com'); true")
    })
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/page-b`)

    await shell.getByRole('button', { name: '打开调试' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((contents) => contents.isDevToolsOpened()),
        ),
      )
      .toBe(true)
  })

  test('opens and clears recent pages from the native File menu', async () => {
    const pageAUrl = `${sourceServer.url}/page-a`
    const pageBUrl = `${sourceServer.url}/page-b`

    for (const url of [pageAUrl, pageBUrl]) {
      const address = await editAddress()
      await address.fill(url)
      await address.press('Enter')
      await waitForTarget(url)
    }

    const recentItems = await app.evaluate(({ Menu }) => {
      const recentMenu = Menu.getApplicationMenu()?.getMenuItemById('recent-pages')?.submenu
      return recentMenu?.items.map((item) => ({ label: item.label, toolTip: item.toolTip })) ?? []
    })
    expect(recentItems.slice(0, 2).map((item) => item.toolTip)).toEqual([pageBUrl, pageAUrl])

    await app.evaluate(({ BrowserWindow, Menu }, targetUrl) => {
      const recentMenu = Menu.getApplicationMenu()?.getMenuItemById('recent-pages')?.submenu
      const item = recentMenu?.items.find((candidate) => candidate.toolTip === targetUrl)
      if (!item?.click) throw new Error('Recent page menu item was not found')
      item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent)
    }, pageAUrl)
    await waitForTarget(pageAUrl)
    await expect(displayedAddress()).toHaveText(pageAUrl)

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('clear-recent-pages')
      if (!item?.click) throw new Error('Clear recent pages menu item was not found')
      item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent)
    })
    expect(JSON.parse(fs.readFileSync(path.join(userDataDirectory, 'state', 'recent-pages.json'), 'utf8'))).toEqual([])
    expect(
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          ?.getMenuItemById('recent-pages')
          ?.submenu?.items.map((item) => ({ label: item.label, enabled: item.enabled })),
      ),
    ).toEqual([{ label: '无最近项目', enabled: false }])
  })

  test('edits and validates the XDG configuration in a standalone window', async () => {
    const configPath = path.join(configDirectory, 'config.js')
    const originalSource = fs.readFileSync(configPath, 'utf8')
    expect(await shell.evaluate(() => 'configEditor' in window)).toBe(false)
    await shell.getByRole('button', { name: '打开配置' }).click()

    await expect
      .poll(() => app.windows().map((page) => page.url()))
      .toEqual(expect.arrayContaining([expect.stringContaining('config-editor.html')]))
    const editor = app.windows().find((page) => page.url().includes('config-editor.html'))!
    await editor.waitForLoadState('domcontentloaded')

    expect(await editor.evaluate(() => 'configEditor' in window && !('workbench' in window))).toBe(true)
    await expect(editor.getByRole('heading', { name: '配置编辑器' })).toBeVisible()
    await expect(editor.locator('.config-editor-header p')).toHaveCount(0)
    await expect(editor.getByRole('toolbar', { name: '配置操作' })).toBeVisible()
    const titlePosition = await editor.evaluate(() => {
      const headerBounds = document.querySelector('.config-editor-header')?.getBoundingClientRect()
      const titleBounds = document.querySelector('.config-editor-header h1')?.getBoundingClientRect()
      if (!headerBounds || !titleBounds) throw new Error('Config editor title bar was not found')
      return {
        distanceFromLeft: titleBounds.left - headerBounds.left,
        centerOffset: titleBounds.left + titleBounds.width / 2 - (headerBounds.left + headerBounds.width / 2),
      }
    })
    expect(titlePosition.distanceFromLeft).toBeGreaterThan(120)
    expect(Math.abs(titlePosition.centerOffset)).toBeLessThan(0.5)
    await expect(editor.locator('.cm-content')).toContainText('slow-start')
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const editorWindow = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes('config-editor.html'),
          )
          return Boolean(
            editorWindow &&
            !editorWindow.isModal() &&
            !editorWindow.getParentWindow() &&
            editorWindow.isMinimizable() &&
            !editorWindow.isMaximizable() &&
            !editorWindow.isFullScreenable(),
          )
        }),
      )
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const editorWindow = BrowserWindow.getAllWindows().find((window) => window.getTitle() === '配置编辑器')
      if (!editorWindow) throw new Error('Config editor window was not found')
      editorWindow.setBounds({ x: 140, y: 160, width: 760, height: 560 })
    })
    await expect
      .poll(() => readWindowBounds(configEditorWindowStateFile))
      .toEqual({
        x: 140,
        y: 160,
        width: 760,
        height: 560,
      })
    const editorWindowId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '配置编辑器')
      if (!window) throw new Error('Config editor window was not found')
      const testState = globalThis as typeof globalThis & {
        configEditorFocusCount?: number
        originalConfigEditorFocus?: () => void
      }
      testState.configEditorFocusCount = 0
      testState.originalConfigEditorFocus = window.focus.bind(window)
      window.focus = () => {
        testState.configEditorFocusCount = (testState.configEditorFocusCount ?? 0) + 1
        testState.originalConfigEditorFocus?.()
      }
      window.hide()
      return window.id
    })
    try {
      await shell.getByRole('button', { name: '打开配置' }).click()
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((window) => window.getTitle() === '配置编辑器')
              .map((window) => ({
                id: window.id,
                visible: window.isVisible(),
                focusCalls: (globalThis as typeof globalThis & { configEditorFocusCount?: number })
                  .configEditorFocusCount,
              })),
          ),
        )
        .toEqual([{ id: editorWindowId, visible: true, focusCalls: 1 }])
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        const testState = globalThis as typeof globalThis & {
          configEditorFocusCount?: number
          originalConfigEditorFocus?: () => void
        }
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '配置编辑器')
        if (window && testState.originalConfigEditorFocus) window.focus = testState.originalConfigEditorFocus
        delete testState.configEditorFocusCount
        delete testState.originalConfigEditorFocus
      })
    }

    await app.evaluate(({ BrowserWindow }, windowId) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.id === windowId)
        ?.minimize()
    }, editorWindowId)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, windowId) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.id === windowId)
              ?.isMinimized(),
          editorWindowId,
        ),
      )
      .toBe(true)
    await shell.getByRole('button', { name: '打开配置' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, windowId) => {
          const windows = BrowserWindow.getAllWindows().filter((window) => window.getTitle() === '配置编辑器')
          const window = windows.find((candidate) => candidate.id === windowId)
          return { count: windows.length, minimized: window?.isMinimized(), visible: window?.isVisible() }
        }, editorWindowId),
      )
      .toEqual({ count: 1, minimized: false, visible: true })

    const editorContent = editor.locator('.cm-content')
    await editorContent.click()
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await editor.keyboard.insertText('export default {}')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('config-editor.html'))
        ?.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'R',
          modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
        })
    })
    await expect(editorContent).toContainText('export default {}')
    await editor.getByRole('button', { name: /^保存/ }).click()
    await expect(editor.getByRole('status')).toContainText('config.js 必须配置 startUrl')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalSource)

    await app.evaluate(({ dialog }) => {
      const testState = globalThis as typeof globalThis & {
        configDiscardPromptCount?: number
        originalConfigShowMessageBox?: typeof dialog.showMessageBox
      }
      testState.configDiscardPromptCount = 0
      testState.originalConfigShowMessageBox = dialog.showMessageBox
      dialog.showMessageBox = (async () => {
        testState.configDiscardPromptCount = (testState.configDiscardPromptCount ?? 0) + 1
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    try {
      await editor.getByRole('button', { name: '取消' }).click()
      await expect.poll(() => app.windows().some((page) => page.url().includes('config-editor.html'))).toBe(true)
      await expect
        .poll(() =>
          app.evaluate(
            () => (globalThis as typeof globalThis & { configDiscardPromptCount?: number }).configDiscardPromptCount,
          ),
        )
        .toBe(1)
    } finally {
      await app.evaluate(({ dialog }) => {
        const testState = globalThis as typeof globalThis & {
          configDiscardPromptCount?: number
          originalConfigShowMessageBox?: typeof dialog.showMessageBox
        }
        if (testState.originalConfigShowMessageBox) dialog.showMessageBox = testState.originalConfigShowMessageBox
        delete testState.configDiscardPromptCount
        delete testState.originalConfigShowMessageBox
      })
    }

    const updatedSource = `export default {
  startUrl: ${JSON.stringify(`${sourceServer.url}/page-a`)},
  browser: { remoteDebuggingPort: null },
}
`
    const externalSource = `export default {
  startUrl: ${JSON.stringify(`${sourceServer.url}/page-b`)},
  browser: { remoteDebuggingPort: null },
}
`
    fs.writeFileSync(configPath, externalSource)
    await editorContent.click()
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await editor.keyboard.insertText(updatedSource)
    await expect(editor.getByRole('status')).toContainText('保存前会静态校验语法和可确定的必填项')
    await editor.getByRole('button', { name: /^保存/ }).click()
    await expect(editor.getByRole('status')).toContainText('已被其他程序修改，已重新加载最新内容')
    await expect(editorContent).toContainText('/page-b')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(externalSource)

    await editorContent.click()
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await editor.keyboard.insertText(updatedSource)
    await expect(editor.getByRole('status')).toContainText('保存前会静态校验语法和可确定的必填项')
    await editor.getByRole('button', { name: /^保存/ }).click()

    await expect.poll(() => app.windows().some((page) => page.url().includes('config-editor.html'))).toBe(false)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(updatedSource)

    const unavailableConfigPath = `${configPath}.unavailable`
    fs.renameSync(configPath, unavailableConfigPath)
    try {
      const failedEditorPromise = app.waitForEvent('window')
      await shell.getByRole('button', { name: '打开配置' }).click()
      const failedEditor = await failedEditorPromise
      await failedEditor.waitForLoadState('domcontentloaded')
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (window) => !window.getParentWindow() && window.webContents.getURL().includes('config-editor.html'),
            ),
          ),
        )
        .toBe(true)
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().includes('config-editor.html'))
            ?.getNormalBounds(),
        ),
      ).toEqual({ x: 140, y: 160, width: 760, height: 560 })
      await expect(failedEditor.getByRole('status')).toContainText('ENOENT')
      await expect(failedEditor.getByRole('button', { name: /^保存/ })).toBeDisabled()
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes('config-editor.html'))
          ?.close()
      })
      await expect.poll(() => app.windows().some((page) => page.url().includes('config-editor.html'))).toBe(false)
    } finally {
      fs.renameSync(unavailableConfigPath, configPath)
    }

    const editorHtmlPath = path.join(projectRoot, 'dist', 'config-editor.html')
    const unavailableEditorHtmlPath = `${editorHtmlPath}.unavailable`
    fs.renameSync(editorHtmlPath, unavailableEditorHtmlPath)
    try {
      const failedEditorPromise = app.waitForEvent('window')
      await shell.getByRole('button', { name: '打开配置' }).click()
      const failedEditor = await failedEditorPromise
      await expect.poll(() => failedEditor.isClosed()).toBe(true)
    } finally {
      fs.renameSync(unavailableEditorHtmlPath, editorHtmlPath)
    }

    await shell.getByRole('button', { name: '打开配置' }).click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (window) => !window.getParentWindow() && window.webContents.getURL().includes('config-editor.html'),
          ),
        ),
      )
      .toBe(true)
    const crashedEditorWindowId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === '配置编辑器')
      if (!window) throw new Error('Config editor window was not found')
      window.webContents.forcefullyCrashRenderer()
      return window.id
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) => window.getTitle() === '配置编辑器').length,
        ),
      )
      .toBe(0)
    const recoveredEditorPromise = app.waitForEvent('window')
    await shell.getByRole('button', { name: '打开配置' }).click()
    const recoveredEditor = await recoveredEditorPromise
    await recoveredEditor.waitForLoadState('domcontentloaded')
    await expect(recoveredEditor.getByRole('heading', { name: '配置编辑器' })).toBeVisible()
    await expect(recoveredEditor.locator('.cm-content')).toContainText('/page-a')
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, previousId) =>
            BrowserWindow.getAllWindows()
              .filter((window) => window.getTitle() === '配置编辑器' && window.id !== previousId)
              .map((window) => ({ visible: window.isVisible(), loading: window.webContents.isLoading() })),
          crashedEditorWindowId,
        ),
      )
      .toEqual([{ visible: true, loading: false }])
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === '配置编辑器')
        ?.close()
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) => window.getTitle() === '配置编辑器').length,
        ),
      )
      .toBe(0)
  })
})

test('creates the default ESM configuration once', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-default-config-'))

  try {
    const paths = resolveLocalConfigPaths(temporaryDirectory)
    ensureLocalConfig(paths)
    expect(fs.readFileSync(paths.package, 'utf8')).toContain('"type": "module"')
    expect(fs.readFileSync(paths.config, 'utf8')).toBe("export default {\n  startUrl: 'https://pai.mn/',\n}\n")

    fs.writeFileSync(paths.config, 'export default { custom: true }\n')
    ensureLocalConfig(paths)
    expect(fs.readFileSync(paths.config, 'utf8')).toBe('export default { custom: true }\n')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('validates configuration without executing top-level code', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-config-validation-'))

  try {
    const paths = resolveLocalConfigPaths(temporaryDirectory)
    ensureLocalConfig(paths)
    const source = `throw new Error('must not run while saving')
export default { startUrl: 'https://example.com' }
`

    expect(() => saveLocalConfigSource(source, paths)).not.toThrow()
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(source)
    expect(() => saveLocalConfigSource('export default { startUrl: }', paths)).toThrow()
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(source)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('stores a bounded, deduplicated recent page list with readable labels', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-recent-pages-'))

  try {
    const statePath = path.join(temporaryDirectory, 'state', 'recent-pages.json')
    let pages: string[] = []
    for (let index = 0; index < MAX_RECENT_PAGES + 2; index += 1) {
      pages = addRecentPage(pages, `https://example.com/page-${index}`)
    }
    pages = addRecentPage(pages, 'https://example.com/page-5?token=secret#section')

    expect(pages).toHaveLength(MAX_RECENT_PAGES)
    expect(pages[0]).toBe('https://example.com/page-5')
    expect(new Set(pages).size).toBe(pages.length)
    expect(recentPageLabel('https://example.com/path?query=1#section')).toBe('https://example.com/path')
    expect(recentPageLabel(`https://example.com/${'long/'.repeat(20)}`)).toMatch(/…$/)

    writeRecentPages(statePath, pages)
    expect(readRecentPages(statePath)).toEqual(pages)
    fs.writeFileSync(statePath, '["https://example.com/path?query=1#section"]\n')
    expect(() => readRecentPages(statePath)).toThrow('Invalid recent pages state')
    fs.writeFileSync(statePath, '{"invalid":true}\n')
    expect(() => readRecentPages(statePath)).toThrow('Invalid recent pages state')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('validates startUrl using JavaScript property override order', () => {
  expect(() =>
    validateLocalConfigSource("export default { startUrl: '', startUrl: 'https://example.com' }"),
  ).not.toThrow()
  expect(() => validateLocalConfigSource("export default { startUrl: 'https://example.com', startUrl: '' }")).toThrow(
    'config.js 的 startUrl 必须是非空字符串',
  )
  expect(() => validateLocalConfigSource('export default { startUrl() {} }')).toThrow(
    'config.js 的 startUrl 必须是非空字符串',
  )
  expect(() =>
    validateLocalConfigSource(
      "const defaults = { startUrl: 'https://example.com' }; export default { startUrl: '', ...defaults }",
    ),
  ).not.toThrow()
  expect(() =>
    validateLocalConfigSource(
      "const defaults = { startUrl: 'https://example.com' }; export default { ...defaults, startUrl: '' }",
    ),
  ).toThrow('config.js 的 startUrl 必须是非空字符串')
  expect(() => validateLocalConfigSource("export default { startUrl: '', [1]: true }")).toThrow(
    'config.js 的 startUrl 必须是非空字符串',
  )
  expect(() => validateLocalConfigSource("export default { startUrl: '', [`other`]: true }")).toThrow(
    'config.js 的 startUrl 必须是非空字符串',
  )
  expect(() =>
    validateLocalConfigSource("const key = 'other'; export default { startUrl: '', [key]: true }"),
  ).not.toThrow()
})

test('rejects statically non-object default exports while preserving dynamic configs', () => {
  for (const source of [
    'export default null',
    'export default 42',
    "export default () => ({ startUrl: 'https://example.com' })",
    'export default class Config {}',
    'const config = null; export default config',
  ]) {
    expect(() => validateLocalConfigSource(source)).toThrow('config.js 默认导出必须是对象')
  }

  expect(() =>
    validateLocalConfigSource(
      "const base = { startUrl: 'https://example.com' }; const config = base; export default config",
    ),
  ).not.toThrow()
  expect(() => validateLocalConfigSource('const config = createConfig(); export default config')).not.toThrow()
  expect(() =>
    validateLocalConfigSource("const config = {}; config.startUrl = 'https://example.com'; export default config"),
  ).not.toThrow()
  expect(() =>
    validateLocalConfigSource(
      "const config = { startUrl: 'https://example.com' }; config.startUrl = ''; export default config",
    ),
  ).not.toThrow()
  expect(() =>
    validateLocalConfigSource("let config = null; config = { startUrl: 'https://example.com' }; export default config"),
  ).not.toThrow()
  expect(() => validateLocalConfigSource('function config() {}; export default config')).not.toThrow()
})

test('fills optional config fields from defaults', () => {
  const config = resolveAppConfig({ startUrl: 'https://example.com' })

  expect(config).toMatchObject({
    startUrl: 'https://example.com',
    session: { partition: 'persist:genshin-chrome', cache: true },
    window: {
      backgroundColor: '#f5f5f7',
    },
    browser: {
      allowedProtocols: ['http:', 'https:'],
      allowRunningInsecureContent: false,
      devToolsMode: 'detach',
      remoteDebuggingPort: 9222,
    },
    requests: { enabled: false },
  })
  expect(
    config.requests.rewrite({
      id: 1,
      url: 'https://example.com',
      method: 'GET',
      resourceType: 'mainFrame',
      timestamp: 0,
    }),
  ).toBeNull()
})

test('merges partial config groups without replacing their defaults', () => {
  const rewrite = () => ({ cancel: true })
  const config = resolveAppConfig({
    startUrl: 'https://example.com',
    window: { backgroundColor: '#ffffff' },
    browser: { remoteDebuggingPort: null },
    requests: { enabled: true, rewrite },
  })

  expect(config.window).toEqual({
    backgroundColor: '#ffffff',
  })
  expect(config.browser.remoteDebuggingPort).toBeNull()
  expect(config.browser.allowedProtocols).toEqual(['http:', 'https:'])
  expect(config.requests).toEqual({ enabled: true, rewrite })
})

test('requires a non-empty startUrl', () => {
  expect(() => resolveAppConfig({})).toThrow('config.js 必须配置 startUrl')
  expect(() => resolveAppConfig({ startUrl: '   ' })).toThrow('config.js 的 startUrl 必须是非空字符串')
})

test('validates and atomically stores remembered window bounds', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-window-state-'))
  const statePath = path.join(temporaryDirectory, 'state', 'window.json')

  try {
    expect(readWindowBounds(statePath)).toBeNull()
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, '{ invalid json')
    expect(() => readWindowBounds(statePath)).toThrow('Invalid window state')

    fs.writeFileSync(statePath, 'null')
    expect(() => readWindowBounds(statePath)).toThrow('Invalid window state')

    fs.writeFileSync(statePath, JSON.stringify({ x: 0.5, y: 0, width: 960, height: 640 }))
    expect(() => readWindowBounds(statePath)).toThrow('Invalid window state')

    fs.writeFileSync(statePath, JSON.stringify({ x: 0, y: 0, width: 0, height: 640 }))
    expect(() => readWindowBounds(statePath)).toThrow('Invalid window state')

    writeWindowBounds(statePath, { x: -1440, y: 0, width: 1440, height: 900 })
    expect(readWindowBounds(statePath)).toEqual({ x: -1440, y: 0, width: 1440, height: 900 })
    expect(defaultWindowSize).toEqual({ width: 960, height: 640 })
    expect(fs.readdirSync(path.dirname(statePath))).toEqual(['window.json'])
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
