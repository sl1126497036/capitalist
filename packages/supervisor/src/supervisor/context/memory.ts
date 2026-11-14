/**
 * 项目记忆：把用户习惯、运行环境与项目卡点持久化到 `.capitalist/memory.json`，
 * 监工重启后仍生效。只读写该文件，与任务台账解耦；写入失败不影响调度。
 * 条目受条数、单条字数、总字数与时效四道上限裁剪；面板删除留痕，自动记录不再写入同文条目。
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJson } from "../../core/record/json";
import { supervisorDir } from "../../core/record/paths";

/**
 * 两类记忆：`habit` 收用户习惯与运行环境等既有事实，`blocker` 收项目卡点。
 * 存储值保持不变，旧任务根里的 `memory.json` 可直接读回。
 */
export type MemoryKind = "habit" | "blocker";

export const MEMORY_KINDS: readonly MemoryKind[] = ["habit", "blocker"];

export function isMemoryKind(v: unknown): v is MemoryKind {
  return v === "habit" || v === "blocker";
}

/** 单条记忆。 */
export interface MemoryEntry {
  /** 稳定 id（首次写入时生成，更新不变）。 */
  id: string;
  /** 类别：习惯 / 环境等既有事实、项目卡点。 */
  kind: MemoryKind;
  /** 匹配用的关键词（从正文里提炼，小写）。 */
  keys: string[];
  /** 描述文本，供界面展示与提示词注入。 */
  note: string;
  /** 命中同类卡点的累计次数。 */
  count: number;
  first_at: string;
  last_at: string;
  /** 最近一次关联到的派单 id，便于回查台账。 */
  last_dispatch: string;
}

interface MemoryFile {
  at: string;
  entries: MemoryEntry[];
  /** 面板人工删除的正文；自动记录不再写入同文条目。 */
  dismissed?: string[];
}

/** 条目数上限，超限按时间从旧到新裁剪。 */
export const MEMORY_MAX = 40;
/** 单条描述字符上限。 */
export const MEMORY_NOTE_MAX = 160;
/** 全部条目正文的总字符上限。 */
export const MEMORY_TOTAL_CHARS = 6000;
/** 时效：超过该天数未再命中的条目淘汰。 */
export const MEMORY_TTL_DAYS = 30;
/** 人工删除留痕的条数上限，避免无限增长。 */
export const MEMORY_DISMISSED_MAX = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryPath(root: string): string {
  return join(supervisorDir(root), "memory.json");
}

