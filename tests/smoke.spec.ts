import fs from 'node:fs'
import { spawn } from 'node:child_process'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = createRequire(import.meta.url)('electron') as string

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
    configDirectory = path.join(temporaryDirectory, 'config')
    fs.mkdirSync(configDirectory)
    fs.writeFileSync(
      path.join(configDirectory, 'config.ts'),
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
          rewrite(request: { url: string }) {
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
        GENSHIN_CHROME_CONFIG_DIR: configDirectory,
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
    await expect(shell.getByLabel('网页地址')).toBeVisible()
    await expect(shell.getByRole('button', { name: '打开调试' })).toBeVisible()
    await expect(shell.locator('button')).toHaveCount(3)
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
})

test('exits with an error when the local configuration is missing', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-chrome-missing-config-'))

  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(electronPath, [projectRoot], {
        cwd: projectRoot,
        env: {
          ...process.env,
          GENSHIN_CHROME_CONFIG_DIR: path.join(temporaryDirectory, 'missing'),
          GENSHIN_CHROME_USER_DATA_DIR: path.join(temporaryDirectory, 'user-data'),
        },
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stderr }))
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
