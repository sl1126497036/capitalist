<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { CloseOutlined, SearchOutlined, ThunderboltOutlined } from "@ant-design/icons-vue";
import { dur, hhmm } from "../../lib/fmt.js";
import { isAlive, queueCompare } from "../../lib/queueOrder.js";
import { numberQueue, shortOf } from "../../lib/shortId.js";
import { taskTitle } from "../../lib/taskTitle.js";
/* 单位口径（积分 / tokens / 现金）统一在 lib/usage.js，顶栏与左栏共用同一份判据。 */
import { billParts, totalUsageText } from "../../lib/usage.js";
import EmptyState from "../empty-state";

const props = defineProps({
  threads: { type: Array, default: () => [] },
  current: { type: String, default: "" },
  total: { type: Number, default: 0 },
  /** 当前根的监工状态（/api/supervisor），左栏第一行用它渲染固定行。 */
  capitalist: { type: Object, default: () => ({}) },
  /** 监工流的未读数：不在监工会话里时由上层按水位差算好传进来。 */
  supervisorUnread: { type: Number, default: 0 },
  collapsed: { type: Boolean, default: false },
  __q: { type: String, default: "" },
  __filter: { type: String, default: "all" },
  __all: { type: Boolean, default: false },
});
const emit = defineEmits(["pick", "capitalist", "refresh", "close", "promote", "stats"]);

const q = ref(props.__q || "");
const filter = ref(props.__filter || "all");
const menuOpen = ref(false);
const fbox = ref(null);

/* ---------------------------------------------------------------- 状态分档 */

/** 与旧版 statusBucket 同口径：run / queue / bad / done。 */
function bucket(s) {
  if (s === "running" || s === "starting" || s === "claimed") return "run";
  if (s === "queued" || s === "open") return "queue";
  if (s === "failed" || s === "missing" || s === "orphan" || s === "gone") return "bad";
  return "done";
}
function cell(t) {
  const s = String(t?.status || "");
  /*
   * 后端把 closed 且 closed_by 为 user 的派单标记为 canceled。
   * 该状态不属于完成或失败：监工不再调度，恢复需在对话中登记。
   * 单独一档用紫灰，与完成态和故障态区分。
   */
  if (s === "canceled") return { tone: "cancel", kind: "word", text: "已取消" };
  if (s === "running" || s === "starting" || s === "claimed") {
    const secs = liveSecs(t);
    return secs === null ? { tone: "run", ...NA_DUR } : { tone: "run", kind: "dur", text: dur(secs) };
  }
  if (s === "done" || s === "exited" || s === "finished") {
    const secs = closedSecs(t);
    return secs === null ? { tone: "done", ...NA_DUR } : { tone: "done", kind: "dur", text: dur(secs) };
  }
  /* 状态词沿用 i18n 的 statusQueued：只写“排队”，不加“中”。
     该档包含刚入队与排队较久两种情形，进行时后缀不适用于两者。 */
  if (s === "queued" || s === "open") return { tone: "warn", kind: "word", text: "排队" };
  if (s === "failed" || s === "missing" || s === "orphan" || s === "gone") {
    return { tone: "bad", kind: "word", text: "异常" };
  }
  if (s === "paused") return { tone: "warn", kind: "word", text: "已暂停" };
  if (s === "held") return { tone: "warn", kind: "word", text: "接管中" };
  return { tone: "idle", kind: "word", text: "待调度" };
}

const NA_DUR = { kind: "na", text: "无采样" };

/** 运行中：从调度时刻起算到此刻；接口的 duration_sec 是下限（重启后可能滞后）。 */
function liveSecs(t) {
  const start = Date.parse(t?.started_at || "");
  const fromServer = Number(t?.duration_sec) > 0 ? Number(t.duration_sec) : 0;
  if (!Number.isFinite(start)) return fromServer > 0 ? fromServer : null;
  return Math.max(fromServer, Math.round((Date.now() - start) / 1000));
}