/**
 * 进程内缓存，每个任务根一份。按 mtime/size 判失效；外部修改文件后，下一轮读到新值。
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  entries: MemoryEntry[];
  dismissed: string[];
}
const cache = new Map<string, CacheEntry>();

function clone(e: MemoryEntry): MemoryEntry {
  return { ...e, keys: [...e.keys] };
}

/** 补齐缺失字段并归一化；无法修复时返回 null。 */
function normalize(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MemoryEntry>;
  const note = String(r.note ?? "").replace(/\s+/g, " ").trim().slice(0, MEMORY_NOTE_MAX);
  if (!note) return null;
  const kind: MemoryKind = isMemoryKind(r.kind) ? r.kind : guessKind(note);
  const keys = Array.isArray(r.keys) && r.keys.length ? r.keys.map((k) => String(k).toLowerCase()).filter(Boolean) : keywordsOf(note, 10);
  const first = String(r.first_at ?? "").trim() || new Date().toISOString();
  const last = String(r.last_at ?? "").trim() || first;
  return {
    id: String(r.id ?? "").trim() || `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    kind,
    keys,
    note,
    count: Number.isFinite(Number(r.count)) && Number(r.count) > 0 ? Math.round(Number(r.count)) : 1,
    first_at: first,
    last_at: last,
    last_dispatch: String(r.last_dispatch ?? ""),
  };
}

/** 无 kind 的条目按文本判定：命中习惯特征词为 `habit`，其余为 `blocker`。 */
function guessKind(note: string): MemoryKind {
  return /习惯|偏好|总是|每次|一律|prefers?\b|always\b/i.test(note) ? "habit" : "blocker";
}

function tsOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 按四道上限裁剪：时效 -> 条数 -> 总字数，顺序固定，优先移除最旧条目。 */
function prune(entries: MemoryEntry[]): { entries: MemoryEntry[]; changed: boolean } {
  const before = entries.length;
  const now = Date.now();
  let out = entries.filter((e) => now - Math.max(tsOf(e.last_at), tsOf(e.first_at)) <= MEMORY_TTL_DAYS * DAY_MS);
  out.sort((a, b) => tsOf(a.last_at) - tsOf(b.last_at) || tsOf(a.first_at) - tsOf(b.first_at));
  while (out.length > MEMORY_MAX) out.shift();
  let chars = out.reduce((n, e) => n + e.note.length, 0);
  while (out.length > 0 && chars > MEMORY_TOTAL_CHARS) {
    const gone = out.shift();
    chars -= gone ? gone.note.length : 0;
  }
  return { entries: out, changed: out.length !== before };
}

function persist(root: string, entries: MemoryEntry[], dismissed?: readonly string[]): void {
  try {
    /* 删除留痕与条目写入同一文件；未传时沿用缓存值。 */
    const kept = (dismissed ?? cache.get(root)?.dismissed ?? [])
      .map((n) => String(n ?? "").trim())
      .filter(Boolean)
      .slice(-MEMORY_DISMISSED_MAX);
    writeJson(memoryPath(root), { at: new Date().toISOString(), entries, dismissed: kept } satisfies MemoryFile);
    const st = statSync(memoryPath(root));
    cache.set(root, { mtimeMs: st.mtimeMs, size: st.size, entries: entries.map(clone), dismissed: [...kept] });
  } catch {
    /* 写入失败不阻断派单主流程。 */
  }
}

/**
 * 读全部记忆；文件不存在或损坏时返回空表，不阻塞调度。
 * 读取时裁剪过期与超限条目并落盘，避免注入失效内容。
 */
export function loadMemories(root: string): MemoryEntry[] {
  const p = memoryPath(root);
  if (!existsSync(p)) {
    cache.delete(root);
    return [];
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    return [];
  }
  const hit = cache.get(root);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries.map(clone);

  const raw = readJson<MemoryFile>(p, { at: "", entries: [] });
  const list = Array.isArray(raw?.entries) ? raw.entries.map(normalize).filter((e): e is MemoryEntry => e !== null) : [];
  const dismissed = Array.isArray(raw?.dismissed)
    ? raw.dismissed.map((n) => String(n ?? "").trim()).filter(Boolean).slice(-MEMORY_DISMISSED_MAX)
    : [];
  const pruned = prune(list);
  if (pruned.changed) persist(root, pruned.entries, dismissed);
  else cache.set(root, { mtimeMs: st.mtimeMs, size: st.size, entries: pruned.entries.map(clone), dismissed });
  return pruned.entries.map(clone);
}

/** 当前任务根的人工删除留痕（正文列表）；未加载时先读取。 */
function loadDismissed(root: string): string[] {
  loadMemories(root);
  return cache.get(root)?.dismissed ?? [];
}

/** 删除留痕去重后追加（同文只留一条，超限移除最旧）。 */
function withDismissed(list: readonly string[], note: string): string[] {
  const next = list.filter((n) => n !== note);
  next.push(note);
  return next.slice(-MEMORY_DISMISSED_MAX);
}

/** 人工重新新增同文条目时解除留痕。 */
function withoutDismissed(list: readonly string[], note: string): string[] {
  return list.filter((n) => n !== note);
}

/** 启动时预加载并清理过期条目（`runSupervisor` 开头调用）。 */
export function primeMemory(root: string): MemoryEntry[] {
  return loadMemories(root);
}

/** 从卡点文本提炼匹配关键词：英文长词 + 中文二元组，去停用词，取信息量最大的几个。 */
export function keywordsOf(text: string, max = 5): string[] {
  const s = String(text || "").toLowerCase();
  if (!s.trim()) return [];
  const stops = new Set([
    "the", "and", "for", "with", "this", "that", "not", "但", "的", "了", "是",
    "任务", "这一单", "派单", "进程", "失败", "重派", "再次", "仍然", "已经",
  ]);
  const counts = new Map<string, number>();
  const add = (k: string): void => {
    if (k.length < 2 || stops.has(k)) return;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const w of s.match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]+/g, " ");
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i + 2 <= seg.length; i += 1) add(seg.slice(i, i + 2));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([k]) => k)
    .filter(Boolean);
}

/** 两条文本的关键词重合数（≥1 即算命中；重合越多越可能是同一类卡点）。 */
function overlap(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const k of b) if (set.has(k)) n += 1;
  return n;
}

/** 正文归一化：与条目 note 同一规则，删除留痕按它比对。 */
function normalizeNote(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, MEMORY_NOTE_MAX);
}

/**
 * 记录一条记忆。正文非空即收；同类别内按关键词重合（≥2，或单键完全命中）判为同类并合并，否则新建。
 * 提不出关键词的正文照常落盘，只是不注入提示词。
 *
 * @param kind 非法值按 blocker 处理。
 * @param manual 面板人工新增：不查删除留痕，并解除同文留痕。
 */
function recordLesson(
  root: string,
  note: string,
  dispatch: string,
  kind: MemoryKind,
  manual: boolean,
): MemoryEntry | null {
  const text = normalizeNote(note);
  if (!text) return null;
  /* 面板人工删除的正文不再自动写回；人工重新新增同文条目即解除留痕。 */
  const dismissed = loadDismissed(root);
  if (!manual && dismissed.includes(text)) return null;
  const dismissedNext = manual ? withoutDismissed(dismissed, text) : undefined;
  const keys = keywordsOf(text, 10);
  const entries = loadMemories(root);
  const useKind: MemoryKind = isMemoryKind(kind) ? kind : "blocker";
  const now = new Date().toISOString();
  let hit: MemoryEntry | null = null;
  let best = 0;
  for (const e of entries) {
    if (e.kind !== useKind) continue;
    const n = overlap(e.keys, keys);
    const exactSingle = (e.keys.length === 1 || keys.length === 1) && n >= 1;
    if (n >= 2 || exactSingle) {
      if (n > best) {
        hit = e;
        best = n;
      }
    }
  }
  if (hit) {
    hit.count += 1;
    hit.last_at = now;
    hit.note = text.length > hit.note.length ? text : hit.note;
    if (dispatch) hit.last_dispatch = dispatch;
    persist(root, entries, dismissedNext);
    return hit;
  }
  const entry: MemoryEntry = {
    id: `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    kind: useKind,
    keys,
    note: text,
    count: 1,
    first_at: now,
    last_at: now,
    last_dispatch: String(dispatch || ""),
  };
  entries.push(entry);
  persist(root, prune(entries).entries, dismissedNext);
  return entry;
}

