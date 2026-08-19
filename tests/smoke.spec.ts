import fs from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { ensureLocalConfig, resolveAppConfig, resolveLocalConfigPaths } from '#/local-config.ts'
import { defaultWindowSize, readWindowBounds, writeWindowBounds } from '#/window-state.ts'

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
  let slowStartCompleted = false
  let windowVisibleWhileStartPending = false
  let temporaryDirectory: string
  let configHome: string
  let configDirectory: string
  let userDataDirectory: string
  let windowStateFile: string

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
    await expect(displayedAddress()).toBeVisible()
    await expect(displayedAddress()).toHaveText(`${sourceServer.url}/slow-start`)
    await expect(displayedAddress()).toHaveAttribute(
      'aria-label',
      `编辑网页地址，当前地址：${sourceServer.url}/slow-start`,
    )
    await expect(shell.locator('button')).toHaveCount(6)
    await expect(shell.locator('textarea, [role=switch], aside')).toHaveCount(0)

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

  test('opens the XDG configuration in the default editor', async () => {
    await app.evaluate(({ shell }) => {
      shell.openPath = async (targetPath) => {
        ;(globalThis as typeof globalThis & { openedConfigPath?: string }).openedConfigPath = targetPath
        return ''
      }
    })

    await shell.getByRole('button', { name: '打开配置' }).click()
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { openedConfigPath?: string }).openedConfigPath),
      )
      .toBe(path.join(configDirectory, 'config.js'))
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
