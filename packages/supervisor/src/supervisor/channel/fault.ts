/**
 * 通道故障判定唯一入口。
 *
 * 额度耗尽、登录态失效、限流三类结论原先由五处在各自的作用域上跑同一份正则：进程
 * stderr 尾部、stdout 全文、模型正文、工作进程日志、登录检查原文。判定规则相同、作用域
 * 不同，业务文本混进任一作用域就会把正常回复判成上游拒绝。实测：对话层被要求“一到三句”，
 * 正文提到“额度耗尽”即被整段作废，模型真实回答被替换成错误文案。
 *
 * 收口后调用方只声明文本来源（{@link FaultScope}），取多少、能不能判、按什么顺序判由本
 * 模块决定。新增判定点只允许加一个作用域，不允许在调用方另写正则或另定阈值。
 */

/** 判定文本的来源。作用域决定取样范围与可用判据，见 {@link judgeFault}。 */
export type FaultScope =
  /** 进程诊断输出（stderr）：取尾部，错误通常出现在末尾。 */
  | "diag"
  /** 协议 stdout：只认带 errors / is_error 的协议行，业务文本不参与判定。 */
  | "stream"
  /** 模型正文：仅当整段就是上游拒绝说明时成立，见 {@link judgeFault}。 */
  | "reply"
  /** 工作进程日志：取尾部若干行。 */
  | "log";

/** 三类故障。空串表示未命中。 */
export type FaultKind = "quota" | "auth" | "rate" | "";

/** 额度耗尽的界面措辞。宿主以 code 0 退出并把 429 说明当正文输出时也归到这里。 */
export const QUOTA_EXHAUSTED_TEXT = "额度已耗尽";
/** 登录态失效的短措辞，用于失败结论文本。 */
export const AUTH_REQUIRED_TEXT = "登录状态无效";
/** 登录态失效的完整措辞，带处置，用于对话回复。 */
export const AUTH_HINT_TEXT = "登录状态无效，请重新登录或授权";
/** 限流的界面措辞。可自行恢复，不按故障处理。 */
export const RATE_BUSY_TEXT = "通道繁忙，稍后会自动重试";

/** 故障类型对应的界面文案；空类型返回空串。 */
export function faultText(kind: FaultKind): string {
  if (kind === "quota") return QUOTA_EXHAUSTED_TEXT;
  if (kind === "auth") return AUTH_HINT_TEXT;
  if (kind === "rate") return RATE_BUSY_TEXT;
  return "";
}

/** 判定结论文本是否为额度耗尽。只认常量，不做特征匹配。 */
export function isQuotaText(text: string): boolean {
  return String(text ?? "").includes(QUOTA_EXHAUSTED_TEXT);
}

/**
 * 额度耗尽特征。
 *
 * 要求词与状态后缀同时出现，或 402/429 带上协议上下文：日志是整段 JSON，裸数字 429
 * 会命中 token 计数与耗时，把正常退出误判成额度耗尽。中文同理，只认“额度已耗尽”这类短语。
 *
 * “使用量已超出频率限制”是宿主拒绝说明的固定措辞，本身不带“额度”二字，靠它单独列出；
 * 只按正文判断时缺这一条，真 429 说明会被当成模型回答。
 */
const QUOTA_HINT =
  /(quota|insufficient[_\s-]?(funds|balance|credit)|credits?[_\s-]?(exhausted|exceeded)|balance[_\s-]?(low|insufficient|exhausted)|payment[_\s-]?required|(额度|积分|余额|配额)[^\n。，,；;]{0,8}(用尽|用完|不足|耗尽|超出|不够)|欠费|使用量[^\n。，,；;]{0,10}(?:超出|超限|已达上限|超过上限)|(?:http|status|code|error|response)[^\n]{0,24}\b(?:402|429)\b|\b(?:402|429)\b[^\n]{0,24}(?:too many requests|rate[_\s-]?limit|quota|余额|额度))/i;

/**
 * 上游拒绝说明的协议特征。
 *
 * 正文作用域额外要求这一条：真 429 说明由宿主原样转述，带状态码或英文协议词；模型正常
 * 回答复述“额度耗尽”不带这些。缺了它，任何提到额度的问答都会被当成拒绝。
 */
