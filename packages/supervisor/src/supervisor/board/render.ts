/**
 * 看板文本渲染：把日志事件、消息、派单记录压成单行或短段落。
 *
 * 只做字符串加工，不读盘、不发请求、不持有状态，便于被各视图层共用。
 */

import { ThreadMessage, describeEvent } from "./snapshot";
import { zh } from "./zh";
import { isShellTool, summarizeCommand } from "../worker/workerLog";
import { dispatchOfThreadNo } from "../usage/threadNo";
import { splitDirectiveTag } from "../../core/dispatch/commands";
import { dispatchNoLabel, taskNoLabel, workerNoLabel } from "../../core/record/idMap";
export const MQ_KIND_LABEL: Record<string, string> = {
  stuck: "卡住",
  question: "要方向",
  risk: "红线风险",
  deviation: "偏航",
  quality: "质量自评",
  blocked: "外部阻塞",
  progress: "进展",
  done: "报告完成",
};

export const MQ_DECISION_LABEL: Record<string, string> = {
  continue: "继续，不干预",
  nudge: "已纠正方向",
  requeue: "已重开该派单",
  pause_shard: "已暂停该分片",
  escalate: "已转人工裁决",
  accept: "报告通过",
  reject: "报告打回",
};

/* 只缓存全量页：不同 limit 只是同一份数据去掉末尾，没必要各算一遍。 */

