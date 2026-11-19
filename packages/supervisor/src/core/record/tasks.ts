/** 任务池台账（`.capitalist/tasks.jsonl`）：一件“要做的活”而不是“一次执行尝试”。 */

import { join } from "node:path";

import { appendJsonl, readJsonl, writeJsonl } from "./json";
import { supervisorDir } from "./paths";
import { registerDispatch, registerTask } from "./idMap";
import type { Dispatch } from "./supervisor";

/** 任务状态。 */
export type TaskState = "pending" | "dispatched" | "submitted" | "accepted" | "failed" | "void";

/** 一个任务项。 */
export interface TaskItem {
  /** 任务号字符串（如 `"2"`），与 `no` 同值。 */
  id: string;
  /** 任务号（正整数，对外编号 `#01` 里的数字）。建任务时发行，重派复用，稳定不漂。 */
  no?: number;
  title: string;
  detail?: string;
  /** AI 打的分类标签。 */
  tags: string[];
  state: TaskState;
  /** 最近一次承载它的派单。 */
  dispatch?: string;
  /** 累计派过几次（重派会加）。 */
  attempts: number;
  stage?: string;
  shard?: string;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  note?: string;
  /** 归并时被并进来的其它任务项（代表项才有）。 */
  merged_from?: string[];
  /** 被并走的那一项指向谁（`void` 状态下有值）。 */
  merged_into?: string;
}

