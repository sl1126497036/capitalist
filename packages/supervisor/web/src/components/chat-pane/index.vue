<script setup>
import {computed, nextTick, onMounted, onUnmounted, reactive, ref, watch} from "vue";
import {Bubble, XProvider} from "ant-design-x-vue";
import theme from "ant-design-vue/es/theme";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  NumberOutlined,
  DownOutlined,
  EnterOutlined,
  FileImageOutlined,
  LeftOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RightOutlined,
  SendOutlined,
  ThunderboltOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import { loadModels, setNextModel, setWorkerModel } from "../../lib/models.js";
import { lang, t } from "../../lib/i18n.js";
/* 局部形参 t 会遮蔽模块级文案函数，取文案统一走 tr。 */
const tr = t;
import {
  BLANK_LABEL,
  blockParts,
  clock,
  cmdLabel,
  dur,
  evtReceipt,
  evtTag,
  evtText,
  hhmm,
  isSupervisorSpeech,
  msgRef,
  sayStatus,
} from "../../lib/fmt.js";
import { rejectTail } from "../../lib/rejectTail.js";
import { dedupeMessages, isBlankMessage } from "../../lib/msgDedup.js";
import {toneOf} from "../../lib/msgTone.js";
import {isLog, logRowsOf} from "../../lib/msgNoise.js";
import {shortOf, numberQueue} from "../../lib/shortId.js";
/* 结束态判定与左栏队列卡共用 lib/status.js。 */
import {endedWord} from "../../lib/status.js";
import {taskTitle} from "../../lib/taskTitle.js";
import {isLightTheme, themeId} from "../../lib/theme.js";
import {fmtCtx, fmtTokens, modelOf, modelLabel, spendOf} from "../../lib/usage.js";
/* 指示气泡的动作由服务端判定，此处只取文案。 */
import {supervisorActivityText, workerDoingText} from "../../lib/doing.js";
import EmptyState from "../empty-state";
import MetricBar from "../metric-bar";
import MsgText from "../msg-text";

const props = defineProps({
  /** "capitalist" 或线程 id */
  sel: {type: String, default: "capitalist"},
  /** 监工在线状态；离线时空态显示“没有消息”。 */
  offline: {type: Boolean, default: false},
  root: {type: String, default: ""},
  title: {type: String, default: ""},
  messages: {type: Array, default: () => []},
  /** 服务端总数大于已渲染条数时表示窗口被截断。 */
  total: {type: Number, default: 0},
  truncated: {type: Boolean, default: false},
  canLoadOlder: {type: Boolean, default: false},
  stages: {type: Array, default: () => []},
  stageIndex: {type: Number, default: -1},
  stageName: {type: String, default: ""},
  /** 选中的线程；监工态为 null。 */
  thread: {type: Object, default: null},
  threads: {type: Array, default: () => []},
  /** 分组条数取 /api/threads 的 counts 聚合。 */
  counts: {type: Object, default: () => ({})},
  /** 线程接口可能不带 action，任务名由派单表回落生成。 */
  dispatches: {type: Array, default: () => []},
  capitalist: {type: Object, default: () => ({})},
  /** 当前单的验收项：{ items: [{n,text}], gate: [本分片未过的门槛], report }。 */
  acceptance: {type: Object, default: () => ({items: [], gate: [], report: ""})},
  canInterject: {type: Boolean, default: false},
  running: {type: Number, default: -1},
  /** 上层回传的执行结果 { text, bad } */
  notice: {type: Object, default: null},
  sending: {type: Boolean, default: false},
  readonly: {type: Boolean, default: false},
  reload: {type: Object, default: null},
  typing: {type: Boolean, default: false},
  loading: {type: Boolean, default: false},
  /** 首份结果落地前只显示载入指示；零条才显示空态，失败走失败提示。 */
  msgPending: {type: Boolean, default: false},
  liveOut: {type: Object, default: () => ({})},
  /** 正在等对话回执的会话集合，按会话精确显示生成中，不受并行发送影响。 */
  talkBusy: {type: Set, default: () => new Set()},
  queueCollapsed: {type: Boolean, default: false},
  paused: {type: Boolean, default: false},
});
const emit = defineEmits(["send", "capitalist", "handback", "interject", "pick", "toggleQueue", "close", "loadOlder", "refresh", "pause", "locate"]);

/* 会话标题取任务根目录最后一段；根不可用时退回“监工”，不拼出“-监工”。 */
const supervisorTitle = computed(() => {
  const p = String(props.root || "").replace(/[\\/]+$/, "");
  const name = p.split(/[\\/]/).pop() || "";
  return name ? tr("{name}-监工", { name }) : tr("监工");
});

/* 任务卡标题按线程 title、分片映射、派单正文摘要依次回落；无来源时留空，不显示占位文案。 */
const cardTitle = computed(() => {
  if (props.title) return props.title;
  if (isSupervisor.value) return supervisorTitle.value;
  return nameOf(props.thread);
});

