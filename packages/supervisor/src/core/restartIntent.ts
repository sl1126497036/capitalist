/** 「这张派单要做的事就是重启监工」的判据。 */

/** 首段的判定范围。再往后的内容当背景说明处理，不参与判断。 */
const HEAD_CHARS = 160;

/** 三种「要求重启」的句式。 */
const RESTART_FORMS: RegExp[] = [
  /* 动宾：重启监工 / 重启 supervisor / 重启一下监工 */
  /重启\s*(?:一下\s*)?(?:监工|supervisor)/gi,
  /* 主谓：监工需要重启（必须带情态词，否则是定语） */
  /(?:监工|supervisor)\s*(?:进程)?\s*(?:需要|必须|务必|应该|应|要|得|需)\s*重启/gi,
  /* 英文 */
  /restart(?:ing)?\s+(?:the\s+)?supervisor/gi,
];

/** 命中位置之前的否定词。 */
const NEGATION_BEFORE = /(?:无需|不需要|不用|不必|不要|不该|不能|禁止|勿|别|没有|没|不)\s*$/;

/** 命中位置之前必须是指令环境：句首、标点/空白之后，或者情态/祈使词之后。 */
const IMPERATIVE_BEFORE =
  /(?:^|[，,。；;！!？?、：:\s（(]|请|需要|必须|务必|应该|应|要|得|需|立即|马上|立刻|然后|接着|再)$/;

/** 命中位置之后是名词时按定语处理：重启监工的按钮／重启监工蒙版文案… */
const NOUN_AFTER = /^\s*(?:的|按钮|文案|蒙版|提示|图标|遮罩|流程|逻辑|机制|事件|记录|状态|入口)/;

/** 这一单是不是「要求重启监工」的动作单。 */
export function isRestartSupervisorDispatch(action: string): boolean {
  const head = String(action ?? "").split(/\r?\n/)[0] ?? "";
  const text = head.slice(0, HEAD_CHARS).trim();
  if (!text) return false;
  for (const re of RESTART_FORMS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + m[0].length);
      if (!NEGATION_BEFORE.test(before) && IMPERATIVE_BEFORE.test(before) && !NOUN_AFTER.test(after)) return true;
      m = re.exec(text);
    }
  }
  return false;
}
