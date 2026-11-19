/**
 * 暂停标记（`.capitalist/pause.json`）：存在即处于暂停态，删除即恢复。
 *
 * 定义放在 core 而非监工循环里，是因为读取方跨三层：监工轮次（`supervisor/loop.ts`）、
 * 命令行（`cli/main.ts`）、看板（`supervisor/board/*`）。任一方都不该为了读一个记录文件
 * 去引用监工循环，否则命令行为读一个标志位就要加载整条调度链路。
 *
 * 写入不进本模块：暂停与恢复都伴随事件记录，属监工层职责，见 `loop.ts` 的
 * `writePauseFile` / `clearPauseFile`。
 */

import { readJson } from "./json";
import { runtime } from "./locations";

/** `.capitalist/runtime/pause.json` 的内容。 */
export interface PauseFile {
  at: string;
  reason: string;
  by?: string;
}

/** 暂停文件的绝对路径：`<root>/.capitalist/runtime/pause.json`。 */
export function pausePath(root: string): string {
  return runtime.pause(root);
}

/**
 * 读暂停文件；缺失或损坏都视为未暂停，不因一次写入损坏而使状态无法恢复。
 *
 * @returns 归一化后的暂停记录；文件不存在、内容非对象或无法解析时返回 null。
 */
export function readPause(root: string): PauseFile | null {
  const raw = readJson<Partial<PauseFile> | null>(pausePath(root), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    at: String(raw.at ?? ""),
    reason: String(raw.reason ?? ""),
    ...(raw.by === undefined ? {} : { by: String(raw.by) }),
  };
}
