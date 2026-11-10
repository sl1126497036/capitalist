/**
 * 看板与回报流水命令。
 *
 * `board` 默认起 HTTP 服务（Ctrl-C 结束），`--json` 只打一次快照；`feed` 只取事件流水。
 * 两者共用 supervisor/board 的投影函数，不自己读文件，避免接口与命令行给出两种口径。
 */

import { flagBool, flagNumber, flagString, type Parsed } from "./args";
import { rootOrDie } from "./context";
import { write, writeJson } from "./output";
import { clockOf } from "../core/clock";

/**
 * 看板。
 *
 * 服务只活在当前进程里：`capitalist board` 被 Ctrl-C 掉，面板就打不开。一块没人管的常驻面板
 * 比没有面板更容易误导人。
 */
export async function cmdBoard(p: Parsed): Promise<number> {
  const root = rootOrDie(p);
  const { serveBoard, snapshotJson } = await import("../supervisor/board");

  if (flagBool(p, "json")) {
    write(snapshotJson(root));
    return 0;
  }

  const port = flagNumber(p, "port");
  const served = await serveBoard({
    root,
    port,
    host: flagString(p, "host"),
    newKey: p.flags["new-key"] === true || p.flags["new-key"] === "true",
    secure: flagBool(p, "secure"),
    out: (s) => write(`${s}\n`),
  });

  write(`[看板] ${served.url}  任务根 ${root}\n`);
  write("[看板] 页面按间隔轮询状态；Ctrl-C 结束\n");

  // 前台阻塞到进程被信号结束：serveBoard 返回的 server 自己维持事件循环，
  // 保持一个不 resolve 的 promise，使 main() 不退出并终止服务。
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      served.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    served.server.once("close", () => resolve());
  });
  return 0;
}

/** 回报流水：按工作进程的执行记录输出，供终端或其他调用方轮询。 */
export async function cmdFeed(p: Parsed): Promise<number> {
  const root = rootOrDie(p);
  const limit = Math.max(1, Math.min(Math.floor(flagNumber(p, "limit") ?? 20), 200));
  const { buildFeed } = await import("../supervisor/board");
  const feed = buildFeed(root, limit);

  if (flagBool(p, "json")) {
    writeJson(feed);
    return 0;
  }

  if (feed.length === 0) {
    write("还没有回报流水。\n");
    return 0;
  }
  for (const e of feed) {
    /* 本地时间，不截 ISO（那是 UTC，和界面上其它钟点差 8 小时）。见 core/clock.ts。 */
    write(`${clockOf(e.at)}  ${e.text}\n`);
  }
  return 0;
}
