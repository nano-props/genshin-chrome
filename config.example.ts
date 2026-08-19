import type { AppConfig, RewriteRequest } from '#/config-types.ts'

const config = {
  startUrl: 'https://example.com',
  session: {
    partition: 'persist:genshin-chrome-preview',
    cache: true,
  },
  window: {
    width: 1280,
    height: 820,
    minWidth: 680,
    minHeight: 480,
    backgroundColor: '#f5f5f7',
  },
  browser: {
    allowedProtocols: ['http:', 'https:'],
    allowRunningInsecureContent: false,
    devToolsMode: 'detach' as const,
    remoteDebuggingPort: 9222,
  },
  requests: {
    enabled: true,
    rewrite(request: RewriteRequest) {
      const url = new URL(request.url)
      if (url.hostname !== 'api.example.com') return null
      url.protocol = 'http:'
      url.hostname = 'localhost'
      url.port = '3000'
      return { url: url.toString() }
    },
  },
} satisfies AppConfig

export default config
