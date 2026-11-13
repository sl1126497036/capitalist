<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { CloseOutlined, DeleteOutlined, PlayCircleOutlined, SearchOutlined, ThunderboltOutlined } from "@ant-design/icons-vue";
import { dur, hhmm } from "../../lib/fmt.js";
import { t } from "../../lib/i18n.js";
/* 局部形参 t 会遮蔽模块级文案函数，取文案统一走 tr。 */
const tr = t;
import { isAlive, queueCompare } from "../../lib/queueOrder.js";
import { numberQueue, shortOf } from "../../lib/shortId.js";
/* 结束态判定与详情面板共用 lib/status.js。 */
import { endedKind, settled } from "../../lib/status.js";
import { taskTitle } from "../../lib/taskTitle.js";
/* 单位与模型名口径统一在 lib/usage.js。 */
import { billParts, fmtCtx, modelOf, totalUsageText } from "../../lib/usage.js";
/* 状态词做动作到中文的映射，判定由服务端完成。 */
import { workerDoingText } from "../../lib/doing.js";
import EmptyState from "../empty-state";

const props = defineProps({
  threads: { type: Array, default: () => [] },
  /** 派单台账用于区分进程退出与派单结项：被打回重排的单同样处于 exited。 */
  dispatches: { type: Array, default: () => [] },
  current: { type: String, default: "" },
  total: { type: Number, default: 0 },
  /** counts 为服务端全量聚合，不受筛选、搜索与折叠影响。 */
  counts: { type: Object, default: () => ({}) },
  capitalist: { type: Object, default: () => ({}) },
  supervisorUnread: { type: Number, default: 0 },
  collapsed: { type: Boolean, default: false },
  root: { type: String, default: "" },
  /** busyKey 标记清除请求中的卡，收到响应后由上层清除。 */
  busyKey: { type: String, default: "" },
  /** stopBusy 与 busyKey 分开两个键：文案不同，且同一时刻只允许一张卡处于请求中。 */
  stopBusy: { type: String, default: "" },
});
const emit = defineEmits(["pick", "capitalist", "refresh", "close", "promote", "wake", "stats", "clear", "clearCard", "forest"]);


const supervisorTitle = computed(() => {
  const p = String(props.root || "").replace(/[\\/]+$/, "");
  const name = p.split(/[\\/]/).pop() || "";
  return name ? tr("{name}-监工", { name }) : tr("监工");
});


/* 暂停档不提供清空：暂停单的处置为唤醒或关闭，归档会使该派单离开待办队列，语义与“清空列表”不同。 */
/* 已结项档同样不清空：这些单已终止，归档只影响回查。 */
const canClear = computed(
  () =>
    filter.value !== "paused" &&
    filter.value !== "closed" &&
    (counts.value[filter.value] || 0) > 0,
);
const clearAsk = ref(false);

/** 清空只归档记录，不结束运行中进程。 */
const clearBody = computed(() => {
  const n = counts.value[filter.value] || 0;
  const base = tr("将清空 {n} 项：进程记录与派单移进归档目录，列表里不再出现。", { n });
  if (filter.value === "all") return `${base}${tr("运行中的进程不会结束，完成后会重新出现在列表。")}`;
  if (filter.value === "run") return tr("这 {n} 个进程不会结束，记录移出列表，完成后会重新出现。", { n });
  if (filter.value === "queue") return tr("这 {n} 张排队中的派单会从队列撤下，监工不再派发。", { n });
  if (filter.value === "bad") return `${base}${tr("这些进程的日志将移至归档目录。")}`;
  return base;
});

function doClear() {
  clearAsk.value = false;
  /* 已取消档按 done 归档。 */
  emit("clear", filter.value === "canceled" ? "done" : filter.value);
}

const q = ref("");
const filter = ref("all");
const menuOpen = ref(false);
const fbox = ref(null);


