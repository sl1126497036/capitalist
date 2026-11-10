/**
 * 宿主模型清单。多个面板会同时拉取，同一次会话内缓存并合并并发请求。
 * codebuddy 返回全量清单，claude 只返回示例别名并在 `reason` 给出说明。
 */

let cache = null;
let cacheAt = 0;
/** 缓存存活时间：切换宿主后不沿用上一份清单，1 分钟后重新取数。 */
const TTL_MS = 60_000;
let inflight = null;

/** 读清单；`force` 请求 `?fresh=1`，由后端重新解析宿主 CLI。 */
export async function loadModels(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`./api/models${force ? "?fresh=1" : ""}`);
      const d = await r.json();
      cache = {
        models: Array.isArray(d.models) ? d.models.map(String) : [],
        host: String(d.host || ""),
        source: String(d.source || ""),
        /* 宿主配置的默认模型，用于「宿主默认」一行。 */
        default_model: String(d.default_model || ""),
        reason: String(d.reason || ""),
      };
    } catch (e) {
      cache = {
        models: [],
        host: "",
        source: "",
        default_model: "",
        reason: `读模型清单失败：${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      inflight = null;
      cacheAt = Date.now();
    }
    return cache;
  })();
  return inflight;
}

/** 发送指令；失败时抛出带可读原因的 Error。 */
async function postCommand(body, path = "./api/capitalist-command") {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || d.reason || `HTTP ${r.status}`);
  return { ok: true, effective: String(d.effective || "") };
}

/** 派单模型写入 `.capitalist/next_model.json` 后常驻生效，派单只读不消费；传空串清除设定。 */
export function setNextModel(root, model) {
  return postCommand({ action: "next-model", arg: String(model || ""), ...(root ? { root } : {}) });
}

/**
 * 更换当前派单的对话模型：后端结束当前进程，监工重派时以 `--resume` 接回历史。
 * 传空串回到契约或启动参数指定的模型。
 */
export function setWorkerModel(root, thread, model) {
  /* /api/command 处理针对单个工作进程的动作；/api/capitalist-command 只处理监工级指令。 */
  return postCommand(
    {
      action: "worker-model",
      id: String(thread || ""),
      model: String(model || ""),
      ...(root ? { root } : {}),
    },
    "./api/command",
  );
}

/** 监工对话层换模型：写 supervisor.json 的 supervisor_model，下一轮调用生效。 */
export function setSupervisorModel(root, model) {
  return postCommand({ action: "capitalist-model", arg: String(model || ""), ...(root ? { root } : {}) });
}

/**
 * 调整该监工的并行度：复用 concurrency 指令通道（supervisor-direct 台账，由 loop 在下一轮执行）。
 * 参数合法性由执行侧裁决，拒绝原因原样抛回。
 */
export function setConcurrency(root, n) {
  return postCommand({ action: "concurrency", arg: String(n), ...(root ? { root } : {}) });
}