/** 已结束：优先用服务端算好的 duration_sec，没有再按“首末消息时间”兜一次；都没有就是 null。 */
function closedSecs(t) {
  const d = Number(t?.duration_sec);
  if (d > 0) return d;
  const start = Date.parse(t?.started_at || "");
  const last = Date.parse(t?.last_at || "");
  if (Number.isFinite(start) && Number.isFinite(last) && last > start) {
    return Math.round((last - start) / 1000);
  }
  return null;
}

/* ---------------------------------------------------------------- 模型名与版本 */

const VENDOR = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  gpt: "GPT",
  anthropic: "Anthropic",
  claude: "Claude",
  google: "Google",
  gemini: "Gemini",
  qwen: "Qwen",
  tongyi: "通义",
  kimi: "Kimi",
  moonshot: "Moonshot",
  glm: "GLM",
  zhipu: "智谱",
  llama: "Llama",
  mistral: "Mistral",
  doubao: "豆包",
};

function capFirst(s) {
  return String(s || "").replace(/^([a-z])/, (m) => m.toUpperCase());
}

function modelOf(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const cut = s.search(/[-_/ ]/);
  const head = (cut > 0 ? s.slice(0, cut) : s).toLowerCase();
  const rest = cut > 0 ? s.slice(cut + 1) : "";
  const name = VENDOR[head] || capFirst(head);
  /* 版本段按 `-`/`_` 断词，逐词首字母大写：`v4.1-flash` -> `V4.1 Flash`。 */
  const ver = rest
    .split(/[-_]+/)
    .filter(Boolean)
    .map(capFirst)
    .join(" ");
  return { name, ver, raw: s };
}

/* ---------------------------------------------------------------- 消耗 */

const NO_USAGE = "未上报";


function spendOf(t) {
  const u = t?.usage;
  if (!u || !u.reported) return { text: "", num: "", unit: "", tip: String(u?.unavailable_reason || "") };
  if (u.billing_unit === "usd" && typeof u.cost_usd === "number" && u.cost_usd > 0) {
    const p = billParts(u.cost_usd, "usd");
    return { ...p, tip: "金额取自日志 result 行的 total_cost_usd" };
  }
  if (typeof u.credit === "number") {
    const p = billParts(u.credit, u.credit_unit || "credit");
    return { ...p, tip: "积分按计费接口已用积分的增量摊算到这条线程；面板未开启期间的消耗没有摊算依据，读数可能偏小" };
  }
  /* 积分制宿主只按积分报：该线程无积分读数时留空，不回退为 token。 */
  if (creditHost.value) return { text: "", num: "", unit: "", tip: "按积分计费，本线程未分摊到读数" };
  if (typeof u.total_tokens === "number") {
    const p = billParts(u.total_tokens, "token");
    return {
      ...p,
      tip: `输入 ${u.input_tokens ?? "未上报"} + 输出 ${u.output_tokens ?? "未上报"}；缓存命中 ${u.cache_read_tokens ?? "未上报"}（单列，不重复计入）。该模型不走美元计价（total_cost_usd=0），按 token 显示`,
    };
  }
  return { text: "", num: "", unit: "", tip: "这条读数有 usage 但没有 token 字段" };
}

function ctxOf(t) {
  const u = t?.usage;
  if (!u || typeof u.context_used !== "number") return "";
  const used = u.context_used >= 1000 ? `${(u.context_used / 1000).toFixed(1)}k` : String(u.context_used);
  const win = typeof u.context_window === "number" && u.context_window > 0
    ? (u.context_window >= 1000 ? `${(u.context_window / 1000).toFixed(0)}k` : String(u.context_window))
    : "";
  return win ? `${used}/${win}` : used;
}

function metaOf(t) {
  const secs = isAlive(t)
    ? liveSecs(t)
    : String(t?.status || "") === "queued" || String(t?.status || "") === "open"
      ? null
      : closedSecs(t);
  const sp = spendOf(t);
  return {
    at: hhmm(t?.started_at || ""),
    durText: secs === null ? "" : dur(secs),
    spend: sp.num,
    spendUnit: sp.unit,
    spendTip: sp.tip,
    ctx: ctxOf(t),
  };
}

/* ---------------------------------------------------------------- 组件自取 */

const localSupervisor = ref({});
const dispatches = ref([]);
let hydTimer = 0;