export function oneLine(m: ThreadMessage): string {
  const s = m.text.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

export function toolSummary(e: Record<string, unknown>): { text: string; cmd: string } {
  const tool = String(e.tool ?? "");
  const cmd = String(e.cmd ?? "");
  const verb =
    /^(Read|NotebookRead)$/.test(tool) ? "查文件"
    : /^(Write)$/.test(tool) ? "写文件"
    : /^(Edit|MultiEdit|NotebookEdit)$/.test(tool) ? "改文件"
    : /^(Grep|Search)$/.test(tool) ? "搜索"
    : /^(Glob)$/.test(tool) ? "找文件"
    : isShellTool(tool) ? "执行命令"
    : tool || "工具调用";
  const desc = String(e.desc ?? "").trim().replace(/\s+/g, " ");
  if (desc !== "") return { text: desc.slice(0, 80), cmd };
  let short = cmd.trim().replace(/\s+/g, " ");
  if (isShellTool(tool)) {
    const { intent, waiting } = summarizeCommand(short);
    if (intent !== "") short = intent;
    else if (waiting) return { text: "等待", cmd };
  }
  short = short.slice(0, 80);
  return { text: short ? `${verb} ${short}` : verb, cmd };
}

/**
 * 进程号在显示时加 `#` 前缀（`2-P1` -> `#02-P1`）。
 *
 * 仅用于内部日志与排查。界面不展示进程号：看板文本统一经 {@link maskWorkerIds}
 * 改成任务号，工作进程叙述中出现的编号也会一并改写。
 */
export function workerLabel(id: string): string {
  const s = String(id ?? "").trim();
  if (!s) return s;
  if (/^\d+-P\d+$/.test(s)) return workerNoLabel(s);
  return s;
}

export function targetFromText(root: string, text: string): string {
  const m = /#\s*(\d{1,3})(?!\d)/.exec(String(text ?? ""));
  if (!m) return "";
  const no = Number(m[1]);
  if (!Number.isFinite(no) || no <= 0) return "";
  try {
    return String(dispatchOfThreadNo(root, no)?.id ?? "");
  } catch {
    return "";
  }
}

export function mqMessageText(e: Record<string, unknown>, rep: Record<string, unknown> | undefined): string {
  const body = String(rep?.text ?? e.text ?? "").trim();
  const evidence = String(rep?.evidence ?? e.evidence ?? "").trim();
  return [body, evidence ? `证据：\n${evidence}` : ""].filter(Boolean).join("\n\n");
}

export function mqTriageText(e: Record<string, unknown>): string {
  const decision = MQ_DECISION_LABEL[String(e.decision ?? "")] ?? "已处理";
  const why = String(e.why ?? "").trim();
  const say = String(e.say ?? "").trim();
  return [`处理结论：${decision}`, why ? `理由：${why}` : "", say ? `回给进程：${say}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function cmdReceiptText(e: Record<string, unknown>): string {
  const label = zh.cmd(e.action, e.urgent);
  /* 指令参数里可能带分类标签（`[supervisor-copy] …`），那是调度用的会话键，不进界面。 */
  const arg = splitDirectiveTag(String(e.arg ?? "").trim()).body;
  const ok = e.ok === true;
  const reason = String(e.reason ?? "").trim();
  const detail = String(e.detail ?? "").trim();
  return [
    `指令：${label}${arg ? ` · ${arg}` : ""}`,
    `结果：${ok ? "已执行" : "被拒"}`,
    !ok && reason ? `原因：${reason}` : "",
    detail ? `说明：${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function verdictText(
  e: Record<string, unknown>,
  mq?: Map<string, Record<string, unknown>>,
  nos?: Map<string, string>,
): string {
  const name = String(e.event ?? e.kind ?? "");
  if (name === "mq_message") return mqMessageText(e, mq?.get(String(e.id ?? "")));
  if (name === "mq_triage") return mqTriageText(e);
  if (name === "supervisor_cmd") return maskDispatchIds(cmdReceiptText(e), nos);
  return maskDispatchIds(describeEvent(e), nos);
}

/** 正则转义，供编号按字面量匹配。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskDispatchIds(text: string, nos?: Map<string, string>): string {
  if (!text || !nos || nos.size === 0) return text;
  let out = text;
  /*
   * `nos` 的值统一为裸编号（不带 `#`）。新派单号（`2-2`）显示成派单号 `#02-2`，
   * 旧格式派单显示成任务号 `#02`；两者都经补 `#` 的统一口径，不各自拼。
   *
   * 已被 `#` 前缀的编号不再替换：正文若已被上游补过 `#`，二次替换会生成 `##3-1`。
   * 前后须为非编号字符，避免从 `13-1`、`3-12` 这类更长串里切出片段。
   */
  for (const [id] of nos) {
    if (!id) continue;
    const raw = nos.get(id);
    if (!raw) continue;
    /* 新派单号显示成派单号 `#02-2`，旧格式派单显示成任务号 `#02`；都经 idMap 统一补 `#` 与两位任务号。 */
    const label = /^\d+-\d+$/.test(id)
      ? dispatchNoLabel(id)
      : /^\d+$/.test(raw)
        ? taskNoLabel(Number(raw))
        : `#${raw}`;
    out = out.replace(new RegExp(`(?<![\\d#-])${escapeRe(id)}(?![\\d-])`, "g"), label);
  }
  return out;
}

/**
 * 把进程号换成任务号：`6-P1` -> `#06`。
 *
 * 界面只发行任务号与派单号，进程号是调度内部标识，不对外展示。进程号通过三条途径
 * 进入界面文本：监工分诊的自由文本、工作进程的叙述与工具摘要、工作进程目录路径
 * （`.capitalist/workers/6-P1/brief.md`）。源头无法穷举：工作进程能看到
 * `CAPITALIST_WORKER_ID` 与所在目录名，可能在表述中复述。因此在出口统一改写。
 *
 * 本函数仅供内部使用，外部一律用 {@link maskBoardText} 或
 * {@link maskThreadMessage}，避免出现第二套改写口径。
 *
 * 边界：
 *   - 已带 `#` 的编号不替换，避免二次处理生成 `##06`；
 *   - 前一位不能是字母、数字、下划线、`#` 或 `-`，后一位不能是字母、数字、下划线
 *     或 `-`，避免从包含 `P1` 的长串中截取片段；
 *   - 路径中的进程号同样替换，`workers/6-P1/x` 显示成 `workers/#06/x`：路径仍指向
 *     真实目录，读者可对应，界面上不再出现进程号。
 */
function maskWorkerIds(text: string): string {
  const s = String(text ?? "");
  if (!s) return s;
  return s.replace(/(?<![\w#-])(\d{1,4})-P(\d{1,4})(?![\w-])/g, (_m, no: string) =>
    taskNoLabel(Number(no)),
  );
}

/**
 * 任意界面文本的出口：进程号换成任务号，再按编号表给派单号补 `#`。
 *
 * 用于不属于消息对象的零散文本，如线程摘要的说明字段与概览提示。
 * 顺序固定：先替换进程号，再改写派单号。反序会先把 `6-1` 变成 `#06-1`，进程号
 * 前一位成了 `-`，反而躲开匹配。
 */
export function maskBoardText(text: string, nos?: Map<string, string>): string {
  return maskDispatchIds(maskWorkerIds(text), nos);
}

/**
 * 界面消息的唯一出口。
 *
 * 所有下发到前端的消息对象都在这里改写一次。调用方只负责传入消息，不判断字段。
 * 新增可读字段要在这里登记，否则会形成第二种口径。
 *
 * 字段分两类：
 *   - 正文与供人阅读的说明（`text`、`reason`、`detail`、引用与指令文字）：完整改写，
 *     编号按界面口径补 `#`；
 *   - 命令与工具名（`tool`、`cmd`）：只替换进程号，不动派单号。两者是操作原文，
 *     把命令参数当成派单号改写，会导致按界面内容抄写的命令执行失败。
 */
export function maskThreadMessage(m: ThreadMessage, nos?: Map<string, string>): ThreadMessage {
  const body = (v: unknown): string => maskBoardText(String(v ?? ""), nos);
  const raw = (v: unknown): string => maskWorkerIds(String(v ?? ""));
  return {
    ...m,
    text: body(m.text),
    tool: raw(m.tool),
    cmd: raw(m.cmd),
    ...(m.reason ? { reason: body(m.reason) } : {}),
    ...(m.detail ? { detail: body(m.detail) } : {}),
    ...(m.quote ? { quote: body(m.quote) } : {}),
    ...(m.quote_text ? { quote_text: body(m.quote_text) } : {}),
    ...(m.action ? { action: body(m.action) } : {}),
    ...(m.arg ? { arg: body(m.arg) } : {}),
    ...(Array.isArray(m.debug) ? { debug: m.debug.map((x) => body(x)) } : {}),
  };
}

/**
 * 流式增量的出口。
 *
 * `onDelta` 逐字输出模型正文，进程号可能被切成两块（`6-` 与 `P1`），逐块改写会漏掉。
 * 这里保留一段尾部缓冲，与下一块拼接后再判断。尾部 12 个字符足以覆盖 `9999-P9999`
 * 这一最长形态，代价是首字延迟十余个字符，影响可忽略。
 *
 * 只缓冲正文与思考两类；工具帧原样转发（工具名不含编号）。
 * 调用方在流结束时必须调用 `flush()`，否则尾部内容不会输出。
 */
export function maskStream(send: (d: Record<string, unknown>) => void, nos?: Map<string, string>) {
  const TAIL = 12;
  let pending = "";
  let kind = "text";
  const flush = (): void => {
    if (!pending) return;
    const text = maskBoardText(pending, nos);
    pending = "";
    if (text) send({ kind, text });
  };
  return {
    onDelta: (d: { kind?: string; text?: string }): void => {
      const k = String(d?.kind ?? "");
      if (k !== "text" && k !== "thinking") {
        send(d as Record<string, unknown>);
        return;
      }
      if (k !== kind) {
        flush();
        kind = k;
      }
      pending += String(d.text ?? "");
      if (pending.length <= TAIL) return;
      const cut = pending.length - TAIL;
      const head = maskBoardText(pending.slice(0, cut), nos);
      pending = pending.slice(cut);
      if (head) send({ kind, text: head });
    },
    flush,
  };
}

export function fingerprint(e: object): string {
  const r = e as Record<string, unknown>;
  const s = [
    String(r.at ?? ""),
    String(r.event ?? r.kind ?? ""),
    String(r.tool ?? ""),
    String(r.cmd ?? ""),
    String(r.dispatch ?? ""),
    String(r.worker ?? ""),
    String(r.text ?? r.reason ?? r.note ?? ""),
  ].join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