const PROTOCOL_QUOTA_HINT =
  /\b(?:402|429)\b|insufficient[_\s-]?quota|quota[_\s-]?(?:exceeded|exhausted)|payment[_\s-]?required/i;

/** 认证失效特征，与额度特征分开匹配，两者处置不同。 */
const AUTH_HINT = /(\b401\b|\b403\b|unauthorized|invalid[_\s-]?api[_\s-]?key|authentication|认证失败|凭证(?:失效|过期|无效)|未登录)/i;

/** 限流特征：可自行恢复，不按故障处理。 */
const RATE_HINT = /(\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|限流|频繁)/i;

/**
 * 回复正文里的动作行标记。
 *
 * 带动作行的正文是模型在干活，不可能是上游拒绝说明。这一条挡住的正是“模型复述失败原因后
 * 顺手给出重派指令”的常见形态。
 */
const ACTION_LINE =
  /^[ \t]*(?:DO|ATT|PARENT|PARENT_REASON|AFTER|GROUP|INSERT|INSERT_MODE|REVOKE|TITLE)[ \t]*[:：]/im;

/** 正文作用域的长度上限：拒绝说明很短，正常回答通常更长。 */
const REPLY_MAX = 400;
/** 诊断作用域取尾部字数。 */
const DIAG_TAIL = 600;
/** 日志作用域取尾部行数。 */
const LOG_TAIL_LINES = 200;

function tailChars(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

function tailLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.length > n ? lines.slice(-n).join("\n") : s;
}

/** 只保留协议行的 errors / is_error 字段所在行；业务文本与历史正文不带这两个字段。 */
function protocolLines(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => line.includes('"errors"') || line.includes('"is_error":true'))
    .join("\n");
}

/**
 * 判定一段文本属于哪类通道故障。
 *
 * @param scope 文本来源，决定取样范围与判据强度：
 * - `diag` 取尾部 600 字，三类都判；
 * - `stream` 只取带 errors / is_error 的协议行，三类都判，没有这类行即不判；
 * - `reply` 额外要求长度不超过 400 字、不含动作行、带协议特征，且只判额度：正文提到额度
 *   字样不构成拒绝证据，只有整段像宿主转述的拒绝说明才算；
 * - `log` 取尾部 200 行，三类都判。
 * @returns 命中的故障类型；未命中返回空串。
 */
export function judgeFault(scope: FaultScope, text: string): FaultKind {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";
  const hay =
    scope === "diag"
      ? tailChars(raw, DIAG_TAIL)
      : scope === "log"
        ? tailLines(raw, LOG_TAIL_LINES)
        : scope === "stream"
          ? protocolLines(raw)
          : raw;
  if (!hay.trim()) return "";
  if (scope === "reply") {
    if (hay.length > REPLY_MAX) return "";
    if (ACTION_LINE.test(hay)) return "";
    if (!PROTOCOL_QUOTA_HINT.test(hay)) return "";
    return QUOTA_HINT.test(hay) ? "quota" : "";
  }
  if (QUOTA_HINT.test(hay)) return "quota";
  if (AUTH_HINT.test(hay)) return "auth";
  if (RATE_HINT.test(hay)) return "rate";
  return "";
}

/**
 * 从 `result` 行的 `errors_info` 取故障类型与原文。
 *
 * `status` / `category` 是上游给的分类，比正文措辞可靠；这是协议作用域，也是唯一允许
 * 直接下结论的地方。`category` 优先于 `status`：429 既可能是额度耗尽，也可能是限流，
 * 两者的处置不同（限流可自愈，不应写进额度状态）。原文只用于日志，不进入界面。
 */
export function judgeResultFault(o: unknown): { kind: FaultKind; detail: string } {
  const arr = (o as Record<string, unknown>)?.errors_info;
  if (!Array.isArray(arr)) return { kind: "", detail: "" };
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const status = Number(r.status);
    const cat = String(r.category ?? "").toLowerCase();
    const detail = String(r.details ?? r.message ?? "").trim();
    if (cat === "rate_limit") return { kind: "rate", detail };
    if (cat === "quota" || cat === "insufficient_quota") return { kind: "quota", detail };
    if (status === 402 || status === 429) return { kind: "quota", detail };
  }
  return { kind: "", detail: "" };
}
