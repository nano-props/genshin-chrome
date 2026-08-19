# Genshin Chrome

A minimal Electron browser shell driven by a local TypeScript configuration. The interface only contains Back, Forward, Reload, the address bar, and a button that opens the target page's DevTools.

## Setup

```bash
bun install
mkdir -p config
cp config.example.ts config/config.ts
bun run dev
```

The local `config/` directory is ignored by Git. Edit `config/config.ts` to configure the start URL, window dimensions, isolated session, allowed protocols, request rewriting, DevTools mode, and remote debugging port. Set `browser.remoteDebuggingPort` to `null` to disable remote debugging.

To load configuration from a different local directory, set `GENSHIN_CHROME_CONFIG_DIR` to a directory that contains a `config.ts` entry file.

The interface uses Vue 3 with TSX. The Electron main process, preload bridge, and all source files under `src/` are TypeScript. They run using the TypeScript support provided by the Node.js version embedded in Electron.

## Commands

```bash
# Development
bun run dev

# Production build and preview
bun run build
bun run preview

# End-to-end smoke test
bun run test:smoke

# Type-check, format-check, build, and smoke-test
bun run check
```

## Local configuration

The entry file exports a configuration object as an ES module:

```ts
type Request = {
  url: string
  method: string
  resourceType: string
}

const config = {
  startUrl: 'https://example.com',
  // Window, session, and browser options...
  requests: {
    enabled: true,
    rewrite(request: Request) {
      if (!request.url.includes('/api/')) return null
      return { url: request.url.replace('example.com', 'localhost:3000') }
    },
  },
}

export default config
```

The request hook may return:

- `null` to allow the original request.
- `{ url: "..." }` to redirect the request.
- `{ cancel: true }` to block the request.

The request hook is synchronous and the local configuration is fully trusted. There is no validation, fallback, retry, or compatibility layer. Remote pages still run without Node.js integration in a separate, sandboxed Electron session.
