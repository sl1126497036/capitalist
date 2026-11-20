/**
 * 回复解析：把模型输出切成“正文 / 待办 / 动作 / 树字段”。
 *
 * 从 `llm.ts` 拆出。解析只认行首的标记（`DO:` / `PARENT:` / `GROUP:` / `INSERT:` …），
 * 与模型调用、超时、鉴权无关；混在一个文件里，调整语法需要在大量通信代码中查找。
 *
 * 一条硬规则：标记行只认行首。工作进程常在自己的说明里引用 `PARENT:` 这些字样，
 * 行中出现一律当正文，否则会把正文内容写入树字段。
 */

import { ATT_LINE, parseShots } from "./attShots";
import {
  AFTER_LINE,
  GROUP_LINE,
  INSERT_LINE,
  INSERT_MODE_LINE,
  PARENT_LINE,
  PARENT_REASON_LINE,
  REVOKE_LINE,
  parseInsert,
  parseInsertMode,
  type InsertRef,
} from "./treeLines";

/** 仅剥离 `ACTION:` 开头的一个已知动作词，不处理句中词，也不做语义判断。 */
const LEGACY_VERB = /^\s*(pause|resume|concurrency|retry|skip|set-next|dispatch|ask|instruct|intervene)\s+/i;

/** 监工会话的动作行：`DO: dispatch 查一下长列表卡顿` -> `{action:"dispatch", arg:"查一下…"}`。只认行首（允许前导空白），避免误切正文。 */
const DO_LINE = /^\s*DO:\s*([a-zA-Z-]+)\s*([\s\S]*)$/;






/** 一个动作块：`DO:` 行及其后的 `ATT:` 行；一条消息多单时每单各自带附件。 */
export interface ParsedAction {
  action: string;
  arg: string;
  /**
   * 这一单带哪几张图（编号，1 起）。
   *
   * - `undefined`：未写 ATT 行
   * - `[]`：明确不带
   * - `[1,3]`：只带这几张
   */
  shots?: number[];
  /**
   * 这一单推翻的旧口径（`REVOKE:` 行）。
   *
   * 由调用方写入派单正文：工作进程与验收据此判定本次是有意推翻，不按两套并存处理。
   * 该行本身不进入回复正文。
   */
  revoke?: string;
}

export interface ParsedReply {
  /** 气泡正文，已剔除标记行 */
  reply: string;
  /** 工作进程会话里的待办（`ACTION:` 行） */
  want: string;
  /** 第一个动作（兼容单动作调用点）。多动作时用 {@link acts}。 */
  act: { action: string; arg: string } | null;
  /** 全部动作，按出现顺序保留；一条消息中的多件事各成一单，不合并。 */
  acts: ParsedAction[];
  /**
   * 模型写的依赖编号（`AFTER:` 行）。undefined 表示未写（无依赖）。
   * 只有 `DO: dispatch` 使用它：建单时翻译成台账上的 `after` 字段。
   */
  after?: string[];
  /**
   * 模型写的父节点（`PARENT:` 行）：编号 / id 或 `none`。
   * `undefined` 与 `none` 同义；`none` 在解析阶段不落字段，故不会出现 `""`。
   */
  parent?: string;
  /** 挂父节点的理由（`PARENT_REASON:` 行）。写了 `parent` 却没写它，建单会被拒。 */
  parentReason?: string;
  /** 分组声明（`GROUP:` 行）原话：`new <标题>` / `#G1`。由调用方解析并落成结构。 */
  group?: string;
  /** 插入声明（`INSERT:` 行）：把本单插到锚点之前或之后。 */
  insert?: InsertRef;
  /** 在途处置（`INSERT_MODE:` 行）：`halt` 退回重做 / `keep` 不中断 / `drop` 作废。 */
  insertMode?: "halt" | "keep" | "drop";
  /**
   * 模型挑的截图编号（1 起，对应提示词里【可用截图】的编号）。
   * `undefined`：未写 ATT 行，使用本条消息自带的图片；`[]`：明确不带；`[1,3]`：只带这几张。
   */
  shots?: number[];
}

