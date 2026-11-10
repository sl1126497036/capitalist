<script setup>
/* 结构与消息分两条通道：结构按周期轮询、各接口单独处理失败；消息由 /stream 信号触发拉取，推流连续两次断开后降级为轮询。 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import HeaderBar from "./components/header-bar";
import QueuePane from "./components/queue-pane";
import ChatPane from "./components/chat-pane";
import SupervisorStrip from "./components/supervisor-strip";
import ForestPane from "./components/forest-pane";
import { msgRef } from "./lib/fmt.js";
import { lang, t } from "./lib/i18n.js";
/* 局部 t 会遮蔽模块级文案函数，取文案统一走 $t 别名。 */
const $t = t;
import { clampWidth as clampLimit, dragWidth } from "./lib/splitter.js";

const PORT = (typeof location !== "undefined" && location.port) || "";
const pageTitle = () => t("capitalist 监工看板") + (PORT ? ` :${PORT}` : "");

const tasks = ref([]);
const root = ref("");
const capitalist = ref({});
/* 首帧未取得 /api/supervisor 前按连接中处理。 */
const capitalistLoaded = ref(false);
const metrics = ref({});
/* 服务端缓存使暂停或恢复成功后立即重拉仍可能返回旧值：指令成功时先本地上屏目标态，接口值追平后交回服务端。 */
const pauseOverride = ref(null);
let pauseOverrideTimer = 0;
const pausedView = computed(() =>
  pauseOverride.value === null ? Boolean(metrics.value?.paused) : pauseOverride.value,
);

/*
 * 当前宿主：取监工记录里的 worker_host 与注册表标签。
 * 监听离线或字段缺失时返回空串，顶栏不显示该胶囊，避免出现空白占位。
 */
const boardHost = computed(() => String(metrics.value?.supervisor?.worker_host ?? "").trim());
const boardHostLabel = computed(() => String(metrics.value?.supervisor?.worker_host_label ?? "").trim());

function applyPause(v) {
  const want = Boolean(v);
  clearTimeout(pauseOverrideTimer);
  pauseOverride.value = Boolean(metrics.value?.paused) === want ? null : want;
  if (pauseOverride.value !== null) {
    pauseOverrideTimer = window.setTimeout(() => {
      pauseOverride.value = null;
    }, 12000);
  }
  load();
}

watch(
  () => Boolean(metrics.value?.paused),
  (v) => {
    if (pauseOverride.value !== null && v === pauseOverride.value) {
      clearTimeout(pauseOverrideTimer);
      pauseOverride.value = null;
    }
  },
);
const boardState = ref(null);
/** /api/overview：顶栏跨监工读数条的数据源。 */
const overview = ref(null);
const threads = ref([]);
/** /api/threads 的 counts：左栏筛选与任务分组的数据源。 */
const threadCounts = ref({});
const threadTotal = ref(0);
const sel = ref("capitalist");
const messages = ref([]);
/** 监工流时间窗（小时），0 表示不限。 */
const supervisorHours = ref(24);

/* 左栏开合状态只由 App 持有，QueuePane 仅接收 collapsed；其 localStorage 键与左栏任务列表折叠键相互独立。 */
const QUEUE_KEY = "cap.board.queue.collapsed";
const queueCollapsed = ref(false);

/* 工作树开关由 QueuePane 发事件，开合状态与 ForestPane 的挂载由 App 持有。 */
const forestOpen = ref(false);

/* 左栏宽度只写在外壳的 --w-left，QueuePane 按该变量排版；宽度持久化在 localStorage。 */
const QUEUE_WIDTH_KEY = "cap.board.queue.width";
const WIDTH_DEFAULT = 330;
const WIDTH_MIN = 260;
const WIDTH_MAX = 720;
const queueWidth = ref(WIDTH_DEFAULT);
const dragging = ref(false);
const leftEl = ref(null);

function clampWidth(px) {
  return clampLimit(px, WIDTH_MIN, WIDTH_MAX, WIDTH_DEFAULT);
}

function readQueueWidth() {
  try {
    const raw = localStorage.getItem(QUEUE_WIDTH_KEY);
    queueWidth.value = raw ? clampWidth(raw) : WIDTH_DEFAULT;
  } catch {
    queueWidth.value = WIDTH_DEFAULT;
  }
}

function saveQueueWidth() {
  try {
    localStorage.setItem(QUEUE_WIDTH_KEY, String(queueWidth.value));
  } catch {
  }
}

const resetWidth = () => {
  queueWidth.value = WIDTH_DEFAULT;
  saveQueueWidth();
};

/* 起点按指针绝对位移计算，初始宽度须取左栏外壳，取 .body 会按整行宽计算；拖动中关闭宽度过渡，并用 pointer 捕获保证指针移出窗口后仍收到 move / up 事件。 */
let dragFrom = null;

function onResizeStart(e) {
  /* 只认主键（左键 / 触控笔尖）；右键、中键按下不算开始拖。 */
  if (e.button !== undefined && e.button !== 0) return;
  const rect = leftEl.value?.getBoundingClientRect?.();
  dragFrom = { x: e.clientX, width: rect ? rect.width : queueWidth.value };
  dragging.value = true;
  e.currentTarget?.setPointerCapture?.(e.pointerId);
  /* 拖拽期间禁用文本选择，避免右栏轮询刷新时选区干扰拖动。 */
  document.body.style.userSelect = "none";
  e.preventDefault();
}

function onResizeMove(e) {
  if (!dragFrom) return;
  queueWidth.value = dragWidth({ startX: dragFrom.x, startWidth: dragFrom.width, x: e.clientX, min: WIDTH_MIN, max: WIDTH_MAX });
}

function onResizeEnd(e, save) {
  if (!dragFrom) return;
  dragFrom = null;
  dragging.value = false;
  document.body.style.userSelect = "";
  e?.currentTarget?.releasePointerCapture?.(e.pointerId);
  if (save) saveQueueWidth();
}

/* 指针在窗口外松开时收不到 pointerup，由 pointercancel 与失焦事件解除文本选择锁定。 */
function onResizeCancel() {
  if (!dragFrom) return;
  onResizeEnd(null, true);
}

function onResizeKey(e) {
  const step = e.shiftKey ? 64 : 16;
  if (e.key === "ArrowLeft") queueWidth.value = clampWidth(queueWidth.value - step);
  else if (e.key === "ArrowRight") queueWidth.value = clampWidth(queueWidth.value + step);
  else if (e.key === "Home") queueWidth.value = WIDTH_DEFAULT;
  else return;
  e.preventDefault();
  saveQueueWidth();
}

function readQueue() {
  readQueueWidth();
  try {
    queueCollapsed.value = localStorage.getItem(QUEUE_KEY) === "1";
  } catch {
    queueCollapsed.value = false;
  }
}
watch(queueCollapsed, (v) => {
  try {
    localStorage.setItem(QUEUE_KEY, v ? "1" : "0");
  } catch {
  }
});
function toggleQueue() {
  queueCollapsed.value = !queueCollapsed.value;
}
/* /stream 的逐字缓冲按工作进程 id 累积，落库正文到达后由 ChatPane 判定退场。 */
const liveOut = ref({});
/* 正在等对话回执的会话集合：回执未落或请求未结束前，状态条用它区分「生成中」与「已结束」。 */
const talkBusy = ref(new Set());
const msgTotal = ref(0);
const msgTruncated = ref(false);
/** 监工流时间窗之外还有事件时置真；该值为真时显示「展开更早的消息」。 */
const msgHasOlder = ref(false);
const notice = ref(null);
/* 监工流没有 unread 字段，前端按事件总数记水位、差值算未读；总数因时间窗滑出而变小时同步下调水位，不显示负数。 */
const CAPITALIST_SEEN_KEY = "cap.board.capitalist.seen";
const supervisorTotal = ref(0);
const supervisorSeen = ref(0);
try {
  supervisorSeen.value = Number(localStorage.getItem(CAPITALIST_SEEN_KEY) || 0) || 0;
} catch {
  supervisorSeen.value = 0;
}
const supervisorUnread = computed(() => Math.max(0, supervisorTotal.value - supervisorSeen.value));

