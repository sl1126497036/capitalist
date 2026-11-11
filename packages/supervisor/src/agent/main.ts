#!/usr/bin/env node
/**
 * Hook 入口，由宿主进程调用。
 *
 *   capitalist-hook <event> [--agent <id>]      处理一个事件
 *   capitalist-hook --selftest [--agent <id>]   打印解析到的事件映射，不处理事件
 *
 * 事件名可以写宿主原生名（`PreToolUse`），也可以写中性名（`action`）。安装器写原生名。
 *
 * 退出码 0 放行，退出码 2 用于忽略结构化输出的宿主。内部错误一律退出 0。
 *
 * 例外是“监工已不在了”：那由 `orphanGuard` 判定，写一行说明进 worker 日志后退出 1，
 * 不再走正常放行。它不是 hook 的错误，是 worker 该结束了。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { byId, detect, normalize } from "./registry";
import { dispatch } from "./dispatch";
import { guardSupervisor } from "./orphanGuard";
import type { HostImpl, NativePayload } from "./contract";

/** 两次心跳落盘之间的最小间隔，单位毫秒。 */
const HEARTBEAT_MIN_GAP_MS = 2000;

/**
 * 续写当前工作进程的心跳。
 *
 * 写入 `.capitalist/workers/<id>.json` 的 `heartbeat_at` 与 `heartbeat_ts`。缺少 `CAPITALIST_WORKER_ID`
 * 或 `CAPITALIST_ROOT`、文件不存在、距上次写入不足最小间隔、读写失败时都不写。
 *
 * 监工判活只读 `heartbeat_ts`，该字段启动时写一次。不续写时，超过超时阈值的正常工作
 * 会被判死并重派，重派是新上下文。
 */
function touchWorkerHeartbeat(): void {
  const id = process.env.CAPITALIST_WORKER_ID;
  const root = process.env.CAPITALIST_ROOT;
  if (!id || !root) return;
  const file = join(root, ".capitalist", "workers", `${id}.json`);
  try {
    if (!existsSync(file)) return;
    if (Date.now() - statSync(file).mtimeMs < HEARTBEAT_MIN_GAP_MS) return;
    const rec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    rec.heartbeat_at = new Date().toISOString();
    rec.heartbeat_ts = Date.now() / 1000;
    writeFileSync(file, JSON.stringify(rec, null, 2));
  } catch {
    /* 心跳写失败不影响判定 */
  }
}

interface Args {
  event: string;
  hostArg: string | null;
  selftest: boolean;
}

/** 解析命令行：事件名、`--agent` 取值、是否自检。无法识别的参数按事件名收进 `event`。 */
function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let hostArg: string | null = null;
  let selftest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    /* 宿主 id，由安装器写入。 */
    if (a === "--agent" || a === "-A") {
      hostArg = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--agent=")) {
      hostArg = a.slice("--agent=".length);
    } else if (a === "--selftest") {
      selftest = true;
    } else {
      rest.push(a);
    }
  }
  return { event: rest[0] ?? "", hostArg, selftest };
}

/**
 * 等 stdin 的首次数据上限，单位毫秒。
 *
 * 宿主调 hook 时会把事件写成 JSON 从 stdin 传入。读取必须带超时：`-p` 模式下
 * 宿主的管道不保证在 hook 退出前关闭，同步读到 EOF 会一直等到宿主超时，
 * 宿主又在等 hook 返回，于是双方互等，整条命令表现为卡住。
 */
const STDIN_WAIT_MS = 800;

/**
 * 读 stdin。
 *
 * TTY（手工执行）时直接给空对象。非 TTY 时最多等 {@link STDIN_WAIT_MS}：
 * 收齐后立即返回，超时则用已收到的部分，没收到就返回空对象。
 * 拿不到完整事件时按空事件处理，走放行，不阻断宿主。
 */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("{}");
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.destroy();
      } catch {
        /* 已关闭时忽略 */
      }
      resolve(buf.trim() || "{}");
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      process.stdin.resume();
    } catch {
      finish();
    }
  });
}

/**
 * 取得要用的 impl。
 *
 * 显式 `--agent` 只加载那一个，取值经 `normalize` 归一；没给时才按目录猜。未知 id 返回
 * null，不回落到探测结果。
 */
function pickImpl(hostArg: string | null): HostImpl | null {
  if (hostArg) {
    const id = normalize(hostArg);
    return id ? byId(id) : null;
  }
  return byId(detect());
}

/** 打印 impl 的身份、配置文件位置与事件映射，不处理事件。 */
function selftest(impl: HostImpl): number {
  const points = ["PreToolUse", "UserPromptSubmit", "Stop", "PreCompact", "on_action", "unknown"];
  const lines = [
    `host: ${impl.id} (${impl.label})`,
    `config: ~/${impl.configDir}/${impl.settingsFile}`,
    "event map:",
    ...points.map((p) => `  ${p} -> ${impl.hook.pointFor(p) ?? "(不处理)"}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 先自查监工是否存活，再读 stdin。
  if (!args.selftest) guardSupervisor();

  const impl = pickImpl(args.hostArg);

  if (!impl) {
    // 未知宿主不阻断宿主进程（放行），但要在 stderr 说明。
    process.stderr.write(`未知宿主：${args.hostArg ?? "(无可用默认 impl)"}。用 capitalist hosts 查看可用 id。\n`);
    return 0;
  }

  if (args.selftest) return selftest(impl);

  if (!args.event) {
    process.stderr.write("用法：capitalist-hook <事件名> [--agent <宿主>] [--selftest]\n");
    return 0; // 参数错误不阻断宿主
  }

  let payload: NativePayload = {};
  try {
    const raw = (await readStdin()).trim();
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as NativePayload;
    }
  } catch {
    payload = {}; // payload 坏了也要能继续：按空事件处理，走放行
  }

  const mapped = impl.hook.pointFor(args.event);
  if (mapped === null) return 0; // 该宿主事件不参与监督

  /*
   * 状态注入只在工作进程内有意义：它把监工状态与待处理插话送进模型上下文。
   * 监工探测与用户手工打开的一次性会话走同一条启动路径，却不需要这段注入；
   * 该路径上宿主要等 hook 返回，整条命令会表现为卡住。
   * 判据沿用 hook 体系既有约定：工作进程带 CAPITALIST_WORKER_ID。
   */
  if (mapped === "on_idle" && !process.env.CAPITALIST_WORKER_ID) return 0;

  const event = impl.hook.parse(payload, args.event);
  // 先续心跳再判定：判定可能耗时或抛错，心跳不能跟着一起丢。
  touchWorkerHeartbeat();
  const result = dispatch(impl.hook, { ...event, point: mapped });

  if (result.stdout) process.stdout.write(result.stdout);
  return result.code;
}

/* 未捕获异常一律放行：hook 报错不应让宿主的命令失败。 */
main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
