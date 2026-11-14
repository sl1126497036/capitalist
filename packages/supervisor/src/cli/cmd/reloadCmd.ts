/**
 * `capitalist reload`，监工上下文重载。
 *
 * 执行“落快照 -> 压上下文 -> 换会话 -> 写恢复计划”，不推进阶段、不改 schedule。
 * 复验单由监工在下一轮调度中经 `applyResumePlan` 补出（`source=reverify`）。
 *
 * 本命令逐条复跑 done 规格并压缩上下文，与只读写台账的 records.ts 分开。
 */

import { loadContract } from "../../core/contract/contract";
import { findRoot } from "../../core/record/paths";
import { loadState } from "../../core/record/state";
import { skillDirs } from "../../agent/locations";
import { beginReload, readResumePlan, reloadStatus, snapshotPath } from "../../supervisor/context/reload";
import { flagBool, flagInt, flagString, type Parsed } from "../args";

/**
 * 执行重载。
 *
 * `--status` 只读：打印当前是否在重载、代次与阶段，用于看板之外的命令行核对。
 */
export async function cmdReload(p: Parsed): Promise<number> {
  const root = flagString(p, "root") ?? findRoot();
  if (!root) throw new Error("当前不在任何受监督任务内。开工：capitalist start <目标> --contract <任务列表名>");

  if (flagBool(p, "status")) {
    const st = reloadStatus(root);
    process.stdout.write(
      st.active
        ? `重载中 gen ${st.gen}（阶段 ${st.phase}，已 ${st.age_sec}s）\n`
        : `没有进行中的重载（最近一代 gen ${st.gen}）\n`,
    );
    const plan = readResumePlan(root);
    if (plan) {
      const done = Object.values(plan.state).filter((s) => s.state === "verified").length;
      process.stdout.write(
        `恢复计划：不复验 ${plan.skip.length}｜待复验 ${plan.reverify.length}（已成立 ${done}）｜继续 ${plan.pending.length}\n`,
      );
    }
    return 0;
  }

  const state = loadState(root);
  if (!state) throw new Error(`${root} 下没有可用的 .capitalist/state.json`);
  const contract = loadContract(state.contract_path) ?? loadContract(state.contract, skillDirs());
  if (!contract) throw new Error(`任务列表文件丢失：${state.contract_path}`);

  // 上限 60 秒：这个参数只用于“让人看见重载中”，不是常驻等待。
  const holdSec = flagInt(p, "hold", { min: 0, max: 60, fallback: 0 });
  const summary = await beginReload(root, contract, { holdSec });
  const plan = readResumePlan(root);

  if (flagBool(p, "json")) {
    process.stdout.write(`${JSON.stringify({ ...summary, plan }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      `快照：${snapshotPath(root)}`,
      `上下文：${summary.before_chars} -> ${summary.after_chars} 字` +
        `（事件 ${summary.events_total} 条，移除 ${summary.events_dropped} 条心跳、调度与已完成明细）`,
      `会话：${summary.session_id}（换会话即换上下文，老会话不再读）`,
      `不重派（已完成且有证据）：${summary.skip} 片`,
      `待复验（已做未验证）：${summary.reverify} 个分片，下一轮调度派复验单` +
        (summary.deferred ? `（另有 ${summary.deferred} 片属于旧阶段/已删分片，只记录不派）` : ""),
      `继续做（未完成）：${summary.pending} 片 -> 由监工原有补派逻辑接手`,
      plan && plan.reverify.length > 0
        ? `复验清单：${plan.reverify.map((r) => r.key).join("、")}`
        : "复验清单：无",
    ].join("\n") + "\n",
  );
  return 0;
}
