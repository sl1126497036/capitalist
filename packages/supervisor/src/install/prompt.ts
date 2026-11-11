/**
 * 安装与卸载的交互式选择。
 *
 * 仅在交互终端显示选择菜单。脚本、CI、管道以及显式传入 `--agent` 的调用不显示菜单，
 * 由调用方回落到自动探测流程，保持非交互调用的行为不变。
 *
 * 同族宿主合并为一个菜单项。同族宿主写入各自的配置目录，共用同一套 hook 协议与
 * 登录态。
 */

import { createInterface } from "node:readline/promises";

import type { HostId } from "../agent/contract";
import { all, normalize } from "../agent/registry";
import { hostInstalled } from "./install";

/** 大号标识。只在交互安装 / 卸载时打印，管道与 CI 的输出里不出现。 */
export const BANNER = [
  "  ____      _      ____    ___   _____      _      _       ___   ____    _____",
  " / ___|    / \\    |  _ \\  |_ _| |_   _|    / \\    | |     |_ _| / ___|  |_   _|",
  "| |       / _ \\   | |_) |  | |    | |     / _ \\   | |      | |  \\___ \\    | |",
  "| |___   / ___ \\  |  __/   | |    | |    / ___ \\  | |___   | |   ___) |   | |",
  " \\____| /_/   \\_\\ |_|     |___|   |_|   /_/   \\_\\ |_____| |___| |____/    |_|",
].join("\n");

/** 菜单项。一个菜单项对应一个或多个宿主实现。 */
export interface AgentGroup {
  readonly label: string;
  readonly ids: readonly HostId[];
}

/**
 * 参与选择的宿主分组。
 *
 * 按 `family` 聚合：同族宿主共用登录态与 hook 协议，菜单中合并为一项。未声明 `family`
 * 的 impl 以 `id` 单独成组。标签与 id 均从 impl 读取，新增宿主时添加对应 impl。
 *
 * 菜单仅列出具备项目级配置落点的宿主。缺少该落点时，安装会使本机每次工具调用都
 * 触发进程；此类宿主可通过 `--agent <id>` 显式指定。
 */
function buildAgentGroups(): AgentGroup[] {
  const buckets = new Map<string, { labels: string[]; ids: HostId[] }>();
  for (const impl of all()) {
    if (!impl.install || impl.projectLocal !== true) continue;
    const key = impl.family ?? impl.id;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.labels.push(impl.label);
      bucket.ids.push(impl.id);
    } else {
      buckets.set(key, { labels: [impl.label], ids: [impl.id] });
    }
  }
  return [...buckets.values()].map((bucket) => ({
    label: bucket.labels.join(" / "),
    ids: bucket.ids,
  }));
}

export const AGENT_GROUPS: readonly AgentGroup[] = buildAgentGroups();

/** 菜单选择结果。`cancel` 表示取消选择，`retry` 表示输入无法识别。 */
type Selection =
  | { kind: "cancel" }
  | { kind: "agents"; ids: HostId[] }
  | { kind: "retry" };

/** 可安装的宿主 id，按注册表顺序。 */
function installableIds(): HostId[] {
  return all()
    .filter((impl) => Boolean(impl.install) && impl.projectLocal === true)
    .map((impl) => impl.id);
}

/**
 * 解析一行输入。
 *
 * 接受编号、逗号或空格分隔的多个编号，以及 `all` / `全部`。空输入按取消处理。
 * 直接回车与“取消”输入均按取消处理。
 */
