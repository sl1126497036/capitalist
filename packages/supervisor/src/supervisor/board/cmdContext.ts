
import { stripAttachments } from "../../core/message/attachments";
import { listWorkers, readDispatches } from "../../core/record/supervisor";
import { readTasks } from "../../core/record/tasks";
import { taskNoOfDispatchId } from "../../core/record/tasks";
import { groupNoLabel, taskNoLabel } from "../../core/record/idMap";
import { readGroups, groupIndexOf } from "../../core/record/groups";
import { groupStateWord, groupStatusOf } from "../../core/dispatch/groupGraph";
import { label as nodeLabel } from "../../core/record/nodeRef";
import { laneBaseOf, laneContextWindow, readLane } from "../judge/sessionLane";
import { dispatchNoTable } from "../usage/threadNo";
import { parseWorkerLog } from "../worker/workerLog";
import { ThreadSummary, dispatchTitle } from "./snapshot";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * 命令上下文文本：把线程、运行时、结算情况汇总为供监工阅读的短段落。
 *
 * 只读盘与拼字符串，不做写入，供命令层与看板路由共用。
 */
export function forestNoOf(root: string): (id: string) => string {
  const byDispatch = dispatchNoTable(root);
  return (id) => byDispatch.get(String(id)) ?? "";
}

export function taskNoLines(root: string, threads: readonly ThreadSummary[], limit = 24): string[] {
  const rank = (s: string): number =>
    s === "running" || s === "starting" ? 0 : s === "queued" ? 1 : s === "failed" ? 2 : 3;
  const picked = threads
    .filter((t) => t.no)
    .sort((a, b) => rank(a.status) - rank(b.status) || Number(a.no) - Number(b.no))
    .slice(0, limit);
  const lines = picked.map((t) => {
    const who = t.worker ? "执行中" : "排队中";
    const title = t.title ? ` · ${t.title}` : "";
    return `  ${taskNoLabel(Number(t.no))} [${t.shard || t.stage}] ${t.status}${title} · ${who}`;
  });
  if (lines.length === 0 && readGroups(root).length === 0) return [];
  return [
    "",
    "【任务编号表】用户给出的#号就是这里的编号，回答时直接引用，不要自行编号：",
    ...lines,
    ...groupNoLines(root),
  ];
}

/**
 * 分组行。没有组时不输出任何内容，避免给模型一个空标题引发猜测。
 *
 * 组号必须出现在这张表里：模型只认这里列出的号，看不到 `#G1` 就不会写 `PARENT: #G1`，
 * 分组功能将无法使用。
 */
export function groupNoLines(root: string, limit = 12): string[] {
  const groups = readGroups(root);
  if (groups.length === 0) return [];
  const rows = readDispatches(root);
  const idx = groupIndexOf(rows, groups);
  const lines = groups
    .slice(-limit)
    .map((g) => {
      const st = groupStatusOf(g.id, rows, idx);
      const done = st?.done ?? 0;
      const total = st?.total ?? 0;
      const state = st ? groupStateWord(st.state) : "";
      const broken = st?.brokenAt ? ` · 断链 ${st.brokenAt}` : "";
      return `  ${groupNoLabel(g.id)} [组] ${g.title} ${done}/${total} 完成 · ${state}${broken}`;
    });
  return [
    "",
    "  以 [组] 开头的是分组：组内并行、整组完成才放行挂在组上的派单。",
    "  加入组写 `GROUP: #G号`，新建组写 `GROUP: new <组标题>`，挂组写 `PARENT: #G号`（仍须填写 PARENT_REASON）。",
    ...lines,
  ];
}

