
import { forceRelease, lockStatus, reap as reapLocks, release as releaseLock } from "../../core/record/fileLock";
import type { Parsed } from "../args";
import { rootOrDie } from "./context";

const USAGE =
  '用法：capitalist lock status [<路径>] ｜ capitalist lock release <路径> [--force] ｜ capitalist lock reap';

function say(s: string): void {
  process.stdout.write(`${s}\n`);
}

function fail(s: string): number {
  process.stderr.write(`${s}\n`);
  return 1;
}

export function cmdLock(p: Parsed): number {
  const sub = String(p.positional[0] ?? "status").trim();
  const root = rootOrDie(p);

  if (sub === "status" || sub === "ls") {
    const only = p.positional[1] ? String(p.positional[1]) : undefined;
    const { locks, queue } = lockStatus(root, only);
    if (locks.length === 0) {
      say(only ? `${only} 上没有锁。` : "没有文件被锁。");
    } else {
      say(`文件锁 ${locks.length} 把：`);
      for (const e of locks) {
        const mode = e.mode === "write" ? "写锁" : "读锁";
        const beat = Date.parse(e.beat);
        const age = Number.isFinite(beat) ? Math.max(0, Math.round((Date.now() - beat) / 1000)) : -1;
        say(`  [${mode}] ${e.path}`);
        say(
          `      持有者 ${e.holder}（pid ${e.pid}，心跳 ${age}s 前，深度 ${e.depth}` +
            `${e.transient ? "，随工具调用释放" : ""}，自 ${e.since}）`,
        );
      }
    }
    if (queue.length > 0) {
      say("");
      say(`排队 ${queue.length} 个（先到先得，写优先）：`);
      for (const w of queue) {
        say(`  [${w.mode === "write" ? "写" : "读"}] ${w.path} ← ${w.holder}（自 ${w.at}）`);
      }
    }
    return 0;
  }

  if (sub === "release") {
    const target = p.positional[1];
    if (!target) return fail(USAGE);
    const force = p.flags.force === true || p.flags.force === "true";
    const { locks } = lockStatus(root, target);
    if (locks.length === 0) {
      say(`${target} 上没有锁，无需释放。`);
      return 0;
    }
    let n = 0;
    for (const e of locks) {
      if (force) {
        if (forceRelease(root, e.path)) n += 1;
      } else if (releaseLock(root, e.path, e.holder)) {
        n += 1;
      }
    }
    say(n > 0 ? `已释放 ${n} 把锁。` : "没有释放：持有者不匹配，确认要强行解锁请加 --force。");
    return 0;
  }

  if (sub === "reap") {
    const { reclaimed } = reapLocks(root);
    if (reclaimed.length === 0) {
      say("没有可回收的锁（持有者进程都还在，或心跳未过期）。");
      return 0;
    }
    for (const r of reclaimed) say(`回收 ${r.path}（${r.holder}：${r.why}）`);
    return 0;
  }

  return fail(`未知子命令：${sub}\n${USAGE}`);
}