function markSupervisorSeen(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return;
  const changed = v !== supervisorSeen.value || v !== supervisorTotal.value;
  supervisorTotal.value = v;
  supervisorSeen.value = v;
  if (!changed) return;
  try {
    localStorage.setItem(CAPITALIST_SEEN_KEY, String(v));
  } catch {
  }
}

const err = ref("");
const errKind = ref("");
/* 在途请求按计数记录，不用于判定能否发送：多条消息并行各自等待。 */
const inflight = ref(0);
const sending = computed(() => inflight.value > 0);
/* 切换会话后消息清空到新数据返回之间保持载入态，避免先闪现空态。 */
const loading = ref(true);
/* 当前缓冲拿到第一份结果前只显示载入指示，避免刷新时先闪空态；请求失败不清成空态，走失败提示。 */
const msgPending = ref(true);
const conn = ref("connecting");
const fails = ref(0);


const curThread = computed(() => threads.value.find((t) => t.id === sel.value) || null);
const isSupervisor = computed(() => sel.value === "capitalist");

const alive = computed(() => ["running", "starting"].includes(String(curThread.value?.status || "")));

/** 线程到派单的匹配先按 dispatch id，再回落到同分片，与左栏一致。 */
function dispatchOf(t) {
  if (!t) return null;
  const ds = boardState.value?.dispatches || [];
  if (t.dispatch) {
    const d = ds.find((x) => x.id === t.dispatch);
    if (d) return d;
  }
  if (t.shard) {
    const d = ds.find((x) => x.shard === t.shard);
    if (d) return d;
  }
  return null;
}

/* /api/state 的 dispatch.action 已截断，完整派单正文取线程接口的首条 dispatch 消息，消息未到时才回落快照。 */
const orderAction = computed(() => {
  const t = curThread.value;
  if (!t) return "";
  const full = messages.value.find((m) => m?.kind === "dispatch" && String(m?.text || "").trim());
  return String(full?.text || dispatchOf(t)?.action || t.action || "");
});

/* 验收项取派单正文的编号条目与 /api/state 中按分片过滤的未通过 gate；报告路径仅作定位线索，不读取内容。 */
const ACCEPT_LINE = /^\s*(\d+)[.、)]\s+(.+)$/;

function numberedOf(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = ACCEPT_LINE.exec(line.trim());
    if (m) out.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return out.slice(0, 8);
}

const orderPanel = computed(() => {
  const t = curThread.value;
  if (!t) return { items: [], gate: [], report: "" };
  const action = orderAction.value;
  const shard = String(t.shard || "");
  return {
    items: numberedOf(action).map((x) => ({ id: `${t.id}-${x.n}`, n: x.n, text: x.text })),
    gate: (boardState.value?.gate || [])
      .map((x) => String(x || ""))
      .filter((x) => Boolean(shard) && x.includes(shard)),
    report: (action.match(/\.workbuddy\/reports\/[\w.-]+\.json/) || [""])[0],
  };
});

/** 生成中：线程存活且最近动作在 20 秒内，与活动条同一口径。 */
const typing = computed(() => {
  if (!alive.value) return false;
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const idle = messages.value[i]?.idle_sec;
    if (typeof idle === "number") return idle < 20;
  }
  return true;
});

/* 输入区始终可输入；没有有效工作进程目标时消息转交监工。 */
const readonly = computed(() => false);


