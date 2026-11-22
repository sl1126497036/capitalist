/**
 * 建单工厂：派单记录的字段组装唯一入口。
 *
 * 此前 10 处 `appendDispatch` 各自手拼字段：重派要继承树边、重开要继承标题、
 * 换模型重试不继承 tags……每加一个字段（例如分组 `group`），都要在十处逐一接入，
 * 漏一处即出现“重派后树边丢失”“重派后组缺员”。
 *
 * 本模块只做字段组装，不做 IO：
 *   - 必填项与默认值集中在这里（`status` 缺省 `open`、`lineage` 缺省自指）；
 *   - 继承按显式清单进行（{@link InheritKey}），调用方声明"这次要从哪张单继承什么"；
 *   - 空值的落盘形态固定：`atts` 传了就写（含空数组），`after` / `tags` 为空不写。
 *
 * 取号由调用方完成；写盘与任务池同步统一由 {@link commitDispatch} 完成。
 * 取号涉及锁与占位，不属于字段组装。
 */

import type { Dispatch } from "../record/supervisor";
import { appendDispatch } from "../record/supervisor";
import { ensureTaskForDispatch } from "../record/tasks";
import { stripLeadOrdinal } from "../text";

/** 派单上的扩展字段。与 `loop.ts` 的 `DispatchEx` 同形，供组装结果带类型地读回。 */
export interface ComposedDispatch extends Dispatch {
  /** 中文标题；建单时写入，老记录读侧按分片映射补齐。 */
  title?: string;
  model?: string;
  /** 模型是谁定的：`user` 表示看板上显式切换过，补派与重派沿用该值。 */
  model_by?: "user";
  model_fallback?: string;
  model_fallback_used?: boolean;
  required?: boolean;
}

/**
 * 可继承的字段组。
 *
 * `tree` 是一个组而不是单个字段：`parent` / `parent_reason` / `group` 三者共同表达
 * “这张单在树上的位置”，必须同进同退。新增树字段时只改这里，调用方无需逐处补参数。
 */
export type InheritKey =
  /** 树边：`parent` / `parent_reason` / `group`。 */
  | "tree"
  /** 接替关系：`supersedes`。重派后仍要记得自己顶替的是哪一件事。 */
  | "supersede"
  /** 标题（重派沿用首次登记值）。 */
  | "title"
  /** 分类标签。 */
  | "tags"
  /** 模型与回退模型。 */
  | "model"
  /** 角色（work / diagnose / fix）。 */
  | "role"
  /** 多前置（遗留 `after`）。 */
  | "after";

/** 继承的默认清单：重派场景的常规组合。 */
export const DEFAULT_INHERIT: readonly InheritKey[] = [
  "tree",
  "supersede",
  "title",
  "tags",
  "model",
  "role",
  "after",
];

/** 组装输入。除 `id` / `stage` / `action` 外都可省略。 */
export interface ComposeInput {
  /** 派单 id（落盘形式 `2-3`），由取号入口发行后传入。 */
  id: string;
  stage: string;
  action: string;
  at?: string | undefined;
  shard?: string | undefined;
  title?: string | undefined;
  status?: Dispatch["status"] | undefined;
  source?: Dispatch["source"] | undefined;
  attempt?: number | undefined;
  lineage?: string | undefined;
  urgent?: boolean | undefined;
  tags?: string[] | undefined;
  parent?: string | undefined;
  parentReason?: string | undefined;
  after?: string[] | undefined;
  /** 所属分组（组号，落盘 `G1`）。 */
  group?: string | undefined;
  /** 接替的目标派单 id（落盘 `supersedes`）。 */
  supersedes?: string | undefined;
  model?: string | undefined;
  /** 标记模型由用户显式指定；后续补派按该值沿用，不再回到契约分片模型。 */
  modelBy?: "user" | undefined;
  modelFallback?: string | undefined;
  /** 附件路径。传空数组表示显式无附件。 */
  atts?: string[] | undefined;
  role?: Dispatch["role"] | undefined;
  retryAccept?: string | undefined;
  retryVerdict?: Dispatch["retry_verdict"] | undefined;
  srcMsg?: string | undefined;
  srcMsgs?: string[] | undefined;
  /** 备注（复验单用它记录重载代次与原因）。 */
  note?: string | undefined;
  cascadeResets?: number | undefined;
  /** 从哪张单继承、继承哪些字段。省略即不继承。 */
  inherit?: { from: Dispatch; keys?: readonly InheritKey[] | undefined } | undefined;
}

