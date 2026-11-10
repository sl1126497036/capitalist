/**
 * 本机文件系统边界。
 *
 * 红线判定发往目标的内容，本模块判定在本机触及的路径。两者独立运行，都要通过。
 *
 * 判定顺序即优先级：
 *   1. 敏感路径或敏感文件名   拒，不接受理由
 *   2. 删除任务根以外的内容   拒
 *   3. 在任务根或 allow_roots 内   放行
 *   4. 在边界外且理由仍在有效期内   放行，列入待复核
 *   5. 在边界外且无理由     先要求登记理由
 *
 * 敏感位置在理由之前判定：`~/.ssh` 与浏览器凭据不属于「给个理由就能碰」的范围。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Contract } from "./contract";
import { readJsonl } from "./json";
import { isInside, normalizeForCompare, supervisorDir } from "./paths";
import type { ActionKind, LocalDecision, LocalHit } from "./types";

/** 理由登记文件的绝对路径：`<root>/.capitalist/justify.jsonl`。 */
export function justifyPath(root: string): string {
  return join(supervisorDir(root), "justify.jsonl");
}

/**
 * 规范成小写正斜杠的绝对路径，供比较使用。
 *
 * 处理三种输入形态：Git Bash 的 `/d/work`、`~` 开头、相对路径（按任务根解析）。
 * Git Bash 形态必须还原成 `d:/work`，否则永远和契约里写的 `D:/...` 对不上，
 * 这是 Windows 上最容易出现的一类「判定该拦却没拦」。
 *
 * @param base 相对路径的解析基准，默认取当前工作目录。
 * @returns 归一后的路径；输入为空时返回空串。
 */
export function normLocal(p: string, base?: string | null): string {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";

  const drive = /^\/([A-Za-z])\//.exec(s);
  if (drive) s = `${drive[1]}:/${s.slice(3)}`;

  if (s.startsWith("~")) {
    s = `${homedir().replace(/\\/g, "/")}${s.slice(1)}`;
  } else if (!s.startsWith("/") && !/^[A-Za-z]:\//.test(s)) {
    s = resolve(base ?? process.cwd(), s).replace(/\\/g, "/");
  }
  return normalizeForCompare(s);
}

/**
 * 该路径（或它的上级，或它的下级）有没有仍在有效期内的理由登记。
 *
 * @param ttlDefault 登记未写 `ttl` 时用的默认有效期，单位秒。
 */
export function hasJustification(root: string, path: string, ttlDefault = 300): boolean {
  const now = Date.now() / 1000;
  const target = normLocal(path, root);
  if (!target) return false;

  for (const rec of readJsonl<Record<string, unknown>>(justifyPath(root))) {
    const ttl = Number(rec.ttl ?? ttlDefault) || ttlDefault;
    const at = Number(rec.at_ts ?? 0);
    if (!at || now - at > ttl) continue;

    const jp = normLocal(String(rec.path ?? ""), root);
    if (!jp) continue;
    // 双向包含：登记的目录覆盖其子项，精确匹配的文件也算
    if (target === jp || target.startsWith(`${jp}/`) || jp.startsWith(`${target}/`)) {
      return true;
    }
  }
  return false;
}

/** 本机边界判定结果。`hits` 给出拒绝或放行的具体依据。 */
export interface LocalCheckResult {
  decision: LocalDecision;
  hits: LocalHit[];
}

/**
 * 本机边界判定。行为与归档的 Python 实现 `local_check()` 逐条对齐。
 *
 * @param contract 提供 `local_guard` 配置；无该配置时直接放行。
 * @param root 任务根。为 null 时不存在「根内」这一免判区域，所有路径都按越界处理。
 * @param paths 待判定的路径列表。为空时直接放行。
 * @param action 动作类型，决定删除类判定是否生效。
 */