function readToken(name) {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const xTheme = computed(() => {
  /* 依赖 themeId 重算以读取新写入的 CSS 变量；浅色判断用 isLightTheme，薄雾灰也按浅色处理。 */
  const light = isLightTheme(themeId.value);
  return {
    algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm,
    token: {
      colorPrimary: readToken("--accent"),
      colorBgBase: readToken("--bg-deep"),
      colorBgContainer: readToken("--surface"),
      colorText: readToken("--t2"),
      colorTextSecondary: readToken("--t4"),
      colorBorder: readToken("--line"),
      borderRadius: 8,
      fontFamily: readToken("--font"),
    },
  };
});

const streamEl = ref(null);
const liveEl = ref(null);
const inputEl = ref(null);
const chatEl = ref(null);
const draft = ref("");
const obeyFollow = ref(true);
const pending = ref(0);
const live = reactive({text: "", tone: "", final: false});

/* 介入状态随回执推进“介入中 -> 已介入 -> 已结束”，状态词并入底部状态条，不复述派单正文。 */
const supervisorAct = ref(""); // "" 无 | ing 介入中 | on 已介入 | end 已结束
let supervisorActTimer = 0;
const supervisorActText = computed(() =>
  supervisorAct.value === "end" ? tr("已结束") : supervisorAct.value === "on" ? tr("已介入") : tr("介入中"),
);

function supervisorActBegin() {
  if (supervisorActTimer) clearTimeout(supervisorActTimer);
  supervisorActTimer = 0;
  supervisorAct.value = "ing";
}

function supervisorActAnswered() {
  if (supervisorAct.value !== "ing") return;
  supervisorAct.value = "on";
  supervisorActTimer = window.setTimeout(() => {
    supervisorAct.value = "end";
    supervisorActTimer = window.setTimeout(() => {
      supervisorAct.value = "";
      supervisorActTimer = 0;
    }, 3000);
  }, 3000);
}

/** 失败或切换会话时撤掉介入状态词，避免状态条留下过期状态。 */
function supervisorActClose() {
  if (supervisorActTimer) clearTimeout(supervisorActTimer);
  supervisorActTimer = 0;
  supervisorAct.value = "";
}

const seen = ref(new Set());
const newIds = ref(new Set());
/** 按 root+sel 记录滚动位置，切回时回到原处。 */
const scrollMemo = new Map();

/* 引用条：{ ref, text } */
const quote = ref(null);
/** 服务端不一定回填引用 ref，本地记住自己刚发出的话与 ref 的对应关系。 */
const sentQuotes = reactive({});

const stopOpen = ref(false);
const alsoBlock = ref(false);
let toastTimer = 0;

const closeAsk = ref(false);
/* 暂停单可关闭：确认后直接结项，无需先唤醒。 */
const CLOSEABLE = new Set(["running", "starting", "claimed", "queued", "open", "paused"]);
const canCloseSel = computed(() => CLOSEABLE.has(String(props.thread?.status || "")));

function closeSelTap() {
  closeAsk.value = !closeAsk.value;
}

function closeSelConfirm() {
  const t = props.thread || {};
  closeAsk.value = false;
  emit("close", {id: t.dispatch || t.id || "", shard: t.shard || "", title: cardTitle.value});
}

const isSupervisor = computed(() => props.sel === "capitalist");

const viaSupervisor = ref(false);
const held = computed(() => Boolean(props.thread?.held));


function cls(m) {
  if (m.role === "worker") {
    if (m.kind === "tool") return "tool";
    if (m.kind === "thinking") return "think";
    /* 引擎诊断单独分档，渲染为系统消息样式的折叠块。 */
    if (m.kind === "engine") return "engine";
    /* 进程非零退出由底部状态条表达，其历史正文不按失败着色。 */
    return "worker";
  }
  if (m.role === "user") return held.value ? "human" : "user";
  if (m.role === "supervisor") {
    if (m.kind === "say") return "supervisorsay";
    if (isSupervisorSpeech(m, isSupervisor.value)) return "supervisorsay";
    return "sys";
  }
  return "sys";
}

const lineCount = (m) => String(m.text || "").split("\n").filter((x) => x.trim() !== "").length;

const FULL_EVENTS = new Set(["mq_message", "mq_triage", "supervisor_cmd"]);
const isFullMsg = (m) => FULL_EVENTS.has(String(m?.event || ""));

const TRACE_FIELD =
  /"(?:request_?id|trace_?id|span_?id|parent_tool_use_id|tool_use_id|session_?id|stop_reason|usage)"\s*:/i;

function isNoise(m) {
  if (!m || m.role === "user") return false;
  const kind = String(m.kind || "");
  if (kind === "debug" || kind === "trace" || kind === "log") return true;
  const t = String(m.text || "").trim();
  if (!t) return false;
  if (t.length > 40 && /^[[{]/.test(t) && TRACE_FIELD.test(t)) return true;
  return /^(?:trace|debug)\b/i.test(t);
}

const THUMB_KEY = "capitalist.chat.thumbs";
const thumbMap = ref({});
try {
  thumbMap.value = JSON.parse(localStorage.getItem(THUMB_KEY) || "{}") || {};
} catch {
  thumbMap.value = {};
}

function saveThumb(path, url) {
  if (!path || !url) return;
  const next = {...thumbMap.value, [path]: url};
  const keys = Object.keys(next);
  /* 只保留最近 80 张：localStorage 配额超限时写入会失败。 */
  if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete next[k];
  thumbMap.value = next;
  try {
    localStorage.setItem(THUMB_KEY, JSON.stringify(next));
  } catch {
  }
}

/** 原图可能超过 localStorage 配额，上传后压成 120px 缩略图存本地。 */
async function shrink(dataUrl) {
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    const max = 120;
    const w0 = img.width || max;
    const h0 = img.height || max;
    const scale = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return "";
    g.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

/* 正文中的 [附件] 路径与 [图1] 路径行都要摘掉，附件已按 atts 渲染为缩略图。 */
const ATT_LINE = /^\s*\[(?:附件|图\s*\d*)\]\s*(.+)$/;
/** 附件行可能出现在正文中间，不限于行首。 */
const ATT_INLINE = /\[(?:附件|图\s*\d*)\][\s\u3000]*([^\s<>"')]+\.(?:png|jpe?g|webp|gif))/gi;
const ATT_TAG = /\[(?:附件|图\s*\d*)\]/;

function splitAtt(text) {
  const lines = String(text || "").split("\n");
  const kept = [];
  const files = [];
  for (const line of lines) {
    const m = ATT_LINE.exec(line);
    if (m) {
      files.push(m[1].trim());
      continue;
    }
    if (!ATT_TAG.test(line)) {
      kept.push(line);
      continue;
    }
    const rest = line
      .replace(ATT_INLINE, (_, f) => {
        files.push(String(f));
        return "";
      })
      .replace(/\s{2,}/g, " ")
      .trim();
    if (rest) kept.push(rest);
  }
  return {text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), files};
}

/** 本地回显的 attachments 带 dataUrl，历史消息只有路径。 */
const attMeta = ref({});

async function loadAttMeta() {
  try {
    const r = await fetch("./api/attachments", {cache: "no-store"});
    if (!r.ok) return;
    const d = await r.json();
    attMeta.value = d.items && typeof d.items === "object" ? d.items : {};
  } catch {
    /* 归属信息取不到时不画角标，不阻断消息渲染。 */
  }
}

/* 缩略图与放大预览共用取图地址：本地有图直接用，否则按路径走 /api/attachment。 */
function attSrc(path, local) {
  const l = String(local || "").trim();
  if (l) return l;
  const p = String(path || "").trim();
  return p ? attUrl(p) : "";
}

function attOf(m, allowText = false) {
  const own = Array.isArray(m.attachments) ? m.attachments : [];
  /* 附件归属以服务端写入的 atts 为准。 */
  const ownPaths = Array.isArray(m.atts) ? m.atts.map((x) => String(x)) : [];
  const {text, files} = splitAtt(m.text);
  const fromText = allowText ? files : [];
  const paths = [...ownPaths];
  for (const p of fromText) if (!paths.includes(p)) paths.push(p);
  for (const a of own) {
    const p = String(a.path || "");
    if (p && !paths.includes(p)) paths.push(p);
  }
  const meta = attMeta.value || {};
  const list = paths.map((p) => {
    const hit = own.find((a) => String(a.path || "") === p);
    /* 本地缓存缺失时向后端取文件；仅有路径行不算缩略图。 */
    const url = attSrc(p, hit?.thumb || hit?.url || thumbMap.value[p]);
    const mm = meta[p] || {};
    return {
      path: p,
      name: String(hit?.name || mm.name || p.split(/[\\/]/).pop() || p),
      url,
      full: String(hit?.url || ""),
      thread: String(mm.thread || ""),
      tag: String(mm.tag || ""),
    };
  });
  return {text, list};
}

const HEARTBEAT_EVENTS = new Set([
  "supervisor_tick",
  "tick_window",
  "dispatch_orphan",
  "dispatch_retry",
  "dispatch_forced_finished",
  "dispatch_reaped",
  "redispatch_capped",
  "worker_gone",
  "worker_killed",
  "worker_looping_killed",
  "worker_heartbeat_rescued",
  "worker_reaped",
  "stage_stalled",
]);
const isTick = (m) => HEARTBEAT_EVENTS.has(String(m?.event || ""));

const belongsSupervisor = (m) => {
  const t = String(m?.thread || "");
  return t === "" || t === "capitalist" || t === "capitalist:main";
};

const CAPITALIST_SESSION_EVENTS = new Set([
  "supervisor_chat_ask",
  "supervisor_reply",
  "supervisor_answer",
  "mq_message",
  "supervisor_advance",
  "supervisor_done",
  "debt_settled",
  "stage_skipped",
  "stage_fallback",
  "dispatch_failed",
  "worker_launch_failed",
  "contract_error",
  "contract_refused",
  "supervisor_cmd",
]);
const isSupervisorSessionEvent = (m) => {
  const e = String(m?.event || "");
  if (!e) return true;
  if (HEARTBEAT_EVENTS.has(e)) return false;
  if (!CAPITALIST_SESSION_EVENTS.has(e)) return false;
  /* 指令回执只保留“被拒”；“已执行”已由指令气泡上的状态标表达。 */
  return e !== "supervisor_cmd" || m?.ok === false;
};

/* 同一任务的连续重开裁决合并为可展开的组，默认只显示最近一次。 */
const REDISPATCH_VERDICT = /^(启动进程|中断进程|进程\s*\S+\s*心跳超时)/;

function isRedispatch(m) {
  const event = String(m?.event || "");
  if (event === "dispatch_retry" || event === "dispatch_orphan") return true;
  if (String(m?.kind || "") !== "verdict") return false;
  return REDISPATCH_VERDICT.test(String(m?.text || "").trim());
}

/* 调度指令卡的认定条件为 id 以 SC- 开头且正文以“调度指令：”开头；该前缀是服务端内部标记，上屏前剥掉，卡片按普通消息保留。 */
const DISPATCH_ECHO_PREFIX = "调度指令：";

function isDispatchEcho(m) {
  return String(m?.id || "").startsWith("SC-") && String(m?.text || "").startsWith(DISPATCH_ECHO_PREFIX);
}

const view = computed(() => {
  const kept = props.messages
    .filter((m) => !isNoise(m))
    .filter((m) => !isSupervisor.value || m?.role !== "worker")
    .filter((m) => !isSupervisor.value || belongsSupervisor(m))
    .filter((m) => !isSupervisor.value || isSupervisorSessionEvent(m))
    .filter((m) => isSupervisor.value || m?.thread !== "capitalist:main")
    .filter((m) => !(isSupervisor.value && isLog(m)))
    .filter((m) => !isTick(m))
    .filter((m) => !isBlankMessage(m, BLANK_LABEL))
    .filter((m) => String(m.text || "").trim() !== "" || String(m.cmd || "").trim() !== "");
  /* 展示层按同一说话人与归一同文再判一次：同台账 5 秒、S- 与 CH- 跨台账 2 分钟，口径见 lib/msgDedup.js。 */
  const list = dedupeMessages(kept).map((m) =>
    /* 复制后再改字段，元素仍引用 props.messages，原地修改会污染上层数据。 */
    isDispatchEcho(m)
      ? { ...m, text: String(m.text || "").slice(DISPATCH_ECHO_PREFIX.length).trim() }
      : m,
  );

  /* 重派通知按同一任务合并，两条以上才收成组，组挂在第一条出现的位置。 */
  const redispatch = list.filter(isRedispatch);
  const grouped = [];
  if (redispatch.length > 1) {
    const refs = new Set(redispatch.map((m) => msgRef(m)));
    let anchor = null;
    for (const m of list) {
      if (!refs.has(msgRef(m))) {
        grouped.push(m);
        continue;
      }
      if (!anchor) {
        anchor = { __redispatch: [] };
        grouped.push(anchor);
      }
      anchor.__redispatch.push(m);
    }
  } else {
    grouped.push(...list);
  }

  /* 同一次派单的 SC- 指令卡与 supervisor_reply 说明在 link 同值且都上屏时才建立归属关联。 */
  const linkCount = new Map();
  for (const m of list) {
    const k = String(m?.link || "");
    if (k) linkCount.set(k, (linkCount.get(k) || 0) + 1);
  }

  return grouped
    .map((item) => {
      if (item && item.__redispatch) {
        const items = item.__redispatch;
        const last = items[items.length - 1];
        return {
          m: last,
          c: "redispatch",
          tone: "",
          note: "",
          ref: `RD-${msgRef(items[0])}`,
          fold: false,
          huge: false,
          full: true,
          text: "",
          atts: [],
          items: items.map((x) => ({
            ref: msgRef(x),
            at: x.at,
            text: String(x.text || ""),
          })),
        };
      }
      const m = item;
      const c = cls(m);
      const full = isFullMsg(m);
      const fold = !full && (c === "think" || (c === "worker" && lineCount(m) >= 6));
      const huge = !full && c === "worker" && lineCount(m) >= LOG_FOLD_LINES;
      // 本人消息的附件行渲染为图，监工与工作进程消息里的 [附件] 行只摘除文本。
      const mine = c === "user" || c === "human";
      const att = attOf(m, mine);
      /* link 同值出现两次以上才算归属确认；带 action 的按指令卡配色。 */
      const lk = String(m.link || "");
      const paired = Boolean(lk) && (linkCount.get(lk) || 0) >= 2;
      /* 归属标识优先用服务端下发的任务编号 no；历史消息查不到时才回落指令 id 尾段。 */
      const assocId = paired ? lk.slice(-6) : "";
      const assoc = paired ? (String(m.no || "") ? `#${m.no}` : assocId) : "";
      const card = paired && String(m.action || "") !== "";
      /* 颜色取 toneOf 的三档：bad 红、warn 琥珀、空为中性。 */
      const {tone, note} = toneOf(m);
      return {
        m,
        c,
        tone,
        note,
        ref: msgRef(m),
        fold,
        huge,
        full,
        text: att.text || (att.list.length ? "" : m.text),
        atts: att.list,
        assoc,
        assocId,
        card,
        /* 带任务编号的派单卡与监工回执卡可跳转；编号缺失或归属不明时保持普通卡片。 */
        jump: c === "supervisorsay" && String(m.no || "") !== "",
      };
    })
    .filter((v) => v.c === "redispatch" || v.text.trim() !== "" || v.atts.length > 0);
});

const rdupOpen = reactive({});

function toggleRedispatch(ref) {
  rdupOpen[ref] = !rdupOpen[ref];
}

/** 超过该行数的输出按超长日志处理，默认收起，展开后在块内滚动。 */
const LOG_FOLD_LINES = 40;

const hugeOpen = reactive({});

function toggleHuge(ref) {
  hugeOpen[ref] = !hugeOpen[ref];
}

const dbgOpen = reactive({});

function toggleDbg(ref) {
  dbgOpen[ref] = !dbgOpen[ref];
}

const threadLive = computed(
  () => ["running", "starting", "claimed"].includes(String(props.thread?.status || "")) || Boolean(props.typing),
);
const lastThinkRef = computed(() => {
  let r = "";
  for (const v of view.value) if (v.c === "think") r = v.ref;
  return r;
});

/* 思考是否仍在进行按末块文字是否变化判定：每次追加刷新时间戳，超过 6 秒未变即视为结束；now 由 2 秒定时器推动以参与响应式。 */
const lastThinkText = computed(() => {
  const hit = view.value.find((v) => v.ref === lastThinkRef.value);
  return String(hit?.m?.text || "");
});
const thinkGrewAt = ref(Date.now());
watch(lastThinkText, () => {
  thinkGrewAt.value = Date.now();
});
const nowTick = ref(Date.now());
const nowTickId = setInterval(() => (nowTick.value = Date.now()), 2000);
onUnmounted(() => clearInterval(nowTickId));
const thinkActive = computed(
  () => threadLive.value && nowTick.value - thinkGrewAt.value < 6000,
);

/** 工具调用只在活动条里出现，不进消息流。 */
const seq = computed(() => view.value.filter((v) => v.c !== "tool"));

const sideOf = (c) =>
  c === "worker" || c === "think" || c === "engine"
    ? "worker"
    : c === "user" || c === "human"
      ? "me"
      : "capitalist";

const rows = computed(() =>
  seq.value.map((v, i) => {
    const prev = seq.value[i - 1];
    const bubble = v.c === "user" || v.c === "human" || v.c === "supervisorsay" || v.c === "worker";
    const side = sideOf(v.c);
    const prevSide = prev ? sideOf(prev.c) : "";
    const swap = Boolean(prev) && prevSide !== side && prevSide !== "me" && side !== "me";
    return {
      ...v,
      first: !prev || prev.c !== v.c,
      grp: Boolean(prev) && prev.c === v.c && bubble,
      seam: swap ? (side === "worker" ? tr("工作进程") : tr("监工")) : "",
      fresh: newIds.value.has(v.ref),
    };
  }),
);

const logOpen = ref(false);
const logRows = computed(() => (isSupervisor.value ? logRowsOf(props.messages.filter((m) => !isTick(m))) : []));


const SQUEEZE_H = 420;
const chatH = ref(0);
const squeezed = computed(() => chatH.value > 0 && chatH.value < SQUEEZE_H);
/* 辅助面板一律默认收起，由标题行控制展开；矮屏时自动收起以避免压住消息区。 */
const auxOpen = ref(false);
watch(squeezed, (v) => {
  if (v) auxOpen.value = false;
});
watch(isSupervisor, () => {
  auxOpen.value = false;
});
let squeezeRo = null;

const thinkOpen = reactive({});

function toggleThink(ref) {
  thinkOpen[ref] = !thinkOpen[ref];
}

function foldedOf(v) {
  if (!v) return false;
  /* 申报与回执整篇显示，不参与任何折叠。 */
  if (v.full) return false;
  return v.c === "think" && !thinkOpen[v.ref];
}

/* 当前工具动作只取末行单行显示；工作进程侧只进底部状态气泡，活动条仅在监工侧保留。 */
const activity = computed(() => {
  let last = null;
  for (const v of view.value) if (v.c === "tool") last = v.m;
  if (!last) return "";
  const rs = String(last.text || "").split("\n").filter((x) => x.trim() !== "");
  if (!rs.length) return "";
  return rs[rs.length - 1];
});

const thinkLine = computed(() => {
  /* 监工面板不展示工作进程的推理内容，会话隔离。 */
  if (isSupervisor.value) return "";
  let line = "";
  for (const m of props.messages) {
    if (m?.role !== "worker" || m?.kind !== "thinking") continue;
    const rows = String(m.text || "").split("\n").filter((x) => x.trim() !== "");
    if (rows.length) line = rows[rows.length - 1].trim();
  }
  return line;
});

/** 上层压成一行的思考占位文案不进入消息流。 */
const THINKY = /^(思考中\s*[·\s]\s*|已发出\s*[·\s]\s*模型在想)/;

/** 活行文案与落库回执、block 同源时不重复上屏。 */
function echoed(text) {
  const s = String(text || "").trim();
  if (s.length < 6) return false;
  return props.messages.slice(-8).some((m) => {
    const x = String(m?.text || "").trim();
    return x.length >= 6 && (x.includes(s) || s.includes(x));
  });
}

/** 进程退出时展示最后一条输出，没有则显示空态。 */
function diedText() {
  for (let i = props.messages.length - 1; i >= 0; i -= 1) {
    const m = props.messages[i];
    if (m?.role !== "worker") continue;
    const rows = String(m.text || "").split("\n").filter((x) => x.trim() !== "");
    if (rows.length) return rows[rows.length - 1].trim();
  }
  return String(props.thread?.last || "").trim() || tr("日志里没有原因");
}

/* 未完成任务优先读 /api/threads 的 counts，缺失时退回当前列表状态；失败件按未完成计。 */
const pendingTasks = computed(() => {
  const c = props.counts || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (Object.keys(c).length) return n(c.running) + n(c.queued) + n(c.failed) > 0;
  const done = new Set(["done", "closed", "canceled", "exited", "finished"]);
  return (props.threads || []).some((t) => !done.has(String(t?.status || "")));
});

const stateRowBase = computed(() => {
  if (live.tone === "bad") return {text: live.text, bad: true, warn: false, dots: false};
  /* 重载期间服务端 activity.kind 为 compacting，气泡文案走 doing.js 的同一张表，不单独维护状态机。 */
  const act = isSupervisor.value ? props.capitalist?.activity || null : null;
  const kind = String(act?.kind || "");
  if (isSupervisor.value && kind === "compacting") {
    return {text: supervisorActivityText(act), bad: false, warn: true, dots: true};
  }
  if (live.tone === "warn") return {text: live.text, bad: false, warn: true, dots: false};
  const note = String(live.text || "");
  /* 状态行只放过程文案：监工侧取 live.text 的 process（派单卡全文走 acc 不进此路），live.final 已上屏不重复；工作进程侧只过滤思考占位。 */
  if (!isSupervisor.value && note && !THINKY.test(note) && !echoed(note)) {
    /* 正文已在气泡展示时，状态条只保留进行态词。 */
    if (tailRaw.value.trim() && tailRaw.value.trim() === note.trim()) {
      return {text: tr("正在生成回复"), bad: false, warn: false, run: true, dots: true};
    }
    return {text: note, bad: false, warn: false, dots: false};
  }
  if (isSupervisor.value) {
    if (!props.root) return null;
    /* 对话回执未到时状态行持续占位：有过程文案就用过程，否则显示“已发出 模型在想”。 */
    if (props.sending) {
      return {text: note || tr("已发出 模型在想"), bad: false, warn: false, run: true, dots: true};
    }
    /* 状态行优先报过程内容，没有过程时才回退动作档位。 */
    if (note && !live.final) {
      return {text: note, bad: false, warn: false, run: true, dots: true};
    }
    /* 指示气泡按监工真实动作出词：处理申报与回执为“回执中”，其余动作或有未完成任务时为“监管中”。 */
    if (kind === "receipt" || kind === "supervising") {
      return {text: supervisorActivityText(act), bad: false, warn: false, run: true, dots: true};
    }
    if (pendingTasks.value) {
      return {text: tr("监管中"), bad: false, warn: false, run: true, dots: true};
    }
    return null;
  }
  if (!props.thread) return null;
  const s = String(props.thread.status || "");
  if (s === "failed" || s === "orphan") {
    const why = diedText();
    const normal = /exit\s*0\b|supervisor:exit0|被用户中断|SIGTERM|已收工/i.test(why);
    return normal
      ? {text: tr("本轮进程已退出，等待下一轮派发（{why}）", { why }), bad: false, warn: true, dots: false}
      /* 异常条显示状态；`why` 为工作进程末行消息。 */
      : {text: tr("进程异常"), bad: true, warn: false, dots: true};
  }
  /* 运行中时状态行按 thread.doing 报当前动作，不复述思考内容；有工具调用时直接显示调用内容并替换动作词。 */
  if (s === "running" || s === "starting" || s === "claimed" || props.typing) {
    return {
      text: activity.value || workerDoingText(props.thread?.doing),
      bad: false,
      warn: false,
      run: true,
      dots: true,
    };
  }
  /* 排队态不占用状态条；仅在进程运行中或异常时显示。 */
  if (s === "queued") return null;
  /* 暂停态与左栏任务卡共用同一词条：暂停单既未运行也未退出，气泡显示等待唤醒状态。 */
  if (s === "paused") return {text: tr("已暂停"), bad: false, warn: true, dots: false};
  /* 会话结束后发起的新提问仍在等待回执，状态条保持生成中。 */
  if (props.talkBusy.has(props.sel)) {
    return {text: tr("正在生成回复"), bad: false, warn: false, run: true, dots: true};
  }
  /* 结束态词条取 lib/status.js，与左栏队列卡共用同一份判定。 */
  return {text: endedWord(props.thread) || tr("进程已退出"), bad: false, warn: false, dots: false};
});

/* “思考中 <后缀>”只保留“思考中”标签，后缀整段移除；进行态由动态点表达，文案不带省略号。 */
const stateRow = computed(() => {
  const r = stateRowBase.value;
  if (!r) return r;
  const prefix = tr("思考中");
  let row = r;
  if (r.text.startsWith(prefix)) row = {...r, tag: prefix, text: ""};
  /* 介入期间只显示状态词本身，作为正常状态词放在 .ltxt，不套弱化标签、不显示后缀。 */
  if (supervisorAct.value) return {...row, tag: "", text: supervisorActText.value};
  return row;
});


const tailRaw = computed(() => {
  if (isSupervisor.value) return "";
  const full = String(props.liveOut?.[props.sel]?.text || "");
  const text = full.trim();
  if (!text) return "";
  const bees = view.value
    .filter((v) => v.c !== "user" && v.c !== "human" && v.c !== "supervisorsay")
    .slice(-6);
  if (bees.some((v) => String(v.m?.text || "").includes(text))) return "";
  return full;
});

const tailText = computed(() => {
  const full = tailRaw.value;
  if (!full) return "";
  const lines = full.split(/\r?\n/).filter((l) => l.trim() !== "");
  const kept = lines.slice(-4).join("\n");
  return kept.length > 480 ? kept.slice(-480) : kept;
});

const tailShown = ref("");
let tailCursor = 0;
let tailTimer = 0;

function stopTail() {
  if (!tailTimer) return;
  clearInterval(tailTimer);
  tailTimer = 0;
}

function tickTail() {
  const t = tailText.value;
  if (!t || tailCursor >= t.length) {
    stopTail();
    return;
  }
  /* 按码点切分，避免拆开代理对。 */
  const cps = Array.from(t);
  const shown = Array.from(tailShown.value);
  tailShown.value = cps.slice(0, Math.min(cps.length, shown.length + 3)).join("");
  tailCursor = Array.from(tailShown.value).length;
  if (obeyFollow.value && streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight;
}

function syncTail() {
  const t = tailText.value;
  if (!t) {
    stopTail();
    tailShown.value = "";
    tailCursor = 0;
    return;
  }
  if (!t.startsWith(tailShown.value)) {
    /* 缓冲被替换时直接铺上旧前缀，仅对末尾 300 字做逐字动画。 */
    const head = Array.from(t).slice(0, Math.max(0, Array.from(t).length - 300)).join("");
    tailShown.value = head;
    tailCursor = Array.from(head).length;
  } else if (Array.from(t).length - tailCursor > 300) {
    tailShown.value = t;
    tailCursor = Array.from(t).length;
  }
  /* 打字机逐字动画间隔 33ms（30fps）。 */
  if (Array.from(t).length > tailCursor && !tailTimer) tailTimer = window.setInterval(tickTail, 33);
}

watch(tailText, syncTail, {immediate: true});
watch(
  tailShown,
  () => {
    const box = liveEl.value?.querySelector(".ant-bubble-content");
    if (box) box.scrollTop = box.scrollHeight;
  },
  {flush: "post"},
);
watch(
  () => props.sel,
  () => {
    stopTail();
    tailShown.value = "";
    tailCursor = 0;
    syncTail();
  },
);


const lastAt = computed(() => {
  const arr = view.value.filter((v) => v.m.at);
  return arr.length ? arr[arr.length - 1].m.at : "";
});

const headMeta = computed(() => {
  const t = lastAt.value ? clock(lastAt.value) : "—";
  return tr("{n} 条消息 最近 {t}", { n: view.value.length, t });
});


function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (v) => String(v).padStart(2, "0");
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return lang.value === "en"
    ? `${d.getMonth() + 1}/${d.getDate()} ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function stat(v) {
  /* 监工直达消息（supervisorsay）同样带执行状态小字。 */
  if (v.c === "user" || v.c === "human" || v.c === "supervisorsay") {
    const s0 = sayStatus(v.m.status, v.m.no, v.m.reason, v.m.detail);
    /* 派单消息卡带 no 时显示 #NN，与执行回执的编号一致。 */
    if (!s0 && v.m.no) return `#${v.m.no}`;
    return s0;
  }
  if (v.m.event === "supervisor_cmd") return evtReceipt(v.m);
  const s = String(v.m.status || "");
  if (s === "pending") return tr("等待下一轮调度");
  if (s === "executed") return v.m.no ? tr("已执行 #{no}", { no: v.m.no }) : tr("已执行");
  /* 被拒尾标按 reason 优先、回落 detail，两者皆空只显示“被拒”；字段由 supervisor_cmd 事件与 SC- 指令卡下发。 */
  if (s === "rejected") {
    const tail = rejectTail(v.m.reason, v.m.detail);
    return tail ? `${tr("被拒")} · ${tail}` : tr("被拒");
  }
  return "";
}

/** 状态尾标仅在文案被省略号截断时挂 data-tip，放得下时不弹提示。 */
function saystTipOn(e, v) {
  const el = e.currentTarget;
  if (!(el instanceof Element)) return;
  if (el.scrollWidth > el.clientWidth + 1) el.setAttribute("data-tip", stat(v));
  else el.removeAttribute("data-tip");
}

function attUrl(path) {
  const p = String(path || "").trim();
  if (!p) return "";
  /* /api/attachment 必须带 root：接口按服务启动时的任务根取文件，缺 root 时其它任务根的附件全部 404。 */
  const q = new URLSearchParams();
  q.set("path", p);
  if (props.root) q.set("root", String(props.root));
  return `${location.origin}/api/attachment?${q.toString()}`;
}

/** 缩略图加载失败时退成文件名小卡，不留空框。 */
const badThumbs = ref(new Set());

function markBadThumb(path) {
  const p = String(path || "");
  if (!p || badThumbs.value.has(p)) return;
  const next = new Set(badThumbs.value);
  next.add(p);
  badThumbs.value = next;
}

const zoom = ref(null); // { items: [{url,name,path}], i }
const zoomStage = ref(null);
const zoomFail = ref(false);
const zoomTries = ref(0);
const zoomSize = ref({w: 0, h: 0});
let zoomNat = {w: 0, h: 0};
let zoomTimer = 0;

const zoomItem = computed(() => (zoom.value ? zoom.value.items[zoom.value.i] || null : null));
const zoomCount = computed(() => zoom.value?.items.length || 0);
const zoomSrc = computed(() => {
  const it = zoomItem.value;
  if (!it?.url) return "";
  /* 重试时加一次性参数绕过缓存；data URL 不能带查询参数，且本身不走网络缓存。 */
  if (!zoomTries.value || String(it.url).startsWith("data:")) return it.url;
  return `${it.url}${it.url.includes("?") ? "&" : "?"}r=${zoomTries.value}`;
});

function zoomList(list) {
  return (list || [])
    .map((a) => {
      const path = String(a?.path || "");
      const url = attSrc(path, a?.full) || String(a?.url || "");
      return {url, path, name: String(a?.name || path.split(/[\\/]/).pop() || tr("附件"))};
    })
    .filter((x) => x.url);
}

function openZoom(list, index = 0) {
  const items = zoomList(list);
  if (!items.length) return;
  zoomNat = {w: 0, h: 0};
  zoomFail.value = false;
  zoomTries.value = 0;
  zoomScale.value = 1;
  zoomSize.value = {w: 0, h: 0};
  zoom.value = {items, i: Math.min(Math.max(index, 0), items.length - 1)};
  armZoomTimer();
}

function closeZoom() {
  clearTimeout(zoomTimer);
  zoom.value = null;
  zoomFail.value = false;
  zoomSize.value = {w: 0, h: 0};
}

function stepZoom(d) {
  const z = zoom.value;
  if (!z || z.items.length < 2) return;
  z.i = (z.i + d + z.items.length) % z.items.length;
  zoomNat = {w: 0, h: 0};
  zoomFail.value = false;
  zoomTries.value = 0;
  zoomScale.value = 1;
  zoomSize.value = {w: 0, h: 0};
  armZoomTimer();
}

function retryZoom() {
  zoomFail.value = false;
  zoomScale.value = 1;
  zoomSize.value = {w: 0, h: 0};
  zoomTries.value += 1;
  armZoomTimer();
}

/* 加载超时同样按失败处理，避免只等 onerror 时界面停在空态。 */
function armZoomTimer() {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    if (zoom.value && !zoomSize.value.w) zoomFail.value = true;
  }, 8000);
}

const zoomScale = ref(1); // 用户缩放倍率（1 = 初始“半屏”档）
const zoomBase = ref(1); // 初始半屏档相对原图的倍率
const zoomPct = computed(() => Math.round(zoomBase.value * zoomScale.value * 100));

function fitZoom() {
  const nat = zoomNat;
  if (!nat.w || !nat.h) return;
  const halfW = (window.innerWidth || 1280) * 0.5;
  const halfH = (window.innerHeight || 800) * 0.5;
  zoomBase.value = Math.min(1, halfW / nat.w, halfH / nat.h);
  applyZoom();
}

function applyZoom() {
  const nat = zoomNat;
  if (!nat.w || !nat.h) return;
  const k = zoomBase.value * zoomScale.value;
  zoomSize.value = {w: Math.max(1, Math.round(nat.w * k)), h: Math.max(1, Math.round(nat.h * k))};
}

function stepScale(factor) {
  if (!zoomSize.value.w) return;
  const next = Math.min(6, Math.max(0.25, zoomScale.value * factor));
  if (next === zoomScale.value) return;
  zoomScale.value = next;
  applyZoom();
}

/** 滚轮缩放仅在按住 Ctrl 时生效，普通滚动仍用于查看长图。 */
function onZoomWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  stepScale(e.deltaY < 0 ? 1.2 : 1 / 1.2);
}

function resetScale() {
  zoomScale.value = 1;
  applyZoom();
}

function onZoomLoad(e) {
  clearTimeout(zoomTimer);
  const img = e?.target;
  zoomNat = {w: img?.naturalWidth || 0, h: img?.naturalHeight || 0};
  /* naturalWidth 为 0 表示解码失败，不能按加载成功处理。 */
  if (!zoomNat.w || !zoomNat.h) {
    zoomFail.value = true;
    return;
  }
  zoomFail.value = false;
  zoomScale.value = 1;
  fitZoom();
}

function onZoomError() {
  clearTimeout(zoomTimer);
  zoomFail.value = true;
  zoomSize.value = {w: 0, h: 0};
}

/** 点空白关闭预览，点滚动条不关闭。 */
function onZoomBlank(e) {
  const el = e.currentTarget;
  if (e.target !== el) return;
  if (typeof e.offsetX === "number" && e.offsetX >= el.clientWidth) return;
  closeZoom();
}

function onZoomKey(e) {
  if (!zoom.value) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeZoom();
    return;
  }
  if (e.key === "ArrowLeft") stepZoom(-1);
  if (e.key === "ArrowRight") stepZoom(1);
  if (e.key === "+" || e.key === "=") stepScale(1.25);
  if (e.key === "-") stepScale(1 / 1.25);
  if (e.key === "0") resetScale();
}