/** 状态分档与后端 taskBucket 一致。 */
function bucket(x) {
  const s = typeof x === "string" ? x : String(x?.status || "");
  const t = typeof x === "string" ? null : x;
  if (s === "running" || s === "starting" || s === "claimed") return "run";
  if (s === "queued" || s === "open") return "queue";
  if (s === "suspended") return "queue";
  /* 暂停单独成档：该状态等待用户唤醒，与等待槽位的排队状态不同。 */
  if (s === "paused") return "paused";
  if (s === "done" || s === "finished") return "done";
  if (s === "exited") return settled(t) ? "done" : "queue";
  if (s === "canceled") return "canceled";
  /* 作废与结项单单独成档，与后端 taskBucket 同口径。 */
  if (s === "closed" || s === "superseded") return "closed";
  /* 未知状态按异常归类，与后端一致。 */
  return "bad";
}
function cell(t) {
  const s = String(t?.status || "");
  /* 后端把 closed 且 closed_by 为 user 的单标为 canceled；监工不调度，恢复需在对话中提出。 */
  if (s === "canceled") return { tone: "cancel", kind: "word", text: tr("已取消") };
  if (s === "superseded") return { tone: "cancel", kind: "word", text: tr("已作废") };
  if (s === "closed") return { tone: "cancel", kind: "word", text: tr("已结项") };
  /* 派单处于 reported 时不显示运行中或耗时；判据取后端下发的 doing，不按运行时长推断。 */
  if (String(t?.doing || "") === "report") {
    return { tone: "run", kind: "word", text: workerDoingText("report") };
  }
  if (s === "running" || s === "starting" || s === "claimed") {
    /* 判活以后端 alive 为准（另核对 pid）；文案用“进程已退出”，不用“无响应”。 */
    if (t?.alive === false) return { tone: "bad", kind: "word", text: tr("进程已退出") };
    /* 状态位按日志动作出词，读不出时回退“运行中”；耗时放在第二行。 */
    if (t?.doing) return { tone: "run", kind: "word", text: workerDoingText(t.doing) };
    return { tone: "run", kind: "word", text: tr("运行中") };
  }
  /* 结束态词条取 lib/status.js，与详情面板同一口径。 */
  const ended = endedKind(t);
  if (ended === "done") {
    const secs = closedSecs(t);
    return secs === null ? { tone: "done", ...NA_DUR } : { tone: "done", kind: "dur", text: dur(secs) };
  }
  if (ended === "wakeup") return { tone: "warn", kind: "word", text: tr("待重派") };
  /* 排队区分等待前置单与普通排队；stuck_on 与 stuck_on_no 由后端下发，前端不读 after、不自行推导。 */
  if (s === "queued" || s === "open") {
    const no = String(t?.stuck_on_no || "").trim();
    if (no) return { tone: "warn", kind: "word", text: tr("等待 #{no}", { no }) };
    const id = String(t?.stuck_on || "").trim();
    if (id) return { tone: "warn", kind: "word", text: tr("等待 #{no}", { no: shortOf(id) }) };
    return { tone: "warn", kind: "word", text: tr("排队") };
  }
  if (s === "suspended") return { tone: "warn", kind: "word", text: tr("已让位") };
  if (s === "failed" || s === "missing" || s === "orphan" || s === "gone") {
    if (String(t?.retry_verdict || "") === "hold") {
      return { tone: "bad", kind: "word", text: tr("暂不重派") };
    }
    return { tone: "bad", kind: "word", text: tr("异常") };
  }
  if (s === "paused") return { tone: "warn", kind: "word", text: tr("已暂停") };
  if (s === "held") return { tone: "warn", kind: "word", text: tr("接管中") };
  return { tone: "idle", kind: "word", text: tr("待调度") };
}

/* 占位文案随语言变化，用 getter 取值。 */
const NA_DUR = { kind: "na", get text() { return tr("无采样"); } };

/** 运行时长从调度时刻算起；duration_sec 为下限，重启后可能滞后。 */
function liveSecs(t) {
  const start = Date.parse(t?.started_at || "");
  const fromServer = Number(t?.duration_sec) > 0 ? Number(t.duration_sec) : 0;
  if (!Number.isFinite(start)) return fromServer > 0 ? fromServer : null;
  return Math.max(fromServer, Math.round((Date.now() - start) / 1000));
}