async function hydrate() {
  if (hasSupervisor.value) return;
  try {
    const r = await fetch("./api/supervisor", { headers: { accept: "application/json" } });
    if (r.ok) localSupervisor.value = (await r.json()) || {};
  } catch {
    /* 拿不到就维持上一次读数：监工行不是主线，不能因为这里失手把左栏弄红。 */
  }
  if (!dispatches.value.length) {
    try {
      const r = await fetch("./api/state", { headers: { accept: "application/json" } });
      if (r.ok) dispatches.value = (await r.json())?.dispatches || [];
    } catch {
      /* 同上。 */
    }
  }
}

/* ---------------------------------------------------------------- 行名 */

/** 线程 -> 派单：先按 dispatch id，再退到同分片（旧版同口径）。 */
function dispatchOf(t) {
  const ds = dispatches.value || [];
  if (t?.dispatch) {
    const d = ds.find((x) => x.id === t.dispatch);
    if (d) return d;
  }
  if (t?.shard) {
    const d = ds.find((x) => x.shard === t.shard);
    if (d) return d;
  }
  return null;
}

function procTitle(t) {
  return taskTitle(
    { title: t?.title, shard: t?.shard, action: dispatchOf(t)?.action || "" },
  );
}

function shownName(t) {
  return procTitle(t);
}

/* ---------------------------------------------------------------- 顺序 */

const startedMs = (t) => Date.parse(t?.started_at || "") || 0;

/* ---------------------------------------------------------------- 筛选 + 搜索 */

const FILTERS = [
  { key: "all", label: "全部", tone: "" },
  { key: "run", label: "运行中", tone: "run" },
  { key: "queue", label: "排队", tone: "warn" },
  { key: "bad", label: "异常", tone: "bad" },
  { key: "done", label: "已完成", tone: "done" },
];

const curFilter = computed(() => FILTERS.find((f) => f.key === filter.value) || FILTERS[0]);

/** 搜索匹配不含状态分档。列表与计数共用同一份底数。 */
function searchMatch(t) {
  const key = q.value.trim().toLowerCase();
  if (!key) return true;
  /* 命中字段：语义标题 + shard + id + worker（旧版口径，不含 stage / model）。 */
  const hay = `${procTitle(t)} ${t.shard || ""} ${t.id || ""} ${t.worker || ""}`.toLowerCase();
  return hay.includes(key);
}

function visible(t) {
  return showStale.value || !staleOf(t) || String(q.value || "").trim() !== "";
}

function matchThread(t) {
  if (filter.value !== "all" && bucket(String(t?.status || "")) !== filter.value) return false;
  return searchMatch(t);
}

const base = computed(() => props.threads.filter(searchMatch).filter(visible));

const list = computed(() =>
  base.value
    .filter((t) => filter.value === "all" || bucket(String(t?.status || "")) === filter.value)
    .slice()
    .sort(queueCompare),
);

/**
 * 各档计数按全部线程算，不受搜索与当前档位影响，与 client.ts 的计数口径一致。
 * 搜索是“从列表里找”，筛选是“看哪一类”，两套维度互相改写对方数字会让人无法判断基数。
 * 折叠掉的旧任务仍计入：它们是真实存在的任务，折叠只是显示层的收起（按钮本身写着收起了几条）。
 */
const counts = computed(() => {
  const c = { all: props.threads.length, run: 0, queue: 0, bad: 0, done: 0 };
  for (const t of props.threads) c[bucket(String(t?.status || ""))]++;
  return c;
});

watch(
  counts,
  (v) => emit("stats", { ...v }),
  { immediate: true, deep: true },
);

/* ---------------------------------------------------------------- 不活跃折叠 */
const STALE_MS = 3 * 60 * 60 * 1000;
const TOUCH_KEY = "capitalist.thread.touched";
const touched = ref(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(TOUCH_KEY) || "{}") || {};
    } catch {
      return {};
    }
  })(),
);
const showStale = ref(false);

function staleOf(t) {
  const s = String(t.status || "");
  if (s === "running" || s === "starting" || s === "queued" || s === "claimed") return false;
  const at = Date.parse(String(t.last_at || t.started_at || "")) || 0;
  if (!at || Date.now() - at < STALE_MS) return false;
  return !touched.value[String(t.id || "")];
}