function onZoomResize() {
  fitZoom();
}

watch(zoom, (v) => {
  const on = Boolean(v);
  window.removeEventListener("keydown", onZoomKey);
  window.removeEventListener("resize", onZoomResize);
  if (on) {
    window.addEventListener("keydown", onZoomKey);
    window.addEventListener("resize", onZoomResize);
  }
});

onUnmounted(() => {
  clearTimeout(zoomTimer);
  window.removeEventListener("keydown", onZoomKey);
  window.removeEventListener("resize", onZoomResize);
});

const stageIds = computed(() =>
  props.stages.map((s, i) => {
    const id = String(s.id || `#${i + 1}`);
    /* 完成度按派单台账计算：总片为该阶段出现过的 shard 去重数，已做为其中落成 closed/done 的 shard 数，failed 不计入。 */
    const ds = (props.dispatches || []).filter((d) => String(d.stage || "") === id);
    const all = new Set(ds.map((d) => String(d.shard || "")).filter(Boolean));
    const ok = new Set(
      ds
        .filter((d) => ["closed", "done"].includes(String(d.status)))
        .map((d) => String(d.shard || ""))
        .filter(Boolean),
    );
    const left = [...all].filter((x) => !ok.has(x));
    return {
      id,
      name: String(s.name || s.title || s.id || ""),
      shards: typeof s.shards === "number" ? s.shards : Array.isArray(s.shards) ? s.shards.length : null,
      total: all.size,
      doneCount: ok.size,
      leftTip: left.length ? tr("未完成：{list}", { list: left.join(tr("、")) }) : tr("本阶段分片均已完成"),
      gate: Boolean(s.gate_passed ?? s.gate_ok ?? s.done),
      done: Boolean(s.done) || i < props.stageIndex,
      cur: i === props.stageIndex,
    };
  }),
);

