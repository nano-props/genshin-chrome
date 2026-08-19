import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BrowserState } from '#/browser-types.ts'

const ChevronLeft = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m12.3 4.4-5.5 5.6 5.5 5.6" />
  </svg>
)

const ChevronRight = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m7.7 4.4 5.5 5.6-5.5 5.6" />
  </svg>
)

const Reload = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M15.4 7.2A6 6 0 1 0 16 11" />
    <path d="M15.4 3.8v3.8h-3.8" />
  </svg>
)

const Wrench = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M11.9 4.3a4 4 0 0 0-4.8 5.1l-4 4a1.7 1.7 0 0 0 2.4 2.4l4-4a4 4 0 0 0 5.1-4.8l-2.3 2.3-1.7-.4-.4-1.7 2.3-2.3a4 4 0 0 0-.6-.6Z" />
  </svg>
)

const IconButton = defineComponent({
  props: {
    label: { type: String, required: true },
    disabled: Boolean,
  },
  emits: ['press'],
  setup(props, { emit, slots }) {
    return () => (
      <button
        class="toolbar-button"
        type="button"
        aria-label={props.label}
        title={props.label}
        disabled={props.disabled}
        onClick={() => emit('press')}
      >
        {slots.default?.()}
      </button>
    )
  },
})

export default defineComponent({
  name: 'BrowserShell',
  setup() {
    const currentUrl = ref('')
    const draft = ref('')
    const editingAddress = ref(false)
    const loading = ref(false)
    const canGoBack = ref(false)
    const canGoForward = ref(false)
    const viewport = ref<HTMLElement | null>(null)
    const cleanup: Array<() => void> = []
    let resizeObserver: ResizeObserver | undefined

    function updateViewportBounds() {
      if (!viewport.value) return
      const rect = viewport.value.getBoundingClientRect()
      window.workbench.updateViewBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }

    async function navigate(event: Event) {
      event.preventDefault()
      await window.workbench.navigate(draft.value)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }

    function handleKeyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        const input = document.querySelector<HTMLInputElement>('#address-input')
        input?.focus()
        input?.select()
      }
    }

    onMounted(() => {
      cleanup.push(
        window.workbench.onBrowserState((state: BrowserState) => {
          currentUrl.value = state.url
          if (!editingAddress.value && state.url) draft.value = state.url
          loading.value = state.loading
          canGoBack.value = state.canGoBack
          canGoForward.value = state.canGoForward
        }),
      )

      resizeObserver = new ResizeObserver(updateViewportBounds)
      if (viewport.value) resizeObserver.observe(viewport.value)
      window.addEventListener('resize', updateViewportBounds)
      document.addEventListener('keydown', handleKeyboard)
      requestAnimationFrame(updateViewportBounds)
    })

    onBeforeUnmount(() => {
      cleanup.forEach((unsubscribe) => unsubscribe())
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateViewportBounds)
      document.removeEventListener('keydown', handleKeyboard)
    })

    return () => (
      <div class="browser-shell">
        <header class="toolbar">
          <nav class="navigation-controls no-drag" aria-label="浏览器导航">
            <IconButton label="后退" disabled={!canGoBack.value} onPress={() => window.workbench.browserAction('back')}>
              <ChevronLeft />
            </IconButton>
            <IconButton
              label="前进"
              disabled={!canGoForward.value}
              onPress={() => window.workbench.browserAction('forward')}
            >
              <ChevronRight />
            </IconButton>
            <IconButton label="刷新" onPress={() => window.workbench.browserAction('reload')}>
              <Reload />
            </IconButton>
          </nav>

          <form class={['address-field no-drag', loading.value && 'is-loading']} onSubmit={navigate}>
            <input
              id="address-input"
              value={draft.value}
              aria-label="网页地址"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              onInput={(event) => (draft.value = (event.target as HTMLInputElement).value)}
              onFocus={(event) => {
                editingAddress.value = true
                ;(event.target as HTMLInputElement).select()
              }}
              onBlur={() => {
                editingAddress.value = false
                draft.value = currentUrl.value
              }}
            />
            <span class="loading-line" aria-hidden="true" />
          </form>

          <div class="debug-control no-drag">
            <IconButton label="打开调试" onPress={() => window.workbench.browserAction('devtools')}>
              <Wrench />
            </IconButton>
          </div>
        </header>

        <main ref={viewport} class="viewport" />
      </div>
    )
  },
})
