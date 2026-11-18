/**
 * npm 安装后的收尾。
 *
 * 分两种情形：
 *
 * - 从未接入过（没有任何宿主目录下存在本手册）：只打印下一步，不写任何宿主配置。
 *   装到哪个宿主、写到哪个项目，由用户执行 `capitalist install` 时选择；安装阶段自动写配置
 *   会让用户失去选择权，也会把 hook 写进用户级配置，使这台机器上每个项目的每次工具调用
 *   都起一次进程。
 *
 * - 已接入过（某宿主 `skills/capitalist/SKILL.md` 存在）：只刷新该手册正文，不动 hook 配置。
 *   `npm update` 只替换 dist，手册留在旧副本里会让宿主读到过期流程；刷新是幂等的，
 *   不新增宿主、不改既有 hook 条目、不重新选择安装位置。
 *
 * 失败不改变退出码：包已装好，提示缺失不应让 npm install 报错。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { all } from "../agent/registry";
import { ensureSkillManual } from "../install/install";

/** 手册目录名，与安装器安装时的目录名一致。 */
const SKILL_NAME = "capitalist";

async function main(): Promise<void> {
  const installed = all().filter((impl) =>
    existsSync(join(homedir(), impl.configDir, "skills", SKILL_NAME, "SKILL.md")),
  );

  if (installed.length === 0) {
    process.stdout.write(
      "capitalist：下一步执行 capitalist install，选择要接入的宿主。\n",
    );
    return;
  }

  try {
    const res = ensureSkillManual(installed, false);
    for (const p of res.placed) {
      process.stdout.write(`capitalist：监工手册已更新 ${p}\n`);
    }
    for (const f of res.failed) {
      process.stderr.write(`capitalist：监工手册更新失败 ${f}\n`);
    }
    if (res.placed.length > 0) {
      process.stdout.write(
        "capitalist：hook 配置未改动；需要更换接入宿主时执行 capitalist install。\n",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `capitalist：监工手册更新失败 ${reason}；执行 capitalist install 可重试。\n`,
    );
  }
}

main().catch(() => {
  /* 包已装好，收尾失败不应让 npm install 报错 */
});