function parseSelection(raw: string): Selection {
  const text = raw.trim().toLowerCase();
  if (!text || text === "0" || text === "q" || text === "quit" || text === "取消") {
    return { kind: "cancel" };
  }
  const allIndex = String(AGENT_GROUPS.length + 1);
  if (text === allIndex || text === "all" || text === "全部") {
    return { kind: "agents", ids: AGENT_GROUPS.flatMap((group) => [...group.ids]) };
  }
  const picks = text.split(/[\s,，、]+/).filter(Boolean);
  const ids: HostId[] = [];
  for (const pick of picks) {
    if (!/^\d+$/.test(pick)) return { kind: "retry" };
    const group = AGENT_GROUPS[Number(pick) - 1];
    if (!group) return { kind: "retry" };
    for (const id of group.ids) if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? { kind: "agents", ids } : { kind: "retry" };
}

/** 判断分组是否已安装：组内任一宿主存在自有条目即视为已安装。 */
function groupInstalled(group: AgentGroup, root: string): boolean {
  return group.ids.some((id) => {
    const impl = all().find((candidate) => candidate.id === id);
    return impl ? hostInstalled(impl, root) : false;
  });
}

/**
 * 渲染菜单并读取选择。
 *
 * @returns 选中的宿主 id；用户取消时返回 null。
 */
export async function pickAgents(opts: {
  action: "install" | "uninstall";
  root: string;
}): Promise<HostId[] | null> {
  const verb = opts.action === "install" ? "安装" : "卸载";
  const lines: string[] = [
    "",
    BANNER,
    "",
    `  选择要${verb}的 agent（可多选，编号以空格分隔）`,
    "",
  ];
  /* 标签按最大宽度补齐，使已安装标记对齐为一列。 */
  const labelWidth = Math.max(...AGENT_GROUPS.map((group) => group.label.length));
  AGENT_GROUPS.forEach((group, index) => {
    const mark = groupInstalled(group, opts.root) ? "✓ 已安装" : "";
    lines.push(`    ${index + 1}) ${group.label.padEnd(labelWidth, " ")}  ${mark}`.trimEnd());
  });
  lines.push(`    ${AGENT_GROUPS.length + 1}) 全部${verb}`);
  lines.push("    0) 取消");
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await rl.question(`  请输入编号 [0-${AGENT_GROUPS.length + 1}]：`);
      const picked = parseSelection(raw);
      if (picked.kind === "cancel") return null;
      if (picked.kind === "agents") return picked.ids;
      process.stdout.write("  编号无法识别，请重新输入。\n");
    }
    process.stdout.write("  连续三次输入无效，已取消。\n");
    return null;
  } finally {
    rl.close();
  }
}

/** 选择来源的解析入参。 */
export interface ResolveAgentsOptions {
  action: "install" | "uninstall";
  /** `--agent` 的原始取值，多个以逗号分隔。 */
  explicit?: string | undefined;
  /** `--all`：不动菜单，直接选全部可安装宿主。 */
  all?: boolean;
  /** 是否允许弹菜单。非交互终端、`--dry-run` 由调用方决定。 */
  interactive: boolean;
  root: string;
}

/**
 * 确定目标宿主列表。
 *
 * 优先级：显式 `--agent` > `--all` > 交互菜单。三者都没有时不做选择，直接返回 null：
 * 自动装到所有已检测宿主会让用户失去选择权，也可能把 hook 写进并不使用的宿主。
 *
 * @returns 宿主 id 列表；未选择或用户取消时返回 null。
 */
export async function resolveAgents(
  opts: ResolveAgentsOptions,
): Promise<string[] | null> {
  const explicit = opts.explicit?.trim();
  if (explicit) {
    // 取值原样传给安装器；未知取值由安装器报错，当前层不丢弃。
    const ids = explicit
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (ids.length > 0) return ids;
  }
  if (opts.all === true) return installableIds();
  if (opts.interactive) return pickAgents({ action: opts.action, root: opts.root });

  const names = AGENT_GROUPS.flatMap((group) => [...group.ids]);
  process.stderr.write(
    `未指定宿主：用 --agent 指定（${names.join(" / ")}），或 --all 安装到全部已检测宿主。\n`,
  );
  return null;
}

/** 把宿主 id 归一成注册表键，供输出与去重使用。 */
export function canonicalIds(ids: readonly string[]): HostId[] {
  const out: HostId[] = [];
  for (const id of ids) {
    const key = normalize(id);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}
