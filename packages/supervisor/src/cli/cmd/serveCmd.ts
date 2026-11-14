/**
 * `capitalist serve` 入口：本地启动器的查看与运行。
 *
 * 启动器由 `capitalist install` 在用户终端创建，不写自启、不写注册表。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { BRIDGE_PLATFORM, askBridge, bridgeLogPath, runBridge } from "../../core/platform/bridge";
import { flagBool, type Parsed } from "../args";
import { write } from "../output";

function log(line: string): void {
  try {
    const file = bridgeLogPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    /* 日志写不进去不影响启动器本身 */
  }
}

/** 探活。 */
async function status(): Promise<number> {
  const alive = await askBridge({ type: "ping" }, 3000);
  write(alive?.ok ? "启动器：在线\n" : "启动器：未运行。重跑 capitalist install。\n");
  return alive?.ok ? 0 : 1;
}

/** `capitalist serve [--status]`。 */
export function cmdServe(p: Parsed): Promise<number> | number {
  if (!BRIDGE_PLATFORM) {
    write("当前平台不使用启动器。\n");
    return 0;
  }
  if (flagBool(p, "status")) return status();
  return runBridge(log);
}
