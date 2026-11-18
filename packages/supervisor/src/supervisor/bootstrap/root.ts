/**
 * 启动前的任务根检查与创建。
 *
 * 监工负责建根，执行侧不参与。没有任务根时先征得用户确认，并把路径写全：在错误目录下
 * 建根之后，监工与工作进程都落在那个目录，事后只能靠 restart 重来。
 */

import { createInterface } from "node:readline";

import { createTaskRoot } from "../../core/contract/init";
import { loadState } from "../../core/record/state";
import { skillDirs } from "../../agent/locations";

/** 建根入参；取自监工启动参数，只保留这几项。 */
export interface BootstrapOptions {
  root: string;
  target?: string | undefined;
  contractSpec?: string | undefined;
}

export type BootstrapResult = { ok: true; created: boolean } | { ok: false; message: string };

/** 已有任务根直接继续；没有时按交互与否决定询问或交回可执行命令。 */
export async function ensureRoot(opts: BootstrapOptions): Promise<BootstrapResult> {
  if (existsState(opts.root)) return { ok: true, created: false };

  const root = opts.root;
  let target = String(opts.target ?? "").trim();
  if (!target) {
    if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      return {
        ok: false,
        message:
          `当前 ${root} 路径下没有任务根。在终端执行 capitalist supervise "<目标>" 可创建并启动；` +
          "非交互环境不代为创建。",
      };
    }
    const asked = await askNewRoot(root);
    if (!asked) return { ok: false, message: "未创建任务根，监工未启动。" };
    target = asked;
  }
  try {
    createTaskRoot({
      target,
      contractSpec: opts.contractSpec,
      root,
      contractDirs: skillDirs(),
    });
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, message: `[监工] 建根失败：${String((err as Error).message ?? err)}` };
  }
}

/**
 * 连续问两个问题：是否建根、任务目标。
 *
 * 共用一个 readline 实例：每问一句新建一个实例会把终端缓冲里后续的输入丢掉，
 * 粘贴答案时第二问就永远收不到。
 *
 * @returns 用户确认后的目标；拒绝建根时返回 null。
 */
function askNewRoot(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise((done) => rl.question(q, (a) => done(String(a ?? "").trim())));
    void (async () => {
      const yes = await ask(`当前 ${root} 路径下没有任务根，是否创建？y/n `);
      if (!/^(y|yes|是)$/i.test(yes)) {
        rl.close();
        resolve(null);
        return;
      }
      const target = await ask("任务目标（一句话，可留空）：");
      rl.close();
      resolve(target || "(未填写)");
    })();
  });
}

function existsState(root: string): boolean {
  try {
    return loadState(root) !== null;
  } catch {
    return false;
  }
}
