import { ChevronLeft, ChevronRight, RotateCw, SlidersHorizontal, Wrench } from '@lucide/vue'
import { defineComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BrowserState } from '#/browser-types.ts'

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
    const addressButton = ref<HTMLButtonElement | null>(null)
    const addressInput = ref<HTMLInputElement | null>(null)
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
      draft.value = await window.workbench.navigate(draft.value)
      editingAddress.value = false
    }

    function editAddress() {
      if (!editingAddress.value) {
        draft.value = currentUrl.value
        editingAddress.value = true
      }
      void nextTick(() => {
        addressInput.value?.focus()
        addressInput.value?.select()
      })
    }

    function closeAddressEditor(restoreButtonFocus = false) {
      draft.value = currentUrl.value
      editingAddress.value = false
      if (restoreButtonFocus) void nextTick(() => addressButton.value?.focus())
    }

    onMounted(() => {
      cleanup.push(
        window.workbench.onEditAddress(editAddress),
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
      requestAnimationFrame(updateViewportBounds)
    })

    onBeforeUnmount(() => {
      cleanup.forEach((unsubscribe) => unsubscribe())
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateViewportBounds)
    })

    return () => (
      <div class="browser-shell">
        <header class="toolbar">
          <nav class="navigation-controls no-drag" aria-label="浏览器导航">
            <IconButton label="后退" disabled={!canGoBack.value} onPress={() => window.workbench.browserAction('back')}>
              <ChevronLeft aria-hidden="true" />
            </IconButton>
            <IconButton
              label="前进"
              disabled={!canGoForward.value}
              onPress={() => window.workbench.browserAction('forward')}
            >
              <ChevronRight aria-hidden="true" />
            </IconButton>
          </nav>

          <div
            class={[
              'address-control no-drag',
              currentUrl.value && 'has-inline-action',
              editingAddress.value && 'is-editing',
              loading.value && 'is-loading',
            ]}
          >
            {editingAddress.value ? (
              <form class="address-editor" onSubmit={navigate}>
                <input
                  ref={addressInput}
                  id="address-input"
                  value={draft.value}
                  aria-label="网页地址"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  onInput={(event) => (draft.value = (event.target as HTMLInputElement).value)}
                  onBlur={() => closeAddressEditor()}
                  onKeydown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    closeAddressEditor(true)
                  }}
                />
              </form>
            ) : (
              <button
                ref={addressButton}
                class="address-display"
                type="button"
                aria-label={`编辑网页地址，当前地址：${currentUrl.value}`}
                title={currentUrl.value}
                onClick={editAddress}
              >
                {currentUrl.value}
              </button>
            )}
            {currentUrl.value && (
              <span class="address-inline-action">
                <IconButton label="刷新" onPress={() => window.workbench.browserAction('reload')}>
                  <RotateCw aria-hidden="true" />
                </IconButton>
              </span>
            )}
            <span class="loading-line" aria-hidden="true" />
          </div>

          <div class="toolbar-actions no-drag">
            <IconButton label="打开调试" onPress={() => window.workbench.browserAction('devtools')}>
              <Wrench aria-hidden="true" />
            </IconButton>
            <IconButton label="打开配置" onPress={() => window.workbench.browserAction('open-config')}>
              <SlidersHorizontal aria-hidden="true" />
            </IconButton>
          </div>
        </header>

        <main ref={viewport} class="viewport" />
      </div>
    )
  },
})
