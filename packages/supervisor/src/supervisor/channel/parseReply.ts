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
  SUPERSEDE_LINE,
  TITLE_LINE,
  parseInsert,
  parseInsertMode,
  type InsertRef,
} from "./treeLines";

/** 仅剥离 `ACTION:` 开头的一个已知动作词，不处理句中词，也不做语义判断。 */
const LEGACY_VERB = /^\s*(pause|resume|concurrency|retry|skip|set-next|dispatch|ask|instruct|intervene)\s+/i;

/** 监工会话的动作行：`DO: dispatch 查一下长列表卡顿` -> `{action:"dispatch", arg:"查一下…"}`。只认行首（允许前导空白），避免误切正文。 */
const DO_LINE = /^\s*DO:\s*([a-zA-Z-]+)\s*([\s\S]*)$/;






/**
 * 树字段的集合。`ParsedReply`（单动作兼容）与 `ParsedAction`（每个动作）都满足它，
 * 于是 `treeDirectiveFields` 只认这一份形状，不必区分调用方传的是整条还是单条。
 *
 * 字段只在这里列举一次：`ParsedAction` 直接继承它。两处各写一遍时，新增一个树字段
 * 很容易只加到其中一处，表现是“解析出来了但没落库”，且不会报错。
 */
export interface TreeFieldBag {
  /**
   * 派单标题（`TITLE:` 行）。
   *
   * 不是树字段，但归属规则与树字段相同（跟着最近的 `DO:`），且要与 ATT / PARENT 一起
   * 从解析结果传递到指令记录，所以放在同一个包里，由 {@link treeDirectiveFields} 统一带出。
   * 优先级高于正文摘要：摘要判断不出哪一段是任务本体。
   */
  title?: string;
  parent?: string;
  parentReason?: string;
  after?: string[];
  group?: string;
  /** 接替声明（`SUPERSEDE:` 行）原话。建单时换算成台账 id 并校验同组。 */
  supersede?: string;
  insert?: InsertRef;
  insertMode?: "halt" | "keep" | "drop";
}