function q(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  return u.toString();
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 单个接口失败只影响该块，返回默认值而不抛出。 */
async function safe(url, fallback) {
  try {
    return await getJson(url);
  } catch {
    return fallback;
  }
}

/* 消息取数区分失败与零条；失败不转为默认值。 */
async function tryJson(url) {
  try {
    return { ok: true, data: await getJson(url) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 消息请求失败时显示全局「请求失败」提示。 */
function msgRequestFail(error) {
  errKind.value = "request";
  err.value = $t("请求失败 {m}", { m: error });
}

/** 消息请求成功后清掉「请求失败」类异常条，脚本异常保留。 */
function msgRequestOk() {
  if (errKind.value === "request") {
    err.value = "";
    errKind.value = "";
  }
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data.ok !== false, data };
}

/* 切根或切会话时请求换代，过期响应的结果直接忽略，避免覆盖新数据。 */
let epoch = 0;

/* 线程列表到达后发出消息请求；消息只依赖线程 id，不等待串行的结构计算。 */
/* 首屏加载态等消息请求落地才收，避免结构先返回时消息区短暂空白。 */
let firstMessages = Promise.resolve();

async function loadThreads(thenMessages = false) {
  const my = epoch;
  const withRoot = root.value ? { root: root.value } : {};
  const thrRes = await safe(`./api/threads?${q({ ...withRoot, limit: 500 })}`, { threads: [] });
  if (my !== epoch) return;
  threads.value = thrRes?.threads || [];
  threadCounts.value = thrRes?.counts || {};
  threadTotal.value = Number(thrRes?.counts?.total ?? thrRes?.total ?? threads.value.length);
  ensureSel();
  if (thenMessages) firstMessages = loadMessages();
}

async function loadStructure(thenMessages = false) {
  const my = epoch;
  const withRoot = root.value ? { root: root.value } : {};
  /* 先判定在线状态；离线时不请求列表与会话接口。 */
  const supervisorRes = await safe(`./api/supervisor?${q(withRoot)}`, {});
  if (my !== epoch) return;
  capitalist.value = supervisorRes || {};
  capitalistLoaded.value = true;
  if (!supervisorRes?.online) {
     /*
      * 离线时切到「未启动」态：任务、消息、指标、流式行清空；
      * 顶栏读数条（额度 / 内存）与调度无关，离线时仍继续刷新。
      */
    threads.value = [];
    threadCounts.value = {};
    threadTotal.value = 0;
    tasks.value = [];
    messages.value = [];
    msgPending.value = false;
    liveOut.value = {};
    metrics.value = {};
    boardState.value = null;
    notice.value = null;
    overview.value = await safe("./api/overview", null);
    return;
  }
  const thrP = loadThreads(thenMessages);
  const [taskRes, metRes, ovRes, stRes] = await Promise.all([
    safe("./api/tasks", { tasks: [] }),
    safe(`./api/metrics?${q(withRoot)}`, {}),
    /* overview 失败只影响顶栏读数条，不拖垮结构。 */
    safe("./api/overview", null),
    safe(`./api/state?${q(withRoot)}`, null),
  ]);
  await thrP;
  if (my !== epoch) return;
  tasks.value = taskRes?.tasks || [];
  if (!root.value && tasks.value.length) {
    root.value = tasks.value[0].root || "";
    /* 任务根确定后立即补发首份消息请求：首屏那次请求根尚未确定，只能空返回。 */
    loadMessages();
  }
  if (!root.value) {
    /* 结构确认无任务根时收掉载入指示，显示「尚未选择任务根」。 */
    msgPending.value = false;
  }
  metrics.value = metRes || {};
  overview.value = ovRes;
  boardState.value = stRes;
  /* 每 5 轮结构刷新触发一次消息全窗口校正。 */
  pollSeq += 1;
  if (pollSeq % 5 === 0) forceFull = true;
  ensureSel();
}

/* 刷新后默认选中监工面板；会话内的选择在切根时按 viewByRoot 保留。 */
let autoPicked = false;
function ensureSel() {
  if (autoPicked) return;
  autoPicked = true;
  if (sel.value !== "capitalist" && !threads.value.some((t) => t.id === sel.value)) sel.value = "capitalist";
}

/** 消息时间戳（毫秒）；格式不可解析时返回 null，排在末尾并保持原顺序。 */
function msOf(v) {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : null;
}

/*
 * 按稳定 id 合并，再按 at 归位。服务端窗口分页，未加载的历史消息可能后到，
 * 统一追加到尾部会排在新消息之后。同一时间戳与缺时间戳的条目保持原有相对次序；
 * 本地回显无 at，留在末尾。
 */
function mergeMessages(prev, next) {
  const idx = new Map();
  prev.forEach((m, i) => idx.set(msgRef(m), i));
  const out = prev.slice();
  for (const m of next) {
    const id = msgRef(m);
    const at = idx.get(id);
    if (at === undefined) {
      idx.set(id, out.length);
      out.push(m);
    } else {
      out[at] = m;
    }
  }
  /* 稳定归位：有时间按时间升序，同一时间或两边都缺时间时用原下标保证次序稳定。 */
  const keyed = out.map((m, i) => ({ m, i, t: msOf(m?.at) }));
  keyed.sort((a, b) => {
    if (a.t === null && b.t === null) return a.i - b.i;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return a.t - b.t || a.i - b.i;
  });
  const sorted = keyed.map((x) => x.m);
  /* 已读过的消息不因为滑出服务端窗口而消失；上限只防无限增长。 */
  return sorted.length > 1200 ? sorted.slice(sorted.length - 1200) : sorted;
}

/* 发送后立即插入本地回显，允许连续追加；服务端落库后按同文与时间认领，本地那条自动退场。 */
const echoes = ref([]);
let echoSeq = 0;
/** 本地回显三分钟未落库即移除。 */
const ECHO_TTL = 3 * 60 * 1000;

/** 判同忽略标点、空格与全半角，与 ChatPane 一致。 */
function normSay(s) {
  return String(s || "")
    .replace(/^\[(?:附件|图\s*\d*)\][^\n]*$/gm, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：！？,.;:!?~～"'“”‘’（）()【】\[\]<>《》\-—_]/g, "")
    .toLowerCase();
}

function pushEcho(thread, text, attachments) {
  echoSeq += 1;
  const item = {
    id: `L-${Date.now().toString(36)}-${echoSeq}`,
    at: new Date().toISOString(),
    role: "user",
    kind: "say",
    text: String(text || ""),
    status: "",
    thread: String(thread || ""),
    local: true,
    attachments: Array.isArray(attachments) ? attachments : [],
  };
  echoes.value = [...echoes.value, item];
  return item;
}

function pruneEchoes() {
  const now = Date.now();
  const keep = echoes.value.filter((e) => now - (Date.parse(String(e.at || "")) || 0) < ECHO_TTL);
  if (keep.length !== echoes.value.length) echoes.value = keep;
}

/* 渲染串由服务端消息与未被认领的本地回显组成；认领要求同为本人、同文，且服务端时间不早于本地 4 秒。 */
const shownMessages = computed(() => {
  const mine = echoes.value.filter((e) => String(e.thread || "") === sel.value);
  if (!mine.length) return messages.value;
  const left = mine.slice();
  const out = [];
  for (const m of messages.value) {
    out.push(m);
    if (String(m.role || "") !== "user") continue;
    const key = normSay(m.text);
    if (!key) continue;
    const at = Date.parse(String(m.at || "")) || 0;
    const i = left.findIndex((e) => normSay(e.text) === key && at >= (Date.parse(String(e.at || "")) || 0) - 4000);
    if (i >= 0) left.splice(i, 1);
  }
  return left.length ? [...out, ...left] : out;
});

/* since 游标之后的结果只追加不替换；输出块正文会随 id 不变而增长，故每 5 轮做一次全窗口校正，done 帧到达时也强制校正。 */
let msgSince = 0;
let msgKey = "";
let pollSeq = 0;
let forceFull = false;

async function loadMessages() {
  /*
   * 调度进程未运行时不请求会话。SSE 与 400ms 抖动刷新仍会触发这里，
   * 离线后忽略迟到的历史响应。
   */
  if (!capitalist.value?.online) {
    messages.value = [];
    msgPending.value = false;
    return;
  }
  const my = epoch;
  const withRoot = root.value ? { root: root.value } : {};
  const key = `${root.value}|${sel.value}`;
  if (key !== msgKey) {
    /* 换会话即整块换缓冲：消息流按会话隔离，保留其它会话的消息会混入当前窗口。 */
    msgKey = key;
    msgSince = 0;
    forceFull = true;
    messages.value = [];
    msgTotal.value = 0;
    msgTruncated.value = false;
    msgHasOlder.value = false;
    msgPending.value = true;
  }
  if (isSupervisor.value) {
    if (!root.value) {
      messages.value = [];
      return;
    }
    /* 监工流无 since 游标，按 supervisorHours 时间窗做全窗口合并；hours=0 表示不限。 */
    const res = await tryJson(`./api/capitalist-events?${q({ ...withRoot, limit: 400, hours: supervisorHours.value })}`);
    /* 返回时若已切换会话，该结果属于上一栏，不写入缓冲。 */
    if (my !== epoch || key !== msgKey) return;
    if (!res.ok) {
      msgPending.value = false;
      msgRequestFail(res.error);
      return;
    }
    msgRequestOk();
    msgPending.value = false;
    const d = res.data;
    const list = d?.messages || [];
    const total = Number(d?.total || list.length);
    messages.value = mergeMessages(messages.value, list);
    msgTotal.value = total;
    msgTruncated.value = false;
    /* 窗口之外是否还有事件由服务端判定，前端不依据条数推断。 */
    msgHasOlder.value = Boolean(d?.has_older);
    /* 查看监工会话时水位更新到最新，未读归零。 */
    markSupervisorSeen(total);
    return;
  }

  const t = curThread.value;
  if (!t) {
    /* 选中进程未出现在返回窗口时保留右栏内容，不清空。 */
    if (!threads.value.length) messages.value = [];
    /* 选不中进程时按已有结果收掉载入指示，不停在载入中。 */
    msgPending.value = false;
    return;
  }

  const full = forceFull || !msgSince;
  forceFull = false;
  const url = `./api/thread?${q({
    ...withRoot,
    id: t.id,
    shard: t.shard || "",
    limit: 300,
    ...(full ? {} : { since: msgSince }),
  })}`;
  const res = await tryJson(url);
  if (my !== epoch || key !== msgKey) return;
  if (!res.ok) {
    /* 请求失败走失败提示；游标作废，下次改走全量补齐缺口。 */
    msgPending.value = false;
    msgSince = 0;
    msgRequestFail(res.error);
    return;
  }
  msgRequestOk();
  msgPending.value = false;
  const d = res.data;
  const list = d.messages || [];
  messages.value = mergeMessages(messages.value, list);
  msgTotal.value = Number(d.total || messages.value.length);
  msgTruncated.value = Boolean(d.truncated);
  /* 响应被截断说明服务端窗口已滑走，游标失效，退回全量取数。 */
  if (d.truncated) msgSince = 0;
  else if (typeof d.next_since === "number") msgSince = d.next_since;
}

/* 展开更早的消息把时间窗放宽为不限并重拉全量；窗口变化后结果集不同，只重拉不追加。 */
function loadOlder() {
  if (supervisorHours.value === 0) return;
  supervisorHours.value = 0;
  msgSince = 0;
  forceFull = true;
  loadMessages();
}

async function load() {
  const my = epoch;
  try {
    await loadStructure(true);
    await firstMessages;
    pruneEchoes();
    if (errKind.value === "request") {
      err.value = "";
      errKind.value = "";
    }
  } catch (e) {
    errKind.value = "request";
    err.value = $t("请求失败 {m}", { m: e instanceof Error ? e.message : String(e) });
  } finally {
    /* 加载态由切栏点亮、由本处收；请求换代后不收，避免提前熄掉新一栏的加载态。 */
    if (my === epoch) loading.value = false;
  }
}


let structTimer = 0;
let msgTimer = 0;
let es = null;
let streamFails = 0;
let retryTimer = 0;
let debounceTimer = 0;
let pageHidden = false;

function scheduleRefresh() {
  if (pageHidden) return;
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    loadMessages();
  }, 400);
}

/* SSE 只作为有新内容的信号，不承载结构数据；连续两次断开即降级为轮询，10 秒后重试，轮询本身不受影响。 */
function openStream() {
  clearTimeout(retryTimer);
  try {
    es = new EventSource("./stream");
  } catch {
    degrade();
    return;
  }
  es.addEventListener("open", () => {
    streamFails = 0;
    fails.value = 0;
    conn.value = "live";
  });
  es.addEventListener("output", (evt) => {
    conn.value = "live";
    let d = null;
    try {
      d = JSON.parse(evt.data || "{}");
    } catch {
      d = null;
    }
    if (d && d.worker) applyFrame(d);
    scheduleRefresh();
  });
  es.addEventListener("error", () => {
    streamFails += 1;
    if (streamFails >= 2) degrade();
  });
}

/* 同一工作进程的 seq 跳号时标一次全窗口校正补齐缺口；重复或过期帧不写入；done 帧标志本段结束、逐字缓冲收起。 */
function applyFrame(d) {
  const id = String(d.worker);
  const prev = liveOut.value[id] || { seq: 0, text: "", at: "", done: false };
  const at = String(d.at || prev.at || "");
  if (d.seq && d.seq <= prev.seq) return;
  if (d.seq > prev.seq + 1 && prev.seq > 0) forceFull = true;
  const next = {
    seq: Number(d.seq || prev.seq || 0),
    text: String(prev.text || "") + String(d.text || ""),
    at,
    done: Boolean(d.done),
  };
  if (next.done && next.seq === prev.seq) return;
  liveOut.value = { ...liveOut.value, [id]: next };
  /* 逐字缓冲只保留最近 12 条，避免浏览历史进程时无界增长。 */
  const keys = Object.keys(liveOut.value);
  if (keys.length > 12) {
    const old = keys
      .filter((k) => k !== id)
      .sort((a, b) => String(liveOut.value[a].at).localeCompare(String(liveOut.value[b].at)))
      .slice(0, keys.length - 12);
    if (old.length) {
      const copy = { ...liveOut.value };
      for (const k of old) delete copy[k];
      liveOut.value = copy;
    }
  }
}

function degrade() {
  closeStream();
  if (conn.value !== "online") conn.value = "degraded";
  retryTimer = window.setTimeout(() => {
    if (!pageHidden) openStream();
  }, 10_000);
}

function closeStream() {
  if (!es) return;
  try {
    es.close();
  } catch {
  }
  es = null;
}

/* 不在监工会话时每 10 秒取一条仅用于读 total；未读数为总数与水位的差值，首次取值只作基线。 */
let supervisorPeekTimer = 0;

async function peekSupervisorTotal() {
  if (isSupervisor.value || !root.value || pageHidden) return;
  const d = await safe(`./api/capitalist-events?${q({ root: root.value, limit: 1 })}`, null);
  const n = Number(d?.total);
  if (!Number.isFinite(n)) return;
  if (!supervisorSeen.value) {
    supervisorSeen.value = n;
    supervisorTotal.value = n;
    try {
      localStorage.setItem(CAPITALIST_SEEN_KEY, String(n));
    } catch {
    }
    return;
  }
  if (n < supervisorSeen.value) {
    supervisorSeen.value = n;
    try {
      localStorage.setItem(CAPITALIST_SEEN_KEY, String(n));
    } catch {
    }
  }
  supervisorTotal.value = n;
}

function startTimers() {
  stopTimers();
  structTimer = window.setInterval(loadStructure, 5000);
  msgTimer = window.setInterval(loadMessages, 5000);
  supervisorPeekTimer = window.setInterval(peekSupervisorTotal, 10_000);
  peekSupervisorTotal();
}

function stopTimers() {
  clearInterval(structTimer);
  clearInterval(msgTimer);
  clearInterval(supervisorPeekTimer);
  structTimer = 0;
  msgTimer = 0;
  supervisorPeekTimer = 0;
}

/** 页面隐藏时停轮询，回前台补齐一次再继续。 */
function onVisibility() {
  pageHidden = document.hidden;
  if (pageHidden) {
    stopTimers();
    return;
  }
  load();
  startTimers();
  if (!es) openStream();
}

function applyTitle() {
  const p = String(root.value || "").replace(/[\\/]+$/, "");
  const name = p.split(/[\\/]/).pop() || "";
  document.title = name ? `${name}-${t("监工")} capitalist` : pageTitle();
}
watch(root, applyTitle);
/* 切换界面语言时重写标签页标题，其中的界面文案需随语言更新。 */
watch(lang, applyTitle);

onMounted(() => {
  applyTitle();
  readQueue();
  load().then(() => {
    startTimers();
    openStream();
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("keydown", onHotkey);
  window.addEventListener("error", onScriptError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("capitalist:restarting", onRestarting);
});

onUnmounted(() => {
  epoch += 1;
  stopTimers();
  closeStream();
  clearTimeout(retryTimer);
  clearTimeout(debounceTimer);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("keydown", onHotkey);
  window.removeEventListener("error", onScriptError);
  window.removeEventListener("unhandledrejection", onRejection);
  window.removeEventListener("capitalist:restarting", onRestarting);
  clearTimeout(restartTimer);
});

/* 全局异常处理覆盖模板与事件回调抛出的错误，记录来源与文件行号。 */
function onScriptError(e) {
  const at = e?.filename ? `（${e.filename}:${e.lineno || 0}）` : "";
  errKind.value = "script";
  err.value = `${$t("脚本异常")} ${e?.message || $t("未知错误")}${at}`;
}

function onRejection(e) {
  const r = e?.reason;
  errKind.value = "promise";
  err.value = `${$t("未处理的 Promise")} ${r?.message || String(r || $t("未知原因"))}`;
}


/** 按任务根记录上次选中的会话，切回时恢复该选择。 */
const viewByRoot = new Map();

function pickRoot(r) {
  if (r === root.value) return;
  viewByRoot.set(root.value, sel.value);
  epoch += 1;
  root.value = r;
  messages.value = [];
  msgTotal.value = 0;
  msgTruncated.value = false;
  autoPicked = true;
  sel.value = viewByRoot.get(r) || "capitalist";
  notice.value = null;
  /* 切换任务根时右栏清空并进入加载态，不保留上一根的内容。 */
  loading.value = true;
  load();
}

function pickThread(id) {
  if (id === sel.value) return;
  epoch += 1;
  sel.value = id;
  messages.value = [];
  notice.value = null;
  loading.value = true;
  load();
}

function pickSupervisor() {
  if (sel.value === "capitalist") return;
  epoch += 1;
  sel.value = "capitalist";
  messages.value = [];
  notice.value = null;
  loading.value = true;
  /* 进入监工会话时未读立即归零，不等下一轮轮询。 */
  markSupervisorSeen(supervisorTotal.value);
  load();
}

/* 编号到任务卡的匹配与滚动高亮由 QueuePane 完成，App 只转交事件。 */
const queuePane = ref(null);

function onLocateTask(no) {
  queuePane.value?.revealByNo(no);
}

function onHotkey(e) {
  if (!e.ctrlKey || e.key !== "Tab" || !tasks.value.length) return;
  e.preventDefault();
  const i = tasks.value.findIndex((t) => t.root === root.value);
  const step = e.shiftKey ? -1 : 1;
  const next = tasks.value[(i + step + tasks.value.length) % tasks.value.length];
  if (next) pickRoot(next.root);
}

/* /api/capitalist-chat 为流式响应：正文逐字追加，思考与工具调用各占一行，返回最终的 done 事件供调用方收尾。 */
async function streamChat(text, thread, onDelta, via = "", quote = null) {
  const res = await fetch("./api/capitalist-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    /* 请求随带 ref 与首行摘要；后端按 ref 取不到原文时用摘要回落，被引原文拼进发给模型的内容。 */
    body: JSON.stringify({
      text,
      thread: thread || "",
      via: via || "",
      ...(quote && quote.ref ? { quote: quote.ref, quote_text: String(quote.text || "").slice(0, 200) } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done = null;
  for (;;) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    buf += dec.decode(value, { stream: true });
    let cut = buf.indexOf("\n\n");
    while (cut >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.kind === "done") done = d;
          else onDelta(d);
        } catch {
        }
      }
      cut = buf.indexOf("\n\n");
    }
  }
  return done;
}

let talkSeq = 0;

/* 写一次性回执时把 talkSeq 前推一格，避免仍在运行的老对话响应覆盖较新的回执。 */
function setNotice(next) {
  talkSeq += 1;
  notice.value = next;
}
async function talkTo(text, thread, via = "", quote = null) {
  /* 多条消息可并行发送，活行只保留最后发起那一路的响应，较早的响应忽略。 */
  const mine = (talkSeq += 1);
  /* 流式回执按会话隔离；监工对话归一为 "capitalist"，与 chat-pane 的 sel 一致，避免混入工作进程气泡。 */
  const owner = thread || "capitalist";
  talkBusy.value = new Set(talkBusy.value).add(owner);
  const live1 = (fn) => {
    if (mine === talkSeq) fn();
  };
  let acc = "";
  let think = "";
  let tool = "";
  /* 监工活行只放过程内容：工具调用、思考与生成回复逐条更新、不堆叠，最终回复作为普通消息上屏；工作进程侧优先展示生成中的正文。 */
  let process = "";
  /* 续接会话期间无正文增量，状态帧用于显示等待进度。 */
  let stage = "";
  const isSupervisorTalk = owner === "capitalist";
  /* 过程气泡只写生成中的正文；状态帧归活行，空内容不清空已有输出。 */
  const paintBubble = (t) => {
    if (isSupervisorTalk || !t) return;
    const cur = liveOut.value[owner] || {};
    if (String(cur.text || "") === t) return;
    liveOut.value = {
      ...liveOut.value,
      [owner]: { seq: Number(cur.seq || 0), text: t, at: new Date().toISOString(), done: false },
    };
  };
  const paint = () => {
    if (mine !== talkSeq) return;
    if (isSupervisorTalk) {
      notice.value = { text: process || stage || $t("已发出 模型在想"), bad: false, thread: owner };
      return;
    }
    /* 状态条按正文、工具、思考、过程帧的优先级取当前可显示内容。 */
    const line =
      acc ||
      (tool ? $t("正在调用 {tool}", { tool }) : "") ||
      (think ? `${$t("思考中")} ${think.slice(-48)}` : "") ||
      stage ||
      $t("已发出 模型在想");
    notice.value = { text: line, bad: false, thread: owner };
    paintBubble(acc);
  };
  paint();
  try {
    const done = await streamChat(text, thread, (d) => {
      if (d.kind === "status") {
        stage = $t(String(d.text || ""));
        paint();
      } else if (d.kind === "text") {
        acc += d.text;
        process = $t("正在生成回复");
        paint();
      } else if (d.kind === "thinking") {
        think += d.text;
        process = `${$t("思考中")} ${think.slice(-48)}`;
        paint();
      } else if (d.kind === "tool") {
        tool = String(d.name || $t("工具"));
        process = $t("正在调用 {tool}", { tool });
        paint();
      } else if (d.kind === "error") {
        live1(() => {
          notice.value = { text: String(d.text || $t("对话失败")), bad: true, thread: owner };
        });
      }
    }, via, quote);
    if (done) {
      const applied = String(done.applied || "");
      /* 上屏正文取服务端算好的 display 字段，前端不另行拼接。 */
      const shown = String(done.display ?? done.reply ?? "").trim();
      live1(() => {
        notice.value = { text: shown || applied || $t("已处理"), bad: false, thread: owner, final: true };
      });
      /* 正文由消息流上屏后移除同内容的过程气泡。 */
      if (!isSupervisorTalk) {
        const cur = liveOut.value[owner];
        if (cur && acc && String(cur.text || "") === acc) {
          const copy = { ...liveOut.value };
          delete copy[owner];
          liveOut.value = copy;
        }
      }
    }
  } catch (e) {
    live1(() => {
      notice.value = { text: `${$t("对话失败")} ${e instanceof Error ? e.message : String(e)}`, bad: true, thread: owner };
    });
  } finally {
    const rest = new Set(talkBusy.value);
    rest.delete(owner);
    talkBusy.value = rest;
  }
}

/** quote 为 {ref, text}，随监工会话请求一并发送。 */
async function sendSupervisor(text, quote = null) {
  await talkTo(text, "", "", quote);
}

/** 追加消息只登记待办，不中断当前进程；quote 为 {ref, text}。 */
async function say(text, quote) {
  const t = curThread.value;
  if (!t) {
    setNotice({ text: $t("没有可发送的进程"), bad: true });
    return false;
  }
  const body = { id: t.worker || t.id, shard: t.shard || "", action: "say", text };
  if (quote && quote.ref) {
    body.quote = quote.ref;
    if (quote.text) body.quote_text = String(quote.text).slice(0, 200);
  }
  const r = await postJson("./api/command", body);
  if (!r.ok) {
    setNotice({ text: `${$t("插话失败")} ${r.data.error || r.data.reason || $t("未知原因")}`, bad: true });
    return false;
  }
  setNotice({ text: $t("已登记（{eff}生效）", { eff: r.data.effective || $t("下一次派单") }), bad: false });
  return true;
}

/* 先插入本地回显再发请求：输入框随即清空并可继续输入，请求只影响活行。 */
async function onSend(text, quoteRef, meta) {
  const thread = isSupervisor.value ? "capitalist" : sel.value;
  pushEcho(thread, meta?.text || text, meta?.attachments || []);
  inflight.value += 1;
  try {
    if (isSupervisor.value || !curThread.value) {
      await sendSupervisor(text, quoteRef);
    } else {
      const t = curThread.value;
      /* 进程已结束也走这条对话接口：服务端在原会话里接着答，不会把一句问话变回一次重开。 */
      await talkTo(text, t.id, meta?.via || "", quoteRef);
    }
    load();
  } finally {
    inflight.value -= 1;
    pruneEchoes();
  }
}

/* 中断顺序固定为 say 登记、可选 block、最后 stop-worker；反序会在进程退出与阻塞登记之间留出重派窗口。 */
async function onInterject({ text, alsoBlock, quote }) {
  const t = curThread.value;
  if (!t || inflight.value > 0) return;
  if (text) pushEcho(sel.value, text, []);
  inflight.value += 1;
  try {
    if (text) await say(text, quote);
    if (alsoBlock) {
      const b = await postJson("./api/command", {
        action: "block",
        type: "manual",
        reason: $t("用户中断工作进程后登记阻塞"),
      });
      if (!b.ok) setNotice({ text: `${$t("登记阻塞失败")} ${b.data.error || $t("未知原因")}`, bad: true });
    }
    const r = await postJson("./api/command", { action: "stop-worker", id: t.worker || t.id, shard: t.shard || "" });
    setNotice(
      r.ok
        ? { text: `${$t("已中断")} ${r.data.worker || t.id} ${r.data.effective || $t("下一轮调度重派")}`, bad: false }
        : { text: `${$t("中断失败")} ${r.data.error || r.data.reason || $t("未知原因")}`, bad: true },
    );
    load();
  } finally {
    inflight.value -= 1;
    pruneEchoes();
  }
}

/** 交还监工按钮只在人工介入期间显示。 */
async function onHandback() {
  const t = curThread.value;
  if (!t) return;
  const r = await postJson("./api/command", { action: "release", id: t.id, shard: t.shard || "" });
  setNotice(
    r.ok
      ? { text: $t("已交还监工，下一轮调度起恢复自动裁定"), bad: false }
      : { text: `${$t("交还失败")} ${r.data.error || $t("未知原因")}`, bad: true },
  );
  load();
}

/* 结项由后端把派单置为 closed（在跑先结单再 SIGTERM，排队直接撤下）；请求期间单号写入 cardStopBusy 供 QueuePane 铺蒙版，同一时刻只允许一张卡处于请求中。 */
/* 操作蒙版至少停留 320ms，避免请求过快时蒙版一闪而过。 */
const BUSY_MIN_MS = 320;
function holdBusy(startedAt) {
  const left = BUSY_MIN_MS - (Date.now() - startedAt);
  return left > 0 ? new Promise((r) => setTimeout(r, left)) : Promise.resolve();
}

const cardStopBusy = ref("");
async function onCloseTask({ id, shard, title }) {
  if (!id || cardStopBusy.value) return;
  const startedAt = Date.now();
  cardStopBusy.value = id;
  try {
    const r = await postJson("./api/command", { action: "close", id, shard: shard || "" });
    /* 结项与清除的回执走页面级浮层，不进会话流，避免被监工当作用户消息读入。 */
    showToast(
      r.ok
        ? r.data.effective || `${$t("已结项")} ${r.data.dispatch || id} ${$t("监工不再为它补单")}`
        : `${$t("结项失败")} ${r.data.error || r.data.reason || $t("未知原因")}`,
      !r.ok,
    );
    if (sel.value && (sel.value === id || curThread.value?.dispatch === id)) {
      /* 关闭当前选中线程时回到监工流。 */
      pickSupervisor();
    }
    load();
  } finally {
    await holdBusy(startedAt);
    cardStopBusy.value = "";
  }
}

/* 确认框在 QueuePane，App 只发指令并按结果回报；回执按后端 promote 返回的 preempt 与越单数生成，前端不判定。 */
async function onPromoteTask({ id, shard, title }) {
  if (!id) return;
  const r = await postJson("./api/command", { action: "promote", id, shard: shard || "" });
  setNotice(
    r.ok
      ? { text: r.data.effective || r.data.detail || `${$t("已置顶")} ${title || r.data.dispatch || id}`, bad: false }
      : { text: `${$t("插队失败")} ${r.data.error || r.data.reason || $t("未知原因")}`, bad: true },
  );
  load();
}

/* 唤醒同样使用页面级回执；暂停单可能已过时，回执说明「下一 tick 起参与调度」。 */
async function onWakeTask({ id, shard, title }) {
  if (!id) return;
  const r = await postJson("./api/command", { action: "wake", id, shard: shard || "" });
  setNotice(
    r.ok
      ? { text: r.data.effective || r.data.detail || `${$t("已唤醒")} ${title || r.data.dispatch || id}`, bad: false }
      : { text: `${$t("唤醒失败")} ${r.data.error || r.data.reason || $t("未知原因")}`, bad: true },
  );
  load();
}

/* bucket 取界面筛选档名（all / done / bad）；后端只归档已结束记录，在跑与排队的保留。 */
async function onClearThreads(bucket) {
  const r = await postJson("./api/command", { action: "clear-threads", bucket: String(bucket || "all") });
  showToast(
    r.ok
      ? r.data.effective || $t("已清空")
      : `${$t("清空失败")} ${r.data.error || r.data.reason || $t("未知原因")}`,
    !r.ok,
  );
  load();
}

/* 清除类操作反馈走页顶浮层并自动消失；bad 为 true 时停留更久。 */
const toast = ref(null);
let toastTimer = 0;
function showToast(text, bad = false) {
  toast.value = { text, bad };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, bad ? 6000 : 4000);
}
onUnmounted(() => clearTimeout(toastTimer));

/* 清除单卡由后端先结项（异常单）再打标记，不删记录；请求期间卡 id 写入 cardBusy 供按钮显示进行态，结果只走 showToast。 */
const cardBusy = ref("");
async function onClearCard({ key }) {
  if (!key || cardBusy.value) return;
  const startedAt = Date.now();
  cardBusy.value = key;
  try {
    const r = await postJson("./api/command", { action: "clear-thread", key });
    showToast(
      r.ok
        ? r.data.effective || $t("已清除该任务卡")
        : `${$t("清除失败")} ${r.data.error || r.data.reason || $t("未知原因")}`,
      !r.ok,
    );
    if (sel.value === key) pickSupervisor();
    load();
  } finally {
    await holdBusy(startedAt);
    cardBusy.value = "";
  }
}

/* 状态行只统计服务端给出的在跑进程数（含将起、已领），不受筛选与搜索影响。 */
const runningCount = computed(() => Number(threadCounts.value?.running || 0));

/**
 * 离线原因仅用于选择提示文案：lost 心跳失联 / ended 上一轮已结束 / never 未启动。
 *
 * 服务端将所有非 running 状态归为 status:"stopped"，仅凭该字段无法区分后两种，
 * 用 last_status 补充「已完成」状态。
 */
const offlineKind = computed(() => {
  const s = capitalist.value || {};
  if (String(s.status || "") === "heartbeat-timeout") return "lost";
  const last = String(s.last_status || "");
  if (last === "done" || last === "exited" || last === "finished") return "ended";
  return "never";
});

/** 离线态提示按状态组织；看板连接失败时单独提示读数可能过期。 */
const offlineView = computed(() => {
  const s = capitalist.value || {};
  if (conn.value === "fail") {
    return { title: t("看板连接失败"), desc: t("接口未响应，页面读数可能已过期。") };
  }
  if (offlineKind.value === "lost") {
    return {
      title: t("监工心跳失联"),
      desc: t("心跳已 {n} 秒未更新，进程可能已退出。重新启动监工后可继续。", {
        n: Number(s.heartbeat_age_sec || 0),
      }),
    };
  }
  if (offlineKind.value === "ended") {
    return { title: t("上一轮已结束"), desc: t("上一轮任务已结束。继续任务需重新启动监工。") };
  }
  return { title: t("监工未启动"), desc: t("派单与查看消息需先启动监工。") };
});

/* 命令以可选中的纯文本呈现，复制失败不提示错误。 */
const cmdCopied = ref(false);
let cmdTimer = 0;
const SUPERVISE_CMD = "capitalist supervise";
async function copySupervise() {
  try {
    await navigator.clipboard.writeText(SUPERVISE_CMD);
    cmdCopied.value = true;
    clearTimeout(cmdTimer);
    cmdTimer = window.setTimeout(() => {
      cmdCopied.value = false;
    }, 1600);
  } catch {
    cmdCopied.value = false;
  }
}


/* 跨监工读数由 OverviewStrip 渲染；当前监工的读数与阶段进度由 ChatPane 按 props.capitalist 计算，App 不搬运。 */

/* 监工自动重载期间 reload.active 为 true，蒙版铺满视口并拦截指针与键盘事件；标记回到 false 后随轮询自动撤除。 */
/* 用户点重启时 metric-bar 派发 capitalist:restarting，App 接住并铺蒙版；监工重新上线 2 秒后撤除，另设 30 秒上限。 */
const restartMask = ref(false);
let restartTimer = 0;
function onRestarting() {
  restartMask.value = true;
  clearTimeout(restartTimer);
  restartTimer = window.setTimeout(() => {
    restartMask.value = false;
  }, 30_000);
}
watch(
  () => Boolean(capitalist.value?.online),
  (online) => {
    if (!online || !restartMask.value) return;
    clearTimeout(restartTimer);
    restartTimer = window.setTimeout(() => {
      restartMask.value = false;
    }, 2000);
  },
);
const ctxMask = computed(() => Boolean(capitalist.value?.reload?.active) || restartMask.value);

</script>

<template>
  <!-- 四层光晕须为 #app 的直接子元素（见 styles/app.css）。 -->
  <div class="glow-a" aria-hidden="true" />
  <div class="glow-b" aria-hidden="true" />

  <div class="page">
    <HeaderBar
      :online="Boolean(capitalist?.online)"
      :state="offlineKind"
      :detail="capitalist?.detail || ''"
      :running="Number(capitalist?.running || 0)"
      :root="root"
      :conn="conn"
      :fails="fails"
      :paused="pausedView"
      :overview="overview"
      :host="boardHost"
      :host-label="boardHostLabel"
    />

    <div class="body">
      <!-- 未在线时渲染状态区；首帧未取得 /api/supervisor 前按「连接中」处理；离线时不提供消息输入入口。 -->
      <template v-if="!capitalistLoaded || !capitalist?.online">
        <div v-if="!capitalistLoaded" class="boot-pane" role="status" aria-live="polite">
          <span class="boot-dots" aria-hidden="true"><i/><i/><i/></span>
          <span>{{ t("正在连接看板…") }}</span>
        </div>

        <div v-else class="off-pane">
          <div class="off-card" role="status">
            <div class="off-title">{{ offlineView.title }}</div>
            <p class="off-desc">{{ offlineView.desc }}</p>
            <div class="off-cmd">
              <code class="off-code">{{ SUPERVISE_CMD }}</code>
              <button type="button" class="off-copy" @click="copySupervise">
                {{ cmdCopied ? t("已复制") : t("复制命令") }}
              </button>
            </div>
            <p class="off-note">
              {{ t("该命令需在任务目录执行；监工启动后页面自动连接。") }}
            </p>
          </div>
        </div>
      </template>

      <template v-else>
      <!-- 收起时只把外壳宽度过渡到 0，内部 QueuePane 固定 330 不重排；inert 保证收起后列表按钮不被 Tab 选中。 -->
      <div
        ref="leftEl"
        class="leftwrap"
        :class="{ collapsed: queueCollapsed, dragging }"
        :style="{ '--w-left': `${queueWidth}px` }"
        :inert="queueCollapsed"
        :aria-hidden="queueCollapsed ? 'true' : 'false'"
      >
        <!-- 监工 tab 与任务队列同属左栏，顶栏不渲染；数量多时整行横向滚动、不换行。 -->
        <SupervisorStrip
          class="q-supervisor-strip"
          :tasks="tasks"
          :current="root"
          @pick="pickRoot"
        />

        <QueuePane
          ref="queuePane"
          :threads="threads"
          :dispatches="boardState?.dispatches || []"
          :current="sel"
          :total="threadTotal"
          :counts="threadCounts"
          :capitalist="capitalist || {}"
          :root="root"
          :capitalist-unread="supervisorUnread"
          :collapsed="queueCollapsed"
          :busy-key="cardBusy"
          :stop-busy="cardStopBusy"
          @pick="pickThread"
          @capitalist="pickSupervisor"
          @refresh="load"
          @close="onCloseTask"
          @promote="onPromoteTask"
          @wake="onWakeTask"
          @clear="onClearThreads"
          @clear-card="onClearCard"
          @forest="forestOpen = true"
        />
      </div>

      <!-- 左栏收起时分隔条一并去掉（列宽已为 0，无可拖分界）。 -->
      <div
        v-if="!queueCollapsed"
        class="splitter"
        :class="{ dragging }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('任务队列宽度')"
        :aria-valuenow="queueWidth"
        :aria-valuemin="WIDTH_MIN"
        :aria-valuemax="WIDTH_MAX"
        @pointerdown="onResizeStart"
        @pointermove="onResizeMove"
        @pointerup="(e) => onResizeEnd(e, true)"
        @pointercancel="onResizeCancel"
        @lostpointercapture="onResizeCancel"
        @dblclick="resetWidth"
        @keydown="onResizeKey"
      />

      <ChatPane
        :sel="sel"
        :offline="capitalistLoaded && !capitalist?.online"
        :root="root"
        :messages="shownMessages"
        :live-out="liveOut"
        :total="msgTotal"
        :truncated="msgTruncated"
        :can-load-older="isSupervisor && supervisorHours !== 0 && msgHasOlder"
        @load-older="loadOlder"
        :thread="curThread"
        :threads="threads"
        :dispatches="boardState?.dispatches || []"
        :capitalist="capitalist || {}"
        :acceptance="orderPanel"
        :notice="notice"
        :sending="sending"
        :talk-busy="talkBusy"
        :readonly="readonly"
        :typing="typing"
        :loading="loading"
        :msg-pending="msgPending"
        :reload="capitalist?.reload || null"
        :can-interject="alive"
        :running="runningCount"
        :counts="threadCounts"
        :queue-collapsed="queueCollapsed"
        :paused="pausedView"
        @toggle-queue="toggleQueue"
        @send="onSend"
        @interject="onInterject"
        @handback="onHandback"
        @pause="applyPause"
        @capitalist="pickSupervisor"
        @pick="pickThread"
        @locate="onLocateTask"
        @close="onCloseTask"
        @refresh="load"
      />
      </template>

      <div v-if="err" class="errbar" :class="errKind" role="alert">{{ err }}</div>

      <!-- 蒙版在捕获阶段拦截键盘、对指针事件一律 prevent，重载结束后随 reload.active 翻 false 自动撤除。 -->
      <div
        v-if="ctxMask"
        class="ctx-mask"
        role="alertdialog"
        aria-modal="true"
        :aria-label="t('重启中...')"
        @click.stop.prevent
        @pointerdown.stop.prevent
        @pointerup.stop.prevent
        @mousedown.stop.prevent
        @mouseup.stop.prevent
        @submit.stop.prevent
        @keydown.capture.stop.prevent
        @wheel.stop.prevent
      >
        <div class="ctx-mask-box">
          <div class="ctx-mask-title">
            <span class="ctx-mask-spin" aria-hidden="true"></span>
            {{ t("重启中...") }}
          </div>
          <div class="ctx-mask-note">{{ t("重启期间界面暂停，完成后自动恢复调度。若未自动恢复，可在宿主唤起或终端执行 capitalist supervise 重新拉起监工。") }}</div>
        </div>
      </div>
    </div>
  </div>

  <Transition name="toastfade">
    <div v-if="toast" class="page-toast" :class="{ bad: toast.bad }" role="status">
      {{ toast.text }}
    </div>
  </Transition>

  <!-- 工作树看板 Teleport 到 body；关闭时不发请求。 -->
  <ForestPane :root="root" :open="forestOpen" @close="forestOpen = false" />
</template>

<style scoped>
.page {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--s16) var(--s16) 0;
  background: var(--surface-2);
  border-radius: 0 18px 16px 16px;
  overflow: hidden;
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  border-top: 1px solid var(--line-3);
}

/* 只改变外壳宽度，内部 .queue 固定 330 不重排；右栏 flex:1 随之铺满。 */
.leftwrap {
  flex: 0 0 auto;
  width: var(--w-left);
  /* 窗口窄于左栏宽度时左栏让位，分隔条跟随其右边界。 */
  max-width: 100%;
  /* 左栏高度受 .body 约束，内部自行滚动，避免列高把整页顶开。 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 240ms cubic-bezier(0.4, 0, 0.2, 1);
  will-change: width;
}
.leftwrap.collapsed {
  width: 0;
}
.leftwrap.dragging {
  transition: none;
}

.q-supervisor-strip {
  flex: 0 0 auto;
  padding: 0 var(--s8);
  border-bottom: 1px solid var(--line-soft);
  overflow-x: auto;
  scrollbar-width: none;
}
.q-supervisor-strip::-webkit-scrollbar {
  display: none;
}
.q-supervisor-strip :deep(.strip) {
  padding: 0;
  gap: var(--s6);
  flex-wrap: nowrap;
  overflow-x: auto;
}
.q-supervisor-strip :deep(.tab) {
  height: 34px;
}

/* 中线为伪元素且 pointer-events: none，事件由外层 6px 宽的命中区域接收。 */
.splitter {
  position: relative;
  flex: 0 0 6px;
  width: 6px;
  margin-left: -3px;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.splitter::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: var(--line-3);
  pointer-events: none;
  transition: background 160ms ease;
}
.splitter:hover::before,
.splitter:focus-visible::before,
.splitter.dragging::before {
  background: var(--info-line);
}
.splitter.dragging::before {
  width: 2px;
  left: 2px;
}
.leftwrap :deep(.queue) {
  /* 列方向以 flex-basis 覆盖组件自身的 330 宽度基准，高度按外壳撑满。 */
  flex: 1 1 auto;
  min-height: 0;
  transition:
    transform 240ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 240ms cubic-bezier(0.4, 0, 0.2, 1);
}
.leftwrap.collapsed :deep(.queue) {
  transform: translateX(-16px);
  opacity: 0.55;
}
/* 系统开启「减少动态效果」时直接换宽度，不做过渡。 */
@media (prefers-reduced-motion: reduce) {
  .leftwrap,
  .leftwrap :deep(.queue) {
    transition: none;
  }
}

.errbar {
  position: absolute;
  left: var(--s16);
  right: var(--s16);
  bottom: var(--s8);
  padding: var(--s6) var(--s10);
  border-radius: var(--r-row);
  background: var(--bad-bg-2);
  border: 1px solid var(--bad-line);
  color: var(--t-row-bad-time);
  font-size: var(--f-tiny);
}
.errbar.promise {
  background: var(--note-bg);
  border-color: var(--note-line);
  color: var(--note-text);
}
.errbar.request {
  background: var(--info-bg);
  border-color: var(--info-line);
  color: var(--info-text);
}

/* 蒙版 fixed 铺满视口，z-index 高于 app.css 的最高一层（9000）；光标保持普通箭头。 */
.ctx-mask {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--veil);
  backdrop-filter: blur(3px);
  user-select: none;
}

.ctx-mask-box {
  max-width: 420px;
  padding: var(--s16) var(--s16);
  border-radius: 14px;
  background: var(--surface-4);
  border: 1px solid var(--line-3);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.38);
  text-align: center;
}

.ctx-mask-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s6);
  font-size: var(--f-card);
  font-weight: 600;
  color: var(--t2);
}

