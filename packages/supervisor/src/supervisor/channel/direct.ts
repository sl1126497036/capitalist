/**
 * 监工调度指令通道（`.capitalist/ledger/supervisor-direct.jsonl`）。与 `direct.jsonl` 是两条独立通道：
 * 后者承载派单内容，前者承载调度动作，合并会导致动作与内容互相误判。
 * 只接受允许的动作，未知动作落已消费的拒绝记录；本模块只写不执行，状态变更由 `loop.ts` 的调度轮次完成，写入来源由调用方校验。
 */

import { join } from "node:path";

import { withFileLock } from "../../core/dispatch/commands";
import { appendJsonl, readJsonl, writeJsonl } from "../../core/record/json";
import { recordEvent } from "../../core/record/ledger";
import { ledger as ledgerLoc } from "../../core/record/locations";
import { isUserMsgDirection, msgDirection, msgId, userMsgDirectionOf } from "../../core/message/msgId";
import { taskNoOfDispatchId } from "../../core/record/tasks";
import { parseGroupSpec } from "../../core/dispatch/groupOps";
import { parseInsert, parseInsertMode } from "./treeLines";

/**
 * 允许的动作，顺序即界面快捷清单顺序。`dispatch` 当场建单并插到队首；
 * `instruct` 已废弃，因看板与 `loop.ts` 仍引用而保留。
 */
export const CAPITALIST_ACTIONS = [
  "pause",
  "resume",
  "set-next",
  "dispatch",
  "amend",
  "diagnose",
  "fix",
  "reload",
  "concurrency",
  "retry",
  /* 重开已结束的一单：沿用原单 id、编号与对应的会话（`DO: redo #03`）。 */
  "redo",
  /* 置顶并抢占槽位：`DO: promote #03`。 */
  "promote",
  /* 插到排队队首，不抢占槽位；与 promote 的立即执行不同。 */
  "queue",
  /* 单张恢复：只解除这一张的暂停，不解除全局暂停（`DO: wake #03`）。 */
  "wake",
  /* 作废一张单：结束该单、结束进程且不再重派（`DO: cancel #65`）。 */
  "cancel",
  "skip",
  "ask",
  "instruct",
] as const;

export type SupervisorAction = (typeof CAPITALIST_ACTIONS)[number];

/** 一次指令执行的结果，写入记录的 `result` 字段供界面回显。 */
export interface SupervisorResult {
  ok: boolean;
  /** 被拒原因；成功时为空串 */
  reason: string;
  /** 成功时的界面回显文本（例如“已重派 supervisor-entry”） */
  detail: string;
  /** 插队标记，仅 `dispatch` 建插队单时置真；随 result 写入记录供界面回显。 */
  urgent?: boolean;
  /**
   * 目标派单 id：`dispatch` 并入既有单或 `amend` 追加时指向实际对应的单，界面据此显示任务编号。
   * 被拒或新建单时不存在。
   */
  dispatch?: string;
}

