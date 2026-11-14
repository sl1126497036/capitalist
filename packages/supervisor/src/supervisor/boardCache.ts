/**
 * 看板产物的模块缓存管理。
 *
 * 热重载只换 `dist/supervisor` 下的模块，不动 `dist/core`：core 的共享可变状态清掉后，
 * loop 与 board 会各持一份实例。core 的改动须完整重启。
 */

import { join } from "node:path";

/**
 * 看板入口的真实产物路径。
 *
 * 单文件时代是 `board.js`，拆成目录后是 `board/index.js`。写死一种，另一种布局下解析不到，
 * 缓存清理会静默失效。
 */
function boardEntry(supervisorDir: string): string {
  try {
    return require.resolve(join(supervisorDir, "board"));
  } catch {
    /* 产物缺失时没有缓存可清，退回单文件路径。 */
    return join(supervisorDir, "board.js");
  }
}

/**
 * 清掉看板产物的模块缓存，否则 `require("./board")` 取回的仍是启动时的旧模块。
 *
 * @param supervisorDir `dist/supervisor` 目录
 * @param keep 不清的模块，传 loop 自身，避免两套调度并存
 */
export function clearBoardModuleCache(supervisorDir: string, keep: string): void {
  const targets = new Set<string>();
  const walk = (id: string): void => {
    if (targets.has(id)) return;
    targets.add(id);
    const m = require.cache[id];
    if (m) for (const c of m.children) walk(c.id);
  };
  walk(boardEntry(supervisorDir));
  for (const id of targets) {
    if (id === keep) continue;
    if (!id.startsWith(supervisorDir)) continue;
    delete require.cache[id];
  }
}