/** 线程到派单的匹配先按 id 再按同分片，与左栏、App 一致。 */
function dispatchOf(t) {
  if (!t) return null;
  if (t.dispatch) {
    const d = props.dispatches.find((x) => x.id === t.dispatch);
    if (d) return d;
  }
  if (t.shard) return props.dispatches.find((x) => x.shard === t.shard) || null;
  return null;
}

function nameOf(t) {
  return taskTitle({title: t?.title, shard: t?.shard, action: dispatchOf(t)?.action || t?.action || ""});
}

const ALIVE_ST = new Set(["running", "starting", "claimed"]);

/** 状态分档与左栏、服务端 taskBucket 一致。 */
function bucketOf(t) {
  const s = String(t?.status || "");
  if (ALIVE_ST.has(s)) return "run";
  if (s === "queued" || s === "open") return "queue";
  if (s === "done" || s === "exited" || s === "finished") return "done";
  if (s === "canceled") return "canceled";
  /* 未知状态按异常归类，与后端一致。 */
  return "bad";
}

const GROUP_DEFS = [
  {key: "run", label: "运行中", tone: "run"},
  {key: "queue", label: "排队", tone: "warn"},
  {key: "bad", label: "异常", tone: "bad"},
  {key: "done", label: "已完成", tone: "done"},
  {key: "canceled", label: "已取消", tone: "cancel"},
];

const startedMs = (t) => Date.parse(t?.started_at || "") || 0;

/* 分组条数取服务端全量聚合 counts，行只取当前列表中可显示的条目。 */
const groups = computed(() => {
  const by = new Map(GROUP_DEFS.map((g) => [g.key, []]));
  for (const t of props.threads) by.get(bucketOf(t)).push(t);
  const c = props.counts || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const totals = {
    run: num(c.running),
    queue: num(c.queued),
    bad: num(c.failed),
    done: num(c.done),
    canceled: num(c.canceled),
  };
  return GROUP_DEFS.filter((g) => g.key !== "canceled" || totals.canceled > 0).map((g) => {
    const all = by
      .get(g.key)
      .slice()
      .sort((a, b) => startedMs(b) - startedMs(a) || (String(a.id) < String(b.id) ? -1 : 1));
    return {
      ...g,
      label: tr(g.label),
      count: totals[g.key] || 0,
      rows: all.slice(0, 3).map((t) => ({
        id: t.id,
        name: nameOf(t),
        unread: Math.max(0, Number(t.unread) || 0),
        tip: `${nameOf(t)} ${t.worker || t.id}${t.unread ? tr(" {n} 条未读", { n: t.unread }) : ""}`,
      })),
      rest: Math.max(0, all.length - 3),
    };
  }).filter((g) => g.count > 0);
});