export function workerRuntimeLines(root: string, max = 5): string[] {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length === 0) return [];
  const disps = readDispatches(root);
  const rows: string[] = [];
  for (const w of live.slice(0, max)) {
    const noNum = w.dispatch ? taskNoOfDispatchId(String(w.dispatch)) : 0;
    const no = noNum > 0 ? taskNoLabel(noNum) : "";
    const laneId = String((w as unknown as { ai_session?: string }).ai_session ?? "");
    const base = laneBaseOf(root, laneId);
    const st = base ? readLane(root, base) : null;
    const short = base.replace(/^capitalist-[a-z0-9]+-/, "") || "?";
    const win = st ? laneContextWindow(st) : 0;
    const used = st?.ctx_used ?? null;
    const pct = used !== null && win > 0 ? Math.round((used / win) * 100) : null;
    const room = pct === null ? "余量未知" : `余量 ${100 - pct}%`;
    const gen = st && st.gen >= 4 ? ` · 第 ${st.gen + 1} 代` : "";
    const d = w.dispatch ? disps.find((x) => String(x.id) === String(w.dispatch)) : undefined;
    const rawWhat = d ? stripAttachments(String(d.action ?? "")).trim() || dispatchTitle(d) : "";
    const what = rawWhat.replace(/\s+/g, " ").trim().slice(0, 40);
    const digest = workerDigest(w);
    const tail = [what, digest].filter(Boolean).join(" · ");
    rows.push(`  ${no ? no : `进程 ${w.id}`} · ${w.id} · ${short}${gen} · ${room}${tail ? ` · ${tail}` : ""}`);
  }
  return [
    "",
    "【运行中的进程】一行一个：编号、会话、余量、本单任务内容、当前进度。判断“这句话该不该发给它”：",
    "  会话＝是不是同类任务；余量＝装不装得下；要做什么＝与当前消息是不是同一件事；做到哪＝还差多少。",
    "  这几样不够判断时不推断：`capitalist worker <进程号>` 看它的动作时间线，再不够就读 `.capitalist/workers/<进程号>.log`。",
    ...rows,
  ];
}

export function workerDigest(w: { log?: string }): string {
  const file = String(w.log ?? "");
  if (!file) return "";
  try {
    const size = statSync(file).size;
    const take = Math.min(size, 256_000);
    const buf = Buffer.alloc(take);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, take, size - take);
    } finally {
      closeSync(fd);
    }
    const parts = parseWorkerLog(buf.toString("utf8").split("\n"), { stream: true });
    const edits = new Set<string>();
    const reads = new Set<string>();
    let runs = 0;
    for (const t of parts.tools) {
      const s = String(t).replace(/^▸\s*/, "").replace(/\s+/g, " ").trim();
      if (!s) continue;
      if (/^修改\s/.test(s)) edits.add(s.replace(/^修改\s*/, ""));
      else if (/^读取\s|^搜索\s/.test(s)) reads.add(s.replace(/^(?:读取|搜索)\s*/, ""));
      else runs += 1;
    }
    const out: string[] = [];
    const ed = [...edits];
    if (ed.length) out.push(`改过 ${ed.slice(0, 2).join("、")}${ed.length > 2 ? ` 等 ${ed.length} 处` : ""}`);
    if (runs) out.push(`执行过 ${runs} 步`);
    if (out.length === 0) out.push(reads.size ? `查过 ${reads.size} 处，尚未开始修改` : "刚开始，尚未开始修改");
    return out.join("；").slice(0, 64);
  } catch {
    return "";
  }
}

export function settledLines(root: string, limit = 8): string[] {
  const all = readTasks(root)
    .filter((t) => String(t.detail ?? "").trim() || String(t.note ?? "").trim())
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, limit);
  if (all.length === 0) return [];
  const noTable = dispatchNoTable(root);
  const word = (s: string): string =>
    s === "accepted"
      ? "已验收"
      : s === "closed"
        ? "已关闭"
        : s === "failed"
          ? "失败"
          : s === "reported" || s === "submitted"
            ? "待验收"
            : s === "pending" || s === "open"
              ? "待执行"
              : s;
  const flat = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
  const ask = (s: unknown): string => {
    const t = flat(s);
    const at = t.indexOf("要求");
    return (at > 0 ? t.slice(at) : t).slice(0, 44);
  };
  const verdict = (s: unknown): string =>
    flat(s)
      .replace(/(监工裁决通过|监工裁决|实地核证|核证)[：:]\s*/g, "")
      .slice(0, 48);
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const t of all) {
    const no = t.dispatch ? String(noTable.get(String(t.dispatch)) ?? "") : "";
    const key = no || String(t.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = verdict(t.note);
    rows.push(`  ${no ? nodeLabel(no) : "-"} ${word(String(t.state ?? ""))} · ${ask(t.detail)}${res ? ` · ${res}` : ""}`);
    if (rows.length >= limit) break;
  }
  return [
    "",
    "【最近派过的单】按最近更新排。先通读一遍再派：该事项是否已派过、上一轮完成情况如何、",
    "  有没有还没做完的单在等（重复派会让两个进程改同一处，互相把对方覆盖掉）。",
    ...rows,
    "  新要求若与其中任何一条相反（恢复已撤销的改动、改回旧行为、把两套并存的实现再叠加一层），",
    "  必须在动作行下面单独写一行 `REVOKE: <被作废的那条口径>`，说清作废的是哪一条。",
    "  没有 REVOKE 行的派单不许推翻已验收的行为：两条互斥的要求同时挂着，工作进程只能照最新一句做，",
    "  结果就是把刚移除的实现又加回来，形成两套并存。",
  ];
}