/** 已结束时长优先取 duration_sec，缺失时按首末消息时间回落，都没有则为 null。 */
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


function spendOf(t) {
  const u = t?.usage;
  if (!u || !u.reported) return { text: "", num: "", unit: "" };
  if (u.billing_unit === "usd" && typeof u.cost_usd === "number" && u.cost_usd > 0) {
    return billParts(u.cost_usd, "usd");
  }
  if (typeof u.credit === "number") {
    return billParts(u.credit, u.credit_unit || "credit");
  }
    /* 积分制宿主未分摊到积分时留空。 */
  if (creditHost.value) return { text: "", num: "", unit: "" };
  if (typeof u.total_tokens === "number") {
    return billParts(u.total_tokens, "token");
  }
  return { text: "", num: "", unit: "" };
}

function ctxOf(t) {
  const u = t?.usage;
  if (!u || typeof u.context_used !== "number") return "";
  return fmtCtx(u.context_used, u.context_window, u.context_over === true);
}

function metaOf(t) {
  const st = String(t?.status || "");
  const secs = isAlive(t)
    ? liveSecs(t)
    /* 排队与暂停均未运行，耗时无采样；暂停可持续较长时间，不按结束态计算时长。 */
    : st === "queued" || st === "open" || st === "paused"
      ? null
      : closedSecs(t);
  const sp = spendOf(t);
  return {
    at: hhmm(t?.started_at || ""),
    durText: secs === null ? "" : dur(secs),
    spend: sp.num,
  };
}


const localSupervisor = ref({});
const dispatches = ref([]);
let hydTimer = 0;

async function hydrate() {
  if (hasSupervisor.value) return;
  try {
    const r = await fetch("./api/supervisor", { headers: { accept: "application/json" } });
    if (r.ok) localSupervisor.value = (await r.json()) || {};
  } catch {
  }
  if (!dispatches.value.length) {
    try {
      const r = await fetch("./api/state", { headers: { accept: "application/json" } });
      if (r.ok) dispatches.value = (await r.json())?.dispatches || [];
    } catch {
    }
  }
}


/** 线程到派单的匹配先按 dispatch id，再回落到同分片。 */
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


const startedMs = (t) => Date.parse(t?.started_at || "") || 0;


const FILTERS = computed(() => {
  const out = [
    { key: "all", label: tr("全部"), tone: "" },
    { key: "run", label: tr("运行中"), tone: "run" },
    { key: "queue", label: tr("排队"), tone: "warn" },
    /* 暂停档在启动后固定列出，与队列状态无关。 */
    { key: "paused", label: tr("已暂停"), tone: "warn" },
    { key: "bad", label: tr("异常"), tone: "bad" },
    { key: "done", label: tr("已完成"), tone: "done" },
  ];
  if ((counts.value.canceled || 0) > 0) out.push({ key: "canceled", label: tr("已取消"), tone: "cancel" });
  if ((counts.value.closed || 0) > 0) out.push({ key: "closed", label: tr("已结项"), tone: "cancel" });
  return out;
});

const curFilter = computed(() => FILTERS.value.find((f) => f.key === filter.value) || FILTERS.value[0]);

/* 派单编号参与搜索：后端 no 字段，输入 46 或 #46 均命中；# 前缀剥掉后按子串匹配。 */
function searchMatch(t) {
  const raw = q.value.trim().toLowerCase();
  if (!raw) return true;
  const key = raw.startsWith("#") ? raw.slice(1) : raw;
  const no = String(t?.no || "").trim() || numbering.value.get(t.id) || "";
  const hay = `${procTitle(t)} ${t.shard || ""} ${t.id || ""} ${t.worker || ""} ${no ? `${no} #${no}` : ""}`.toLowerCase();
  return hay.includes(key);
}

function visible(t) {
  return showStale.value || !staleOf(t) || String(q.value || "").trim() !== "";
}

function matchThread(t) {
  if (filter.value !== "all" && bucket(t) !== filter.value) return false;
  return searchMatch(t);
}

const base = computed(() => props.threads.filter(searchMatch).filter(visible));