function touchThread(id) {
  const key = String(id || "");
  if (!key) return;
  touched.value = { ...touched.value, [key]: Date.now() };
  try {
    localStorage.setItem(TOUCH_KEY, JSON.stringify(touched.value));
  } catch {
    /* 存不下只影响这一次，不影响当前会话 */
  }
}

const staleCount = computed(() => props.threads.filter(searchMatch).filter(staleOf).length);

/* ---------------------------------------------------------------- 行数据 */

/** 先按队列顺序给全部线程取号，行与消息才读到同一个号（不是谁先渲染谁先取）。 */
const numbering = computed(() => numberQueue(props.threads));

/** 每行渲染需要的全部字段一次算好：名称、重派号、模型、三项元信息、状态词、tooltip。 */
const rows = computed(() =>
  list.value.map((t) => {
    const hit = retry.value.get(t.id) || 0;
    const c = cell(t);
    const m = metaOf(t);
    return {
      t,
      title: shownName(t),
      short: numbering.value.get(t.id) || shortOf(t.id),
      retry: hit > 0 ? hit + 1 : 0,
      /* 右侧那一格只留状态词：耗时已挪到第二行，和启动时刻、消耗排在一起。 */
      tone: c.tone,
      word: c.kind === "word" ? c.text : "",
      model: modelOf(t?.usage?.model || t?.model),
      at: m.at,
      durText: m.durText,
      spend: m.spend,
      spendUnit: m.spendUnit,
      spendTip: m.spendTip,
      ctx: m.ctx,
      /* 未读：服务端按上次访问水位算好的；0 不占位。 */
      unread: Math.max(0, Number(t?.unread) || 0),
      tip: tipOf(t),
    };
  }),
);
/** 一屏最多画这么多行，其余收进“还有 N 个进程未显示”（旧版 client.ts:1281、1339）。 */
const ROW_LIMIT = 50;
const showAllRows = ref(Boolean(props.__all));

const shown = computed(() => (showAllRows.value ? rows.value : rows.value.slice(0, ROW_LIMIT)));

/**
 * 余量按“列表长度”与“服务端总数”取大者算：/api/threads 有 limit，拿回来的行数可能少于
 * 总数（total 更大），只按本地行数算会把没拉到的那部分悄悄吞掉。
 */
const rest = computed(() => Math.max(rows.value.length, Number(props.total) || 0) - shown.value.length);

function pickFilter(key) {
  filter.value = key;
  menuOpen.value = false;
}

/* ---------------------------------------------------------------- 重派计数 */

