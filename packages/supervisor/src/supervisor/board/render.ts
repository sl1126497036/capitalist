/**
 * 看板文本渲染：把日志事件、消息、派单记录压成单行或短段落。
 *
 * 只做字符串加工，不读盘、不发请求、不持有状态，便于被各视图层共用。
 */

import { ThreadMessage, describeEvent } from "./snapshot";
import { zh } from "./zh";
import { isShellTool, summarizeCommand } from "../workerLog";
import { dispatchOfThreadNo } from "../threadNo";
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

/* 只缓存全量页：不同 limit 只是同一份数据裁掉尾巴，没必要各算一遍。 */

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
    : isShellTool(tool) ? "跑命令"
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

export function workerLabel(id: string): string {
  const s = String(id ?? "").trim();
  return /^\d+$/.test(s) ? `#${s}` : s;
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
  const arg = String(e.arg ?? "").trim();
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

export function maskDispatchIds(text: string, nos?: Map<string, string>): string {
  if (!text || !nos || nos.size === 0) return text;
  return text.replace(/\bD-[A-Za-z0-9][A-Za-z0-9-]{1,}/g, (id) => {
    const no = nos.get(id);
    return no ? `#${no}` : id;
  });
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
