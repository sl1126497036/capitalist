/**
 * 将正文中的进程号 / 单号 / 技能路径切为引用片段。本模块只切分，编号由调用方从 lib/shortId.js 取；
 * 未匹配到映射的 id 保留为文字。
 */

/**
 * 编号形态为 `D-` 单号与 `W-` 进程号（大小写不敏感）。
 * 前后须为非单词字符，避免从更长的含连字符串里切出片段。
 */
const REF_RE = /(?<![A-Za-z0-9_-])([DW]-[A-Za-z0-9]{4,})(?![A-Za-z0-9_-])/g;

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
    const raw = m[1] || "";
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (raw) out.push({ type: "ref", raw });
    last = m.index + raw.length;
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