export function parseReply(raw: string): ParsedReply {
  let want = "";
  const acts: ParsedAction[] = [];
  /** 出现在首个 `DO:` 之前的 `ATT:`，归入随后第一单。 */
  let leadShots: number[] | undefined;
  /** 出现在首个 `DO:` 之前的 `REVOKE:`，归入随后第一单。 */
  let leadRevoke: string | undefined;
  /** 是否出现 `ATT:` 行，用于区分未写与明确不带。 */
  let attSeen = false;
  let depRefs: string[] | undefined;
  let parentRef: string | undefined;
  let parentReason: string | undefined;
  let groupRef: string | undefined;
  let insertRef: InsertRef | undefined;
  let insertMode: "halt" | "keep" | "drop" | undefined;
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    /* `ATT:` 归属于其前面最近的 `DO:` 动作。 */
    const doM = DO_LINE.exec(line);
    if (doM) {
      const block: ParsedAction = {
        action: String(doM[1]).toLowerCase(),
        arg: String(doM[2] ?? "").trim(),
      };
      if (leadShots) {
        block.shots = leadShots;
        leadShots = undefined;
      }
      if (leadRevoke) {
        block.revoke = leadRevoke;
        leadRevoke = undefined;
      }
      acts.push(block);
      continue;
    }
    const revM = REVOKE_LINE.exec(line);
    if (revM) {
      const why = String(revM[1] ?? "").trim();
      if (why && !/^(none|无|-|—)$/i.test(why)) {
        const cur = acts[acts.length - 1];
        if (cur) cur.revoke = why;
        else leadRevoke = why;
      }
      continue;
    }
    const attM = ATT_LINE.exec(line);
    if (attM) {
      const picked = parseShots(String(attM[1] ?? ""));
      if (picked) {
        attSeen = true;
        const cur = acts[acts.length - 1];
        if (cur) cur.shots = picked;
        else leadShots = picked;
      }
      continue;
    }
    /* 理由行先于父节点行判定，避免前缀规则误匹配。 */
    const prM = PARENT_REASON_LINE.exec(line);
    if (prM) {
      const why = String(prM[1] ?? "").trim();
      if (why && !/^(none|无|-|—)$/i.test(why)) parentReason = why;
      continue;
    }
    const parM = PARENT_LINE.exec(line);
    if (parM) {
      const t = String(parM[1] ?? "").trim();
      /* `PARENT: none` 等价于未写，不落字段。 */
      if (t && !/^(none|no|无|-|—)$/i.test(t)) parentRef = t;
      continue;
    }
    const afterM = AFTER_LINE.exec(line);
    if (afterM) {
      const t = String(afterM[1] ?? "").trim();
      /* `AFTER: none` 等价于未写，不落字段。 */
      if (!/^(none|无|-|—)$/i.test(t)) {
        const refs = [
          ...new Set(
            t
              .split(/[\s,，、;；]+/)
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ];
        if (refs.length > 0) depRefs = refs;
      }
      continue;
    }
    const grpM = GROUP_LINE.exec(line);
    if (grpM) {
      const t = String(grpM[1] ?? "").trim();
      if (t && !/^(none|no|无|-|—)$/i.test(t)) groupRef = t;
      continue;
    }
    const insM = INSERT_LINE.exec(line);
    if (insM) {
      const parsed = parseInsert(String(insM[1] ?? ""));
      if (parsed) insertRef = parsed;
      continue;
    }
    const modeM = INSERT_MODE_LINE.exec(line);
    if (modeM) {
      const m = parseInsertMode(String(modeM[1] ?? ""));
      if (m) insertMode = m;
      continue;
    }
    /* `ACTION:` 可出现在行中而非仅行首：按位置切分，前段留作正文，后段作为要求。 */
    const at = line.search(/ACTION:/i);
    if (at < 0) {
      kept.push(line);
      continue;
    }
    const before = line.slice(0, at).trim();
    const after = line.slice(at).replace(/^ACTION:\s*/i, "").trim();
    if (before) kept.push(before);
    if (after) want = after;
  }
  /* 树边与依赖仅在单动作时生效；多动作并行时忽略，由调用方提示。 */
  const multi = acts.length > 1;
  const first = acts[0];
  const firstShots = first?.shots;
  return {
    reply: kept.join("\n").trim(),
    want: want.replace(LEGACY_VERB, "").trim(),
    act: first ? { action: first.action, arg: first.arg } : null,
    acts,
    /* `shots` 为兼容字段：单动作时取首单的 ATT；未写 ATT 由调用方按消息自带图处理。 */
    ...(attSeen ? { shots: firstShots ?? leadShots ?? [] } : {}),
    ...(!multi && depRefs ? { after: depRefs } : {}),
    ...(!multi && parentRef ? { parent: parentRef } : {}),
    ...(!multi && parentReason ? { parentReason } : {}),
    ...(!multi && groupRef ? { group: groupRef } : {}),
    ...(!multi && insertRef ? { insert: insertRef } : {}),
    ...(!multi && insertMode ? { insertMode } : {}),
  };
}

/**
 * 把解析出的树字段转成指令记录字段。
 *
 * 一处决定解析结果中哪些字段写入指令记录：`parent` / `after` / `group` / `insert` 各自
 * 有对应的记录字段名。分散在调用方拼接会导致字段已解析却未传递，且不会报错。
 */
export function treeDirectiveFields(p: ParsedReply): {
  parent?: string;
  parent_reason?: string;
  after?: string[];
  group?: string;
  insert?: string;
  insert_mode?: "halt" | "keep" | "drop";
} {
  return {
    ...(p.parent ? { parent: p.parent } : {}),
    ...(p.parentReason ? { parent_reason: p.parentReason } : {}),
    ...(p.after ? { after: p.after } : {}),
    ...(p.group ? { group: p.group } : {}),
    ...(p.insert ? { insert: `${p.insert.where} ${p.insert.anchor}${p.insert.now ? " now" : ""}` } : {}),
    ...(p.insertMode ? { insert_mode: p.insertMode } : {}),
  };
}