const list = computed(() =>
  base.value
    .filter((t) => filter.value === "all" || bucket(t) === filter.value)
    .slice()
    .sort(queueCompare),
);

/* 各档计数取 /api/threads 的 counts，total 由服务端构造为各状态之和。 */
const counts = computed(() => {
  const s = props.counts || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    all: num(s.total),
    run: num(s.running),
    queue: num(s.queued),
    paused: num(s.paused),
    bad: num(s.failed),
    done: num(s.done),
    canceled: num(s.canceled),
    closed: num(s.closed),
  };
});

watch(
  counts,
  (v) => emit("stats", { ...v }),
  { immediate: true, deep: true },
);

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
  /* 暂停由用户设置，保留时长不表示数据陈旧，不自动折叠。 */
  if (s === "running" || s === "starting" || s === "queued" || s === "claimed" || s === "paused") return false;
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
  }
}

const staleCount = computed(() => props.threads.filter(searchMatch).filter(staleOf).length);


/** 按队列顺序统一取号，使任务行与消息引用读到同一个号。 */
const numbering = computed(() => numberQueue(props.threads));

/* 任务键与后端 taskKeyOf 同口径：有分片按阶段/分片，无分片按血缘；同一任务的重派共用一个键。 */
function taskKeyOf(t) {
  const stage = String(t?.stage || "").trim();
  const shard = String(t?.shard || "").trim();
  const lineage = String(t?.lineage || "").trim();
  if (shard) return `${stage}/${shard}`;
  if (lineage) return `${stage}/x${lineage.slice(-6)}`;
  return `${stage}/id${String(t?.id || "")}`;
}

function histRowOf(t) {
  const c = cell(t);
  const m = metaOf(t);
  return {
    t,
    short: numbering.value.get(t.id) || shortOf(t.id),
    tone: c.tone,
    word: c.kind === "word" ? c.text : "",
    at: m.at ? `${m.at} ${tr("启动")}` : tr("启动 未记录"),
    durText: m.durText,
    spend: m.spend,
    tip: tipOf(t),
  };
}

function rowOf(t, history) {
  const c = cell(t);
  const m = metaOf(t);
  return {
    t,
    title: shownName(t),
    short: numbering.value.get(t.id) || shortOf(t.id),
    retry: history.length,
    history: history.map(histRowOf),
    ids: [t.id, ...history.map((h) => h.id)],
    tone: c.tone,
    word: c.kind === "word" ? c.text : "",
    at: m.at,
    durText: m.durText,
    model: modelOf(t?.usage?.model || t?.model),
    stuck: t?.stuck || null,
    /* 未读只判有无新回复、界面不显示数字；排队档尚无回复，不画未读点。 */
    unreadDot: (Number(t?.unread) || 0) > 0 && bucket(t) !== "queue",
    tip: tipOf(t),
  };
}

