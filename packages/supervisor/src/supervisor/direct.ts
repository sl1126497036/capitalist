/**
 * 监工调度指令通道（`.capitalist/supervisor-direct.jsonl`）。与 `direct.jsonl` 是两条独立通道：
 * 后者承载派单内容，前者承载调度动作，合并会导致动作与内容互相误判。
 * 只接受白名单动作，未知动作落已消费的拒绝记录；本模块只写不执行，状态变更由 `loop.ts` 的 tick 完成，写入来源由调用方校验。
 */

import { join } from "node:path";

import { withFileLock } from "../core/commands";
import { appendJsonl, readJsonl, writeJsonl } from "../core/json";
import { recordEvent } from "../core/ledger";
import { supervisorDir } from "../core/paths";

/**
 * 白名单动作，顺序即界面快捷清单顺序。`dispatch` 当场建单并插到队首；
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
  /* 置顶并抢占槽位：`DO: promote #03`。 */
  "promote",
  /* 插到排队队首，不抢占槽位；与 promote 的立即执行不同。 */
  "queue",
  /* 作废一张单：结单、结束进程且不再重派（`DO: cancel #65`）。 */
  "cancel",
  "skip",
  "ask",
  "instruct",
] as const;

export type SupervisorAction = (typeof CAPITALIST_ACTIONS)[number];

/** 一次指令执行的结果，落进记录的 `result` 字段供界面回显。 */
export interface SupervisorResult {
  ok: boolean;
  /** 被拒原因；成功时为空串 */
  reason: string;
  /** 成功时的界面回显文本（例如「已重派 supervisor-entry」） */
  detail: string;
  /** 插队标记，仅 `dispatch` 建插队单时置真；随 result 落盘供界面回显。 */
  urgent?: boolean;
  /**
   * 目标派单 id：`dispatch` 并入既有单或 `amend` 追加时指向实际落到的单，界面据此显示任务编号。
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
  /** 目标线程（`capitalist say --thread` 落的记录）：回显归位到该工作进程会话，不进入监工流。 */
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
  return join(supervisorDir(root), "supervisor-direct.jsonl");
}

function newId(): string {
  return `SD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 把自然语言解析成白名单动作。仅按首词与参数切分，不推断意图；
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
    /* 「继续」不并入 resume：该表述可能指向其他任务，并入后会使对话层自行启动派单。 */
    if (/^(resume|恢复|恢复派单)$/.test(head)) return "resume";
    if (/^(set-next|setnext|next|下一步|设置下一步)$/.test(head)) return "set-next";
    if (/^(amend|追加|补充|更正|改口)$/.test(head)) return "amend";
    if (/^(concurrency|parallel|并行|并行度)$/.test(head)) return "concurrency";
    if (/^(retry|重派|重试)$/.test(head)) return "retry";
    if (/^(queue|插队|排前面|排到前面|插到前面)$/.test(head)) return "queue";
    if (/^(skip|跳过)$/.test(head)) return "skip";
    if (/^(diagnose|诊断|自查|排查|查因)$/.test(head)) return "diagnose";
    if (/^(fix|修复|自我修复|修卡点|自修复)$/.test(head)) return "fix";
    if (/^(ask|问|询问|提问)$/.test(head)) return "ask";
    // `instruct` 为兼容看板仍在下发的 `action:"instruct"` 而保留。
    if (/^(instruct|自然语言|照办|照我说的)$/.test(head)) return "instruct";
    return null;
  };
  const action = pick();
  if (!action) {
    /*
     * 看板可能下发不带动作名的自然语言，整句中文按自然语言调度处理。
     * 判据为含中文且长度 ≥ 6；短命令仍走拒绝路径，避免拼写错误被误判。
     */
    const looksChinese = /[\u4e00-\u9fa5]/.test(raw) && raw.length >= 6;
    if (looksChinese) return { action: "instruct" as SupervisorAction, arg: raw, confirm: false };
    return {
      error: `未知动作「${head || raw}」。白名单：${CAPITALIST_ACTIONS.join(" / ")}（中文同义词同样可用；整句自然语言会按 instruct 解析）`,
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
        `${action} 缺少内容：写成 ${action} <卡在哪>。` +
        "diagnose 只查不改（只读诊断），fix 查完直接修；两者都用全新进程、不占业务槽位。",
    };
  }
  if (action === "instruct" && !rest) {
    return { error: "instruct 缺少内容：请写明要执行的操作，例如「把 UI 相关的任务都停掉」" };
  }
  if (action === "ask" && !rest) {
    return { error: "ask 缺少问题：写成 ask <一句话>" };
  }
  return { action, arg: rest, confirm };
}

/**
 * 追加一条调度指令。显式 `action` 先校验白名单，未知动作报错且不落盘；
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
    /** 前置派单编号 / id（只有 dispatch 用，来自 `AFTER:` 行）。 */
    after?: string[];
    /** 父派单编号 / id 与挂边理由（只有 dispatch 用，来自 `PARENT:` / `PARENT_REASON:` 行）。 */
    parent?: string;
    parent_reason?: string;
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
      return { ok: false, error: `未知动作「${explicit}」。白名单：${CAPITALIST_ACTIONS.join(" / ")}` };
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
    id: newId(),
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
    return { ok: false, error: "指令写入失败（.capitalist 不可写？）" };
  }
  recordEvent(root, "supervisor_direct_inject", {
    id: rec.id,
    action: rec.action || "(未知)",
    arg: rec.arg,
    text: rec.text.slice(0, 120),
    rejected: Boolean(rejected),
  });
  if (rejected) {
    recordEvent(root, "supervisor_cmd", {
      id: rec.id,
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
 * 拿不到锁返回 false，下一轮重试；同一 tick 内的去重由调用方按 id 负责。
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