/** 记录调度卡点或习惯；面板人工删除的同文正文不再自动写回。 */
export function rememberLesson(
  root: string,
  note: string,
  dispatch = "",
  kind: MemoryKind = "blocker",
): MemoryEntry | null {
  return recordLesson(root, note, dispatch, kind, false);
}

/** 看板新增记忆，默认按 `habit` 收录；人工新增解除同文删除留痕。 */
export function addMemory(root: string, note: string, kind: MemoryKind = "habit"): MemoryEntry | null {
  return recordLesson(root, note, "", kind, true);
}

/** 编辑一条记忆；更新后重新裁剪上限，id 不存在或正文为空返回 null。 */
export function updateMemory(
  root: string,
  id: string,
  patch: { note?: string; kind?: MemoryKind },
): MemoryEntry | null {
  const want = String(id || "").trim();
  if (!want) return null;
  const entries = loadMemories(root);
  const idx = entries.findIndex((e) => e.id === want);
  if (idx < 0) return null;
  const cur = entries[idx];
  if (!cur) return null;
  const note = patch.note === undefined ? cur.note : String(patch.note).replace(/\s+/g, " ").trim().slice(0, MEMORY_NOTE_MAX);
  if (!note) return null;
  const kind = isMemoryKind(patch.kind) ? patch.kind : cur.kind;
  const next: MemoryEntry = {
    ...cur,
    note,
    kind,
    keys: note === cur.note ? cur.keys : keywordsOf(note, 10),
    last_at: new Date().toISOString(),
  };
  entries[idx] = next;
  persist(root, prune(entries).entries);
  return next;
}

/** 删除一条记忆并留痕，使自动记录不再写回同文正文；id 不存在返回 false。 */
export function deleteMemory(root: string, id: string): boolean {
  const want = String(id || "").trim();
  if (!want) return false;
  const entries = loadMemories(root);
  const gone = entries.find((e) => e.id === want);
  if (!gone) return false;
  persist(root, entries.filter((e) => e.id !== want), withDismissed(loadDismissed(root), gone.note));
  return true;
}