/* 模型切换后先按所选值显示，等标题观测值追上再放开；与派单模型的回填同一套做法。 */
const modelPending = ref(null);

/** 标题右侧在工作进程会话报模型；监工的阶段与任务数由顶栏展示。 */
const headInfo = computed(() => {
  const observed = String(props.thread?.usage?.model || props.thread?.model || "");
  if (modelPending.value !== null && modelPending.value !== observed) {
    if (!modelPending.value) return tr("默认");
    const want = modelOf(modelPending.value);
    return want ? `${want.name}${want.ver ? ` ${want.ver}` : ""}` : modelPending.value;
  }
  const m = modelOf(observed);
  return m ? `${m.name}${m.ver ? ` ${m.ver}` : ""}` : tr("模型未记录");
});


const accItems = computed(() => (Array.isArray(props.acceptance?.items) ? props.acceptance.items : []));
const accGate = computed(() => (Array.isArray(props.acceptance?.gate) ? props.acceptance.gate : []));
const accReport = computed(() => String(props.acceptance?.report || ""));

/* 写入后尚未回读的本地值，只作用在它所属的作用域上。 */
function localWinFor(scope) {
  return ctxWinLocal.value && ctxWinScope.value === scope ? ctxWinLocal.value : 0;
}

const usageCells = computed(() => {
  const t = props.thread || {};
  const u = t.usage || {};
  const m = modelOf(u.model || t.model);
  const winNow = localWinFor(threadScope()) || u.context_window;
  const ctx = fmtCtx(u.context_used, winNow, u.context_over === true);
  const ctxNote = [
    u.context_estimate ? tr("按消息文本估算") : "",
    u.context_over ? tr("已用超过生效上限，按上限显示") : "",
  ]
    .filter(Boolean)
    .join("；");
  const spend = spendOf(u);
  const st = String(t.status || "");
  const queued = st === "queued" || st === "open";
  const secs = Number.isFinite(Number(u.duration_ms))
    ? Math.round(Number(u.duration_ms) / 1000)
    : Number.isFinite(Number(t.duration_sec))
      ? Number(t.duration_sec)
      : null;
  const tok = (v) => (Number.isFinite(Number(v)) ? fmtTokens(v) : "");
  return [
    {
      k: tr("模型"),
      v: m ? `${m.name}${m.ver ? ` ${m.ver}` : ""}` : tr("未记录"),
      na: !m,
      tip: m ? tr("实际调用 {m}", { m: m.raw }) : tr("派单与日志都没有模型字段"),
    },
    {
      key: "ctx",
      k: tr("上下文"),
      v: ctx || tr("未上报"),
      na: !ctx,
      pick: "ctx",
      tip: ctx ? ctxNote : tr("日志没有上下文读数"),
    },
    {
      k: tr("输入"),
      v: tok(u.input_tokens) ? tr("{n} token", { n: tok(u.input_tokens) }) : tr("未上报"),
      na: !tok(u.input_tokens),
      tip: "",
    },
    {
      k: tr("输出"),
      v: tok(u.output_tokens) ? tr("{n} token", { n: tok(u.output_tokens) }) : tr("未上报"),
      na: !tok(u.output_tokens),
      tip: "",
    },
    {
      key: "dur",
      k: tr("耗时"),
      v: queued ? tr("未开始") : secs === null ? tr("无采样") : dur(secs),
      na: queued || secs === null,
      tip: queued ? tr("排队中的派单不计耗时") : "",
    },
    {
      key: "spend",
      k: tr("消耗"),
      v: spend.text || tr("未上报"),
      na: !spend.text,
      tip: spend.tip,
    },
  ];
});

/* 上下文分母取生效上限 limit（监工配置与模型上限的较小值），缺失时只显示已用；格式化统一走 lib/usage.js 的 fmtCtx，读数不带 ≈，超限仍标注。 */
function supervisorCtxText(c) {
  if (!c || typeof c.used !== "number") return "";
  const fallback = typeof c.limit === "number" && c.limit > 0 ? c.limit : typeof c.window === "number" && c.window > 0 ? c.window : 0;
  const lim = localWinFor("supervisor") || fallback;
  return fmtCtx(c.used, lim, c.over === true);
}

/* 上下文与累计拆成“小标签 + 数值”，由 MetricBar 的 end 插槽渲染，排在流量类读数之后。 */
const supervisorUsageCells = computed(() => {
  if (!isSupervisor.value) return [];
  const s = props.capitalist || {};
  const u = s.usage || {};
  const ctx = supervisorCtxText(s.context);

  /* 按 `credit_unit` 显示累计读数；`total_credit` 为 null 时显示“—”。 */
  const unit = String(u.credit_unit || "").trim();
  const isCredit = unit !== "";
  const raw = u.total_credit;
  const creditNum = raw === null || raw === undefined ? null : Number(raw);
  const credit = creditNum !== null && Number.isFinite(creditNum) && creditNum > 0 ? creditNum : null;
  const tokens = fmtTokens(u.total_tokens);
  const total = isCredit
    ? credit !== null
      ? `${Math.round(credit).toLocaleString("en-US")} ${tr(unit || "积分")}`
      : ""
    : tokens
      ? `${tokens} ${tr("token")}`
      : "";
  /* 累计无读数时整格省略；上下文栏缺值时保留占位。 */
  const cells = [{ k: tr("上下文"), v: ctx || "—", na: !ctx, pick: "ctx" }];
  if (total) cells.push({ k: tr("累计"), v: total });
  return cells;
});

/* 上下文窗口可选 300k / 600k / 1M（默认 600k）；监工与各工作进程各存一份，互不影响。
   超出该作用域模型的真实窗口时后端返回 409，显示理由后由用户确认才写入。 */
const ctxPick = reactive({
  open: false,
  /* 作用域：supervisor 是监工，其余为工作进程 id。 */
  scope: "supervisor",
  window: 600000,
  presets: [300000, 600000, 1000000],
  model: "",
  warn: "",
  want: 0,
  /* 设置请求在途：整块面板盖蒙版，收到响应（成功 / 409 / 异常）后撤除，期间不接受重复提交。 */
  applying: false,
});

/* 当前线程的窗口作用域：工作进程按 id 各存一份；没有 worker 记录（尚未派发）时落到默认档。 */
function threadScope() {
  return String(props.thread?.worker || "") || "default";
}

/* 刚写入的窗口：服务端读数回来前先用它做分母，避免蒙版撤掉后指标还停在旧档位。
   只对写入时的那个作用域生效，切到别的线程不会串用。 */
const ctxWinLocal = ref(0);
const ctxWinScope = ref("");
watch(
  () => [props.thread?.usage?.context_window, props.capitalist?.context?.limit, props.capitalist?.context?.window],
  () => {
    const want = ctxWinLocal.value;
    if (!want) return;
    const scope = ctxWinScope.value;
    const win = scope === "supervisor" ? 0 : Number(props.thread?.usage?.context_window);
    const lim = scope === "supervisor" ? Number(props.capitalist?.context?.limit || props.capitalist?.context?.window) : 0;
    if (win === want || lim === want) {
      ctxWinLocal.value = 0;
      ctxWinScope.value = "";
    }
  },
);

