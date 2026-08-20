import { AlertCircle, Check, FileCode2 } from '@lucide/vue'
import { basicSetup, EditorView } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { requireWindowBridge } from '#/renderer/window-bridge.ts'

const configEditor = requireWindowBridge('configEditor')

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: '#242426',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    padding: '16px 0 28px',
    caretColor: '#007aff',
    fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, Monaco, monospace",
    fontSize: '13px',
    lineHeight: '1.65',
  },
  '.cm-line': { padding: '0 18px 0 8px' },
  '.cm-gutters': {
    color: 'rgba(60, 60, 67, 0.42)',
    backgroundColor: 'rgba(246, 246, 248, 0.72)',
    borderRight: '1px solid rgba(0, 0, 0, 0.055)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(0, 122, 255, 0.055)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(0, 122, 255, 0.18) !important',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-tooltip': {
    overflow: 'hidden',
    border: '1px solid rgba(0, 0, 0, 0.1)',
    borderRadius: 'var(--config-radius-control)',
    backgroundColor: 'rgba(250, 250, 252, 0.98)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
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
          <div class="config-title-block">
            <span class="config-icon" aria-hidden="true">
              <FileCode2 />
            </span>
            <div>
              <h1>配置编辑器</h1>
              <p>config.js · 保存后重启应用生效</p>
            </div>
          </div>
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
            <div class="config-editor-actions">
              <button class="editor-button" type="button" onClick={() => configEditor.requestClose()}>
                取消
              </button>
              <button
                class="editor-button is-primary"
                type="button"
                disabled={loading.value || saving.value || !editor}
                onClick={save}
              >
                {saving.value ? '正在保存…' : '保存'}
                <kbd>⌘S</kbd>
              </button>
            </div>
          </footer>
        </main>
      </div>
    )
  },
})