export function localCheck(
  contract: Contract,
  root: string | null,
  paths: string[],
  action: ActionKind = "read",
): LocalCheckResult {
  const cfg = contract.localGuard;
  if (!cfg || Object.keys(cfg).length === 0 || paths.length === 0) {
    return { decision: "allow", hits: [] };
  }

  const allowRoots = (cfg.allow_roots ?? []).map((x) => normLocal(x));
  const sensPaths = (cfg.sensitive_paths ?? []).map((x) => normLocal(x));
  const sensNames = (cfg.sensitive_names ?? []).map((x) => String(x).toLowerCase());
  const taskRoot = root ? normLocal(root) : "";

  for (const p of paths) {
    const np = normLocal(p, root);
    for (const sp of sensPaths) {
      if (sp && isInside(np, sp)) {
        return {
          decision: "deny",
          hits: [{ kind: "sensitive", path: p, why: `命中敏感路径 ${sp}` }],
        };
      }
    }
    const base = np.split("/").pop() ?? "";
    for (const sn of sensNames) {
      if (sn.startsWith("*.")) {
        if (base.endsWith(sn.slice(1))) {
          return {
            decision: "deny",
            hits: [{ kind: "sensitive", path: p, why: `敏感文件类型 ${sn}` }],
          };
        }
      } else if (base === sn) {
        return {
          decision: "deny",
          hits: [{ kind: "sensitive", path: p, why: `敏感文件名 ${sn}` }],
        };
      }
    }
  }

  if (action === "delete" && cfg.never_delete_outside_task_root !== false) {
    for (const p of paths) {
      const np = normLocal(p, root);
      if (!isInside(np, taskRoot)) {
        return {
          decision: "deny",
          hits: [{ kind: "delete", path: p, why: "不许删除任务根以外的本机内容" }],
        };
      }
    }
  }

  const outside: string[] = [];
  for (const p of paths) {
    const np = normLocal(p, root);
    if (isInside(np, taskRoot)) continue;
    if (allowRoots.some((r) => isInside(np, r))) continue;
    outside.push(p);
  }
  if (outside.length === 0) return { decision: "allow", hits: [] };

  const hits: LocalHit[] = [];
  for (const p of outside) {
    if (hasJustification(root ?? "", p)) {
      hits.push({
        kind: "outside_justified",
        path: p,
        why: "越界放行（已登记理由），待事后复查",
      });
    } else {
      const scope = (cfg.allow_roots ?? []).join(" / ") || "（未设）";
      return {
        decision: "justify",
        hits: [{ kind: "outside", path: p, why: `超出允许范围（${scope}）与任务根` }],
      };
    }
  }
  return { decision: "allow_outside", hits };
}

/**
 * 把本机判定按档位收紧。plan 档下写与删一律拒，读不受影响。
 *
 * @param decideFn 档位判定函数，签名同 `permission.decide`。
 */
export function tightenLocal(
  mode: string,
  decision: LocalDecision,
  kind: ActionKind,
  decideFn: (mode: string, requested: string, kind: ActionKind) => string,
): LocalDecision {
  if (decision === "deny") return "deny";
  const requested = decision === "justify" || decision === "allow_outside" ? "ask" : "allow";
  return decideFn(mode, requested, kind) === "deny" ? "deny" : decision;
}

/**
 * 动作粗判。必须与归档的 Python 实现 `detect_action()` 的正则逐字一致，
 * 该判定决定档位是否介入，两边不一致会导致同一个命令在两套实现下被不同对待。
 */
const DELETE_RX =
  /(?:^|[;&|]\s*)(?:rm\s|rmdir\s|del\s|erase\s|Remove-Item|rmtree|os\.remove|os\.unlink|unlink\s)/i;