async function openCtxWindow(scope = "supervisor") {
  const s = String(scope || "supervisor");
  try {
    const r = await fetch(`./api/ctx-window?scope=${encodeURIComponent(s)}`, { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      ctxPick.scope = String(d.scope || s);
      ctxPick.window = Number(d.window) || 600000;
      ctxPick.presets = Array.isArray(d.presets) && d.presets.length ? d.presets : ctxPick.presets;
      ctxPick.model = String(d.model || "");
    }
  } catch {
  }
  ctxPick.warn = "";
  ctxPick.open = true;
}

async function chooseCtxWindow(w, force = false) {
  if (ctxPick.applying) return;
  ctxPick.applying = true;
  try {
    const r = await fetch("./api/ctx-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window: w, force: Boolean(force), scope: ctxPick.scope }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) {
      /* 模型不支持时原样显示后端返回的理由。 */
      ctxPick.want = w;
      ctxPick.warn = String(d.message || "当前模型可能不支持这个窗口");
      return;
    }
    if (r.ok && d.ok) {
      ctxPick.window = w;
      ctxWinLocal.value = w;
      ctxWinScope.value = String(d.scope || ctxPick.scope);
      ctxPick.open = false;
      ctxPick.warn = "";
      emit("refresh");
    }
  } catch {
  } finally {
    ctxPick.applying = false;
  }
}

/* 工作进程标题行的用量格复用 usageCells，固定上下文 / 耗时 / 消耗三格；无读数保留格子并由 na 弱化。 */
const usageBriefCells = computed(() =>
  usageCells.value.filter((c) => ["ctx", "dur", "spend"].includes(c.key))
);


/* 记忆会进入派单提示词，需可见、可改、可删：读 GET /api/memory，写 POST {op:add|update|delete}；与任务台账相互独立。 */
const memOpen = ref(false);
const memBtnEl = ref(null);
const memPos = ref({left: "0px", bottom: "0px"});
const memLoading = ref(false);
const memError = ref("");
const memEntries = ref([]);
const memStats = ref(null);
const memLimits = ref(null);
/** 正在编辑的 id；"new" 表示新增，空串表示不在编辑。 */
const memEditing = ref("");
const memDraft = ref("");
const memDraftKind = ref("habit");
const memSaving = ref(false);
const memAskDel = ref("");

/* 记忆分 habit 与 blocker 两类：habit 收用户习惯与运行环境，blocker 收项目上反复出现的卡点。 */
const MEM_KINDS = [
  {id: "habit", label: "习惯 / 环境"},
  {id: "blocker", label: "卡点"},
];

function memKindLabel(k) {
  return k === "blocker" ? tr("卡点") : tr("习惯 / 环境");
}

async function loadMemory() {
  memLoading.value = true;
  memError.value = "";
  try {
    const q = props.root ? `?root=${encodeURIComponent(props.root)}` : "";
    const r = await fetch(`./api/memory${q}`, {cache: "no-store"});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    memEntries.value = Array.isArray(d.entries) ? d.entries : [];
    memStats.value = d.stats || null;
    memLimits.value = d.limits || null;
  } catch (e) {
    memError.value = e instanceof Error ? e.message : String(e);
  } finally {
    memLoading.value = false;
  }
}

function toggleMem() {
  memOpen.value = !memOpen.value;
  if (!memOpen.value) return;
  memEditing.value = "";
  memAskDel.value = "";
  const r = memBtnEl.value?.getBoundingClientRect();
  if (r) memPos.value = {left: Math.max(8, r.left - 240), bottom: window.innerHeight - r.top + 6};
  void loadMemory();
}

/* 记忆条数在监工态挂载时拉取、换根后刷新；增删改由 memSend 就地更新 memStats。 */
watch(
  () => [isSupervisor.value, props.root],
  ([capitalist]) => {
    if (capitalist) void loadMemory();
  },
  {immediate: true},
);

function memStartNew() {
  memEditing.value = "new";
  memDraft.value = "";
  memDraftKind.value = "habit";
  memAskDel.value = "";
}

function memStartEdit(e) {
  memEditing.value = String(e.id || "");
  memDraft.value = String(e.note || "");
  /* 仅显式 blocker 归为卡点，其余一律按 habit 处理。 */
  memDraftKind.value = e.kind === "blocker" ? "blocker" : "habit";
  memAskDel.value = "";
}

async function memSend(payload) {
  memSaving.value = true;
  memError.value = "";
  try {
    const r = await fetch("./api/memory", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({root: props.root, ...payload}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    memEntries.value = Array.isArray(d.entries) ? d.entries : [];
    memStats.value = d.stats || null;
    memLimits.value = d.limits || null;
    return true;
  } catch (e) {
    memError.value = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    memSaving.value = false;
  }
}

async function memSave() {
  const note = String(memDraft.value || "").trim();
  if (!note) {
    memError.value = tr("正文不能为空");
    return;
  }
  const editing = memEditing.value;
  const ok = await memSend(
    editing === "new"
      ? {op: "add", note, kind: memDraftKind.value}
      : {op: "update", id: editing, note, kind: memDraftKind.value},
  );
  if (ok) memEditing.value = "";
}

async function memDelete(entry) {
  if (memAskDel.value !== entry.id) {
    memAskDel.value = String(entry.id);
    return;
  }
  const ok = await memSend({op: "delete", id: entry.id});
  if (ok) memAskDel.value = "";
}


/* 功能提示以常量数组维护并定时轮换，绝对定位在输入行水平中线，pointer-events: none 不遮挡输入。 */
const FEATURE_HINTS = [
  "已结束的派单可在原会话中回复，也可由监工介入唤醒",
  "拖输入框上沿可改变高度，双击恢复默认",
  "通过“图片/路径”选择文件后，任务根内的相对路径会插入输入框",
  "截图可直接粘贴或拖入输入框，上传完成后随消息一并发送",
  "在工作进程会话中开启“监工介入”，消息将转由监工处理，工作进程不会收到",
  "“派单模型”选定后对之后的新单持续生效，更换或清除后失效",
  "顶部的并行度与上下文读数可点击切换",
  "发消息可指定技能，作用于下一张派单，如“下一条派单加上 caveman-scene 技能”",
  "消息卡片上的“#”可引用该条信息，引用随下一条消息一起发出",
  "点击“中断”可结束当前进程并重派；“中断”时勾选“同时登记阻塞”则不再重派",
  "连续失败达到上限会停下等用户裁决，不再自动重派",
];
const HINT_INTERVAL_MS = 15000;
const hintIdx = ref(0);
let hintTimer = 0;


onMounted(() => {
  if (FEATURE_HINTS.length < 2) return;
  hintTimer = window.setInterval(() => {
    hintIdx.value = (hintIdx.value + 1) % FEATURE_HINTS.length;
  }, HINT_INTERVAL_MS);
});

onUnmounted(() => {
  if (hintTimer) clearInterval(hintTimer);
  hintTimer = 0;
});

const hintText = computed(() =>
  tr(FEATURE_HINTS[hintIdx.value % FEATURE_HINTS.length] || ""),
);




const memoKey = computed(() => `${props.root}|${props.sel}`);

function distFromBottom() {
  const el = streamEl.value;
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function toBottom() {
  const el = streamEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  pending.value = 0;
  obeyFollow.value = true;
}

function onScroll() {
  const el = streamEl.value;
  if (!el) return;
  obeyFollow.value = distFromBottom() < 80;
  if (obeyFollow.value) pending.value = 0;
  scrollMemo.set(memoKey.value, el.scrollTop);
}

function restoreOrBottom() {
  nextTick(() => {
    const el = streamEl.value;
    if (!el) return;
    const y = scrollMemo.get(memoKey.value);
    if (typeof y === "number" && y > 0) {
      el.scrollTop = y;
      obeyFollow.value = distFromBottom() < 80;
    } else {
      toBottom();
    }
  });
}

function markNew() {
  const fresh = new Set();
  const next = new Set(seen.value);
  for (const v of seq.value) {
    if (!next.has(v.ref)) fresh.add(v.ref);
    next.add(v.ref);
  }
  seen.value = next;
  if (!fresh.size) return;
  newIds.value = new Set([...newIds.value, ...fresh]);
}

watch(
  () => props.messages,
  (nv, ov) => {
    const grew = (nv?.length || 0) - (ov?.length || 0);
    if (grew > 0 && !obeyFollow.value) pending.value += grew;
    markNew();
    if (obeyFollow.value) nextTick(() => toBottom());
  },
);

watch(
  () => memoKey.value,
  () => {
    obeyFollow.value = true;
    pending.value = 0;
    seen.value = new Set();
    newIds.value = new Set();
    restoreOrBottom();
    if (attachments.value.length || uploadingCount.value > 0) {
      draftGen += 1;
      attachments.value = [];
      uploadFails.value = [];
    }
  },
);

onUnmounted(() => {
  clearTimeout(toastTimer);
  stopTail();
  window.removeEventListener("keydown", onZoomKey);
});

const HKEY = "capitalist.chat.inputH";
const H_MAX = 320;
const userH = ref(0);

/** 输入框高度随内容增长，上限 6 行，超出后内部滚动。 */
function autosize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  const want = Math.max(44, el.scrollHeight, userH.value || 0);
  el.style.height = `${Math.min(want, H_MAX)}px`;
}

function saveH() {
  try {
    if (userH.value > 44) localStorage.setItem(HKEY, String(userH.value));
    else localStorage.removeItem(HKEY);
  } catch {
  }
}

/* composer 上边界横线响应指针拖动以调整高度：上拖变高、下拖变矮，低于 44px 回到内容自适应，上限沿用 H_MAX，松手落盘、双击复位。 */
const resizing = ref(false);
let dragFrom = null;

function startResize(e) {
  if (typeof e.button === "number" && e.button !== 0) return;
  const el = inputEl.value;
  if (!el) return;
  e.preventDefault();
  dragFrom = { y: e.clientY, h: Math.round(el.offsetHeight) };
  resizing.value = true;
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    /* 不支持指针捕获时仍由 window 监听处理拖动。 */
  }
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", endResize, { once: true });
  window.addEventListener("pointercancel", endResize, { once: true });
}

function onResizeMove(e) {
  if (!dragFrom) return;
  /* clientY 变小时高度增加，方向与屏幕 y 轴相反。 */
  const next = dragFrom.h + (dragFrom.y - e.clientY);
  userH.value = next <= 44 ? 0 : Math.min(H_MAX, Math.round(next));
  autosize();
}

function endResize() {
  if (!dragFrom) return;
  dragFrom = null;
  resizing.value = false;
  window.removeEventListener("pointermove", onResizeMove);
  saveH();
}

function resetH() {
  userH.value = 0;
  saveH();
  autosize();
}


/* 浏览器取不到文件完整路径，改由后端 /api/fs-list 列任务根内目录并拼出路径；插入草稿的是任务根内相对路径，工作进程的 cwd 即任务根。 */
const pickOpen = ref(false);
const pickAbs = ref("");
const pickRel = ref("");
const pickEntries = ref([]);
const pickLoading = ref(false);
/* 路径栏可编辑：任务根外文件无法逐级点选，可粘贴绝对路径后回车跳转。 */
const pickPathInput = ref("");
const pickOutside = ref(false);
/* .chint 为 overflow:hidden，弹层须用 fixed 相对视口定位才不被裁切。 */
const pickBtnEl = ref(null);
const pickPos = ref({ left: 0, bottom: 0 });

/** Windows 盘符根之上没有上一级。 */
const pickCanUp = computed(() => {
  const p = pickAbs.value;
  if (!p) return false;
  const up = p.replace(/[\\/]+[^\\/]*$/, "");
  return up.length > 0 && up !== p;
});

async function loadPick(rel) {
  pickLoading.value = true;
  try {
    const q = rel ? `?path=${encodeURIComponent(rel)}` : "";
    const r = await fetch(`./api/fs-list${q}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    pickAbs.value = String(d.path || "");
    pickRel.value = String(d.rel || "");
    pickOutside.value = Boolean(d.outside);
    pickPathInput.value = pickRel.value;
    pickEntries.value = Array.isArray(d.entries) ? d.entries : [];
  } catch (e) {
    pickEntries.value = [];
    pickAbs.value = e instanceof Error ? e.message : String(e);
    pickPathInput.value = String(pickPathInput.value || "");
  } finally {
    pickLoading.value = false;
  }
}

/** 回车跳转时相对路径按任务根解析，绝对路径直接传入（后端按 isAbsolute 判定）。 */
function pickJump() {
  const v = String(pickPathInput.value || "").trim();
  if (!v) return;
  void loadPick(v);
}

function togglePick() {
  pickOpen.value = !pickOpen.value;
  if (!pickOpen.value) return;
  const r = pickBtnEl.value?.getBoundingClientRect();
  if (r) pickPos.value = { left: r.left, bottom: window.innerHeight - r.top + 6 };
  void loadPick(pickRel.value);
}

function pickOpenDir(rel) {
  void loadPick(rel);
}

/* 上一级按绝对路径计算，可退到盘符根。 */
function pickGoUp() {
  const p = pickAbs.value;
  if (!p) return;
  const up = p.replace(/[\\/]+[^\\/]*$/, "");
  if (!up || up === p) return;
  void loadPick(up);
}

function pickInto(rel) {
  const p = String(rel || "");
  if (!p) return;
  const cur = String(draft.value || "");
  const needSpace = cur.length > 0 && !/\s$/.test(cur);
  draft.value = `${cur}${needSpace ? " " : ""}${p}`;
  pickOpen.value = false;
  nextTick(() => {
    autosize();
    inputEl.value?.focus();
  });
}

function sizeText(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)}M`;
  if (v >= 1024) return `${Math.round(v / 1024)}k`;
  return `${v}B`;
}


/* 会话模型清单来自 /api/models 解析的宿主 --model 段；切换走 worker-model，按分片登记后结束当前进程，重派时以同一会话 --resume 接回历史。 */
/* 弹层默认贴锚点上方，上方空间不足且下方更大时翻到下方；水平方向夹在视口内。 */
function anchorPos(el, height = 340) {
  if (!el) return { left: "0px", bottom: "0px" };
  const r = el.getBoundingClientRect();
  const gap = 6;
  const boxH = Math.min(height, window.innerHeight * 0.48);
  const above = r.top - gap;
  const below = window.innerHeight - r.bottom - gap;

  const left = `${Math.max(8, Math.min(r.left, window.innerWidth - 348))}px`;
  return above < boxH && below > above
    ? { left, top: `${r.bottom + gap}px` }
    : { left, bottom: `${window.innerHeight - r.top + gap}px` };
}

const modelOpen = ref(false);
const modelPos = ref({ left: "0px", bottom: "0px" });
const modelBtnEl = ref(null);
const hostModels = ref([]);
const modelNote = ref("");
const modelLoading = ref(false);

/** 切换在途态：值为正在切换的那一行（"" 为宿主默认），null 为空闲；期间弹层显示“切换中…”并禁用其它行。 */
const modelBusy = ref(null);

const curModel = computed(() => String(props.thread?.usage?.model || props.thread?.model || ""));

/* 默认模型取监工接口的 model 字段：最近一次派单实际运行的模型，未显式指定时即宿主默认。 */
const hostDefault = computed(() => String(props.capitalist?.model || "").trim());

async function ensureModels() {
  modelLoading.value = true;
  try {
    const v = await loadModels();
    hostModels.value = v.models;
    /* 仅在模型清单不完整时提示（例如 claude 只给示例别名）。 */
    modelNote.value = v.reason;
  } finally {
    modelLoading.value = false;
  }
}

async function toggleModel() {
  modelOpen.value = !modelOpen.value;
  if (!modelOpen.value) return;
  modelPos.value = anchorPos(modelBtnEl.value);
  if (!hostModels.value.length) void ensureModels();
}

async function pickModel(m) {
  const val = String(m || "");
  /* 请求在途时记录所点行并显示“切换中…”、禁用其它行；返回后按钮立即显示新模型，不等下一轮轮询。 */
  if (modelBusy.value !== null) return;
  modelBusy.value = val;
  try {
    await setWorkerModel(props.root, props.sel, val);
    /* 先让所选值上屏，再关面板：蒙版撤掉时标题行已经是新模型。 */
    modelPending.value = val;
    modelOpen.value = false;
    /* 两分钟后放开在途态，回到真实观测值，避免重派未发生时按钮一直停在所选值。 */
    setTimeout(() => {
      if (modelPending.value === val) modelPending.value = null;
    }, 120_000);
  } catch (e) {
    modelNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    modelBusy.value = null;
  }
}

watch(
  () => String(props.thread?.usage?.model || props.thread?.model || ""),
  (v) => {
    if (modelPending.value !== null && modelPending.value === v) modelPending.value = null;
  },
);


/* 标题行管当前会话模型，输入框下管派单模型（写 .capitalist/next_model.json）；派单模型为常驻设定，当前值从 /api/supervisor 的 next_model 回填，仅监工面板提供该入口。 */
const nextOpen = ref(false);
const nextPos = ref({ left: "0px", bottom: "0px" });
const nextBtnEl = ref(null);
const nextModel = ref(String(props.capitalist?.next_model || "").trim());
const nextBusy = ref(null);
/* 轮询可能先返回写入前的旧值，故记录待回显值，观测值对上后再放开跟随服务端。 */
const nextModelPending = ref(null);

watch(
  () => String(props.capitalist?.next_model || "").trim(),
  (v) => {
    if (nextModelPending.value !== null) {
      if (nextModelPending.value !== v) return;
      nextModelPending.value = null;
    }
    nextModel.value = v;
  },
);

/*
 * 按钮文案：已设定时显示所选模型；未设定表示“宿主默认”，显示宿主默认模型名。
 * 两者都取不到（监工未报模型）时显示占位文案，避免按钮显示不存在的模型名。
 */
const nextLabel = computed(() => {
  const raw = nextModel.value || hostDefault.value;
  return raw ? modelLabel(raw) : tr("派单模型");
});

async function toggleNext() {
  nextOpen.value = !nextOpen.value;
  if (!nextOpen.value) return;
  nextPos.value = anchorPos(nextBtnEl.value);
  if (!hostModels.value.length) void ensureModels();
}

async function pickNext(m) {
  const val = String(m || "");
  if (nextBusy.value !== null) return;
  nextBusy.value = val;
  nextModelPending.value = val;
  try {
    await setNextModel(props.root, val);
    nextModel.value = val;
    nextOpen.value = false;
  } catch (e) {
    /* 回显始终对不上时放开待回显值，跟随服务端真实读数。 */
    nextModelPending.value = null;
    modelNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    nextBusy.value = null;
  }
}

/* pointerdown 捕获阶段按下即关闭弹层，排除弹层自身与触发按钮，避免点击后又被 click 重新打开。 */
function closePops(e) {
  if (!modelOpen.value && !nextOpen.value && !pickOpen.value && !memOpen.value) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest(".pickbox") || t.closest(".pickbtn") || t.closest(".memb")) return;
  modelOpen.value = false;
  nextOpen.value = false;
  pickOpen.value = false;
  memOpen.value = false;
}

watch(draft, () => {
  nextTick(autosize);
});

onMounted(() => {
  void loadAttMeta();
  try {
    const v = Number(localStorage.getItem(HKEY) || 0);
    if (v > 44) userH.value = Math.min(v, H_MAX);
  } catch {
  }
  restoreOrBottom();
  autosize();
  squeezeRo = new ResizeObserver((entries) => {
    chatH.value = entries[0]?.contentRect.height || 0;
  });
  if (chatEl.value) squeezeRo.observe(chatEl.value);
  document.addEventListener("pointerdown", closePops, true);
});

onUnmounted(() => {
  squeezeRo?.disconnect();
  squeezeRo = null;
  if (supervisorActTimer) clearTimeout(supervisorActTimer);
  supervisorActTimer = 0;
  document.removeEventListener("pointerdown", closePops, true);
});


function pushLive(text, tone = "", final = false) {
  const t = tone === true ? "bad" : tone === "warn" || tone === "bad" ? tone : "";
  live.text = text;
  live.tone = t;
  live.final = final === true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      live.text = "";
      live.tone = "";
      live.final = false;
    },
    t === "bad" ? 8000 : t === "warn" ? 6000 : 4200,
  );
}

function clearLive() {
  clearTimeout(toastTimer);
  live.text = "";
  live.tone = "";
  live.final = false;
}

watch(() => props.sel, () => {
  clearLive();
  /* 介入状态按会话隔离，切换会话时收口。 */
  supervisorActClose();
});
watch(
  () => props.sel,
  () => {
    /* 确认态不跨会话，切换会话时退出。 */
    closeAsk.value = false;
  },
);

watch(
  () => props.notice,
  (v) => {
    if (!v?.text) return;
    /* 带 thread 的回执只落在发起它的会话，不带 thread 的全局回执处处可见。 */
    if (v.thread && String(v.thread) !== String(props.sel)) return;
    /* 介入状态只认带本会话 thread 的对话回执；失败直接收口，最终回执改报“已介入”并开始收口计时。 */
    if (supervisorAct.value && v.thread && String(v.thread) === String(props.sel)) {
      if (v.bad) supervisorActClose();
      else if (v.final === true) supervisorActAnswered();
    }
    pushLive(v.text, v.bad ? "bad" : "", v.final === true);
  },
);

const copied = reactive({});
const copyTimers = new Map();

function flashCopied(ref, label) {
  if (!ref) return;
  copied[ref] = label;
  clearTimeout(copyTimers.get(ref));
  copyTimers.set(
    ref,
    window.setTimeout(() => {
      delete copied[ref];
      copyTimers.delete(ref);
    }, 1600),
  );
}

async function copy(text, ref) {
  const s = String(text || "");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(s);
    flashCopied(ref, tr("已复制"));
  } catch {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      flashCopied(ref, tr("已复制"));
    } catch {
      flashCopied(ref, tr("复制失败"));
    }
    document.body.removeChild(ta);
  }
}

