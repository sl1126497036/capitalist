/**
 * 线程内要求的归属解析。
 *
 * 用户在看板某条线程里提的要求属于这条线程对应的单：已结束的单先重开再用，不另建一张。
 * 新单会丢掉原会话与原编号，用户随后看到的会变成“另一张单在做刚才说的事”，
 * 原单的补充也没人接手。
 */

export interface ThreadActionInput {
  /** 用户这一轮的原话，用于识别“明确要另开一单”。 */
  text: string;
  /** 这条线程对应的派单 id；为空表示不是线程内的对话。 */
  talkTarget: string;
  /** 该单的任务编号（界面上的 #N）。 */
  talkNo: string;
  action: string;
  arg: string;
  /** 该单当前状态。 */
  status: string;
}

export interface ThreadActionResult {
  action: string;
  arg: string;
  /** 目标单已结束，需要先重开同一单。 */
  reopenFirst: boolean;
}

/** 线程内的 dispatch 改写成 amend；只有用户明确要新任务时保留新建单。 */
export function resolveThreadAction(i: ThreadActionInput): ThreadActionResult {
  const keep = { action: i.action, arg: i.arg, reopenFirst: false };
  if (i.action !== "dispatch" || !i.talkTarget) return keep;
  if (/新开|另开|新建|另一单|新任务|单独一单/.test(i.text)) return keep;

  const live = ["open", "claimed", "reported", "review"].includes(i.status);
  const arg = /^\s*#\s*\d+/.test(i.arg) ? i.arg : `${i.talkNo ? `#${i.talkNo} ` : ""}${i.arg}`;
  return { action: "amend", arg, reopenFirst: !live };
}

/** 重开已结束的原单；目标写编号，编号缺失时退回派单 id。 */
export interface ReopenDirective {
  action: "redo";
  arg: string;
  confirm: boolean;
  target: string;
  msg_id: string;
  via: "capitalist";
}

export function reopenDirective(i: { talkNo: string; talkTarget: string; msgId: string }): ReopenDirective {
  return {
    action: "redo",
    arg: i.talkNo ? `#${i.talkNo}` : i.talkTarget,
    confirm: true,
    target: i.talkTarget,
    msg_id: i.msgId,
    via: "capitalist",
  };
}
