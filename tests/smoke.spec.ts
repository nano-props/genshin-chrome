import fs from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { ensureLocalConfig, resolveLocalConfigPaths } from '#/local-config.ts'

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
  let temporaryDirectory: string
  let configHome: string
  let configDirectory: string

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
        startUrl: ${JSON.stringify(`${sourceServer.url}/page-a`)},
        session: { partition: "persist:genshin-chrome-test", cache: false },
        window: { width: 900, height: 640, minWidth: 680, minHeight: 480, backgroundColor: "#f5f5f7" },
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

    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        GENSHIN_CHROME_USER_DATA_DIR: path.join(temporaryDirectory, 'user-data'),
      },
    })
    await expect
      .poll(() => app.windows().map((page) => page.url()))
      .toEqual(expect.arrayContaining([expect.stringContaining('dist/index.html')]))
    shell = app.windows().find((page) => page.url().includes('dist/index.html'))!
    await shell.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app?.close()
    await sourceServer?.close()
    await replacementServer?.close()
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  test('keeps only navigation, address, and debugging controls', async () => {
    await expect(shell.getByRole('button', { name: '后退' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '前进' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '刷新' })).toBeVisible()
    await expect(shell.getByRole('button', { name: '打开配置' })).toBeVisible()
    await expect(shell.getByLabel('网页地址')).toBeVisible()
    await expect(shell.getByRole('button', { name: '打开调试' })).toBeVisible()
    await expect(shell.locator('button')).toHaveCount(5)
    await expect(shell.locator('textarea, [role=switch], aside')).toHaveCount(0)
    await expect(shell.getByLabel('网页地址')).toHaveValue(`${sourceServer.url}/page-a`)
  })

  test('navigates, rewrites requests, and opens DevTools', async () => {
    const address = shell.getByLabel('网页地址')

    await address.fill(`${sourceServer.url}/rewrite-page`)
    await address.press('Enter')
    await waitForTarget(`${sourceServer.url}/rewrite-page`)
    await expect.poll(() => replacementHits).toBe(1)

    const pageAHitsBeforeNavigation = pageAHits
    await address.fill(`${sourceServer.url}/page-a`)
    await address.press('Enter')
    await expect.poll(() => pageAHits).toBeGreaterThan(pageAHitsBeforeNavigation)
    await waitForTarget(`${sourceServer.url}/page-a`)

    const pageBHitsBeforeNavigation = pageBHits
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
    await expect(address).toHaveValue(`${sourceServer.url}/page-a`)
    await expect(shell.getByRole('button', { name: '前进' })).toBeEnabled()
    await shell.getByRole('button', { name: '前进' }).click()
    await expect(address).toHaveValue(`${sourceServer.url}/page-b`)
    expect(pageBHits).toBeGreaterThan(0)

    await address.fill('user draft')
    await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-b'))
      await target?.loadURL(url)
    }, `${sourceServer.url}/page-a`)
    await waitForTarget(`${sourceServer.url}/page-a`)
    await expect(address).toHaveValue('user draft')
    await address.blur()
    await expect(address).toHaveValue(`${sourceServer.url}/page-a`)

    await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-a'))
      await target?.executeJavaScript(`window.open(${JSON.stringify(url)}); true`)
    }, `${sourceServer.url}/page-b`)
    await waitForTarget(`${sourceServer.url}/page-b`)
    await expect(address).toHaveValue(`${sourceServer.url}/page-b`)

    await app.evaluate(async ({ webContents }) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/page-b'))
      await target?.executeJavaScript("window.open('mailto:test@example.com'); true")
    })
    await expect(address).toHaveValue(`${sourceServer.url}/page-b`)
    await expect(shell.getByLabel('网页地址')).toBeVisible()

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
    expect(fs.readFileSync(paths.config, 'utf8')).toContain('export default')

    fs.writeFileSync(paths.config, 'export default { custom: true }\n')
    ensureLocalConfig(paths)
    expect(fs.readFileSync(paths.config, 'utf8')).toBe('export default { custom: true }\n')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
