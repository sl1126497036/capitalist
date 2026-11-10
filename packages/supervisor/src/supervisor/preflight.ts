/**
 * 执行前核对现状的附加块：随派单下发，附建单时刻供工作进程与目标文件 mtime 比较。
 *
 * 追加在提示词组装层，不写入台账正文，未执行的老单也能带上本块。
 */

/** 段标题；提示词组装据此判断是否已带过。 */
export const PREFLIGHT_MARKER = "【执行前先核对现状】";

/** 派单创建时刻；取不到或解析不了时返回 null，块内不写具体时刻。 */
export function preflightAtOf(d: { at?: string } | null | undefined): { iso: string; epoch: number } | null {
  const raw = String(d?.at ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), epoch: Math.floor(ms / 1000) };
}

/** 生成附加块正文；`at` 可用时写入建单时刻供 mtime 比较，否则只保留通用条款。 */
export function buildPreflightBlock(d: { at?: string } | null | undefined): string[] {
  const at = preflightAtOf(d);
  return [
    `${PREFLIGHT_MARKER}本单正文是派单创建时的快照，动手前先核对代码现状：`,
    "  · 先读本单要改的文件，确认代码现状与派单描述是否一致。",
    "  · 派单要求的事情若已实现，不要重做——在结单报告里指出实现位置（文件 + 行号）与差异。",
    "  · 只做了一半的只补缺的部分，不推倒重来。",
    "  · 本单要求若与已验收的做法相反（要恢复一个已被撤掉的东西），先读 `.capitalist/tasks.jsonl` 里",
    "    同一线程已结单任务的 `note`（裁决结论写着当时定的口径），按本单最新要求做，",
    "    并在结单报告里写明这次推翻了哪一条——不要两条都留着。",
    at
      ? `  · 目标文件的修改时间（mtime）晚于本单创建时刻 ${at.iso} 时，按最新内容做，不许按旧快照覆盖。`
      : "  · 目标文件在本单创建之后被改过时，按最新内容做，不许按旧快照覆盖。",
    ...(at
      ? [
          `    核对方法：\`stat -c %Y <文件>\` 与 \`date -d "${at.iso}" +%s\` 比较，前者更大说明文件在本单创建后被改过。`,
        ]
      : []),
  ];
}

/** 提示词与派单输出是否已带过本块。 */
export function hasPreflight(text: string): boolean {
  return String(text ?? "").includes(PREFLIGHT_MARKER);
}

/** 幂等：已带过本块时原样返回，不重复追加。 */
export function attachPreflight(text: string, d: { at?: string } | null | undefined): string {
  const base = String(text ?? "").trimEnd();
  if (!base) return base;
  if (hasPreflight(base)) return base;
  return `${base}\n\n${buildPreflightBlock(d).join("\n")}`;
}