/** 一条调度指令记录。 */
export interface SupervisorDirective {
  id: string;
  at: string;
  at_ts: number;
  /** 指令原文（自然语言或快捷清单的命令行） */
  text: string;
  action: SupervisorAction | "";
  arg: string;
  /**
   * 派单标题（`TITLE:` 行），仅 `dispatch` 消费，建单时写入台账 `title` 字段。
   *
   * 标题由派单方给出，不从正文摘要推测。缺字段的记录按未写处理，建单侧走摘要兜底。
   */
  title?: string;
  /**
   * 指令来源消息标识与组单时选中的附件。`dispatch` 造单优先用 `atts`；
   * `msg_id` 仅在无 `atts` 时用于回查该消息的附件。
   */
  msg_id?: string;
  atts?: string[];
  /**
   * 指令来源：`user` 为界面或命令行下发，`capitalist` 为监工对话层生成。
   * 缺字段的记录按 `user` 处理。
   */
  via?: "user" | "capitalist";
  /** skip 这类危险动作的二次确认标记 */
  confirm?: boolean;
  /**
   * 父派单（`PARENT:` 行），仅 `dispatch` 消费，建单时写入台账 `parent` 字段。
   * `parent` 为树边，`after` 为多前置屏障；顺序判定与校验在 `loop.ts` 建单时执行。
   */
  parent?: string;
  /** 挂父节点的理由（`PARENT_REASON:` 行）。写了 `parent` 就必须有它，否则建单被拒。 */
  parent_reason?: string;
  /**
   * 前置派单（`AFTER:` 行），建单时写入台账 `after` 字段。
   * 新派单优先用 `PARENT:`，`AFTER:` 仍兼容。
   */
  after?: string[];
  /**
   * 分组声明（`GROUP:` 行），仅 `dispatch` 消费。
   *
   * 落盘保存解析后的结构（`mode: new` 带标题、`mode: join` 带归一后的组号），不存模型原话：
   * 建单时若再解析一次原话，就会出现“回显 #G01、实际挂 G1”这类两处口径。
   * 注：`GROUP: none` 等价于未写，不落字段。
   */
  group?: { mode: "new"; title: string } | { mode: "join"; id: string };
  /**
   * 接替声明（`SUPERSEDE:` 行）原话，仅 `dispatch` 消费。
   *
   * 存原话而不在此换算：换算要用台账与组索引，属于建单校验，放在 `supersede.ts` 一处完成。
   */
  supersede?: string;
  /**
   * 插入声明（`INSERT:` 行），仅 `dispatch` 消费：把本单插到锚点之前或之后。
   * `now` 表示建单后立即执行，建单与置顶在同一事务里完成。
   */
  insert?: { where: "before" | "after"; anchor: string; now: boolean };
  /** 在途处置（`INSERT_MODE:` 行）：`halt` 退回重做 / `keep` 不中断 / `drop` 作废。 */
  insert_mode?: "halt" | "keep" | "drop";
  /** 目标线程（`capitalist say --thread` 写入的记录）：回显归位到该工作进程会话，不进入监工流。 */
  thread?: string;
  /**
   * 指令作用的目标派单 id，仅 `amend` 使用：追加内容必须落在具体一单。
   * 未指定时该条被拒绝，其余动作忽略。
   */
  target?: string;
  consumed: boolean;
  consumed_at?: string;
  result?: SupervisorResult;
}

/** 通道文件的绝对路径。 */
export function supervisorDirectPath(root: string): string {
  return ledgerLoc.supervisorDirect(root);
}

function newId(target: string, fromUser: boolean): string {
  /*
   * 方向段按发起方取，不按记录类型取。
   *
   * 这张台账存的是调度指令，但其中一部分是用户在界面上说的话（`via` 缺省或 `user`）。
   * 那些记录会以“我：”气泡显示，身份必须是用户消息编号（`U2S`）；早先一律按指令性质
   * 记成 `S`，界面上就出现“用户说的话带着监工方向”，引用条也跟着复述错号。
   * 监工对话层自己生成的指令才是 `S2W`：这条台账的内容是发给工作进程的。
   */
  const no = taskNoOfDispatchId(String(target ?? "")) || "S0";
  return msgId(no, fromUser ? userMsgDirectionOf("supervisor") : "S2W");
}

/**
 * 把自然语言解析成允许的动作。仅按首词与参数切分，不推断意图；
 * 认不出即返回未知动作，避免误解析触发动作。
 */