const retry = computed(() => {
  const groups = new Map();
  for (const t of props.threads) {
    const k = `${t.stage || ""}|${t.shard || ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const map = new Map();
  for (const arr of groups.values()) {
    arr.sort((a, b) => startedMs(a) - startedMs(b) || (String(a.id) < String(b.id) ? -1 : 1));
    arr.forEach((t, i) => map.set(t.id, i));
  }
  return map;
});

/* ---------------------------------------------------------------- 手动结项 */

const closing = ref("");

/** 只有还开着的单能关：运行中（running/starting/claimed）与排队（queued/open）。 */
function canClose(t) {
  const s = String(t?.status || "");
  return s === "running" || s === "starting" || s === "claimed" || s === "queued" || s === "open";
}

function canPromote(t) {
  const s = String(t?.status || "");
  return s === "queued" || s === "open";
}

/** 排队行的动作用“取消”，运行中的动作用“关闭”。同一个后端动作按状态给不同标签。 */
function closeWord(t) {
  return canPromote(t) ? "取消" : "关闭";
}

function closeTip(t) {
  return canPromote(t)
    ? "取消这一单：从队列撤下，监工不再派发"
    : "关闭这一单：结项并停止重派（运行中进程会先被结束）";
}

const promoting = ref("");

/** 首次点击插队只进确认态，不直接发请求。置顶会改变其他任务的排队位置。 */
function promoteTap(r) {
  promoting.value = promoting.value === r.t.id ? "" : r.t.id;
  closing.value = "";
}

function promoteConfirm(r) {
  emit("promote", { id: r.t.dispatch || r.t.id, shard: r.t.shard || "", title: r.title });
  promoting.value = "";
}

function closeTap(r) {
  closing.value = closing.value === r.t.id ? "" : r.t.id;
  promoting.value = "";
}

function closeConfirm(r) {
  emit("close", { id: r.t.dispatch || r.t.id, shard: r.t.shard || "", title: r.title });
  closing.value = "";
}

/* ---------------------------------------------------------------- 行 tooltip */

/** 标题 · 分片 · worker · 模型 · 调度时刻 · 三项口径（耗时 / 消耗为什么是这样）。 */
function tipOf(t) {
  const parts = [procTitle(t)];
  if (t.shard) parts.push(t.shard);
  if (t.worker) parts.push(t.worker);
  const mo = modelOf(t?.usage?.model || t?.model);
  if (mo) parts.push(`模型 ${mo.raw}`);
  const u = t?.usage;
  if (u && u.reported) {
    parts.push(`token 输入 ${u.input_tokens ?? "未上报"} / 输出 ${u.output_tokens ?? "未上报"} / 缓存命中 ${u.cache_read_tokens ?? "未上报"}`);
    if (typeof u.duration_ms === "number") parts.push(`日志口径耗时 ${dur(Math.round(u.duration_ms / 1000))}`);
    if (typeof u.context_used === "number") parts.push(`上下文 ${u.context_used}${u.context_window ? ` / ${u.context_window}` : ""}`);
  } else {
    parts.push(`用量${u?.unavailable_reason ? `：${u.unavailable_reason}` : "：未上报"}`);
  }
  const start = Date.parse(t.started_at || "");
  if (Number.isFinite(start)) parts.push(`调度于 ${new Date(start).toLocaleString()}`);
  return parts.join(" ");
}

/* ---------------------------------------------------------------- 监工固定行 */

const hasSupervisor = computed(() => Boolean(props.capitalist && Object.keys(props.capitalist).length));

/** 父级传了就用父级的，没传就用自取的读数（两者都有时父级优先，避免双重真相）。 */
const supervisorView = computed(() => (hasSupervisor.value ? props.capitalist : localSupervisor.value));

/* 宿主是否按积分计费：载荷带 `credit_unit` 即为积分制；积分制下无读数时不显示消耗。 */
const creditHost = computed(() => Boolean(String(supervisorView.value?.usage?.credit_unit ?? "").trim()));


const supervisorState = computed(() => {
  const s = supervisorView.value || {};
  if (!s.online) {
    return { state: s.status === "heartbeat-timeout" ? "timeout" : "stopped", ...supervisorBadge(s) };
  }
  return { state: "online", ...supervisorBadge(s) };
});

function supervisorBadge(s) {
  if (!s || !s.status) return { badge: "—", cls: "" };
  if (s.online) return { badge: "", cls: "" };
  if (s.status === "heartbeat-timeout") return { badge: "心跳超时", cls: "bad" };
  return { badge: "已停", cls: "" };
}

/** “{stage} · i/n 阶段 · 并行 p · 累计 X tokens”，下线再加“已停”。 */
const supervisorMeta = computed(() => {
  const s = supervisorView.value || {};
  if (!s || !s.status) return "—";
  const n = typeof s.stage_total === "number" ? s.stage_total : 0;
  const i = typeof s.stage_index === "number" && s.stage_index >= 0 ? s.stage_index + 1 : 0;
  const p = typeof s.parallel === "number" ? s.parallel : 0;
  const stage = s.stage ? String(s.stage) : "无阶段";
  const base = `${stage} ${i || "?"}/${n || "?"} 阶段 并行 ${p}`;
  const used = supervisorUsage.value;
  const tail = used ? ` 累计 ${used}` : s.usage && s.usage.unreported_runs > 0 ? " 累计 未上报" : "";
  return `${base}${tail}${s.online ? "" : " 已停"}`;
});

/** 本根累计消耗：积分制宿主只报积分，无读数时留空（不回退为 token）。 */
const supervisorUsage = computed(() => totalUsageText(supervisorView.value?.usage));

/** 监工行的上下文：取运行中 worker 里最满的一条（/api/supervisor 的 context）。 */
const supervisorCtx = computed(() => {
  const c = supervisorView.value?.context;
  if (!c || typeof c.used !== "number") return "";
  const used = c.used >= 1000 ? `${(c.used / 1000).toFixed(1)}k` : String(c.used);
  const win = typeof c.window === "number" && c.window > 0 ? (c.window >= 1000 ? `${(c.window / 1000).toFixed(0)}k` : String(c.window)) : "";
  return win ? `${used}/${win}` : used;
});

const supervisorTip = computed(() => {
  const s = supervisorView.value || {};
  const pid = s.pid ? `pid ${s.pid} ` : "";
  return pid + (s.board_url || "");
});

/** 未读角标：超过 99 不把行撑开（tab 是窄条，数字长了会挤掉任务名）。 */
function capNum(n) {
  const v = Number(n) || 0;
  return v > 99 ? "99+" : String(v);
}
/** 监工 tab 的未读：监工流里还没看过的事件数。 */
const supervisorUnreadShown = computed(() => Math.max(0, Number(props.supervisorUnread) || 0));

/*
 * 监工行显示的模型：优先 `supervisor_model`（监工对话层的显式选择），没有就显示默认那个具体模型。
 *
 * 接口的 `model` 是最近一次派单的模型，属于工作进程，不能当作监工模型显示。
 * `supervisor_model` 为空时，“宿主默认”不给出具体模型名，因此用同一个 `model` 作为默认模型的观测值
 * （未显式指定时监工与工作进程使用同一套宿主配置）。
 */
const supervisorModel = computed(() => {
  const s = supervisorView.value || {};
  const raw = String(s.supervisor_model || "").trim() || String(s.model || "").trim();
  return raw ? modelOf(raw) : null;
});
const supervisorModelTip = computed(() => {
  const s = supervisorView.value || {};
  const explicit = String(s.supervisor_model || "").trim();
  if (explicit) return `监工对话模型 ${explicit}`;
  const raw = String(s.model || "").trim();
  return raw ? `默认模型 ${raw}` : "宿主默认";
});

/* ---------------------------------------------------------------- 折叠 */

const FOLD_KEY = "cap.board.queue.folded";
const folded = ref(false);

function readFold() {
  try {
    folded.value = localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    /* 隐私模式下 localStorage 访问抛出异常时按默认展开处理，左栏保持可见。 */
    folded.value = false;
  }
}
function saveFold() {
  try {
    localStorage.setItem(FOLD_KEY, folded.value ? "1" : "0");
  } catch {
    /* 同上，写不进去就只在本次会话内生效。 */
  }
}
watch(folded, saveFold);

/* ---------------------------------------------------------------- 整栏收起的滚动位置 */

const rowsEl = ref(null);
let savedScroll = 0;

watch(
  () => props.collapsed,
  (v, was) => {
    if (v) {
      savedScroll = rowsEl.value ? rowsEl.value.scrollTop : 0;
      return;
    }
    if (!was) return;
    /* 等宽度过渡（240ms）走完再还原：中间帧里列的可用高度没变，但先写回更稳。 */
    setTimeout(() => {
      if (rowsEl.value) rowsEl.value.scrollTop = savedScroll;
    }, 260);
  },
);

/* ---------------------------------------------------------------- 下拉开关 */

function onDocClick(e) {
  if (!menuOpen.value) return;
  if (fbox.value && !fbox.value.contains(e.target)) menuOpen.value = false;
}
function onDocKey(e) {
  if (e.key === "Escape") menuOpen.value = false;
}
function stopHydrate() {
  if (hydTimer) {
    clearInterval(hydTimer);
    hydTimer = 0;
  }
}

onMounted(() => {
  readFold();
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKey);
  /* 父级没给状态时才自取；给了就一次都不发。 */
  if (!hasSupervisor.value) {
    hydrate();
    hydTimer = setInterval(hydrate, 8000);
  }
});
/* 父级补上 `:capitalist` 之后，自取立即收工，不留并行请求。 */
watch(hasSupervisor, (v) => {
  if (v) stopHydrate();
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onDocKey);
  stopHydrate();
});
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
