# 原铬（Genshin Chrome）

一个可编程的 Electron 网站调试壳。输入 URL 后，可以浏览目标页面，并通过 JavaScript 规则改写或阻止页面发出的 HTTP 请求。

## 启动

```bash
bun install
bun run dev
```

界面使用 Vue 3 + JSX、Reka UI 和 Tailwind CSS v4 构建，不使用 Vue SFC。

生产构建：

```bash
bun run build
bun run preview
```

## 规则格式

规则必须声明一个同步的 `rewrite(request)` 函数：

```js
function rewrite(request) {
  const url = new URL(request.url);

  if (url.hostname !== "api.example.com") {
    return null;
  }

  url.hostname = "localhost";
  url.port = "3000";
  url.protocol = "http:";

  return { url: url.toString() };
}
```

- 返回 `null`：放行原请求。
- 返回 `{ url: "..." }`：将请求重定向到新 URL。
- 返回 `{ cancel: true }`：阻止请求。

规则在隔离的 Worker 中运行，单次执行限制为 25ms。网页使用独立 Electron Session，并关闭 Node.js 集成。
