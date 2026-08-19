export type RewriteRequest = {
  id: number
  url: string
  method: string
  resourceType: string
  referrer?: string
  timestamp: number
}

export type RewriteResult = null | undefined | { url?: string; cancel?: boolean }

export type AppConfig = {
  startUrl: string
  session: { partition: string; cache: boolean }
  window: {
    width: number
    height: number
    minWidth: number
    minHeight: number
    backgroundColor: string
  }
  browser: {
    allowedProtocols: string[]
    allowRunningInsecureContent: boolean
    devToolsMode: 'right' | 'bottom' | 'undocked' | 'detach'
    remoteDebuggingPort: number | null
  }
  requests: {
    enabled: boolean
    rewrite: (request: RewriteRequest) => RewriteResult
  }
}
