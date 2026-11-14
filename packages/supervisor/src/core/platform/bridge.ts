/**
 * 本地启动器通道。
 *
 * 宿主在命令通道里执行命令时，命令一返回整棵进程树被回收（Windows 上是 Job 对象），
 * `detached` 只脱离控制台。安装时在用户终端拉起一个常驻启动器，启动器不在那条命令的 Job 里，
 * 由启动器拉起监工才能常驻。
 *
 * 只接受“用本包编译入口启动监工”这一种请求，不接受任意命令行。
 * 只在 Windows 上启用；其它平台 `detach` 可正常脱离，本模块不参与。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

/** 只在 Windows 上需要；其它平台返回 false，调用方走原有路径。 */
export const BRIDGE_PLATFORM = process.platform === "win32";

/** 管道名按用户区分，同一台机器上的不同账号互不干扰。 */
export function bridgePipe(): string {
  let user = "default";
  try {
    user = userInfo().username || user;
  } catch {
    /* 取不到用户名时用固定名，同机只允许一个启动器 */
  }
  return `\\\\.\\pipe\\capitalist-serve-${user}`;
}

export interface BridgeRequest {
  type: "ping" | "spawn";
  /** `[entry, ...cliArgs]`；首个元素必须是本包编译产物。 */
  args?: string[];
  /** 工作目录。 */
  cwd?: string;
}

export interface BridgeReply {
  ok: boolean;
  pid?: number;
  error?: string;
}

/** 允许被拉起的入口：只认本包编译产物，不接受任意脚本。 */
function allowedEntry(entry: string): boolean {
  const p = resolve(entry).replace(/\\/g, "/");
  if (!existsSync(p)) return false;
  return /\/dist\/(?:cli\/main|agent\/main)\.js$/.test(p);
}

/** 允许转发的子命令：只有启动监工这一类长驻命令。 */
function allowedCommand(args: string[]): boolean {
  return args[0] === "supervise" || args[0] === "guard";
}

/**
 * 向启动器发一次请求。
 *
 * @returns 启动器回复；启动器没在运行或超时返回 null，调用方据此回落本地启动。
 */
export function askBridge(req: BridgeRequest, timeoutMs = 5000): Promise<BridgeReply | null> {
  if (!BRIDGE_PLATFORM) return Promise.resolve(null);
  return new Promise((done) => {
    let settled = false;
    const finish = (r: BridgeReply | null): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* 已断开 */
      }
      done(r);
    };

    const sock = connect(bridgePipe());
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      try {
        sock.write(`${JSON.stringify(req)}\n`);
      } catch {
        finish(null);
      }
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        finish(JSON.parse(buf.slice(0, nl)) as BridgeReply);
      } catch {
        finish(null);
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/** 启动器侧：起一个独立进程，不占启动器的控制台与进程组。 */
function spawnFromBridge(args: string[], cwd: string): BridgeReply {
  if (!allowedEntry(args[0] ?? "")) return { ok: false, error: "入口不被接受" };
  if (!allowedCommand(args.slice(1))) return { ok: false, error: "子命令不被接受" };
  try {
    const child = spawn(process.execPath, args, {
      cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const pid = child.pid;
    if (!pid) return { ok: false, error: "未取得 pid" };
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/** 启动器没有控制台，日志写这里。 */
export function bridgeLogPath(): string {
  return join(homedir(), ".capitalist", "serve.log");
}

/**
 * 启动器主体：常驻监听管道，直到进程被结束。
 *
 * 已有实例在监听时直接退出，不重复占管道。
 */
export function runBridge(log: (line: string) => void): Promise<number> {
  return new Promise((done) => {
    const server = createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        let req: BridgeRequest;
        try {
          req = JSON.parse(line) as BridgeRequest;
        } catch {
          sock.end(`${JSON.stringify({ ok: false, error: "请求不是合法 JSON" })}\n`);
          return;
        }

        if (req.type === "ping") {
          sock.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }
        if (req.type !== "spawn" || !Array.isArray(req.args)) {
          sock.end(`${JSON.stringify({ ok: false, error: "请求类型不被接受" })}\n`);
          return;
        }

        const reply = spawnFromBridge(req.args, String(req.cwd ?? ""));
        log(
          `${new Date().toISOString()}\tpid=${reply.pid ?? 0}\t${reply.ok ? "ok" : reply.error}\t` +
            req.args.slice(1).join(" ").slice(0, 180),
        );
        sock.end(`${JSON.stringify(reply)}\n`);
      });
      sock.on("error", () => {
        /* 客户端断开不影响启动器 */
      });
    });

    server.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EADDRINUSE") {
        log(`${new Date().toISOString()}\t已有启动器在监听，本次退出`);
        done(0);
        return;
      }
      log(`${new Date().toISOString()}\t监听失败：${String(e.message ?? e)}`);
      done(1);
    });

    server.listen(bridgePipe(), () => {
      log(`${new Date().toISOString()}\t启动器就绪 ${bridgePipe()}`);
    });
  });
}

/**
 * 拉起启动器。
 *
 * 调用方在自己的终端里运行时，启动器不会随该命令结束被回收。
 *
 * @returns 启动器 pid；启动失败返回 0。
 */
export function startBridgeNow(entry: string): number {
  try {
    const child = spawn(process.execPath, [entry, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? 0;
  } catch {
    return 0;
  }
}
