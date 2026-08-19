export const browserChannels = {
  navigate: 'browser:navigate',
  action: 'browser:action',
  bounds: 'view:bounds',
  state: 'browser:state',
} as const

export type BrowserAction = 'back' | 'forward' | 'devtools'

export type BrowserState = {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type ViewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type Workbench = {
  navigate(url: string): Promise<string>
  browserAction(action: BrowserAction): void
  updateViewBounds(bounds: ViewBounds): void
  onBrowserState(listener: (state: BrowserState) => void): () => void
}