/** 任务池文件路径。 */
export function tasksPath(root: string): string {
  return join(supervisorDir(root), "tasks.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 任务项唯一标识，即任务号（`"2"`）。
 *
 * 任务号自增、永不回收，是任务的唯一标识，不再有独立的内部键（原 `T-` 前缀已废弃）。
 */
function taskIdOf(no: number): string {
  return String(no);
}

/** 下一个任务号：已有任务号最大值 +1，从未分配过则从 1 起。 */
function nextTaskNo(rows: TaskItem[]): number {
  const used = rows
    .map((t) => Number(t.no))
    .filter((n) => Number.isFinite(n) && n > 0);
  return used.length ? Math.max(...used) + 1 : 1;
}

/** 读全部任务项。坏行跳过，一行脏数据不该让整份清单不可读。 */
export function readTasks(root: string): TaskItem[] {
  return readJsonl<TaskItem>(tasksPath(root)).filter(
    (t) => t && typeof t.id === "string" && t.id.length > 0 && typeof t.title === "string",
  );
}

function writeAll(root: string, rows: TaskItem[]): void {
  writeJsonl(tasksPath(root), rows);
}

/** 派单号里的任务号（`2-3` -> 2）；非新格式返回 0。 */
export function taskNoOfDispatchId(dispatchId: string): number {
  const m = /^(\d+)-(\d+)$/.exec(String(dispatchId ?? ""));
  return m ? Number(m[1]) : 0;
}

/**
 * 为一张派单确定任务号与派发序，返回派单号（落盘形式 `2-3`，不带 `#`）。
 *
 * 这是“任务号 + 派发序”的唯一发行点：同一分片复用原任务号、派发序加一；否则分配新任务号。
 * 派单号本身编码任务号，`ensureTaskForDispatch` 据此对齐，不再靠 `thread-no.json` 事后映射。
 */
export function resolveDispatchNo(
  root: string,
  stage: string,
  shard: string | undefined,
): { no: number; attempt: number; dispatchId: string } {
  const rows = readTasks(root);
  const same = shard
    ? rows.find((t) => t.stage === stage && t.shard === shard && t.state !== "void")
    : undefined;
  if (same) {
    const no = Number(same.no) > 0 ? Number(same.no) : nextTaskNo(rows);
    const attempt = (same.attempts ?? 0) + 1;
    return { no, attempt, dispatchId: `${no}-${attempt}` };
  }
  const no = nextTaskNo(rows);
  return { no, attempt: 1, dispatchId: `${no}-1` };
}

/**
 * 为一张派单确保有任务项（幂等）。
 *
 * 已存在（同一 `dispatch`）就原样返回，不重复建。新派单建一条 `dispatched`。
 * 任务号从派单号（`2-3`）解析，与 {@link resolveDispatchNo} 对齐，不重算。
 */
export function ensureTaskForDispatch(root: string, d: Dispatch): TaskItem {
  const rows = readTasks(root);
  const hit = rows.find((t) => t.dispatch === d.id);
  if (hit) return hit;

  const no = taskNoOfDispatchId(String(d.id));
  /* 同一分片的重复派单（重派）挂到同一项上，而不是每次都新建一条。 */
  const sameShard = d.shard
    ? rows.find((t) => t.stage === d.stage && t.shard === d.shard && t.state !== "void")
    : undefined;
  if (sameShard) {
    const next: TaskItem = {
      ...sameShard,
      ...(no > 0 && sameShard.no !== no ? { no } : {}),
      dispatch: d.id,
      state: "dispatched",
      attempts: (sameShard.attempts ?? 0) + 1,
      updated_at: nowIso(),
    };
    writeAll(root, rows.map((t) => (t.id === sameShard.id ? next : t)));
    registerDispatch(root, Number(next.no) || no || nextTaskNo(rows), next.attempts);
    return next;
  }

  const raw = String((d as unknown as { title?: string }).title ?? "").trim() || d.action;
  const no2 = no > 0 ? no : nextTaskNo(rows);
  const item: TaskItem = {
    id: taskIdOf(no2),
    no: no2,
    title: raw.length > 80 ? `${raw.slice(0, 78)}…` : raw,
    detail: String(d.action ?? ""),
    tags: Array.isArray(d.tags) ? d.tags : [],
    state: "dispatched",
    dispatch: d.id,
    attempts: 1,
    stage: d.stage,
    ...(d.shard ? { shard: d.shard } : {}),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  appendJsonl(tasksPath(root), item);
  registerTask(root, no2, item.title);
  registerDispatch(root, no2, item.attempts);
  return item;
}

/** 按派单的新状态同步任务项。 */
export function syncTaskForDispatch(root: string, d: Dispatch): void {
  const rows = readTasks(root);
  const idx = rows.findIndex((t) => t.dispatch === d.id);
  if (idx < 0) return;
  const cur = rows[idx] as TaskItem;

  const map: Record<string, TaskState> = {
    open: "dispatched",
    claimed: "dispatched",
    reported: "submitted",
    review: "submitted",
    done: "accepted",
    failed: "failed",
    closed: "void",
  };
  const nextState = map[String(d.status)] ?? cur.state;
  if (nextState === cur.state && cur.note === (d.note ?? cur.note)) return;

  const next: TaskItem = {
    ...cur,
    state: nextState,
    updated_at: nowIso(),
    ...(nextState === "accepted" ? { accepted_at: nowIso() } : {}),
    ...(d.note ? { note: String(d.note).slice(0, 500) } : {}),
  };
  rows[idx] = next;
  writeAll(root, rows);
}

/** 汇总：这是“派了几项、验收了几项、还剩几项”的唯一出口。 */
export interface TaskSummary {
  total: number;
  /** 已派出（含重试中）。 */
  dispatched: number;
  /** 自称完成、等着确认。 */
  submitted: number;
  /** 已验收。 */
  accepted: number;
  /** 失败待重试。 */
  failed: number;
  /** 人关掉的。 */
  voided: number;
  /** 还没派出去的。 */
  pending: number;
  /** 未完成 = 总数 - 已验收 - 已关闭。 */
  remaining: number;
}

export function taskSummary(root: string): TaskSummary {
  const rows = readTasks(root);
  const count = (s: TaskState): number => rows.filter((t) => t.state === s).length;
  const accepted = count("accepted");
  const voided = count("void");
  return {
    total: rows.length,
    dispatched: count("dispatched"),
    submitted: count("submitted"),
    accepted,
    failed: count("failed"),
    voided,
    pending: count("pending"),
    remaining: rows.length - accepted - voided,
  };
}

/** 人手动关掉一项（不在池里了）。 */
export function voidTask(root: string, id: string, note = ""): TaskItem | null {
  const rows = readTasks(root);
  const idx = rows.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const next: TaskItem = {
    ...(rows[idx] as TaskItem),
    state: "void",
    updated_at: nowIso(),
    ...(note ? { note } : {}),
  };
  rows[idx] = next;
  writeAll(root, rows);
  return next;
}

/** 人手动建一项（动态追加的需求，还没有对应派单时用）。 */
export function createTask(
  root: string,
  input: { title: string; detail?: string; tags?: string[]; stage?: string },
): TaskItem {
  const rows = readTasks(root);
  const no = nextTaskNo(rows);
  const item: TaskItem = {
    id: taskIdOf(no),
    no,
    title: input.title.slice(0, 120),
    ...(input.detail ? { detail: input.detail } : {}),
    tags: input.tags ?? [],
    state: "pending",
    attempts: 0,
    ...(input.stage ? { stage: input.stage } : {}),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  appendJsonl(tasksPath(root), item);
  return item;
}

/** 一行摘要，给 `capitalist status` / 看板直接贴。 */
export function summaryLine(s: TaskSummary): string {
  return (
    `任务池 ${s.total} 项 ｜ 已派 ${s.dispatched} ｜ 待确认 ${s.submitted} ｜ ` +
    `已验收 ${s.accepted} ｜ 失败待重试 ${s.failed} ｜ 已关闭 ${s.voided} ｜ 未完成 ${s.remaining}`
  );
}


/**
 * 标题规范化：只留中英文与数字。
 *
 * 用户同一件事会用不同说法反复追加（“把 X 改一下”“X 还是要改”“X 改了吗”），
 * 区别常常只在标点、空格、语气词。规范化之后这些噪声不参与比较，剩下的才是“说的
 * 是不是同一件事”。
 */
function normTitle(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "")
    .slice(0, 200);
}

/** 字符二元组集合，用来算 Jaccard 相似度（中文按字切，不需要分词器）。 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  /* 一方完整包含另一方（且够长）：这是“同一件事的详写与略写”，直接判同义。 */
  const [shortOne, longOne] = a.length <= b.length ? [a, b] : [b, a];
  if (shortOne.length >= 8 && longOne.includes(shortOne)) return 0.95;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 两段文本是否在讲同一件事（0~1，字符二元组 Jaccard）。 */
export function titleSimilarity(a: string, b: string): number {
  return similarity(normTitle(a), normTitle(b));
}

/** 一批可归并的任务项。 */
export interface MergeGroup {
  /** 代表项 id（保留这一条）。 */
  keep: string;
  /** 被并走的项 id。 */
  drop: string[];
  /** 代表项的标题，供预览时认。 */
  title: string;
}

/** 状态优先级：越靠后越“有进展”，归并时保留进展最多的那条当代表。 */
const STATE_RANK: Record<TaskState, number> = {
  void: 0,
  pending: 1,
  failed: 2,
  dispatched: 3,
  submitted: 4,
  accepted: 5,
};

/** 规划同义归并（只算不改）。 */
export function planMerges(root: string, threshold = 0.62): MergeGroup[] {
  const rows = readTasks(root).filter((t) => t.state !== "void" && t.state !== "accepted");
  const used = new Set<string>();
  const groups: MergeGroup[] = [];

  for (const base of rows) {
    if (used.has(base.id)) continue;
    const nb = normTitle(base.title) || normTitle(String(base.detail ?? ""));
    const same: TaskItem[] = [base];
    for (const other of rows) {
      if (other.id === base.id || used.has(other.id)) continue;
      const no = normTitle(other.title) || normTitle(String(other.detail ?? ""));
      const sameShard =
        base.shard && other.shard && base.stage === other.stage && base.shard === other.shard;
      if (sameShard || similarity(nb, no) >= threshold) same.push(other);
    }
    if (same.length <= 1) continue;
    /* 代表项：进展最多的那条；并列时留最早的（先提的那件事是原始需求）。 */
    const keep = same
      .slice()
      .sort((a, b) => {
        const d = (STATE_RANK[b.state] ?? 0) - (STATE_RANK[a.state] ?? 0);
        return d !== 0 ? d : String(a.created_at).localeCompare(String(b.created_at));
      })[0] as TaskItem;
    const drop = same.filter((t) => t.id !== keep.id).map((t) => t.id);
    for (const t of same) used.add(t.id);
    groups.push({ keep: keep.id, drop, title: keep.title });
  }
  return groups;
}

/** 执行归并：代表项记 `merged_from`，其余项转 `void` 并指向代表项。 */
export function applyMerges(root: string, groups: MergeGroup[]): number {
  if (groups.length === 0) return 0;
  const rows = readTasks(root);
  const byId = new Map(rows.map((t) => [t.id, t] as const));
  let changed = 0;
  for (const g of groups) {
    const keep = byId.get(g.keep);
    if (!keep) continue;
    const merged = [...(keep.merged_from ?? [])];
    for (const id of g.drop) {
      if (!byId.get(id)) continue;
      if (!merged.includes(id)) merged.push(id);
      changed += 1;
    }
    byId.set(g.keep, {
      ...keep,
      merged_from: merged,
      updated_at: nowIso(),
    });
    for (const id of g.drop) {
      const it = byId.get(id);
      if (!it) continue;
      byId.set(id, {
        ...it,
        state: "void",
        merged_into: g.keep,
        note: `已归并到 ${g.keep}（同义重复）`,
        updated_at: nowIso(),
      });
    }
  }
  writeAll(root, rows.map((t) => byId.get(t.id) ?? t));
  return changed;
}
