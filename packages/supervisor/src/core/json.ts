/**
 * JSON 与 JSONL 保存。
 *
 * 整份写入走临时文件加 rename。多个进程会同时写同一个任务根（每次工具调用一个 hook
 * 进程、监工、CLI），写到一半的文件解析为非法 JSON，调用方会当作「文件缺失」处理，
 * 静默丢弃状态。JSONL 只追加，不需要这一套。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { invalidatePath } from "./fsCache";

/** 原子写的临时文件统一落在这个子目录名下（与被写文件同级）。 */
const TMP_DIRNAME = ".tmp";

/** 一次启动最多清多少个历史残留。 */
const PRUNE_MAX_PER_RUN = 400;

/**
 * 读 JSON。
 *
 * @param fallback 文件缺失、内容损坏或不是合法 JSON 时返回的值。
 * @returns 解析结果；解析失败一律返回 `fallback`，不抛。
 */
/** 小文件读缓存有效期：轮询间隔 2 秒，200ms 不会让界面看起来滞后。 */
const READ_CACHE_TTL_MS = 300;
const readCache = new Map<string, { at: number; value: unknown }>();

/**
 * 读 JSON。
 *
 * @param fallback 文件缺失、内容损坏或不是合法 JSON 时返回的值。
 * @returns 解析结果；解析失败一律返回 `fallback`，不抛。
 *
 * 同一个文件在一轮请求里常被多个模块读到（上下文窗口配置、任务编号表、
 * 积分台账），每次都是一次同步读盘；这里按路径缓存解析结果，写路径统一
 * 走 {@link writeJson} 会立即失效，所以「写完马上读」仍看到新值。
 */
export function readJson<T>(file: string, fallback: T): T {
  const hit = readCache.get(file);
  if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.value as T;
  let value: T;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    /* 文件不存在与内容损坏同样处理：都当没有值。省掉一次 existsSync。 */
    value = fallback;
  }
  if (readCache.size >= 4_096) readCache.clear();
  readCache.set(file, { at: Date.now(), value });
  return value;
}

/** 原子写文本：临时文件 + rename。 */
function writeAtomic(file: string, text: string): void {
  // 临时文件放进同级的 `.tmp/` 子目录，而不是与被写文件并排。
  //
  // 并排时启动清理要遍历整个目录才能找出 `.tmp`，而 `.capitalist/` 里同时有几百个
  // 正常文件；一旦残留堆积，读目录本身就成了瓶颈。集中到子目录之后，启动时对这个
  // 子目录整体删除，成本与残留数量无关。rename 仍在同一卷内，原子性不变。
  const tmpDir = join(dirname(file), TMP_DIRNAME);
  const tmp = join(
    tmpDir,
    `${basename(file)}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`,
  );
  mkdirSync(tmpDir, { recursive: true });

  try {
    writeFileSync(tmp, text, "utf8");
    try {
      renameSync(tmp, file);
      return;
    } catch {
      /* 走回退 */
    }
    writeFileSync(file, text, "utf8");
  } finally {
    // rename 成功后 tmp 已不存在；回退成功或中途抛错时它还在，一律删掉。
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 删不掉也不能让写操作失败：留下的是可被 pruneTempFiles 清掉的残留 */
    }
  }
}

/**
 * 原子写 JSON。目录不存在会自动建。缩进 2 空格、中文不转义，便于人工排查。
 *
 * @throws 保存失败时抛出。
 */
export function writeJson(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2));
  invalidatePath(file);
  readCache.delete(file);
}

/**
 * 整文件覆盖写 JSONL。
 *
 * 只用于就地修改已有记录（标记 resolved 之类）：纯追加走 {@link appendJsonl}，
 * 覆盖写会丢掉并发进程刚追加的行。
 *
 * @throws 保存失败时抛出。
 */
export function writeJsonl(file: string, rows: readonly unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  writeAtomic(file, rows.length > 0 ? `${body}\n` : "");
  invalidatePath(file);
  readCache.delete(file);
}

/**
 * 追加一行 JSONL。单行写入在 O_APPEND 下原子，不会与其他进程交错。
 *
 * @returns 写入成功返回 true；失败返回 false，不抛。
 */
export function appendJsonl(file: string, record: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    invalidatePath(file);
    readCache.delete(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 JSONL。坏行跳过而不是整体失败，一行脏数据不该让整份台账不可用。
 *
 * @param limit 最多返回的行数，0 表示不限。
 */
export function readJsonl<T = Record<string, unknown>>(file: string, limit = 0): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as T);
      } catch {
        continue;
      }
      if (limit > 0 && out.length >= limit) break;
    }
  } catch {
    return out;
  }
  return out;
}

/** 清掉原子写留下的临时文件。 */
export function pruneTempFiles(
  dirs: readonly string[],
  maxAgeMs = 600_000,
  maxRemove = PRUNE_MAX_PER_RUN,
): { removed: number; truncated: boolean; samples: string[] } {
  const samples: string[] = [];
  let removed = 0;
  let truncated = false;
  const now = Date.now();
  const budget = { left: maxRemove };

  /** 记账：达到上限就置 truncated 并停止继续处理。 */
  const take = (file: string): boolean => {
    if (budget.left <= 0) {
      truncated = true;
      return false;
    }
    budget.left -= 1;
    removed += 1;
    if (samples.length < 5) samples.push(file);
    return true;
  };

  for (const dir of dirs) {
    // 新式落点：整个子目录一次删掉。里面只会有临时文件，没有需要保留的东西。
    try {
      rmSync(join(dir, TMP_DIRNAME), { recursive: true, force: true });
    } catch {
      /* 删不掉就算了：下次启动再来，不影响主流程 */
    }

    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs < maxAgeMs) continue;
        unlinkSync(file);
        take(file);
      } catch {
        /* 删不掉就留给下一次启动 */
      }
    }
    if (budget.left <= 0) {
      truncated = true;
      break;
    }
  }
  return { removed, truncated, samples };
}