function nonEmpty(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * 组装一张派单。
 *
 * 入参显式值优先于继承值；两者都没有的字段不写进记录（读侧按缺省处理）。
 */
export function composeDispatch(input: ComposeInput): ComposedDispatch {
  const src = input.inherit?.from;
  const keys = new Set<InheritKey>(input.inherit?.keys ?? DEFAULT_INHERIT);
  const from = (k: InheritKey): Dispatch | undefined => (src && keys.has(k) ? src : undefined);

  const tree = from("tree");
  const supersedeSrc = from("supersede");
  const titleSrc = from("title");
  const tagsSrc = from("tags");
  const modelSrc = from("model");
  const roleSrc = from("role");
  const afterSrc = from("after");

  const picked = <T>(v: T | undefined, alt: T | undefined): T | undefined => (v !== undefined ? v : alt);

  const title = picked(input.title, (titleSrc as { title?: string } | undefined)?.title);
  const tags = picked(input.tags, Array.isArray(tagsSrc?.tags) ? tagsSrc.tags : undefined);
  const parent = picked(input.parent, nonEmpty(tree?.parent) || undefined);
  const parentReason = picked(input.parentReason, nonEmpty(tree?.parent_reason) || undefined);
  const group = picked(input.group, nonEmpty((tree as { group?: string } | undefined)?.group) || undefined);
  const supersedes = picked(
    input.supersedes,
    nonEmpty((supersedeSrc as { supersedes?: string } | undefined)?.supersedes) || undefined,
  );
  const after = picked(input.after, Array.isArray(afterSrc?.after) ? afterSrc.after : undefined);
  const model = picked(input.model, nonEmpty((modelSrc as { model?: string } | undefined)?.model) || undefined);
  /*
   * `model_by` 与 `model` 是一对：显式改了 model 就不继承标记（那是本次新定的口径），
   * 只有原样继承 model 时才连标记一起带过来，否则补派会误认为用户切过。
   */
  const modelBy = picked(
    input.modelBy,
    input.model === undefined ? (modelSrc as { model_by?: "user" } | undefined)?.model_by : undefined,
  );
  const modelFallback = picked(
    input.modelFallback,
    nonEmpty((modelSrc as { model_fallback?: string } | undefined)?.model_fallback) || undefined,
  );
  const role = picked(input.role, roleSrc?.role);

  const d: ComposedDispatch = {
    id: String(input.id),
    at: String(input.at ?? "") || new Date().toISOString(),
    stage: String(input.stage ?? ""),
    /*
     * 正文行首的列表序号在建单时去掉：一条消息派多单时，模型会把“第几条”写进每单正文，
     * 而单是分头交给各自的进程的，上下文互相隔离。只拿到 `2.` 的那个会以为前面还有一条
     * 没给它。放在这里而不是各调用点，是因为建单路径有多条（对话、命令行、重派、重开）。
     */
    action: stripLeadOrdinal(String(input.action ?? "")),
    status: input.status ?? "open",
  };

  if (input.shard !== undefined) d.shard = String(input.shard);
  if (nonEmpty(title)) d.title = String(title);
  if (input.source) d.source = input.source;
  if (input.attempt !== undefined) d.attempt = Number(input.attempt);
  if (input.urgent) d.urgent = true;
  if (Array.isArray(tags) && tags.length > 0) d.tags = [...tags];
  if (nonEmpty(parent)) d.parent = String(parent);
  if (nonEmpty(parentReason)) d.parent_reason = String(parentReason);
  if (Array.isArray(after) && after.length > 0) d.after = [...after];
  if (nonEmpty(group)) d.group = String(group);
  if (nonEmpty(supersedes)) d.supersedes = String(supersedes);
  if (nonEmpty(model)) d.model = String(model);
  if (modelBy === "user") d.model_by = "user";
  if (nonEmpty(modelFallback)) d.model_fallback = String(modelFallback);
  if (input.atts !== undefined) d.atts = [...input.atts];
  if (role) d.role = role;
  if (nonEmpty(input.retryAccept)) d.retry_accept = String(input.retryAccept);
  if (input.retryVerdict) d.retry_verdict = input.retryVerdict;
  if (nonEmpty(input.srcMsg)) d.src_msg = String(input.srcMsg);
  if (Array.isArray(input.srcMsgs) && input.srcMsgs.length > 0) d.src_msgs = [...input.srcMsgs];
  if (nonEmpty(input.note)) d.note = String(input.note);
  if (input.cascadeResets !== undefined) d.cascade_resets = Number(input.cascadeResets);

  /* 派生链：显式 > 原单所属链 > 原单自身 > 本单自身。重派必须落在同一条链上。 */
  d.lineage = nonEmpty(input.lineage) || nonEmpty(src?.lineage) || nonEmpty(src?.id) || d.id;

  return d;
}

/**
 * 在一张已有派单上派生下一张（重派 / 重开 / 子树重置）。
 *
 * 与 {@link composeDispatch} 的区别只是把“从原单继承”设为默认值，
 * 避免每个调用点重复书写 `inherit: { from: old }`。
 */
export function deriveDispatch(
  prev: Dispatch,
  input: Omit<ComposeInput, "inherit"> & { keys?: readonly InheritKey[] },
): ComposedDispatch {
  const { keys, ...rest } = input;
  return composeDispatch(
    keys === undefined ? { ...rest, inherit: { from: prev } } : { ...rest, inherit: { from: prev, keys } },
  );
}

/**
 * 落盘一张新建或派生的派单，并同步任务池投影。
 *
 * 两件事必须一起做：任务池是派单的投影，只写台账不同步任务池，面板会停在旧数字上。
 * 此前 11 处调用点各自连写这两行，漏一处即出现“台账里有、任务列表里没有”的派单。
 * 现统一由本函数完成，`appendDispatch` 只允许本模块导入（`test/structure.test.js` 有守卫）。
 */
export function commitDispatch(root: string, d: Dispatch): void {
  appendDispatch(root, d);
  ensureTaskForDispatch(root, d);
}
