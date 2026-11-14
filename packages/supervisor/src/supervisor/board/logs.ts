/**
 * 看板侧的工作进程日志读取。
 *
 * 只把文件读成行与增量；过滤规则与事件摊平在 workerLog.ts，两者不重叠。
 * 从 board.ts 拆出的理由是快照组装与日志 I/O 的变更节奏不同：前者随界面调整，后者只随宿主日志格式变动。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

import { sizeCached, statCached } from "../../core/record/fsCache";
import { parseWorkerLog, type WorkerLogParts } from "../worker/workerLog";

/** 日志尾部内容缓存：一轮请求里同一条日志会被预览、用量、成本各读一次。 */
export const tailLinesCache = new Map<string, { key: string; lines: string[] }>();
export const TAIL_CACHE_MAX = 256;

export function tailLines(file: string, maxBytes: number): string[] {
  try {
    const st = statCached(file);
    if (!st) return [];
    const size = st.size;
    const cacheKey = `${st.mtimeMs}:${size}:${maxBytes}`;
    const hit = tailLinesCache.get(file);
    if (hit && hit.key === cacheKey) return hit.lines.slice();
    const start = Math.max(0, size - maxBytes);
    const want = size - start;
    if (want <= 0) return [];

    const buf = Buffer.alloc(want);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, want, start);
    } finally {
      closeSync(handle);
    }

    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) text = text.replace(/^[^\n]*\n/, "");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (tailLinesCache.size >= TAIL_CACHE_MAX) tailLinesCache.clear();
    tailLinesCache.set(file, { key: cacheKey, lines });
    return lines.slice();
  } catch {
    return [];
  }
}

/** 只发送到最后一个换行，避免多字节 UTF-8 被切出半个汉字；单次最多 maxBytes。 */
export function readDelta(file: string, from: number, maxBytes = 16_384): { text: string; next: number } {
  try {
    const size = statSync(file).size;
    const start = size < from ? 0 : from;
    if (size <= start) return { text: "", next: start };

    const want = Math.min(size - start, maxBytes);
    const buf = Buffer.alloc(want);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      // 按返回值而非请求量取内容：短读时缓冲区尾部是零字节。
      read = readSync(handle, buf, 0, want, start);
    } finally {
      closeSync(handle);
    }
    if (read <= 0) return { text: "", next: start };

    const raw = buf.subarray(0, read).toString("utf8");
    const nl = raw.lastIndexOf("\n");
    if (nl < 0) {
      return read < maxBytes ? { text: "", next: start } : { text: raw, next: start + read };
    }
    const text = raw.slice(0, nl + 1);
    return { text, next: start + Buffer.byteLength(text, "utf8") };
  } catch {
    return { text: "", next: from };
  }
}

export function fileSize(file: string): number {
  return sizeCached(file);
}

export const NEW_WORKER_TAIL_BYTES = 2_048;
export const LINE_SCAN_BYTES = 4_096;

export function alignToLine(file: string, from: number): number {
  if (from <= 0) return 0;
  const back = Math.min(from, LINE_SCAN_BYTES);
  const buf = Buffer.alloc(back);
  try {
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, back, from - back);
    } finally {
      closeSync(handle);
    }
    if (read <= 0) return from;
    const nl = buf.subarray(0, read).lastIndexOf(0x0a);
    return nl >= 0 ? from - back + nl + 1 : 0;
  } catch {
    return from;
  }
}

/** 规则、过滤表与事件摊平在 workerLog.ts，本处只把文件读成行。 */
export const LOG_EVENTS_TAIL_BYTES = 2 * 1024 * 1024;
/** 单次增量超过上限时按尾部窗口重建。 */
export const LOG_INCREMENTAL_MAX_BYTES = 8 * 1024 * 1024;

export interface WorkerLogCursor {
  from: number;
  offset: number;
  parts: WorkerLogParts;
}
export const workerEventsCache = new Map<string, WorkerLogCursor>();

/** 保留预算按字符数计算，三个通道各自独立。 */
export const LOG_PARTS_MAX_CHARS = 4_000_000;