/** 剪贴板的 image/png 只接受 PNG，故先把图解码后转成 PNG Blob。 */
async function imageToPng(url) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("图片解码失败"));
    i.src = url;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext("2d");
  if (!g || !c.width || !c.height) throw new Error("图片尺寸不可用");
  g.drawImage(img, 0, 0);
  return await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("PNG 编码失败"))), "image/png"),
  );
}

async function attDataUrl(a) {
  const url = attSrc(a.path, a.full) || String(a.url || "");
  if (!url) return "";
  if (String(url).startsWith("data:")) return url;
  const r = await fetch(url, {cache: "force-cache"});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ""));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(r.blob());
  });
}

/* 复制带附件的消息时写三类剪贴板内容：text/plain 含路径行、text/html 内嵌 <img>、image/png 为首位图位图；无附件时走纯文本。 */
async function copyMsg(v, ref) {
  const text = String(v.text || "");
  const atts = (Array.isArray(v.atts) ? v.atts : []).filter((a) => a?.path || a?.url);
  if (!atts.length) return copy(text, ref);
  const pathLines = atts.map((a) => `[附件] ${a.path || a.name}`).join("\n");
  const plain = text ? `${text}\n\n${pathLines}` : pathLines;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("no clipboard");
    const urls = [];
    for (const a of atts) {
      const u = await attDataUrl(a);
      if (u) urls.push(u);
    }
    if (!urls.length) throw new Error("no image");
    const esc = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const html = `${text ? `<div>${esc(text).replace(/\n/g, "<br>")}</div>` : ""}${urls
      .map((u) => `<img src="${u}">`)
      .join("")}`;
    const payload = {
      "text/plain": new Blob([plain], {type: "text/plain"}),
      "text/html": new Blob([html], {type: "text/html"}),
    };
    /* 位图转码失败只减少 image/png 条目，不影响文字与富文本两路。 */
    try {
      payload["image/png"] = await imageToPng(urls[0]);
    } catch {
    }
    await navigator.clipboard.write([new ClipboardItem(payload)]);
    flashCopied(ref, tr("已复制"));
  } catch {
    /* 图片写入剪贴板失败时退回纯文本，并给出提示。 */
    await copy(plain, ref);
  }
}

function quoteOf(m, ref) {
  const first = String(m.text || "").split("\n").filter(Boolean)[0] || "";
  quote.value = {ref, text: first.slice(0, 160)};
  nextTick(() => inputEl.value?.focus());
}

function clearQuote() {
  quote.value = null;
}

/* 跳转入口只有带编号的回执标签，emit("locate", no) 后由 App 转交 QueuePane 做滚动定位与高亮。 */