export function parseSupervisorCommand(text: string): { action: SupervisorAction; arg: string; confirm: boolean } | { error: string } {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "指令为空" };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
  const head = (m?.[1] ?? "").toLowerCase().replace(/[：:]$/, "");
  let rest = (m?.[2] ?? "").trim().replace(/^[：:]\s*/, "");

  const pick = (): SupervisorAction | null => {
    if (/^(pause|暂停|暂停派单)$/.test(head)) return "pause";
    /* “继续”不并入 resume：该表述可能指向其他任务，并入后会使对话层自行启动派单。 */
    if (/^(resume|恢复|恢复派单)$/.test(head)) return "resume";
    if (/^(set-next|setnext|next|下一步|设置下一步)$/.test(head)) return "set-next";
    if (/^(amend|追加|补充|更正|改口)$/.test(head)) return "amend";
    if (/^(concurrency|parallel|并行|并行度)$/.test(head)) return "concurrency";
    /* 允许动作名带“任务 / 单”后缀：界面与对话里常见“重派任务 #02”“重开这一单”。 */
    if (/^(retry|重派|重试)(任务|单)?$/.test(head)) return "retry";
    if (/^(redo|重开|返工|重新执行|重新跑|再来一遍)(任务|单)?$/.test(head)) return "redo";
    if (/^(queue|插队|排前面|排到前面|插到前面)$/.test(head)) return "queue";
    if (/^(skip|跳过)$/.test(head)) return "skip";
    if (/^(diagnose|诊断|自查|排查|查因)$/.test(head)) return "diagnose";
    if (/^(fix|修复|自我修复|修卡点|自修复)$/.test(head)) return "fix";
    if (/^(ask|问|询问|提问)$/.test(head)) return "ask";
    // `instruct` 为兼容看板仍在下发的 `action:"instruct"` 而保留。
    if (/^(instruct|自然语言|照办|照我说的)$/.test(head)) return "instruct";
    return null;
  };
  let action = pick();

  /*
   * 口语里的“重派 #02”指的是整单返工，而 retry 只重跑分片，两者参数形态不同：
   * 带 `#编号` 的转给 redo，参数统一为 `#N`（redo 只认开头编号）；
   * 不带井号的（如“重派 s2”）仍按 retry 处理。
   */
  if (action === "retry") {
    const hashed = /#\s*(\d{1,4})\b/.exec(rest);
    if (hashed) {
      action = "redo";
      rest = `#${hashed[1]}`;
    }
  }

  if (!action) {
    /*
     * 看板可能下发不带动作名的自然语言，整句中文按自然语言调度处理。
     * 判据为含中文且长度 ≥ 6；短命令仍走拒绝路径，避免拼写错误被误判。
     */
    const looksChinese = /[\u4e00-\u9fa5]/.test(raw) && raw.length >= 6;
    if (looksChinese) return { action: "instruct" as SupervisorAction, arg: raw, confirm: false };
    return {
      error: `未知动作“${head || raw}”：请改用支持的指令`,
    };
  }

  // 二次确认可写在参数末尾（confirm / 确认）；快捷清单使用显式字段。
  let confirm = false;
  if (/(^|\s)(confirm|确认)\s*$/i.test(rest)) {
    confirm = true;
    rest = rest.replace(/(^|\s)(confirm|确认)\s*$/i, "").trim();
  }

  if ((action === "set-next" || action === "retry" || action === "skip") && !rest) {
    return { error: `${action} 缺少参数` };
  }
  if (action === "amend" && !rest) {
    return { error: "amend 缺少内容：写成 amend <补充或更正的要求>" };
  }
  if ((action === "diagnose" || action === "fix") && !rest) {
    return {
      error:
        `${action} 缺少内容：写成 ${action} <受阻原因>。` +
        "diagnose 只诊断不修改，fix 诊断后直接修复。",
    };
  }
  if (action === "instruct" && !rest) {
    return { error: "请写明要执行的操作，例如“把 UI 相关的任务都停掉”" };
  }
  if (action === "ask" && !rest) {
    return { error: "ask 缺少问题：写成 ask <一句话>" };
  }
  return { action, arg: rest, confirm };
}

/**
 * 追加一条调度指令。显式 `action` 先校验是否为允许的动作，未知动作报错且不落盘；
 * 仅给 `text` 时按自然语言解析，未知动作落已消费的拒绝记录供界面回显。
 */
