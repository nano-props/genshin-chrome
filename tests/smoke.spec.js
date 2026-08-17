const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect, _electron: electron } = require("@playwright/test");

const projectRoot = path.resolve(__dirname, "..");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function html(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

test.describe("原铬核心功能冒烟测试", () => {
  let app;
  let shell;
  let sourceServer;
  let replacementServer;
  let replacementHits = 0;
  let blockedOriginHits = 0;
  let passOriginHits = 0;
  let pageBHits = 0;
  let userDataDirectory;

  test.beforeAll(async () => {
    replacementServer = await startServer((request, response) => {
      if (request.url === "/rewritten") {
        replacementHits += 1;
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "content-type": "application/json"
        });
        response.end(JSON.stringify({ source: "replacement" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    sourceServer = await startServer((request, response) => {
      if (request.url === "/rewrite-page") {
        html(response, `<!doctype html><title>Rewrite fixture</title><script>
          fetch('/api-data').then(r => r.json()).then(data => {
            document.body.dataset.result = data.source
          })
        </script>`);
        return;
      }

      if (request.url === "/blocked-page") {
        html(response, `<!doctype html><title>Block fixture</title><script>
          fetch('/block-me').catch(() => { document.body.dataset.blocked = 'true' })
        </script>`);
        return;
      }

      if (request.url === "/pass-page") {
        html(response, `<!doctype html><title>Pass fixture</title><script>
          fetch('/pass-me').then(() => { document.body.dataset.passed = 'true' })
        </script>`);
        return;
      }

      if (request.url === "/block-me") {
        blockedOriginHits += 1;
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.url === "/pass-me") {
        passOriginHits += 1;
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.url === "/page-a" || request.url === "/page-b") {
        if (request.url === "/page-b") pageBHits += 1;
        html(response, `<!doctype html><title>${request.url.slice(1)}</title>`);
        return;
      }

      response.writeHead(404);
      response.end();
    });

    userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "genshin-chrome-smoke-"));
    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        GENSHIN_CHROME_USER_DATA_DIR: userDataDirectory
      }
    });
    await expect.poll(() => app.windows().map((page) => page.url())).toEqual(
      expect.arrayContaining([expect.stringContaining("dist/index.html")])
    );
    shell = app.windows().find((page) => page.url().includes("dist/index.html"));
    await shell.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app?.close();
    await sourceServer?.close();
    await replacementServer?.close();
    if (userDataDirectory) {
      fs.rmSync(userDataDirectory, { recursive: true, force: true });
    }
  });

  test("导航、改写、阻止、暂停和错误反馈均可工作", async () => {
    const address = shell.getByLabel("网页地址");
    const editor = shell.getByLabel("JavaScript 请求改写规则");
    const applyButton = shell.getByRole("button", { name: /应用规则/ });
    const ruleSwitch = shell.getByRole("switch", { name: "启用请求改写规则" });

    await expect(address).toBeVisible();
    await expect(editor).toBeVisible();
    await expect(shell.getByRole("button", { name: /DEVTOOLS/ })).toBeVisible();
    await expect(ruleSwitch).toBeChecked();

    await editor.fill(`function rewrite(request) {
      if (request.url.includes('/api-data')) {
        return { url: '${replacementServer.url}/rewritten' };
      }
      return null;
    }`);
    await applyButton.click();
    await expect(shell.getByText("规则已启用", { exact: true })).toBeVisible();

    await address.fill(`${sourceServer.url}/rewrite-page`);
    await address.press("Enter");
    await expect.poll(() => replacementHits).toBe(1);
    await expect(shell.getByText("REROUTE").first()).toBeVisible();

    await editor.fill(`function rewrite(request) {
      if (request.url.includes('/block-me')) return { cancel: true };
      return null;
    }`);
    await applyButton.click();
    await address.fill(`${sourceServer.url}/blocked-page`);
    await address.press("Enter");
    await expect(shell.getByText("blocked", { exact: true }).first()).toBeVisible();
    expect(blockedOriginHits).toBe(0);

    await ruleSwitch.click();
    await expect(ruleSwitch).not.toBeChecked();
    await expect(shell.getByText("规则已暂停", { exact: true })).toBeVisible();
    await address.fill(`${sourceServer.url}/pass-page`);
    await address.press("Enter");
    await expect.poll(() => passOriginHits).toBe(1);

    await address.fill(`${sourceServer.url}/page-a`);
    await address.press("Enter");
    await address.fill(`${sourceServer.url}/page-b`);
    await address.press("Enter");
    await expect(shell.getByRole("button", { name: "后退" })).toBeEnabled();
    await shell.getByRole("button", { name: "后退" }).click();
    await expect(address).toHaveValue(`${sourceServer.url}/page-a`);
    await expect(shell.getByRole("button", { name: "前进" })).toBeEnabled();
    await shell.getByRole("button", { name: "前进" }).click();
    await expect(address).toHaveValue(`${sourceServer.url}/page-b`);
    await shell.getByRole("button", { name: "刷新" }).click();
    await expect.poll(() => pageBHits).toBe(2);

    const devtoolsButton = shell.getByRole("button", { name: /DEVTOOLS/ });
    await devtoolsButton.click();
    await expect.poll(() => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((contents) => contents.isDevToolsOpened())
    )).toBe(true);
    await devtoolsButton.click();
    await expect.poll(() => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((contents) => contents.isDevToolsOpened())
    )).toBe(false);

    await editor.fill("function rewrite(");
    await applyButton.click();
    await expect(shell.getByText(/SyntaxError/)).toBeVisible();
    await expect(ruleSwitch).not.toBeChecked();
    await ruleSwitch.click();
    await expect(ruleSwitch).not.toBeChecked();
    await expect(shell.getByText("请先修复并应用当前规则", { exact: true })).toBeVisible();
  });
});