function jumpTo(ref) {
  const box = streamEl.value;
  if (!box) return;
  const safe = String(ref).replace(/["\\]/g, "\\$&");
  const el = box.querySelector(`[data-mref="${safe}"]`);
  if (!el) {
    /* 引用失败只表示消息不在当前窗口，显示提示，不按异常上报。 */
    pushLive(tr("原消息不在当前窗口内 待确认"), "warn");
    return;
  }
  el.scrollIntoView({block: "center"});
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1200);
}


const uploadingCount = ref(0);
const uploading = computed(() => uploadingCount.value > 0);
const canSend = computed(() => !props.readonly && !uploading.value);

const attachments = ref([]);

/** 单张上限与后端一致为 8MB，超限即拒绝。 */
const MAX_IMAGE_BYTES = 8_000_000;

let draftGen = 0;

const UPLOAD_TIMEOUT_MS = 15_000;
/** 上传失败的图保留 File 供重试，不并入 attachments，避免写入空路径。 */
const uploadFails = ref([]);

async function uploadOne(file, gen = draftGen) {
  if (file.size > MAX_IMAGE_BYTES) {
    /* 尺寸超限按琥珀提示处理，不用错误红。 */
    pushLive(tr("图片 {n}MB，超过 8MB 上限", { n: (file.size / 1048576).toFixed(1) }), "warn");
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, UPLOAD_TIMEOUT_MS);
  let r;
  try {
    r = await fetch("./api/upload", {
      method: "POST",
      headers: {"content-type": "application/json"},
      signal: ac.signal,
      body: JSON.stringify({name: file.name || "clipboard.png", dataUrl, thread: String(props.sel || ""), tag: tr("截图")}),
    });
  } catch {
    /* 超时、断网与后端异常按可重试失败处理并给出重试入口。 */
    pushLive(
      timedOut
        ? tr("上传超时（{n} 秒） 图片未上传，点击“重试”重新上传", { n: UPLOAD_TIMEOUT_MS / 1000 })
        : tr("上传中断 连接已断开，点击“重试”重新上传"),
      "bad",
    );
    if (gen === draftGen) uploadFails.value = [...uploadFails.value, {file, name: file.name || "clipboard.png"}];
    return;
  } finally {
    clearTimeout(timer);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.path) {
    /* 上传接口返回 4xx/5xx 时按确定失败处理。 */
    pushLive(`${tr("上传失败")} ${data.error || `HTTP ${r.status}`}`, "bad");
    if (gen === draftGen) uploadFails.value = [...uploadFails.value, {file, name: file.name || "clipboard.png"}];
    return;
  }
  const path = String(data.path);
  const thumb = await shrink(dataUrl);
  if (thumb) saveThumb(path, thumb);
  /* 草稿发出后附件即从输入区移除。 */
  if (gen !== draftGen) return;
  attachments.value = [
    ...attachments.value,
    {
      path,
      url: dataUrl,
      thumb,
      bytes: Number(data.bytes || 0),
      name: file.name || "clipboard.png",
    },
  ];
}

async function runUploads(files, gen = draftGen) {
  if (!files.length) return;
  uploadingCount.value += 1;
  try {
    await Promise.all(files.map((f) => uploadOne(f, gen)));
  } finally {
    uploadingCount.value -= 1;
  }
}

function retryUploads() {
  const files = uploadFails.value.map((x) => x.file);
  uploadFails.value = [];
  void runUploads(files, draftGen);
}

async function onPaste(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter((it) => it.kind === "file" && String(it.type || "").startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  /* 上传代次在批次开始时确定，用于判定该批附件归属哪份草稿。 */
  await runUploads(files, draftGen);
}

function dropAttachment(i) {
  attachments.value.splice(i, 1);
}


/* 浏览器拖入只提供 File，取不到完整路径：图片走上传，其它文件仅在有 file.path（Electron）时插路径，否则提示改用“图片/路径”；文本与 URI 直接插入草稿。 */
const dragging = ref(false);

function dragCarriesSomething(dt) {
  const types = Array.from(dt?.types || []);
  return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
}

function onDragEnter(e) {
  if (dragCarriesSomething(e.dataTransfer)) dragging.value = true;
}

function onDragOver(e) {
  if (!dragCarriesSomething(e.dataTransfer)) return;
  dragging.value = true;
  /* 声明拖放目标，避免部分平台显示禁止光标。 */
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function onDragLeave(e) {
  /* 子元素间移动同样触发 dragleave，指针仍在 composer 内时不收起高亮。 */
  const to = e.relatedTarget;
  if (to instanceof Node && e.currentTarget instanceof Node && e.currentTarget.contains(to)) return;
  dragging.value = false;
}

function insertText(parts) {
  const add = parts.map((s) => String(s || "").trim()).filter(Boolean);
  if (add.length === 0) return;
  const cur = String(draft.value || "");
  const needSpace = cur.length > 0 && !/\s$/.test(cur);
  draft.value = `${cur}${needSpace ? " " : ""}${add.join(" ")}`;
  nextTick(() => {
    autosize();
    inputEl.value?.focus();
  });
}

async function onDrop(e) {
  dragging.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;

  const files = Array.from(dt.files || []);
  if (files.length > 0) {
    const images = files.filter((f) => String(f.type || "").startsWith("image/"));
    if (images.length === files.length) {
      await runUploads(images, draftGen);
      return;
    }
    const paths = files.map((f) => String(f.path || "")).filter(Boolean);
    if (paths.length === files.length) {
      insertText(paths);
      return;
    }
    insertText([tr("（拖入的 {list} 拿不到本机路径，请用“图片/路径”选）", { list: files.map((f) => f.name).join(tr("、")) })]);
    return;
  }

  const text = String(dt.getData("text/plain") || "").trim();
  if (text) insertText([text]);
}

/** 附件路径按一行一个拼进正文，供工作进程按路径读取。 */
function withAttachments(text, list = attachments.value) {
  if (!list.length) return text;
  const lines = list.map((a) => `[附件] ${a.path}`).join("\n");
  return `${text}\n\n${lines}`.trim();
}


/* 暂停态下派单会被后端拒绝，下发前先确认；非暂停态直接执行，弹层用项目自身的 .veil / .modal。 */
const pauseAsk = ref(null); // { run: () => void } | null

/* 仅监工面板的发话与建单会触发派单；取消后草稿与附件原样保留。 */
function askWhenPaused(run) {
  if (!props.paused) {
    run();
    return;
  }
  pauseAsk.value = { run };
}

function pauseAskCancel() {
  pauseAsk.value = null;
}

function pauseAskConfirm() {
  const run = pauseAsk.value?.run;
  pauseAsk.value = null;
  run?.();
}

function submit() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  if (!text && !attachments.value.length) return;
  const shown = text || tr("看这几张图");
  const ref = quote.value?.ref || "";
  const atts = attachments.value.slice();
  const payload = withAttachments(shown, atts);
  /* 引用对象整体下发，后端按 ref 取不到原文时用摘要回落。 */
  const quoteOut = quote.value ? {ref: quote.value.ref, text: quote.value.text} : null;
  const meta = {
    text: shown,
    attachments: atts.map((a) => ({path: a.path, url: a.url, thumb: a.thumb || "", name: a.name})),
    /* 监工介入开启时消息交由监工处理，不直接登记给工作进程。 */
    via: viaSupervisor.value && !isSupervisor.value ? "capitalist" : "",
  };
  const fire = () => {
    /* 提交介入动作时立即亮“介入中”；仅本会话进程存活才交给监工，已退出时不亮该状态。 */
    if (meta.via === "capitalist" && ["running", "starting"].includes(String(props.thread?.status || ""))) supervisorActBegin();
    if (ref) sentQuotes[payload] = ref;
    emit("send", payload, quoteOut, meta);
    draft.value = "";
    attachments.value = [];
    /* 附件批次随消息发出后，上一批的失败重试不并入新草稿。 */
    uploadFails.value = [];
    draftGen += 1;
    clearQuote();
  };
  if (isSupervisor.value) askWhenPaused(fire);
  else fire();
}

/** Enter 发送、Shift+Enter 换行；输入法组字期间不触发发送。 */
function onKey(e) {
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const el = inputEl.value;
    const base = userH.value || el?.offsetHeight || 44;
    userH.value = Math.min(H_MAX, Math.max(44, base + (e.key === "ArrowUp" ? 22 : -22)));
    saveH();
    autosize();
    return;
  }
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey) return;
  e.preventDefault();
  submit();
}

/** 平台标记只写入提示行的 data-os，不参与键位判定。 */
const isMac =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(`${navigator.platform || ""} ${navigator.userAgent || ""}`);


function openStop() {
  alsoBlock.value = false;
  stopOpen.value = true;
}

function doStop() {
  stopOpen.value = false;
  const text = draft.value.trim();
  if (text && quote.value) sentQuotes[text] = quote.value.ref;
  emit("interject", {
    text,
    alsoBlock: alsoBlock.value,
    quote: quote.value ? {ref: quote.value.ref, text: quote.value.text} : "",
  });
  draft.value = "";
  clearQuote();
}

function openSupervisor() {
  emit("capitalist");
  nextTick(() => {
    inputEl.value?.focus();
    toBottom();
  });
}

const stopDetail = computed(() => {
  const t = props.thread;
  if (!t) return "";
  /* 中断文案用中文任务名，标题字段缺失时由分片映射补齐，后附进程号。 */
  return [taskTitle(t), t.worker ? tr("（进程 {w}）", { w: t.worker }) : ""].filter(Boolean).join(" ");
});

const placeholder = computed(() => {
  if (props.readonly) return tr("没有可发送的进程 请先在左栏选择");
  if (!isSupervisor.value) {
    /* 已结束的单仍可发消息，服务端把原单置回 open 带原上下文续跑。 */
    const st = String(props.thread?.status || "");
    if (st === "queued") return tr("这一单在排队 此时发送的内容会并入这一单，启动时一并带入");
    if (!["running", "starting"].includes(st))
      return tr("派单已结束，消息在原会话中回复");
    return tr("给执行中的进程发消息 会在下一个动作间隙收到，不打断当前执行");
  }
  return tr("给监工派单或发送消息");
});

const emptyState = computed(() => {
  /* 离线状态优先返回无消息提示。 */
  if (props.offline) return {h: tr("没有消息"), d: ""};
  if (isSupervisor.value) {
    if (!props.root) return {h: tr("尚未选择任务根"), d: tr("从上方监工条选择一个任务根")};
    return {h: tr("暂无监工记录"), d: ""};
  }
  if (!props.thread) return {h: tr("从左侧选择一个进程"), d: ""};
  return {h: tr("这个进程尚无消息"), d: ""};
});

/* 引用卡的结束态走 lib/status.js 词条，其余状态与队列卡、面板状态行共用同一张表。 */
const THREAD_WORD = {
  running: "运行中",
  starting: "启动中",
  claimed: "已领取",
  queued: "排队",
  failed: "异常",
  orphan: "异常",
  paused: "已暂停",
  held: "接管中",
};

const refIndex = computed(() => {
  const ix = new Map();
  const threads = props.threads || [];
  /* 消息里的编号按与左栏相同的队列顺序取，不按右栏渲染先后。 */
  const numbers = numberQueue(threads);
  const put = (raw, ent) => {
    const key = String(raw || "");
    if (key && !ix.has(key)) ix.set(key, ent);
  };
  for (const t of threads) {
    const ent = {
      no: numbers.get(t.id) || shortOf(t.id),
      threadId: t.id,
      title: taskTitle(t),
      status: endedWord(t) || (THREAD_WORD[String(t.status || "")] ? tr(THREAD_WORD[String(t.status || "")]) : ""),
      stage: String(t.stage || ""),
      dispatch: String(t.dispatch || ""),
      worker: String(t.worker || ""),
    };
    put(t.id, ent);
    put(t.dispatch, ent);
    put(t.worker, ent);
    /* 服务端按同一任务聚合，重派前的旧 W-/D- 编号也映射到当前行的 #序号。 */
    for (const raw of t.dispatches || []) put(raw, ent);
    for (const raw of t.workers || []) put(raw, ent);
  }
  for (const d of props.dispatches || []) {
    if (!d || ix.has(d.id)) continue;
    const t =
      threads.find((x) => x.dispatch === d.id) ||
      threads.find(
        (x) =>
          String(x.stage || "") === String(d.stage || "") &&
          (!d.shard || String(x.shard || "") === String(d.shard)),
      );
    if (!t) continue;
    const ent = ix.get(t.id);
    if (!ent) continue;
    put(d.id, ent);
    put(d.worker, ent);
  }
  return ix;
});

const truncNote = computed(() => {
  const shown = props.messages.length;
  const total = Math.max(shown, Number(props.total) || 0);
  if (!props.truncated || total <= shown) return "";
  return tr("仅显示最近 {a} 条（共 {b} 条），更早记录见任务目录", { a: shown, b: total });
});

const bubblePlacement = (c) => (c === "user" || c === "human" ? "end" : "start");
const isBlock = (v) => v.c === "sys" || v.c === "think" || (v.fold && v.c === "worker");
const blockText = (v) => String((v && v.m && v.m.text) ?? "");
const blockTag = (v) => {
  /* 申报单独成标签，不归入监工消息。 */
  if (v.m.event === "mq_message") return tr("申报");
  if (v.m.role === "supervisor") return evtTag(v.m);
  if (v.m.kind === "thinking") return tr("思考过程");
  return tr("工作进程输出");
};
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
