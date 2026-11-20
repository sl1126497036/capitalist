/**
 * 树相关标记行：`PARENT:` / `PARENT_REASON:` / `AFTER:` / `GROUP:` / `INSERT:` / `INSERT_MODE:`。
 *
 * 抽成一处的理由：这些正则与提示词里的语法一一对应，改语法时若只改提示词不改正则，
 * 模型写了新写法却被静默当成正文。放同一个文件，改一处即可对照。
 *
 * 只认行首（允许前导空白）。行中出现的 `PARENT:` 属于正文，不当作标记。
 * 工作进程常在自己的说明里引用这些字样，误切会把正文内容写入树字段。
 */

/** 树边行：`PARENT: #03` / `PARENT: none`。 */
export const PARENT_LINE = /^\s*(?:PARENT|父节点)[:：]\s*(.*)$/i;

/** 挂边理由行。先于父节点行判定，避免前缀规则误匹配。 */
export const PARENT_REASON_LINE = /^\s*(?:PARENT_REASON|父节点理由)[:：]\s*(.*)$/i;

/** 依赖行：`AFTER: #02` / `AFTER: #01, #03` / `AFTER: *`。 */
export const AFTER_LINE = /^\s*AFTER[:：]\s*(.*)$/i;

/** 分组行：`GROUP: new <标题>` / `GROUP: #G1` / `GROUP: none`。 */
export const GROUP_LINE = /^\s*(?:GROUP|分组)[:：]\s*(.*)$/i;

/** 插入行：`INSERT: before #03` / `INSERT: after #G1 now`。 */
export const INSERT_LINE = /^\s*INSERT[:：]\s*(.*)$/i;

/** 在途处置行：`INSERT_MODE: halt | keep | drop`。 */
export const INSERT_MODE_LINE = /^\s*INSERT_MODE[:：]\s*(.*)$/i;

/** 推翻说明行：`REVOKE: <被作废的口径>`。 */
export const REVOKE_LINE = /^\s*REVOKE[:：]\s*(.*)$/i;

/** 插入位置与锚点。`now` 表示建单后立即执行。 */
export interface InsertRef {
  where: "before" | "after";
  anchor: string;
  now: boolean;
}

/**
 * 解析 `INSERT:` 行内容。
 *
 * 只认 `before` / `after`（兼容中文“之前 / 之后”）。锚点写一个引用，由调用方换算成台账 id。
 * 无法识别的写法返回 `null`，由调用方拒绝。推测会导致新单插到错误层级。
 */
export function parseInsert(raw: string): InsertRef | null {
  const t = String(raw ?? "").trim();
  const m = /^(before|after|之前|之后)\s+(\S+)(?:\s+(now|立即))?$/i.exec(t);
  if (!m) return null;
  const word = String(m[1] ?? "").toLowerCase();
  return {
    where: word === "after" || word === "之后" ? "after" : "before",
    anchor: String(m[2] ?? "").trim(),
    now: Boolean(m[3]),
  };
}

/** 解析 `INSERT_MODE:` 行内容；认不出时返回空串，由调用方按缺省档处理。 */
export function parseInsertMode(raw: string): "halt" | "keep" | "drop" | "" {
  const t = String(raw ?? "").trim().toLowerCase();
  return t === "halt" || t === "keep" || t === "drop" ? t : "";
}
