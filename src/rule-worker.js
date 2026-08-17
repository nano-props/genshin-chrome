const vm = require("node:vm");
const { parentPort } = require("node:worker_threads");

const sandbox = {
  URL,
  URLSearchParams,
  console: Object.freeze({
    log() {},
    warn() {},
    error() {}
  })
};

const context = vm.createContext(sandbox, {
  name: "genshin-chrome-rule",
  codeGeneration: { strings: false, wasm: false }
});

const invokeScript = new vm.Script("__result = __rewrite(__request)");

function compile(source) {
  const script = new vm.Script(`__rewrite = (${source})`, {
    filename: "rewrite-rule.js"
  });
  script.runInContext(context, { timeout: 50 });

  if (typeof context.__rewrite !== "function") {
    throw new TypeError("规则必须是一个函数");
  }
}

function rewrite(request) {
  context.__request = Object.freeze({ ...request });
  invokeScript.runInContext(context, { timeout: 25 });
  const result = context.__result;

  if (result == null) return null;
  if (typeof result !== "object") {
    throw new TypeError("规则必须返回 null 或对象");
  }

  return {
    url: typeof result.url === "string" ? result.url : undefined,
    cancel: result.cancel === true
  };
}

parentPort.on("message", (message) => {
  try {
    const result = message.type === "compile"
      ? compile(message.source)
      : rewrite(message.request);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: `${error.name || "Error"}: ${error.message || "未知规则错误"}`
    });
  }
});