export function appendSupervisorDirective(
  root: string,
  input: {
    text?: string;
    action?: string;
    arg?: string;
    confirm?: boolean;
    via?: "user" | "capitalist";
    /** 指令对应的消息标识与附件，随指令一并落盘。 */
    msg_id?: string;
    atts?: string[];
    /** 作用在哪一单上（只有 amend 用）。 */
    target?: string;
    /** 派单标题（只有 dispatch 用，来自 `TITLE:` 行）。超长与空值在建单侧统一处理。 */
    title?: string;
    /** 前置派单编号 / id（只有 dispatch 用，来自 `AFTER:` 行）。 */
    after?: string[];
    /** 父派单编号 / id 与挂边理由（只有 dispatch 用，来自 `PARENT:` / `PARENT_REASON:` 行）。 */
    parent?: string;
    parent_reason?: string;
    /** 分组声明原话（只有 dispatch 用，来自 `GROUP:` 行）。 */
    group?: string;
    /** 接替声明原话（只有 dispatch 用，来自 `SUPERSEDE:` 行）。 */
    supersede?: string;
    /** 插入声明原话（只有 dispatch 用，来自 `INSERT:` / `INSERT_MODE:` 行）。 */
    insert?: string;
    insert_mode?: string;
  },
): { ok: true; rec: SupervisorDirective } | { ok: false; error: string } {
  const text = String(input.text ?? "").trim();
  const explicit = String(input.action ?? "").trim();
  let action: SupervisorAction | "" = "";
  let arg = String(input.arg ?? "").trim();
  let confirm = input.confirm === true;
  let rejected: string | null = null;

  if (explicit) {
    if (!(CAPITALIST_ACTIONS as readonly string[]).includes(explicit)) {
      return { ok: false, error: `未知动作“${explicit}”：请改用支持的指令` };
    }
    action = explicit as SupervisorAction;
  } else {
    const parsed = parseSupervisorCommand(text);
    if ("error" in parsed) rejected = parsed.error;
    else {
      action = parsed.action;
      arg = parsed.arg;
      confirm = confirm || parsed.confirm;
    }
  }

  if (!explicit && !text) return { ok: false, error: "指令为空" };
  if (text.length > 500) return { ok: false, error: "指令过长（上限 500 字）" };

  const rec: SupervisorDirective = {
    id: newId(String(input.target ?? ""), String(input.via ?? "") !== "capitalist"),
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    text: text || [action, arg].filter(Boolean).join(" "),
    action,
    arg,
    consumed: false,
  };
  if (confirm) rec.confirm = true;
  // 来源标记用于回显时区分监工对话层下发的指令。
  if (input.via === "capitalist" || input.via === "user") rec.via = input.via;
  /*
   * 附件只取调用方传入，不从 `arg` 提取历史路径。
   * 空数组表示明确无附件，读侧不补。
   */
  if (input.msg_id) rec.msg_id = String(input.msg_id);
  if (input.target) rec.target = String(input.target);
  /* 标题只存原文，长度与可用性由建单侧 `declaredTitle` 统一判定。 */
  const declared = String(input.title ?? "").trim();
  if (declared) rec.title = declared;
  /* `PARENT: none` 等价于未写，不落字段；`parent_reason` 单独保存，标出建立该树边的依据。 */
  const parentRef = String(input.parent ?? "").trim();
  if (parentRef && !/^(none|no|无|-|—)$/i.test(parentRef)) {
    rec.parent = parentRef;
    const why = String(input.parent_reason ?? "").trim();
    if (why) rec.parent_reason = why;
  }
  if (Array.isArray(input.after)) {
    rec.after = [...new Set(input.after.map((x) => String(x ?? "").trim()).filter(Boolean))];
  }
  /* 分组：`new <标题>` 与 `#G1` 两种。无法识别的写法不落字段，建单时按未写处理并给出提示。 */
  if (input.group) {
    const spec = parseGroupSpec(input.group);
    if (spec && spec.mode !== "none") rec.group = spec;
  }
  /* 接替：只存原话，换算与校验在建单时完成，避免两处各解析一遍。 */
  const supRef = String(input.supersede ?? "").trim();
  if (supRef && !/^(none|no|无|-|—)$/i.test(supRef)) rec.supersede = supRef;
  /* 插入：无法识别插入位置时不落字段，由建单侧按未写处理，避免把派单插到推测的层级。 */
  if (input.insert) {
    const ins = parseInsert(input.insert);
    if (ins) rec.insert = ins;
  }
  if (input.insert_mode) {
    const mode = parseInsertMode(input.insert_mode);
    if (mode) rec.insert_mode = mode;
  }
  if (Array.isArray(input.atts)) {
    rec.atts = [...new Set(input.atts.map((p) => String(p ?? "").trim()).filter(Boolean))];
  }

  if (rejected) {
    // 未知动作标为已消费，循环不再执行，也不重试。
    rec.consumed = true;
    rec.consumed_at = new Date().toISOString();
    rec.result = { ok: false, reason: rejected, detail: "" };
  }

  if (!appendJsonl(supervisorDirectPath(root), rec)) {
    return { ok: false, error: "指令写入失败：请检查任务目录是否可写" };
  }
  recordEvent(root, "supervisor_direct_inject", {
    id: rec.id,
    action: rec.action || "(未知)",
    arg: rec.arg,
    text: rec.text.slice(0, 120),
    rejected: Boolean(rejected),
  });
  if (rejected) {
    /*
     * 拒绝回执由监工产生，发给用户看，方向 `S2U`；触发它的用户消息号记在 `msg_id`。
     * 复用 `rec.id` 会让拒绝回执与用户原话同号，引用回执时引用条显示用户方向号。
     */
    const triggerNo =
      [String(rec.msg_id ?? ""), String(rec.id ?? "")].find((x) => isUserMsgDirection(msgDirection(x))) || "";
    recordEvent(root, "supervisor_cmd", {
      id: msgId(taskNoOfDispatchId(String(rec.target ?? "")) || "S0", "S2U"),
      ...(triggerNo ? { msg_id: triggerNo } : {}),
      action: rec.action || "",
      arg: rec.arg,
      ok: false,
      reason: rejected,
      detail: "",
      text: rec.text.slice(0, 120),
    });
  }
  return { ok: true, rec };
}

