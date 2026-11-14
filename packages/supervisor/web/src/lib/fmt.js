/**
 * 展示层格式化：只改写已有字段，不推断、不补值，缺数据的指标由调用方显示破折号。
 * 事件标签与指令名取自服务端 src/supervisor/context/terms.ts 的中英对照表。
 */
import { CMD_ZH, EVENT_ZH, EVENT_ZH_FALLBACK } from "../../../src/supervisor/context/terms.ts";
import { lang, t } from "./i18n.js";
import { rejectTail } from "./rejectTail.js";

/* 时间格式随界面语言：英文用 en-GB（24 小时制、日/月顺序），中文用 zh-CN。 */
const locale = () => (lang.value === "en" ? "en-GB" : "zh-CN");

/** 回落标签（“其他事件”）。正文与该标签相同的消息按空消息移除。 */
export const BLANK_LABEL = EVENT_ZH_FALLBACK;

export function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale(), { hour12: false });
}

export function hhmm(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale(), { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** 秒 -> 12:34 / 1:02:03，用于进程行右侧时长（等宽数字）。 */
export function dur(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const p2 = (v) => String(v).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

/** 线程状态 -> 左栏状态点色号与右侧文案。 */
export function rowState(t) {
  const s = String(t?.status || "");
  const alive = s === "running" || s === "starting";
  if (s === "failed") return { tone: "bad", text: t("异常"), secs: 0 };
  if (alive) return { tone: "run", text: "", secs: t?.duration_sec || 0 };
  /* 服务端在已派未领时下发 status=queued，须单列为一态。 */
  if (s === "queued") return { tone: "wait", text: t("排队"), secs: 0 };
  if (s === "exited") return { tone: "done", text: "", secs: t?.duration_sec || 0 };
  if (s === "done") return { tone: "done", text: "", secs: t?.duration_sec || 0 };
  return { tone: "idle", text: t("待调度"), secs: 0 };
}

/** 监工方块的状态点色号。 */
export function supervisorTone(task) {
  const s = String(task?.status || "");
  if (Number(task?.blocked || 0) > 0 || s === "blocked" || s === "failed") return "bad";
  if (s === "running") return "run";
  if (s === "queued") return "wait";
  if (s === "done") return "done";
  return "idle";
}

export function supervisorWord(task) {
  const s = String(task?.status || "");
  if (Number(task?.blocked || 0) > 0) return t("待裁决");
  if (s === "running") return t("运行中");
  if (s === "queued") return t("排队");
  if (s === "done") return t("已完成");
  return t("空闲");
}


/** 内容指纹（djb2）；服务端未给 id 时作为回落身份，避免同秒消息冲突。 */
export function hash(s) {
  let h = 5381;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * 消息引用 ref：有 id 用 id，否则用内容指纹。
 * 列表 `:key`、`data-id` 锚点与引用角标共用该身份；缺 id 时不用指纹会导致节点复用。
 */
export function msgRef(m) {
  if (m && m.id) return String(m.id);
  return `M-${hash(`${m?.role}|${m?.at}|${String(m?.text || "").slice(0, 64)}`)}`;
}


/**
 * 监工事件类型 -> 界面标签。事件名经 src/supervisor/context/terms.ts 转换，不直接上屏。
 * 未收录的事件显示“监工记录”，不套用“其他事件”回落词。
 */
export function evtTag(m) {
  return t(EVENT_ZH[String(m?.event || "")] || "监工记录");
}

/** 指令动作 -> 中文名。dispatch 依据事件的 urgent 字段区分“插队派单”与“已派单”，不二次推断。 */
export function cmdLabel(action, urgent) {
  if (String(action || "") === "dispatch") {
    return urgent === true ? t("插队派单") : t("已派单");
  }
  return t(CMD_ZH[String(action || "")] || "其他指令");
}

export function evtText(m) {
  return String(m?.text || "");
}

/** 指令回执尾标：已执行 / 被拒；落到派单时附任务编号。 */
export function evtReceipt(m) {
  if (m?.event !== "supervisor_cmd") return "";
  const base = m.ok ? t("已执行") : t("被拒");
  /* `no` 由服务端按任务编号表下发；缺失时只显示结论。 */
  const no = String(m?.no || "");
  return no ? `${base} #${no}` : base;
}

/** 发言判据：派单消息两处都算监工发言，其余按当前视图判。 */
export function isSupervisorSpeech(m, supervisorView) {
  if (!m || m.role !== "supervisor") return false;
  if (m.kind === "dispatch") return true;
  if (supervisorView) return m.event === "supervisor_answer";
  return false;
}

/**
 * 用户指令 / 追加卡片的生效状态词。`no` 由服务端下发，仅已落到派单的状态带号。
 * 被拒时 reason 优先、为空回落 detail，与 rejectTail 及 stat() 同口径。
 */
export function sayStatus(s, no, reason, detail) {
  const v = String(s || "");
  const n = String(no || "");
  const withNo = (base) => (n ? `${base} #${n}` : base);
  if (v === "executed") return withNo(t("已执行"));
  if (v === "rejected") {
    const tail = rejectTail(reason, detail);
    return tail ? `${t("被拒")} · ${tail}` : t("被拒");
  }
  if (v === "pending") return t("等待下一轮调度");
  if (v === "已并入派单") {
    return n ? t("已并入派单 #{no} 随该单启动生效", { no: n }) : t("已并入派单 随该单启动生效");
  }
  if (v === "已送达执行中的进程") {
    return n ? t("已送达 #{no} 执行中的进程已收到", { no: n }) : t("已送达 执行中的进程已收到");
  }
  if (v === "随派单启动带入") return t("随派单启动带入");
  if (v === "已登记，进程下一次动作间隙送达") return t("已登记，进程下一次动作间隙送达");
  if (v === "已登记，随归属单带入") return t("已登记，随归属单带入");
  if (v === "待补投递") return t("待补投递");
  return "";
}


function firstRow(text) {
  const rows = String(text == null ? "" : text).split("\n");
  for (const r of rows) if (r.trim() !== "") return r.trim();
  return "";
}

function lastRow(text) {
  const rows = String(text == null ? "" : text).split("\n");
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].trim() !== "") return rows[i].trim();
  return "";
}

function clip(s, n) {
  const v = String(s || "");
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

/**
 * 折叠块头行：摘要 + 行数 + 隐藏行数。三类块共用同一头行，使高度与对齐一致；
 * 隐藏的调试行须标出“隐藏 N 行”。
 */
export function blockParts(m) {
  const rows = String(m?.text || "").split("\n").filter((x) => x.trim() !== "");
  const n = typeof m?.lines === "number" && m.lines > 0 ? m.lines : rows.length;
  const live = ["running", "starting", "claimed"].includes(String(m?.status || ""));
  let sum;
  if (m?.kind === "thinking") {
    /* 思考块摘要取末句；仅运行中给状态词，结束后仍给内容。 */
    const last = clip(lastRow(m.text), 72) || (live ? t("正在思考…") : t("（无正文）"));
    sum = n > 1 ? `${last} ${t("{n} 行", { n })}` : last;
  }
  else if (m?.kind === "tool") sum = lastRow(m.text) || t("（无命令原文）");
  else sum = firstRow(m.text);
  const meta = `${typeof m?.hidden === "number" && m.hidden > 0 ? t("隐藏 {n} 行 ", { n: m.hidden }) : ""}${t("{n} 行", { n })}`;
  return { sum, meta, lines: n };
}

export function shortRoot(root) {
  const s = String(root || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}
