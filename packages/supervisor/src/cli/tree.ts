
import { dependenciesSettled, dispatchForest, dispatchPaused, openQueue, parentOf, pausedDispatches, readDispatches, type Dispatch } from "../core/supervisor";
import { findRoot } from "../core/paths";
import { buildForestView } from "../supervisor/forestView";
import { applyRebuild, planRebuild } from "../core/rebuildTree";
import { flagBool, flagString, type Parsed } from "./args";

/** 只要任务根：树相关命令不依赖 state / 契约，台账在就能看。 */
function rootOf(p: Parsed): string {
  const root = flagString(p, "root") ?? findRoot();
  if (!root) throw new Error("当前不在任何受监督任务内。开工：capitalist start <目标> --contract <任务列表名>");
  return root;
}

const STATE_MARK: Record<string, string> = {
  running: "跑",
  queued: "排",
  waiting: "等",
  review: "审",
  done: "成",
  failed: "败",
  closed: "关",
};

function clip(s: string, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * 打印森林。数据取 `buildForestView`（与界面同一份），不在这里另算一遍，
 * 命令行和界面看到的结构不一样，排查时会白走一趟。
 */
function listTrees(root: string, all = false): number {
  const view = buildForestView(root);
  if (view.empty) {
    process.stdout.write("台账是空的，没有树。\n");
    return 0;
  }

  const { totals } = view;
  process.stdout.write(
    `多节点：${view.trees.length} 棵树 · ${totals.total} 单` +
      `（成 ${totals.done} / 败 ${totals.failed} / 跑 ${totals.running} / 排 ${totals.queued} / 等 ${totals.waiting} / 关 ${totals.closed}）` +
      `· 堵 ${totals.blocked}\n`,
  );
  if (view.degraded) process.stdout.write(`降级信息：${view.degraded}\n`);
  process.stdout.write("\n");

  /** 默认只画还有活的树。 */
  const live = view.trees.filter((t) => t.alive || t.stats.remaining > 0);
  const done = view.trees.length - live.length;
  const shown = all ? view.trees : live;

  for (const t of shown) {
    const head = `${t.cycle ? "[脏] " : ""}${t.rootId}  深 ${t.maxDepth}  剩 ${t.stats.remaining}${t.alive ? "" : "（无活）"}`;
    process.stdout.write(`${head}\n`);
    for (const n of t.nodes) {
      const mark = STATE_MARK[n.state] ?? "?";
      const indent = "  ".repeat(n.depth + 1);
      const stuck = n.stuckOn ? `  ← 等 ${n.stuckOn}` : "";
      const block = n.blocked && n.blockedBy !== n.id ? `  [断在 ${n.blockedBy}]` : "";
      process.stdout.write(`${indent}[${mark}] ${n.id} ${clip(n.title, 34)}${stuck}${block}\n`);
    }
  }
  if (done > 0 && !all) {
    process.stdout.write(`\n另有 ${done} 棵树已全部收尾（历史，加 --all 展开）\n`);
  }

  /* 根节点一览：重建前后最容易看的就是「未完工的根有几个」。 */
  const roots = shown.filter((t) => !t.cycle).map((t) => t.rootId);
  process.stdout.write(`\n未完工的根 ${roots.length} 个：${roots.join(" ") || "（无）"}\n`);
  return 0;
}

/** 打印重建计划（人读版）。 */
function printPlan(plan: ReturnType<typeof planRebuild>): void {
  process.stdout.write(
    `重建计划：台账 ${plan.stats.total} 行 · 在途 ${plan.stats.inFlight} · 已完成 ${plan.stats.settled}\n` +
      `将关闭 ${plan.stats.close} 条、重开 ${plan.stats.reopen} 条、保留 ${plan.stats.keep} 条 · 重建后 ${plan.stats.trees} 棵树\n\n`,
  );

  for (const g of plan.groups) {
    const flag = g.settledBy ? `已完成于 ${g.settledBy}` : `未完成 → 代表 ${g.representative}`;
    process.stdout.write(`· ${clip(g.label, 38)}  [${g.members.length} 条] ${flag}\n`);
  }
  process.stdout.write("\n");

  for (const it of plan.items) {
    /* 计划中不列出不改台账的处置。 */
    if (it.action === "keep" || !it.pending) continue;
    const verb = it.action === "close" ? "关" : "开";
    const parent = it.parent ? `  → 父 ${it.parent}` : "";
    process.stdout.write(`  ${verb} ${it.id}  ${clip(it.title, 30)}  ${clip(it.reason, 44)}${parent}\n`);
  }

  if (plan.edges.length > 0) {
    const landed = plan.edges.filter((e) => e.child && e.parent);
    if (landed.length > 0) {
      process.stdout.write("\n树边：\n");
      for (const e of landed) {
        process.stdout.write(`  ${e.child} ← ${e.parent}   ${clip(e.why, 60)}\n`);
      }
    }
  }
  for (const w of plan.warnings) process.stdout.write(`\n警告：${w}\n`);
}

export function cmdTree(p: Parsed): number {
  const root = rootOf(p);
  const action = p.positional[0] ?? "list";

  if (action === "list" || action === "") return listTrees(root, flagBool(p, "all"));

  if (action === "rebuild") {
    const plan = planRebuild(root);
    printPlan(plan);

    if (!flagBool(p, "apply")) {
      process.stdout.write("\n（只是计划，没有落盘。确认后加 --apply 执行）\n");
      return 0;
    }
    if (plan.stats.close === 0 && plan.stats.reopen === 0) {
      process.stdout.write("\n没有需要改的行（台账已经是这个结构）。\n");
      return 0;
    }
    const r = applyRebuild(root, plan);
    process.stdout.write(`\n已落盘：关闭 ${r.closed} 条、重开 ${r.reopened} 条。\n`);
    process.stdout.write(`${"─".repeat(50)}\n`);
    return listTrees(root, flagBool(p, "all"));
  }

  if (action === "next") {
    const rows = readDispatches(root);
    /* 暂停单不参与本轮调度，需用户唤醒后重新进入候选。 */
    const q = openQueue(root)
      .filter((d) => !dispatchPaused(d))
      .filter((d) => dependenciesSettled(d, rows));
    if (q.length === 0) {
      process.stdout.write("下一轮没有可拉起的单（都在等前置，或被接管/暂停）。\n");
    } else {
      for (const d of q) {
        const why = parentOf(d) ? `父 ${parentOf(d)}` : "根";
        process.stdout.write(`${String(d.id)}  [${why}]  ${clip(String(d.action ?? ""), 40)}\n`);
      }
    }
    const paused = pausedDispatches(root).length;
    if (paused > 0) {
      process.stdout.write(`\n另有 ${paused} 张暂停单，唤醒后才参与调度：capitalist wake --user\n`);
    }
    return 0;
  }

  process.stdout.write("用法：capitalist tree [list] | capitalist tree rebuild [--apply] | capitalist tree next\n");
  return 2;
}

/* 供测试直接引用，避免为了断言再去解析 stdout。 */
export const __testing = {
  listTrees,
  printPlan,
  readAll: (root: string): Dispatch[] => readDispatches(root),
  forest: (root: string) => dispatchForest(readDispatches(root)),
};