/** 读全部指令，跳过缺字段的脏记录。 */
export function listSupervisorDirectives(root: string): SupervisorDirective[] {
  return readJsonl<SupervisorDirective>(supervisorDirectPath(root)).filter(
    (r) => r && typeof r.id === "string" && r.id.length > 0 && typeof r.at === "string",
  );
}

/** 尚未被循环消费的指令，按写入顺序。 */
export function pendingSupervisorDirectives(root: string): SupervisorDirective[] {
  return listSupervisorDirectives(root).filter((r) => r.consumed !== true);
}

/**
 * 标记指令已消费并写入结果。读改写必须带锁：看板进程与监工循环并发写入，不加锁会丢失指令。
 * 获取锁失败返回 false，下一轮重试；同一轮调度内的去重由调用方按 id 负责。
 */
export function markSupervisorDirective(root: string, id: string, result: SupervisorResult): boolean {
  const file = supervisorDirectPath(root);
  const got = withFileLock(file, () => {
    const rows = readJsonl<SupervisorDirective>(file);
    let hit = false;
    for (const r of rows) {
      if (r.id !== id) continue;
      r.consumed = true;
      r.consumed_at = new Date().toISOString();
      r.result = result;
      hit = true;
    }
    if (hit) writeJsonl(file, rows);
    return hit;
  });
  return got.ok ? got.value : false;
}
