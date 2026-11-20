/**
 * 将正文中的进程号 / 单号 / 消息编号 / 技能路径切为引用片段。本模块只切分，编号由调用方从 lib/no.js 取；
 * 未匹配到映射的 id 保留为文字。
 */

/**
 * 编号形态：
 *   - 派单号 `2-2`（数字-数字）
 *   - 进程号 `2-P1`（数字-P数字）
 *   - 消息编号 `2-U2W-<毫秒>`、`2-U2S-<毫秒>`、`2-W-<毫秒>`、`2-S-<毫秒>`、`S0-U2S-<毫秒>`、
 *     `S0-S-<毫秒>`、`S0-SP-<毫秒>`。`S0` 前缀下用户消息、监工回复、派单类消息都可能出现，
 *     方向段要全部认。
 *     同一毫秒内连发时编号尾带自增序（`S0-U2S-<毫秒>-1`），该后缀属编号本体，必须一起切出来；
 *     漏掉后缀会得到一条查不到的编号，引用只能退回摘要。
 * 前后须为非单词字符，避免从更长的含连字符串里切出片段。
 *
 * 编号前允许带 `#`：服务端回执正文（`maskDispatchIds`）已把编号补成 `#2-2`，这里把 `#` 一并
 * 纳入引用片段，避免 `#` 被孤立成一段文字、编号又被二次映射，出现「# #02」这种重复。带 `#` 的
 * 片段由调用方原样显示，不带 `#` 的仍按映射补 `#`。
 */
const REF_RE = /(?<![A-Za-z0-9_#-])(#?)(S0-(?:U2W|U2S|S|SP)-\d+(?:-\d+)?|\d+-(?:P\d+|U2W|U2S|W|S|SP)-\d+(?:-\d+)?|\d+-\d+)(?![A-Za-z0-9_-])/g;

/**
 * 技能路径：以 `SKILL.md` 结尾的绝对路径（Windows 盘符或 POSIX 根、家目录均可），
 * 或派单里的占位写法 `<目录>/<名称>/SKILL.md`。整段替换为名称色块，路径放 title。
 */
const SKILL_PATH = String.raw`[^\s，。；、）]*?[\\/]skills[\\/][^\s，。；、）\\/]+[\\/]SKILL\.md`;
const SKILL_RE = new RegExp(
  String.raw`(?:<目录>[\\/]<名称>[\\/]SKILL\.md)|(?:(?:[A-Za-z]:|~)?[\\/]${SKILL_PATH})`,
  "g",
);

/** 从技能路径取名称；取不到时返回空串。 */
function skillNameOf(raw) {
  const m = /[\\/]([^\\/]+)[\\/]SKILL\.md$/.exec(raw);
  if (m && m[1] && m[1] !== "<名称>") return m[1];
  return "";
}

/** 把一段纯文字按单号 / 进程号切分后追加到 out。 */
function pushRefs(out, text) {
  if (!text) return;
  let last = 0;
  REF_RE.lastIndex = 0;
  let m = REF_RE.exec(text);
  while (m) {
    /* m[1] 是可选的 `#` 前缀，m[2] 是编号主体；`#` 并入 raw，避免被孤立。 */
    const hash = m[1] || "";
    const raw = m[2] || "";
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (raw) out.push({ type: "ref", raw: hash + raw });
    last = m.index + hash.length + raw.length;
    m = REF_RE.exec(text);
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
}

export function splitMessageRefs(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  let last = 0;
  SKILL_RE.lastIndex = 0;
  let m = SKILL_RE.exec(s);
  while (m) {
    pushRefs(out, s.slice(last, m.index));
    out.push({ type: "skill", raw: m[0], name: skillNameOf(m[0]) });
    last = m.index + m[0].length;
    m = SKILL_RE.exec(s);
  }
  pushRefs(out, s.slice(last));
  return out;
}