/** 看板列表用的快照：条目 + 上限 + 当前占用，界面不需要自己再算一遍。 */
export interface MemorySnapshot {
  at: string;
  entries: MemoryEntry[];
  limits: { max: number; note_max: number; total_chars: number; ttl_days: number };
  stats: { count: number; chars: number; habit: number; blocker: number };
}

export function memorySnapshot(root: string): MemorySnapshot {
  const entries = loadMemories(root);
  return {
    at: new Date().toISOString(),
    entries,
    limits: {
      max: MEMORY_MAX,
      note_max: MEMORY_NOTE_MAX,
      total_chars: MEMORY_TOTAL_CHARS,
      ttl_days: MEMORY_TTL_DAYS,
    },
    stats: {
      count: entries.length,
      chars: entries.reduce((n, e) => n + e.note.length, 0),
      habit: entries.filter((e) => e.kind === "habit").length,
      blocker: entries.filter((e) => e.kind === "blocker").length,
    },
  };
}

/** 挑出与 `text` 相关的记忆：关键词命中即相关。 */
export function memoriesFor(root: string, text: string): MemoryEntry[] {
  const keys = keywordsOf(String(text || ""), 24);
  if (keys.length === 0) return [];
  return loadMemories(root).filter((e) => overlap(e.keys, keys) > 0);
}

/**
 * 文案规范条目的识别词。措辞存于记忆条目（note 含此词），由 {@link copyStandardNote} 按需追加。
 * 该类条目不进入 {@link renderMemoryConstraints} 的通用注入，避免重复占上下文。
 */
export const COPY_STANDARD_MARKER = "文案规范";

export function isCopyStandardEntry(e: MemoryEntry): boolean {
  return e.note.includes(COPY_STANDARD_MARKER) || e.keys.includes(COPY_STANDARD_MARKER);
}

/** 取记忆中首条文案规范措辞；未配置返回空串。 */
export function copyStandardNote(root: string): string {
  const hit = loadMemories(root).find(isCopyStandardEntry);
  return hit ? hit.note : "";
}

/** 把记忆渲染成约束段落；跳过文案规范条目，避免重复注入。 */
export function renderMemoryConstraints(entries: readonly MemoryEntry[]): string {
  const usable = entries.filter((e) => !isCopyStandardEntry(e));
  if (!usable.length) return "";
  const lines = usable
    .slice(0, 8)
    .map((e) => {
      const n = e.count > 1 ? `（已发生 ${e.count} 次，最近 ${String(e.last_at).slice(0, 10)}）` : "";
      /*
       * 两类条目性质不同：习惯与环境是既有事实，按其执行；卡点记录要求先核对是否仍成立，
       * 避免在同一个地方重复失败。
       */
      const tag = e.kind === "habit" ? "【用户习惯与运行环境】" : "【项目卡点】";
      const how =
        e.kind === "habit"
          ? "按其执行"
          : "相关时先核对是否仍然成立；仍存在时不要重复尝试，并写明原因";
      return `- ${tag}${e.note}${n}。${how}。`;
    });
  return ["【项目记忆（用户习惯、运行环境与项目卡点，按约束执行）】", ...lines].join("\n");
}

/**
 * 派单正文追加约束；注入前剥掉旧区块，避免重派时重复注入。
 *
 * 兼容旧标题：此前写入的派单正文里区块头为“【调度经验记忆”，重派时仍要能被剥掉。
 */
const MEMORY_SECTION_HEADS = ["【项目记忆", "【调度经验记忆"];

/** 正文中最早出现的记忆区块位置；没有返回 -1。 */
function memorySectionAt(text: string): number {
  let at = -1;
  for (const head of MEMORY_SECTION_HEADS) {
    const i = text.indexOf(head);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at;
}

export function withLessons(root: string, action: string): string {
  const base = String(action || "");
  if (!base.trim()) return base;
  const cut = memorySectionAt(base);
  const stripped = cut >= 0 ? base.slice(0, cut).replace(/\s+$/, "") : base;
  const relevant = memoriesFor(root, stripped);
  const block = renderMemoryConstraints(relevant);
  return block ? `${stripped}\n\n${block}` : stripped;
}

/** 回复提示词用的记忆行。 */
export function memoryLines(root: string, text: string): string[] {
  const block = renderMemoryConstraints(memoriesFor(root, text));
  return block ? block.split("\n") : [];
}
