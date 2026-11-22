/**
 * 启动前的任务根检查与创建。
 *
 * 监工负责建根，执行侧不参与。没有任务根时先征得用户确认，并把路径写全：在错误目录下
 * 建根之后，监工与工作进程都落在那个目录，事后只能靠 restart 重来。
 *
 * 只询问建根一项。任务目标不拦启动：不填写则留空，不影响建根与运行。
 */

import { createInterface } from "node:readline";

import { createTaskRoot } from "../../core/contract/init";
import { loadState } from "../../core/record/state";
import { skillDirs } from "../../agent/locations";
import { t } from "../../cli/lang";

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
        message: t(
          `No task root at ${root}. Run capitalist supervise "<goal>" in a terminal to create and start one; non-interactive sessions do not create roots.`,
          `当前 ${root} 路径下没有任务根。在终端执行 capitalist supervise "<目标>" 可创建并启动；非交互环境不代为创建。`,
        ),
      };
    }
    const asked = await askNewRoot(root);
    if (asked === null) {
      return { ok: false, message: t("Task root not created; supervisor not started.", "未创建任务根，监工未启动。") };
    }
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
    return {
      ok: false,
      message: t(
        `[supervisor] failed to create task root: ${String((err as Error).message ?? err)}`,
        `[监工] 建根失败：${String((err as Error).message ?? err)}`,
      ),
    };
  }
}

/**
 * 问一句是否建根，不分目标。
 *
 * 任务目标只是描述，不参与建根与推进判据，因此不拦启动；需要时由后续动作补，
 * 或在启动命令里直接附带目标跳过该项询问。
 *
 * @returns 确认建根返回空串（目标留空）；拒绝返回 null。
 */
function askNewRoot(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    void (async () => {
      const yes = await new Promise<string>((done) =>
        rl.question(
          t(`No task root at ${root}. Create one? y/n `, `当前 ${root} 路径下没有任务根，是否创建？y/n `),
          (a) => done(String(a ?? "").trim()),
        ),
      );
      rl.close();
      resolve(/^(y|yes|是)$/i.test(yes) ? "" : null);
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