.ctx-mask-spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--line-3);
  border-top-color: var(--info-line);
  animation: ctx-mask-rotate 900ms linear infinite;
}

@keyframes ctx-mask-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ctx-mask-spin {
    animation: none;
  }
}

.ctx-mask-note {
  margin-top: var(--s6);
  font-size: var(--f-tiny);
  color: var(--t7);
  line-height: 1.7;
}

/* 浮层固定在页顶居中并自动消失；失败档（.bad）用红字、停留更久。 */
.page-toast {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  max-width: min(72vw, 640px);
  padding: 10px 18px;
  border-radius: 10px;
  /* 底色须不透明：--surface-3 在深色主题下为半透明，顶栏文字会透上来；改用四套主题都不透明的 --raise。 */
  background: var(--raise, #101628);
  border: 1px solid var(--line-2);
  color: var(--t1, #f2f2f2);
  font-size: var(--f-tiny, 12px);
  line-height: 1.6;
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
  pointer-events: none;
  /* 提示前的圆点按语义着色：成功用 --ok、失败用 --bad，与卡片状态点同一套。 */
  display: flex;
  align-items: center;
  gap: var(--s8, 8px);
}

.page-toast::before {
  content: "";
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok, #4ec9a0);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok, #4ec9a0) 18%, transparent);
}

.page-toast.bad {
  color: #ff9c9c;
}

.page-toast.bad::before {
  background: var(--bad, #ff6b6b);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad, #ff6b6b) 18%, transparent);
}

.toastfade-enter-active,
.toastfade-leave-active {
  transition: opacity 240ms ease, transform 240ms ease;
}

.toastfade-enter-from,
.toastfade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

/* 首帧占位：仅在 /api/supervisor 首次返回前显示，与离线面板分属不同渲染层。 */
.boot-pane {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s8);
  font-size: var(--f-body);
  color: var(--t5);
}

.boot-dots {
  display: inline-flex;
  gap: 3px;
}

.boot-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: bootpulse 1.1s ease-in-out infinite;
}

.boot-dots i:nth-child(2) { animation-delay: 0.15s; }
.boot-dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes bootpulse {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

/* 离线主区：占满右栏，显示离线状态与启动方式，不渲染在线态控件。 */
/* 保持垂直居中，通过下内边距上移内容，使其不贴近顶部且不落在视口偏下位置。 */
.off-pane {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  /* 空态贴近主区域上部：垂直居中会使矮窗口出现大面积空白，提示被状态条遮挡。 */
  align-items: flex-start;
  justify-content: center;
  padding: clamp(64px, 20vh, 220px) var(--s16) var(--s16);
}

.off-card {
  max-width: 460px;
  padding: 24px;
  border-radius: 14px;
  background: var(--surface-4);
  border: 1px solid var(--line-3);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
  text-align: center;
}

.off-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--t1);
}

.off-desc {
  margin: 10px 0 0;
  font-size: var(--f-body);
  line-height: 1.7;
  color: var(--t4);
}

.off-cmd {
  display: flex;
  align-items: center;
  gap: var(--s8);
  margin-top: var(--s16);
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--search);
  border: 1px solid var(--line);
}

.off-code {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  text-align: left;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--note-text);
  white-space: nowrap;
}

.off-copy {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid var(--line-soft);
  background: var(--fill-weak);
  color: var(--t3);
  font-size: var(--f-tiny);
  cursor: pointer;
}

.off-copy:hover { color: var(--t1); }

.off-note {
  margin: var(--s12) 0 0;
  font-size: var(--f-tiny);
  line-height: 1.7;
  color: var(--t6);
}
</style>