export function capByChars(lines: string[], budget: number): string[] {
  let total = 0;
  let i = lines.length;
  while (i > 0) {
    const len = lines[i - 1]?.length ?? 0;
    if (total + len > budget) break;
    total += len;
    i -= 1;
  }
  return i === 0 ? lines : lines.slice(i);
}

export function capParts(parts: WorkerLogParts): WorkerLogParts {
  return {
    text: capByChars(parts.text, LOG_PARTS_MAX_CHARS),
    tools: capByChars(parts.tools, LOG_PARTS_MAX_CHARS),
    thinking: capByChars(parts.thinking, LOG_PARTS_MAX_CHARS),
    debug: capByChars(parts.debug, LOG_PARTS_MAX_CHARS),
    hidden: parts.hidden,
    stream: parts.stream,
    ...(parts.lastAction !== undefined ? { lastAction: parts.lastAction } : {}),
  };
}

/** 从中间起读时退到第一个换行之后并前移偏移；末尾未完成的行留给下一次。 */
export function readLogRange(
  file: string,
  start: number,
  end: number,
): { text: string; offset: number; consumed: number } {
  if (end <= start) return { text: "", offset: start, consumed: start };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    /** readSync 不保证一次读满；Windows 上日志由另一进程持有写句柄时更常见，短读时补齐。 */
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const view = read === buf.length ? buf : buf.subarray(0, read);
    let from = 0;
    if (start > 0) {
      const nl = view.indexOf(0x0a);
      if (nl < 0) return { text: "", offset: start, consumed: start };
      from = nl + 1;
    }
    const lastNl = view.lastIndexOf(0x0a);
    const upto = lastNl >= from ? lastNl + 1 : from;
    return {
      text: view.subarray(from, upto).toString("utf8"),
      offset: start + from,
      consumed: start + upto,
    };
  } finally {
    closeSync(fd);
  }
}

export function readWorkerEvents(file: string, tailBytes: number = LOG_EVENTS_TAIL_BYTES): WorkerLogParts {
  const st = statCached(file);
  if (!st) return parseWorkerLog([]);
  const size = st.size;

  const needFrom = Math.max(0, size - Math.max(64 * 1024, tailBytes));

  const prev = workerEventsCache.get(file);
  let start: number;
  let reuse: WorkerLogCursor | undefined = prev;
  if (!prev) {
    start = needFrom;
  } else if (size < prev.offset) {
    /** 文件变短即截断或被替换，游标作废。 */
    start = needFrom;
    reuse = undefined;
  } else if (needFrom < prev.from) {
    start = needFrom;
    reuse = undefined;
  } else if (size - prev.offset > LOG_INCREMENTAL_MAX_BYTES) {
    start = needFrom;
    reuse = undefined;
  } else {
    start = prev.offset;
  }
  if (reuse && start === reuse.offset && size === reuse.offset) return reuse.parts;

  let range: { text: string; offset: number; consumed: number };
  try {
    range = readLogRange(file, start, size);
  } catch {
    /** 读失败时退回上一份结果，不清空已显示内容。 */
    return reuse?.parts ?? parseWorkerLog([]);
  }

  /** stream/纯文本只在文件开头判一次，增量分片沿用该判定。 */
  const chunk = parseWorkerLog(range.text.split("\n"), reuse ? { stream: reuse.parts.stream } : {});

  let parts: WorkerLogParts;
  if (reuse && start === reuse.offset) {
    const lastAction = chunk.lastAction !== undefined ? chunk.lastAction : reuse.parts.lastAction;
    parts = capParts({
      text: [...reuse.parts.text, ...chunk.text],
      tools: [...reuse.parts.tools, ...chunk.tools],
      thinking: [...reuse.parts.thinking, ...chunk.thinking],
      debug: [...reuse.parts.debug, ...chunk.debug],
      hidden: reuse.parts.hidden + chunk.hidden,
      stream: reuse.parts.stream,
      ...(lastAction !== undefined ? { lastAction } : {}),
    });
  } else {
    /** 首轮与重建的结果不拼接，直接替换。 */
    parts = capParts({
      text: chunk.text,
      tools: chunk.tools,
      thinking: chunk.thinking,
      debug: chunk.debug,
      hidden: chunk.hidden,
      stream: chunk.stream,
      ...(chunk.lastAction !== undefined ? { lastAction: chunk.lastAction } : {}),
    });
  }
  workerEventsCache.set(file, {
    from: Math.min(start, reuse?.from ?? start),
    offset: range.consumed,
    parts,
  });
  trimWorkerEventsCache();
  return parts;
}

