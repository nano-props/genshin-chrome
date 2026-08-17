import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref
} from "vue";
import { SwitchRoot, SwitchThumb } from "reka-ui";

const DEFAULT_RULE = `function rewrite(request) {
  const url = new URL(request.url);

  if (url.hostname !== "api.example.com") {
    return null;
  }

  url.protocol = "http:";
  url.hostname = "localhost";
  url.port = "3000";

  return { url: url.toString() };
}`;

const IconButton = (props, { slots }) => (
  <button
    type="button"
    disabled={props.disabled}
    title={props.title}
    aria-label={props.title}
    onClick={props.onClick}
    class="grid size-8 place-items-center border border-ink/35 bg-transparent text-[17px] transition hover:-translate-y-px hover:bg-ink hover:text-acid disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:translate-y-0 disabled:hover:bg-transparent disabled:hover:text-ink"
  >
    {slots.default?.()}
  </button>
);

IconButton.props = {
  disabled: Boolean,
  title: String,
  onClick: Function
};

export default defineComponent({
  name: "RequestWorkbench",
  setup() {
    const address = ref("https://example.com");
    const addressEditing = ref(false);
    const pageTitle = ref("Example Domain");
    const loading = ref(false);
    const canGoBack = ref(false);
    const canGoForward = ref(false);
    const secure = ref(true);
    const ruleSource = ref(localStorage.getItem("rewrite-rule") || DEFAULT_RULE);
    const ruleEnabled = ref(localStorage.getItem("rule-enabled") !== "false");
    const ruleStatus = ref({ valid: true, message: "规则已启用" });
    const requests = ref([]);
    const requestTotal = ref(0);
    const viewport = ref(null);
    const editor = ref(null);
    const cleanup = [];
    let resizeObserver;

    const lineNumbers = computed(() =>
      Array.from(
        { length: ruleSource.value.split("\n").length },
        (_, index) => index + 1
      ).join("\n")
    );

    function browserAction(action) {
      window.workbench.browserAction(action);
    }

    async function navigate(event) {
      event.preventDefault();
      try {
        await window.workbench.navigate(address.value);
        document.activeElement?.blur();
      } catch (error) {
        ruleStatus.value = { valid: false, message: error.message };
      }
    }

    async function applyRule() {
      localStorage.setItem("rewrite-rule", ruleSource.value);
      ruleStatus.value = await window.workbench.updateRule({
        source: ruleSource.value,
        enabled: ruleEnabled.value
      });
      ruleEnabled.value = ruleStatus.value.enabled;
      localStorage.setItem("rule-enabled", String(ruleEnabled.value));
    }

    async function toggleRule(enabled) {
      const status = await window.workbench.toggleRule(enabled);
      ruleEnabled.value = status.enabled;
      localStorage.setItem("rule-enabled", String(ruleEnabled.value));
      ruleStatus.value = status;
    }

    function updateViewportBounds() {
      if (!viewport.value) return;
      const rect = viewport.value.getBoundingClientRect();
      window.workbench.updateViewBounds({
        x: rect.left + 1,
        y: rect.top + 1,
        width: rect.width - 2,
        height: rect.height - 2
      });
    }

    function handleEditorKeydown(event) {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = event.target.selectionStart;
        const end = event.target.selectionEnd;
        ruleSource.value = `${ruleSource.value.slice(0, start)}  ${ruleSource.value.slice(end)}`;
        nextTick(() => {
          event.target.selectionStart = event.target.selectionEnd = start + 2;
        });
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        applyRule();
      }
    }

    function handleGlobalKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        document.querySelector("#address-input")?.focus();
      }
    }

    function formatRequestURL(log) {
      try {
        const url = new URL(log.rewrittenURL || log.url);
        return `${url.host}${url.pathname}${url.search}`;
      } catch {
        return log.url;
      }
    }

    onMounted(() => {
      cleanup.push(
        window.workbench.onBrowserState((state) => {
          if (!addressEditing.value && state.url) address.value = state.url;
          pageTitle.value = state.title || "UNTITLED TARGET";
          loading.value = state.loading;
          canGoBack.value = state.canGoBack;
          canGoForward.value = state.canGoForward;
          try {
            secure.value = new URL(state.url).protocol === "https:";
          } catch {}
        }),
        window.workbench.onBrowserError(({ errorDescription }) => {
          pageTitle.value = `LOAD ERROR / ${errorDescription}`;
        }),
        window.workbench.onRequestLog((log) => {
          requestTotal.value += 1;
          requests.value.unshift(log);
          if (requests.value.length > 120) requests.value.pop();
        }),
        window.workbench.onRuleStatus((status) => {
          ruleStatus.value = status;
        })
      );

      resizeObserver = new ResizeObserver(updateViewportBounds);
      resizeObserver.observe(viewport.value);
      window.addEventListener("resize", updateViewportBounds);
      document.addEventListener("keydown", handleGlobalKeydown);
      requestAnimationFrame(updateViewportBounds);
      applyRule();
    });

    onBeforeUnmount(() => {
      cleanup.forEach((unsubscribe) => unsubscribe());
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateViewportBounds);
      document.removeEventListener("keydown", handleGlobalKeydown);
    });

    return () => {
      const switchProps = {
        modelValue: ruleEnabled.value,
        "onUpdate:modelValue": toggleRule
      };

      return (
        <div class="h-screen min-h-[680px] min-w-[980px] overflow-hidden bg-paper text-ink">
          <header class="drag-region flex h-[88px] items-center gap-8 border-b border-ink/20 bg-paper/95 py-3 pr-[18px] pl-[82px]">
            <div class="flex w-[286px] min-w-[286px] items-center gap-3 max-[1120px]:w-[220px] max-[1120px]:min-w-[220px]">
              <span class="grid size-10 -rotate-3 place-items-center border border-ink bg-ink font-display text-[22px] font-bold text-acid">原</span>
              <div>
                <strong class="block font-display text-[23px] leading-none font-bold tracking-[0.12em]">原铬</strong>
                <small class="mt-1.5 block text-[8px] tracking-[0.19em] text-muted">REQUEST WORKBENCH</small>
              </div>
            </div>

            <div class="no-drag flex min-w-0 flex-1 items-center gap-2.5">
              <div class="flex gap-1">
                <IconButton title="后退" disabled={!canGoBack.value} onClick={() => browserAction("back")}>←</IconButton>
                <IconButton title="前进" disabled={!canGoForward.value} onClick={() => browserAction("forward")}>→</IconButton>
                <IconButton title={loading.value ? "停止" : "刷新"} onClick={() => browserAction(loading.value ? "stop" : "reload")}>
                  {loading.value ? "×" : "↻"}
                </IconButton>
              </div>

              <form onSubmit={navigate} class="flex h-[42px] min-w-0 flex-1 items-center gap-2.5 border border-ink bg-[#f6f3e9] px-3 shadow-[4px_4px_0_rgba(23,25,20,0.14)]">
                <span class={["size-[7px] shrink-0 rounded-full ring-[3px]", secure.value ? "bg-cyan ring-cyan/15" : "bg-orange ring-orange/15"]}></span>
                <input
                  id="address-input"
                  value={address.value}
                  onInput={(event) => (address.value = event.target.value)}
                  onFocus={(event) => {
                    addressEditing.value = true;
                    event.target.select();
                  }}
                  onBlur={() => (addressEditing.value = false)}
                  spellcheck="false"
                  autocomplete="off"
                  aria-label="网页地址"
                  class="min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
                <span class="border border-ink/15 px-1.5 py-0.5 text-[9px] text-muted">⌘ L</span>
              </form>

              <button type="button" onClick={() => browserAction("devtools")} class="h-8 border border-ink/35 px-3 text-[9px] font-bold tracking-[0.08em] transition hover:-translate-y-px hover:bg-ink hover:text-acid">
                DEVTOOLS ↗
              </button>
            </div>
          </header>

          <main class="grid h-[calc(100vh-88px)] grid-cols-[370px_minmax(0,1fr)] animate-[reveal_480ms_cubic-bezier(.2,.8,.2,1)_both] max-[1120px]:grid-cols-[330px_minmax(0,1fr)]">
            <aside class="flex min-h-0 flex-col border-r-[7px] border-acid bg-[radial-gradient(circle_at_15%_0%,rgba(216,255,62,.07),transparent_35%)] bg-panel text-[#e9e8df]">
              <section class="flex h-[76px] items-end justify-between border-b border-panel-line px-4 py-3.5">
                <div>
                  <p class="mb-1 text-[8px] tracking-[0.18em] text-acid">INTERCEPT / 01</p>
                  <h1 class="font-display text-[25px] leading-none font-bold tracking-[0.08em]">请求改写器</h1>
                </div>
                <SwitchRoot {...switchProps} aria-label="启用请求改写规则" class="relative h-[23px] w-[43px] cursor-pointer border border-[#62675a] bg-[#151713] outline-none data-[state=checked]:border-acid/50">
                  <SwitchThumb class="block size-[15px] translate-x-[3px] bg-[#62675a] transition-transform will-change-transform data-[state=checked]:translate-x-[23px] data-[state=checked]:bg-acid" />
                </SwitchRoot>
              </section>

              <div class="flex h-[35px] items-center justify-between border-b border-panel-line px-3.5 text-[8px] tracking-[0.1em] text-[#a9ada1]">
                <span><i class="mr-1.5 inline-block size-[5px] bg-orange"></i>LOCAL API ROUTE</span>
                <span class={ruleStatus.value.valid ? "text-cyan" : "text-danger"}>{ruleStatus.value.message}</span>
              </div>

              <div class="grid h-[min(330px,43vh)] min-h-[210px] grid-cols-[37px_1fr] bg-[#181a16]">
                <pre class="overflow-hidden border-r border-[#30342c] py-[13px] pr-2 text-right font-mono text-[10.5px] leading-[1.62] text-[#555a4e] select-none">{lineNumbers.value}</pre>
                <textarea
                  ref={editor}
                  value={ruleSource.value}
                  onInput={(event) => (ruleSource.value = event.target.value)}
                  onKeydown={handleEditorKeydown}
                  spellcheck="false"
                  aria-label="JavaScript 请求改写规则"
                  class="size-full resize-none bg-transparent px-3 py-[13px] font-mono text-[10.5px] leading-[1.62] text-[#d9ddd0] caret-acid outline-none [tab-size:2]"
                />
              </div>

              <div class="flex min-h-11 items-center justify-between border-y border-panel-line px-3.5 py-1.5 text-[8px] text-[#777c6f]">
                <span>返回 <code class="text-orange">null</code> 即放行</span>
                <button type="button" onClick={applyRule} class="border border-acid bg-acid px-2.5 py-2 text-[9px] font-bold text-ink transition hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[2px_2px_0_white]">
                  应用规则 <kbd class="font-normal">⌘↵</kbd>
                </button>
              </div>

              <section class="flex min-h-0 flex-1 flex-col">
                <div class="flex h-[38px] shrink-0 items-center justify-between border-b border-panel-line px-3.5 text-[9px] font-bold tracking-[0.11em] text-[#a9ada1]">
                  <span>实时请求</span>
                  <button type="button" onClick={() => { requests.value = []; requestTotal.value = 0; }} class="cursor-pointer text-[8px] text-[#72776a] hover:text-acid">清空</button>
                </div>
                <div class="min-h-0 flex-1 overflow-auto">
                  {requests.value.length === 0 ? (
                    <div class="grid h-full place-content-center text-center text-[8px] tracking-[0.1em] text-[#565b50]">
                      <span class="text-[22px] text-acid">◌</span>
                      <p>等待页面发起请求</p>
                    </div>
                  ) : requests.value.map((log) => (
                    <div key={`${log.id}-${log.time}`} title={log.rewrittenURL ? `${log.url}\n→ ${log.rewrittenURL}` : log.error || log.url} class={["grid grid-cols-[42px_1fr_auto] gap-2 border-b border-[#30332c] px-3 py-2.5 text-[8px] animate-[log-in_180ms_ease_both]", log.outcome === "rewritten" && "shadow-[inset_3px_0_#d8ff3e]", ["blocked", "error"].includes(log.outcome) && "shadow-[inset_3px_0_#ff5c57]"]}>
                      <span class={["font-bold text-cyan", log.outcome === "rewritten" && "text-acid"]}>{log.outcome === "rewritten" ? "REROUTE" : log.method}</span>
                      <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[#b6baad]">{formatRequestURL(log)}</span>
                      <span class="text-[7px] text-[#686d61] uppercase">{log.outcome === "pass" ? log.resourceType : log.outcome}</span>
                    </div>
                  ))}
                </div>
              </section>
            </aside>

            <section class="grid min-h-0 min-w-0 grid-rows-[40px_minmax(0,1fr)] px-[17px] pb-[17px]">
              <div class="flex min-w-0 items-center justify-between text-[8px] tracking-[0.08em] text-muted">
                <div class="flex min-w-0 items-center gap-2">
                  <span class={["size-[7px] shrink-0 rounded-full bg-[#4f5549]", loading.value && "animate-pulse bg-orange"]}></span>
                  <strong class="overflow-hidden text-[10px] text-ellipsis whitespace-nowrap text-ink">{pageTitle.value}</strong>
                </div>
                <div class="flex gap-5">
                  <span>{String(requestTotal.value).padStart(3, "0")} REQ</span>
                  <span>SESSION / ISOLATED</span>
                </div>
              </div>
              <div ref={viewport} class="relative min-h-0 overflow-hidden border border-ink bg-[#f6f3e9] shadow-[7px_7px_0_rgba(23,25,20,0.16)]">
                <div class="absolute inset-0 grid place-content-center text-[9px] tracking-[0.2em] text-[#b1ad9e]">CONNECTING TO TARGET</div>
              </div>
            </section>
          </main>
        </div>
      );
    };
  }
});