const WRITE_RX =
  /(?:>{1,2}\s*\S|tee\s|touch\s|mkdir\s|cp\s|mv\s|write_text|\.write\(|Set-Content|Out-File)/i;

/**
 * 从命令文本粗判动作类型。
 *
 * @returns `delete`、`write` 或 `read`。
 */
export function detectAction(text: string): ActionKind {
  const s = String(text ?? "");
  if (DELETE_RX.test(s)) return "delete";
  if (WRITE_RX.test(s)) return "write";
  return "read";
}

/**
 * 删除命令的参数段（截到下一个命令分隔符）。
 */
const DEL_ARG_RX =
  /(?:^|[;&|]\s*)(?:rm|rmdir|del|erase|Remove-Item|unlink)\s+([^;&|<>]*)/gi;

const DEL_API_RX = /(?:shutil\.rmtree|os\.remove|os\.unlink)\s*\(\s*([^)]*)/gi;

/** 目标里出现这些字符就无法确认具体路径：通配符、变量、大括号展开、家目录简写。 */
const DEL_UNSAFE_RX = /[*?[\]$%{}~]/;

/**
 * 去掉参数外层的引号与括号。
 *
 * `shutil.rmtree('/home')` 里目标被括号和引号一起包着；只剥引号会剩下 `('/home')`，
 * 归一后变成一个不存在的怪路径。只在首字符确实是包裹符号时才剥尾部，否则
 * `a)b` 这种真实路径会被截短，而「截短」的方向恰好是「看起来在任务根内」，那是漏判。
 */
function cleanToken(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^[("']/.test(t)) return t.replace(/^[("']+/, "").replace(/[)"']+$/, "");
  return t.replace(/^["']|["']$/g, "");
}

/**
 * 抽出删除目标。
 *
 * 三种结果语义不同，不能合并：
 *   `rm -rf a/b c/d` → 目标明确，逐个判在不在任务根内
 *   `rm -rf *`       → 目标不确定，直接拒（说不清删哪，就是不知道自己在删什么）
 *   `rm -rf`         → 没给目标，同样拒（等价于删了再说）
 *
 * @returns 目标路径列表与是否含无法确认的目标。`unsafe` 为 true 时目标列表不可用。
 */
export function extractDeleteArgs(text: string): { targets: string[]; unsafe: boolean } {
  const targets: string[] = [];
  let unsafe = false;
  const src = String(text ?? "");

  const consume = (args: string): void => {
    for (const tokRaw of args.split(/\s+/)) {
      const t = cleanToken(tokRaw);
      if (!t || t.startsWith("-")) continue; // 命令行开关
      if (/^\/[A-Za-z]{1,2}$/.test(t)) continue; // Windows 风格开关 /s /q /f
      if (DEL_UNSAFE_RX.test(t)) {
        unsafe = true;
        continue;
      }
      targets.push(t);
    }
  };

  DEL_ARG_RX.lastIndex = 0;
  for (let m = DEL_ARG_RX.exec(src); m; m = DEL_ARG_RX.exec(src)) consume(m[1] ?? "");

  DEL_API_RX.lastIndex = 0;
  for (let m = DEL_API_RX.exec(src); m; m = DEL_API_RX.exec(src)) consume(m[1] ?? "");

  return { targets, unsafe };
}

/**
 * 删除动作判定：目标必须能确认在任务根内。
 *
 * 与红线层的分工：红线只看「是不是删除命令」，本函数看「删的是哪」。
 * 因此删除类红线在契约里都标了 `defer`，由本函数给出最终结论。
 *
 * @param root 任务根。为 null 时所有目标都判为根外，删除一律拒。
 * @param text 命令原文；目标含通配符 / 变量或未给目标时同样拒。
 */
export function localDeleteCheck(
  contract: Contract,
  root: string | null,
  text: string,
): LocalCheckResult {
  const cfg = contract.localGuard;
  if (!cfg || cfg.never_delete_outside_task_root === false) {
    return { decision: "allow", hits: [] };
  }

  const { targets, unsafe } = extractDeleteArgs(text);
  const taskRoot = root ? normLocal(root) : "";

  if (unsafe) {
    return {
      decision: "deny",
      hits: [
        {
          kind: "delete",
          path: "（通配符 / 变量）",
          why: "删除目标不是具体路径，无法确认不会删到任务根以外",
        },
      ],
    };
  }
  if (targets.length === 0) {
    return {
      decision: "deny",
      hits: [{ kind: "delete", path: "（未指定目标）", why: "删除命令没给出可核对的目标路径" }],
    };
  }

  const out: LocalHit[] = [];
  for (const t of targets) {
    if (!isInside(normLocal(t, root), taskRoot)) {
      out.push({ kind: "delete", path: t, why: "不许删除任务根以外的本机内容" });
    }
  }
  return out.length > 0 ? { decision: "deny", hits: out } : { decision: "allow", hits: [] };
}

/** URL 先整段剥掉：远端路径不是本机路径。与归档的 Python 实现 `_URL_RX` 同源。 */
const URL_RX = /[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s'";|&)]+/g;

/** 引号里以 `~` / `/` / 盘符开头的串整体取出。 */
const QUOTED_RX = /(['"])((?:~|\/|[A-Za-z]:[\\/])[^'"]*)\1/g;

/**
 * 裸路径。前置字符集与归档的 Python 实现 `_PATH_RX` 逐字一致，两边不一致会让同一条命令
 * 抽出不同的路径集合，`local_check` 随之给出不同结论。
 */
const PATH_RX =
  /(?:^|[\s'"=:(\[,])(~[\\/][^\s'";|&)]*|[A-Za-z]:[\\/][^\s'";|&)]*|\/[^\s'";|&)]+)/g;

/**
 * 内核伪文件系统与设备节点。`/dev/null` 一类的写入重定向在命令行里极常见，它不是任务数据，
 * 也不存在「先登记理由」的余地：这类路径永远在任务根之外，按越界处理会让正常命令全部停在
 * 判定环节。
 */
const PSEUDO_PATH_RX = /^\/(?:dev|proc|sys)(?:\/|$)/i;

/**
 * 双斜杠开头且只有一段的写法是命令行开关（`tasklist //FI`），不是 UNC 路径。
 * UNC 形如 `//server/share`，至少三段。
 */
const SWITCH_LIKE_RX = /^\/\/[^/]+$/;

/** 从命令文本里抽出本机路径，供边界判定。 */
export function extractLocalPaths(text: string, root: string | null): string[] {
  const s = String(text ?? "").replace(URL_RX, " ");
  const cands: string[] = [];

  QUOTED_RX.lastIndex = 0;
  for (let m = QUOTED_RX.exec(s); m; m = QUOTED_RX.exec(s)) {
    const v = String(m[2] ?? "").trim();
    if (v.length >= 2) cands.push(v);
  }

  const rest = s.replace(QUOTED_RX, " ");
  PATH_RX.lastIndex = 0;
  for (let m = PATH_RX.exec(rest); m; m = PATH_RX.exec(rest)) {
    const p = String(m[1] ?? "").replace(/[.,)\]}]+$/, "");
    // 右邻是管道或正则元字符时，这串属于表达式而不是路径：正则里的分支 `/12153|Offline/`
    // 会被 PATH_RX 截出 `/12153`，它不可能是真实路径，抽进来只会误拦整条命令。
    // 真实路径的右邻是空白、引号、行尾或标点，不会是这些运算符。
    const after = rest[m.index + m[0].length] ?? "";
    if (/[|&^$*?]/.test(after)) continue;
    if (p.length >= 2 && p !== "//" && p !== "/") cands.push(p);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of cands) {
    if (/[\^$*?[\]{}()|<>`]/.test(p)) continue;
    if (PSEUDO_PATH_RX.test(p)) continue;
    if (SWITCH_LIKE_RX.test(p)) continue;
    const n = normLocal(p, root);
    if (!n || seen.has(n)) continue;
     /* 以 `/` 开头且自身与父目录均不存在时按非本机路径丢弃（URL 片段、正则字面量）；删除动作另由 `localDeleteCheck` 判定。 */
    if (p.startsWith("/") && !existsSync(n) && !existsSync(parentDirOf(n))) continue;
    seen.add(n);
    out.push(p);
  }
  return out;
}

/**
 * 父目录。盘符根（`d:`）补成 `d:/`，否则 `existsSync` 恒为假。
 */
function parentDirOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return p;
  const head = p.slice(0, i);
  if (/^[a-z]:$/i.test(head)) return `${head}/`;
  return head || "/";
}