export function trimWorkerEventsCache(): void {
  if (workerEventsCache.size <= 512) return;
  let n = 0;
  for (const k of workerEventsCache.keys()) {
    workerEventsCache.delete(k);
    if ((n += 1) >= 128) break;
  }
}

export function meaningfulLines(rawLines: readonly string[], stream?: boolean): string[] {
  return parseWorkerLog(rawLines, stream === undefined ? {} : { stream }).text;
}

/** 日志在 3 秒窗口内更新即视为正在输出。 */
export const FRESH_LOG_SEC = 3;

export function logIdleSec(file: string): number {
  const st = statCached(file);
  return st ? Math.max(0, (Date.now() - st.mtimeMs) / 1000) : Number.POSITIVE_INFINITY;
}

export const CHUNK_FALLBACK = 16;

export function isStackLine(line: string): boolean {
  return /^\s+at\s+\S/.test(line) || /^at\s+\S+.*\(/.test(line);
}

export function startsChunk(line: string): boolean {
  return (
    /^\d{2}:\d{2}(:\d{2})?\b/.test(line) ||
    /^\[launch/.test(line) ||
    /^\[silent\]/.test(line) ||
    /^\[thinking\]/.test(line) ||
    /^[$>]\s/.test(line) ||
    /^▸\s/.test(line)
  );
}

export function chunkWorkerLines(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let stack = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nextIsStack = i + 1 < lines.length && isStackLine(lines[i + 1] ?? "");
    if (cur.length > 0 && !isStackLine(line) && startsChunk(line)) {
      out.push(cur);
      cur = [];
      stack = 0;
    }
    cur.push(line);
    if (isStackLine(line)) stack += 1;
    const limit = Math.max(CHUNK_FALLBACK, stack);
    if (!isStackLine(line) && !nextIsStack && cur.length >= limit) {
      out.push(cur);
      cur = [];
      stack = 0;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export const LOG_TAIL_BYTES = 512 * 1024;
export const LOG_TAIL_LINES = 4000;
export const logTailCache = new Map<string, { key: string; lines: string[] }>();

export function readLogTail(file: string, size: number, maxBytes: number): string {
  const start = Math.max(0, size - maxBytes);
  let text: string;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  return text;
}

export function readWorkerLog(file: string): string[] {
  try {
    if (!existsSync(file)) return [];
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = logTailCache.get(file);
    if (hit !== undefined && hit.key === key) return hit.lines;
    const lines = meaningfulLines(
      readLogTail(file, st.size, LOG_TAIL_BYTES)
        .split("\n")
        .map((l) => l.replace(/\r$/, "")),
    ).slice(-LOG_TAIL_LINES);
    logTailCache.set(file, { key, lines });
    if (logTailCache.size > 512) {
      let n = 0;
      for (const k of logTailCache.keys()) {
        logTailCache.delete(k);
        if ((n += 1) >= 128) break;
      }
    }
    return lines;
  } catch {
    return [];
  }
}

export const tailRowsCache = new Map<string, { key: string; rows: Array<Record<string, unknown>> }>();

export function readJsonlFromTail(file: string, maxBytes: number): Array<Record<string, unknown>> {
  let key: string;
  try {
    const st = statSync(file);
    key = `${st.mtimeMs}:${st.size}:${maxBytes}`;
  } catch {
    return [];
  }
  const hit = tailRowsCache.get(file);
  if (hit && hit.key === key) return hit.rows;

  const rows: Array<Record<string, unknown>> = [];
  for (const line of tailLines(file, maxBytes)) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (v && typeof v === "object") rows.push(v);
    } catch {
    }
  }
  if (tailRowsCache.size > 64) tailRowsCache.clear();
  tailRowsCache.set(file, { key, rows });
  return rows;
}