/** 一个动作块：`DO:` 行及其后的 `ATT:` 行与树字段；一条消息多单时每单各自带附件与结构。 */
export interface ParsedAction extends TreeFieldBag {
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
   * 模型写的标题（`TITLE:` 行）。undefined 表示未写，建单时按正文摘要兜底。
   * 多动作时每单的标题在 `acts` 里，这里只保留单动作消息的那一份。
   */
  title?: string;
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
  /**
   * 接替声明（`SUPERSEDE:` 行）原话：被顶替事项的编号或派单 id。
   *
   * 建单时换算成台账 id 并校验同组、目标已了结；判定时与被接替事项合并为同一事项。
   */
  supersede?: string;
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
  /**
   * 树字段归属：写在哪个 `DO:` 之后就属于哪一单。
   *
   * 早先这些字段是整条消息共用的，`acts.length > 1` 时一律丢弃。一条消息派两单、
   * 第二单要挂第一单时，写了 `PARENT` 也不生效，而且不报错，只能从结果反推。
   * 现在与 `ATT` / `REVOKE` 同一套归属规则：挂到最近的 `DO:`，尚无 `DO:` 时先存起来，
   * 归入随后第一单。
   */
  const lead: TreeFieldBag = {};
  const treeBag = (): TreeFieldBag => (acts[acts.length - 1] as TreeFieldBag | undefined) ?? lead;
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
      /* 写在首个 `DO:` 之前的树字段，归入这一单。 */
      if (Object.keys(lead).length > 0) {
        Object.assign(block, lead);
        for (const k of Object.keys(lead) as (keyof TreeFieldBag)[]) delete lead[k];
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
      if (why && !/^(none|无|-|—)$/i.test(why)) treeBag().parentReason = why;
      continue;
    }
    const parM = PARENT_LINE.exec(line);
    if (parM) {
      const t = String(parM[1] ?? "").trim();
      /* `PARENT: none` 等价于未写，不落字段。 */
      if (t && !/^(none|no|无|-|—)$/i.test(t)) treeBag().parent = t;
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
        if (refs.length > 0) treeBag().after = refs;
      }
      continue;
    }
    const grpM = GROUP_LINE.exec(line);
    if (grpM) {
      const t = String(grpM[1] ?? "").trim();
      if (t && !/^(none|no|无|-|—)$/i.test(t)) treeBag().group = t;
      continue;
    }
    const supM = SUPERSEDE_LINE.exec(line);
    if (supM) {
      const t = String(supM[1] ?? "").trim();
      if (t && !/^(none|no|无|-|—)$/i.test(t)) treeBag().supersede = t;
      continue;
    }
    /* 标题行与 ATT / PARENT 同一套归属：写到哪个 `DO:` 之后，就属于哪一单。 */
    const titleM = TITLE_LINE.exec(line);
    if (titleM) {
      const t = String(titleM[1] ?? "").trim();
      if (t && !/^(none|无|-|—)$/i.test(t)) treeBag().title = t;
      continue;
    }
    const insM = INSERT_LINE.exec(line);
    if (insM) {
      const parsed = parseInsert(String(insM[1] ?? ""));
      if (parsed) treeBag().insert = parsed;
      continue;
    }
    const modeM = INSERT_MODE_LINE.exec(line);
    if (modeM) {
      const m = parseInsertMode(String(modeM[1] ?? ""));
      if (m) treeBag().insertMode = m;
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
  /*
   * 顶层树字段只为单动作消息保留（兼容既有调用点）。多动作时每单的树字段在 `acts` 里，
   * 由调用方逐条取用。顶层若给一份不分归属的值，会让人误以为整条消息共用同一棵树边。
   */
  const multi = acts.length > 1;
  const first = acts[0];
  const firstShots = first?.shots;
  const solo: TreeFieldBag = multi ? {} : (first ?? lead);
  return {
    reply: kept.join("\n").trim(),
    want: want.replace(LEGACY_VERB, "").trim(),
    act: first ? { action: first.action, arg: first.arg } : null,
    acts,
    /* `shots` 为兼容字段：单动作时取首单的 ATT；未写 ATT 由调用方按消息自带图处理。 */
    ...(attSeen ? { shots: firstShots ?? leadShots ?? [] } : {}),
    ...(solo.title ? { title: solo.title } : {}),
    ...(solo.after ? { after: solo.after } : {}),
    ...(solo.parent ? { parent: solo.parent } : {}),
    ...(solo.parentReason ? { parentReason: solo.parentReason } : {}),
    ...(solo.group ? { group: solo.group } : {}),
    ...(solo.supersede ? { supersede: solo.supersede } : {}),
    ...(solo.insert ? { insert: solo.insert } : {}),
    ...(solo.insertMode ? { insertMode: solo.insertMode } : {}),
  };
}

/**
 * 把解析出的树字段转成指令记录字段。
 *
 * 一处决定解析结果中哪些字段写入指令记录：`parent` / `after` / `group` / `insert` 各自
 * 有对应的记录字段名。分散在调用方拼接会导致字段已解析却未传递，且不会报错。
 */
export function treeDirectiveFields(p: TreeFieldBag): {
  title?: string;
  parent?: string;
  parent_reason?: string;
  after?: string[];
  group?: string;
  supersede?: string;
  insert?: string;
  insert_mode?: "halt" | "keep" | "drop";
} {
  return {
    ...(p.title ? { title: p.title } : {}),
    ...(p.parent ? { parent: p.parent } : {}),
    ...(p.parentReason ? { parent_reason: p.parentReason } : {}),
    ...(p.after ? { after: p.after } : {}),
    ...(p.group ? { group: p.group } : {}),
    ...(p.supersede ? { supersede: p.supersede } : {}),
    ...(p.insert ? { insert: `${p.insert.where} ${p.insert.anchor}${p.insert.now ? " now" : ""}` } : {}),
    ...(p.insertMode ? { insert_mode: p.insertMode } : {}),
  };
}