function groupByTask(threads) {
  const groups = new Map();
  for (const t of threads) {
    const key = taskKeyOf(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = [];
  for (const arr of groups.values()) {
    /* 最近一次派单取启动时间最晚者；时间相同按 id 判定，轮询之间不跳动。 */
    arr.sort((a, b) => startedMs(b) - startedMs(a) || (String(b.id) < String(a.id) ? -1 : 1));
    out.push({ latest: arr[0], history: arr.slice(1) });
  }
  return out;
}

const rows = computed(() =>
  groupByTask(list.value)
    .map(({ latest, history }) => rowOf(latest, history))
    .sort((a, b) => queueCompare(a.t, b.t)),
);

const histOpen = reactive({});

function toggleHist(id) {
  const key = String(id || "");
  if (!key) return;
  histOpen[key] = !histOpen[key];
}

const shown = computed(() => rows.value);

function pickFilter(key) {
  filter.value = key;
  menuOpen.value = false;
  /* 切换筛选档时收起确认框，避免沿用上一档的计数。 */
  clearAsk.value = false;
}



const closing = ref("");

/* 后端 closeTask 仅拦截 done/closed 终态，运行、排队、暂停、exited 未结与回执档均可关闭；异常档执行清除。 */
function canClose(t) {
  /* 已结束、已取消与异常档只提供清除：同一张卡同时给出关闭与清除，会让人以为还要再关一次。 */
  const b = bucket(t);
  if (b === "done" || b === "canceled" || b === "bad") return false;
  const s = String(t?.status || "");
  if (s === "running" || s === "starting" || s === "claimed" || s === "queued" || s === "open") return true;
  /* 暂停单可能已经过时，支持直接关闭，无需先唤醒。 */
  if (s === "paused") return true;
  if (s === "failed" || s === "missing" || s === "orphan" || s === "gone") return false;
  if (s === "exited") return !settled(t);
  return String(t?.doing || "") === "report";
}

function canPromote(t) {
  const s = String(t?.status || "");
  return s === "queued" || s === "open";
}

/** 只有暂停单能唤醒：其余状态没有暂停标记，调后端会按 409 拒绝。 */
function canWake(t) {
  return String(t?.status || "") === "paused";
}

/** 同一后端动作在排队行称“取消”、运行中行称“关闭”。 */
function closeWord(t) {
  return canPromote(t) ? tr("取消") : tr("关闭");
}

function closeTip(t) {
  return canPromote(t)
    ? tr("从队列撤下，监工不再派发")
    : tr("结项并停止重派，运行中进程先结束");
}

const promoting = ref("");

/** 首次点击只进入确认态：立即执行会让运行中进程挂起、排队单被越过。 */
function promoteTap(r) {
  promoting.value = promoting.value === r.t.id ? "" : r.t.id;
  closing.value = "";
  clearing.value = "";
  waking.value = "";
}

function promoteConfirm(r) {
  emit("promote", { id: r.t.dispatch || r.t.id, shard: r.t.shard || "", title: r.title });
  promoting.value = "";
}

const waking = ref("");

/** 唤醒需两次点击确认：旧单可能已经过时，确认后该单重新进入调度。 */
function wakeTap(r) {
  waking.value = waking.value === r.t.id ? "" : r.t.id;
  promoting.value = "";
  closing.value = "";
  clearing.value = "";
}

function wakeConfirm(r) {
  emit("wake", { id: r.t.dispatch || r.t.id, shard: r.t.shard || "", title: r.title });
  waking.value = "";
}

function closeTap(r) {
  closing.value = closing.value === r.t.id ? "" : r.t.id;
  promoting.value = "";
  clearing.value = "";
  waking.value = "";
}

function closeConfirm(r) {
  emit("close", { id: r.t.dispatch || r.t.id, shard: r.t.shard || "", title: r.title });
  closing.value = "";
}


/* 清除只写标记让卡离开列表，历史台账保留；异常档先结项再打标记，运行中与排队不提供清除。 */
function canClearCard(t) {
  const b = bucket(t);
  return b === "done" || b === "canceled" || b === "bad";
}

const clearing = ref("");

function clearTip(t) {
  return bucket(t) === "bad"
    ? tr("结项并停止重派，记录保留")
    : tr("移出列表，记录保留");
}

function clearTap(r) {
  clearing.value = clearing.value === r.t.id ? "" : r.t.id;
  promoting.value = "";
  closing.value = "";
  waking.value = "";
}

function clearConfirm(r) {
  emit("clearCard", { key: r.t.id, dispatch: r.t.dispatch || r.t.id, title: r.title });
  clearing.value = "";
}


/* 卡片悬停显示上下文与消耗两项，以空格分隔；消耗值统一由 spendOf 计算。 */
function tipOf(t) {
  const ctx = ctxOf(t);
  const sp = spendOf(t).text;
  const parts = [ctx ? tr("上下文 {v}", { v: ctx }) : tr("上下文 未上报")];
  /* 积分制宿主无积分读数时整项省略。 */
  if (sp) parts.push(tr("消耗 {v}", { v: sp }));
  else if (!creditHost.value) parts.push(tr("消耗 未上报"));
  return parts.join(" ");
}


const hasSupervisor = computed(() => Boolean(props.capitalist && Object.keys(props.capitalist).length));

const supervisorView = computed(() => (hasSupervisor.value ? props.capitalist : localSupervisor.value));

/*
 * 宿主是否按积分计费：载荷带 `credit_unit` 即为积分制（未派发 worker 时服务端以账号额度单位填充）。
 * 积分制下无积分读数时不显示消耗，不回退为 token。
 */
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
  if (s.status === "heartbeat-timeout") return { badge: tr("心跳超时"), cls: "bad" };
  return { badge: tr("已停"), cls: "" };
}

const supervisorMeta = computed(() => {
  const s = supervisorView.value || {};
  if (!s || !s.status) return "—";
  const alive = typeof s.running === "number" ? s.running : 0;
  const queued = typeof s.queued === "number" ? s.queued : 0;
  const bits = [alive > 0 ? tr("运行中 {n}", { n: alive }) : tr("空闲")];
  if (queued > 0) bits.push(tr("排队 {n}", { n: queued }));
  const used = supervisorUsage.value;
  if (used) bits.push(tr("累计 {v}", { v: used }));
  else if (s.usage && s.usage.unreported_runs > 0) bits.push(tr("累计 未上报"));
  if (!s.online) bits.push(tr("已停"));
  return bits.join(" ");
});

/** 本根累计消耗：积分制宿主只报积分，无读数时留空（不回退为 token）。 */
const supervisorUsage = computed(() => totalUsageText(supervisorView.value?.usage));

const supervisorCtx = computed(() => {
  const c = supervisorView.value?.context;
  if (!c || typeof c.used !== "number") return "";
  const cap = typeof c.limit === "number" && c.limit > 0 ? c.limit : c.window;
  const lim = typeof cap === "number" && cap > 0 ? cap : 0;
  return fmtCtx(c.used, lim, c.over === true);
});

/** 未读角标超过 99 时收口，避免撑宽窄 tab。 */
function capNum(n) {
  const v = Number(n) || 0;
  return v > 99 ? "99+" : String(v);
}
const supervisorUnreadShown = computed(() => Math.max(0, Number(props.supervisorUnread) || 0));

/* 监工行模型优先取 supervisor_model；为空时用接口 model（最近一次派单的模型）作为宿主默认的观测值。 */
const supervisorModel = computed(() => {
  const s = supervisorView.value || {};
  const raw = String(s.supervisor_model || "").trim() || String(s.model || "").trim();
  return raw ? modelOf(raw) : null;
});
const supervisorModelTip = computed(() => {
  const s = supervisorView.value || {};
  const explicit = String(s.supervisor_model || "").trim();
  if (explicit) return tr("监工对话模型：{m}", { m: explicit });
  const raw = String(s.model || "").trim();
  return raw ? tr("默认模型 {m}", { m: raw }) : tr("宿主默认");
});


const FOLD_KEY = "cap.board.queue.folded";
const folded = ref(false);

function readFold() {
  try {
    folded.value = localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    folded.value = false;
  }
}
function saveFold() {
  try {
    localStorage.setItem(FOLD_KEY, folded.value ? "1" : "0");
  } catch {
  }
}
watch(folded, saveFold);


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
    /* 等宽度过渡结束后再恢复滚动位置。 */
    setTimeout(() => {
      if (rowsEl.value) rowsEl.value.scrollTop = savedScroll;
    }, 260);
  },
);

/* 按任务编号滚动定位并短暂高亮（1.2 秒后移除）；编号缺失、任务不在当前列表或整栏收起时静默返回。 */
function revealByNo(no) {
  const want = Number(String(no ?? "").replace(/^#/, ""));
  if (!Number.isFinite(want) || want <= 0) return;
  const hit = rows.value.find((r) => Number(r.short) === want);
  if (!hit) return;
  const box = rowsEl.value;
  if (!box) return;
  const safe = String(hit.t.id).replace(/"/g, '\\"');
  const el = box.querySelector(`[data-tid="${safe}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1200);
}

defineExpose({ revealByNo });


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
  if (!hasSupervisor.value) {
    hydrate();
    hydTimer = setInterval(hydrate, 8000);
  }
});
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
