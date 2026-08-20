import { AlertCircle, Check } from '@lucide/vue'
import { basicSetup, EditorView } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { ToolbarButton, ToolbarRoot } from 'reka-ui'
import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { requireWindowBridge } from '#/renderer/window-bridge.ts'

const configEditor = requireWindowBridge('configEditor')

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ui-color-text-editor)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    padding: '16px 0 28px',
    caretColor: 'var(--ui-color-focus)',
    fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, Monaco, monospace",
    fontSize: '13px',
    lineHeight: '1.65',
  },
  '.cm-line': { padding: '0 18px 0 8px' },
  '.cm-gutters': {
    color: 'var(--config-color-code-gutter-text)',
    backgroundColor: 'var(--config-color-code-gutter)',
    borderRight: '1px solid var(--config-color-code-divider)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--ui-color-focus-subtle)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--ui-color-selection) !important',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-tooltip': {
    overflow: 'hidden',
    border: '1px solid var(--ui-color-border-strong)',
    borderRadius: 'var(--ui-radius-sm)',
    backgroundColor: 'var(--config-color-tooltip)',
    boxShadow: 'var(--config-shadow-tooltip)',
  },
})

export default defineComponent({
  name: 'ConfigEditor',
  setup() {
    const editorHost = ref<HTMLElement | null>(null)
    const loading = ref(true)
    const saving = ref(false)
    const dirty = ref(false)
    const error = ref('')
    let editor: EditorView | undefined
    let savedSource = ''

    async function save() {
      if (!editor || saving.value) return
      const submittedSource = editor.state.doc.toString()
      saving.value = true
      error.value = ''
      try {
        const result = await configEditor.save(submittedSource, savedSource)

        if (!result.ok) {
          if (result.reloadedSource !== undefined) {
            savedSource = result.reloadedSource
            editor.dispatch({
              changes: { from: 0, to: editor.state.doc.length, insert: result.reloadedSource },
            })
            dirty.value = false
            configEditor.setDirty(false)
            error.value = result.error
          } else if (editor.state.doc.toString() === submittedSource) {
            error.value = result.error
          }
          return
        }

        savedSource = submittedSource
        dirty.value = editor.state.doc.toString() !== savedSource
        configEditor.setDirty(dirty.value)
        if (dirty.value) return
        configEditor.requestClose()
      } catch (saveError) {
        if (editor.state.doc.toString() === submittedSource) {
          error.value = saveError instanceof Error ? saveError.message : String(saveError)
        }
      } finally {
        saving.value = false
      }
    }

    function handleShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void save()
    }

    onMounted(async () => {
      window.addEventListener('keydown', handleShortcut)
      try {
        const source = await configEditor.read()
        savedSource = source
        if (!editorHost.value) return
        editor = new EditorView({
          parent: editorHost.value,
          doc: source,
          extensions: [
            basicSetup,
            javascript(),
            EditorView.lineWrapping,
            editorTheme,
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return
              error.value = ''
              dirty.value = update.state.doc.toString() !== savedSource
              configEditor.setDirty(dirty.value)
            }),
          ],
        })
        editor.focus()
      } catch (loadError) {
        error.value = loadError instanceof Error ? loadError.message : String(loadError)
      } finally {
        loading.value = false
      }
    })

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', handleShortcut)
      editor?.destroy()
    })

    return () => (
      <div class="config-editor-shell">
        <header class="config-editor-header">
          <h1>配置编辑器</h1>
          <span
            class={['dirty-indicator', dirty.value && 'is-visible']}
            aria-label={dirty.value ? '有未保存的更改' : ''}
          />
        </header>

        <main class="config-editor-main">
          <section class={['editor-frame', error.value && 'has-error']} aria-label="config.js 编辑器">
            {loading.value && <div class="editor-placeholder">正在读取配置…</div>}
            <div ref={editorHost} class="editor-host" />
          </section>

          <footer class="config-editor-footer">
            <div class={['editor-status', error.value && 'is-error']} role="status" aria-live="polite">
              {error.value ? (
                <>
                  <AlertCircle aria-hidden="true" />
                  <span>{error.value}</span>
                </>
              ) : (
                <>
                  <Check aria-hidden="true" />
                  <span>保存前会静态校验语法和可确定的必填项</span>
                </>
              )}
            </div>
            <ToolbarRoot class="config-editor-actions" aria-label="配置操作" loop>
              <ToolbarButton asChild>
                <button class="editor-button" type="button" onClick={() => configEditor.requestClose()}>
                  取消
                </button>
              </ToolbarButton>
              <ToolbarButton asChild disabled={loading.value || saving.value || !editor}>
                <button
                  class="editor-button is-primary"
                  type="button"
                  disabled={loading.value || saving.value || !editor}
                  onClick={save}
                >
                  {saving.value ? '正在保存…' : '保存'}
                  <kbd>⌘S</kbd>
                </button>
              </ToolbarButton>
            </ToolbarRoot>
          </footer>
        </main>
      </div>
    )
  },
})
