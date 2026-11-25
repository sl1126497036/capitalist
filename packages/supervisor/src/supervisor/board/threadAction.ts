/**
 * 要求的归属解析：这条动作应当新建一张单，还是折算成对某张单的追加。
 *
 * 判据只有两条同时成立才折算：请求带线程键（明确指向某张单），且用户明确表示是补充或更正。
 * 其余情形一律按新建处理：漏判成追加会把新要求并入一张旧单，父节点、分组与验收判据随之丢失；
 * 并在旧单已结束时把它重新拉起。反过来把补充判成新建，代价是多一张单，可由用户关闭。
 *
 * 线程内发言的目标单只有当前单：调用方写入指令时 `target` 直接取当前线程单，
 * 不从正文里的编号推断；正文若指向别的单，执行侧 `loop.ts` 的 amend 分支会拒绝。
 */

export interface ThreadActionInput {
  /** 用户这一轮的原话，用于识别“补充”与“另开一单”。 */
  text: string;
  /** 这条线程对应的派单 id；为空表示不是线程内的对话（监工全局对话）。 */
  talkTarget: string;
  /** 该单的任务编号（界面上的 #N）。 */
  talkNo: string;
  action: string;
  arg: string;
  /** 该单当前状态。 */
  status: string;
  /**
   * 动作是否带树字段（`PARENT` / `GROUP` / `ACCEPTANCE` / `AFTER` / `SUPERSEDE` / `INSERT`）。
   *
   * 这些字段只在新节点上有意义，折算成追加会被执行侧丢掉。带树字段即按新建处理，
   * 不因“补充”措辞折成追加。
   */
  structural?: boolean;
}

export interface ThreadActionResult {
  action: string;
  arg: string;
}

/**
 * 明确表示另起一张单的说法。命中即新建，不折算追加。
 *
 * 「追加派单」「补一张」这类字面带“追加 / 补”的说法同样表示新建，放在这里优先于补充词判定：
 * 只看“追加”“补”两个字会把它们误判成对当前单的补充。
 */
const NEW_TASK_WORDS = [
  "新开",
  "另开",
  "新建",
  "新派",
  "另派",
  "再派",
  "再开",
  "再建",
  "另一单",
  "另一个单",
  "另一张单",
  "新任务",
  "另一个任务",
  "新的任务",
  "新的单",
  "单独一单",
  "单独开",
  "独立一单",
  "追加派单",
  "追加一单",
  "追加一张",
  "追加一个",
  "追加任务",
  "补一张",
  "补一单",
  "补一个",
  "补充一张",
  "补充一单",
  "加一单",
  "加一张",
  "开一单",
  "开一张",
  "开个单",
  "再来一单",
];

/**
 * 明确表示补充或更正的说法。只有线程内命中这些词才折算成追加。
 *
 * 不写单独一个“追加”“补”“加”：这些字眼在「追加派单」「补一张」里表示新建，
 * 单独出现时也判不出归属，按新建处理。
 */
const SUPPLEMENT_WORDS = [
  "补充",
  "补一句",
  "补一条",
  "补上",
  "再补",
  "追补",
  "追加要求",
  "追加一句",
  "追加说明",
  "追加内容",
  "追加条件",
  "追加一条",
  "更正",
  "改正",
  "改口",
  "修正",
  "改成",
  "改为",
  "细化",
  "收紧",
  "说清楚",
  "漏了",
  "忘了说",
  "还有一点",
  "再说明",
  "应该是",
  "不对",
];

function hasAny(text: string, words: readonly string[]): boolean {
  const s = String(text ?? "");
  return words.some((w) => s.includes(w));
}

/** 用户原话是否点名了某张单（`#12`）；点名才算“明确指向某张单”。 */
function citesTaskNo(text: string): boolean {
  return /#\s*\d{1,4}\b/.test(String(text ?? ""));
}

/** 去掉模型写在正文开头的寻址编号：编号是地址，不是要求本身。 */
function stripAddress(arg: string): string {
  return String(arg ?? "").replace(/^\s*#\s*\d{1,4}\s*/, "");
}

/**
 * 解析一条动作的归属。
 *
 * - 全局对话（无线程键）：`dispatch` 原样新建；`amend` 没有线程归属，按新建处理，
 *   避免对已完成单产生“重开 + 追加”两条动作。
 * - 线程内：只有用户明确表示补充或更正、且不带树字段时，`dispatch` 才折算成 `amend`；
 *   说要另开 / 新派 / 补一张等一律新建，判不出来也按新建。
 *
 * 折算时不再单独下发 `redo`：执行侧的 amend 分支对已结束的目标单自行开新单，
 * 一条要求只产生一条动作。
 */
export function resolveThreadAction(i: ThreadActionInput): ThreadActionResult {
  const action = String(i.action ?? "");
  const keep = { action: i.action, arg: i.arg };
  const inThread = Boolean(String(i.talkTarget ?? "").trim());

  if (action === "dispatch") {
    if (!inThread) return keep;
    if (hasAny(i.text, NEW_TASK_WORDS)) return keep;
    if (i.structural) return keep;
    if (!hasAny(i.text, SUPPLEMENT_WORDS)) return keep;

    const arg = /^\s*#\s*\d+/.test(i.arg) ? i.arg : `${i.talkNo ? `#${i.talkNo} ` : ""}${i.arg}`;
    return { action: "amend", arg };
  }

  /*
   * 全局对话里模型写了 amend：没有线程键、用户也没点名某张单，就不是对现有单的补充。
   * 按新建执行，并去掉模型自带的寻址编号，避免新单正文里留下指向旧单的编号。
   */
  if (action === "amend" && !inThread && !(citesTaskNo(i.text) && hasAny(i.text, SUPPLEMENT_WORDS))) {
    const arg = stripAddress(i.arg);
    if (arg) return { action: "dispatch", arg };
  }
  return keep;
}
