/**
 * 预检类命令：红线预检（gate）、本机边界预检（local-check）、越界理由登记（justify）。
 *
 * 三者都在动作发生之前回答同一个问题：这条命令能否执行、访问该路径是否需要先说明理由。
 * 放在一起是因为它们共用判定层（core/localGuard、core/contract），且都不改任务阶段。
 */

import { readFileSync } from "node:fs";

import { evaluate, loadContract } from "../../core/contract/contract";
import {
  detectAction,
  extractLocalPaths,
  localCheck,
  localDeleteCheck,
  normLocal,
  tightenLocal,
} from "../../core/guard/localGuard";
import { appendReason, openGuardRequests } from "../../core/guard/requests";
import { findRoot } from "../../core/record/paths";
import { decide } from "../../core/guard/permission";
import { resolveModeFor } from "../../core/record/state";
import { skillDirs } from "../../agent/locations";
import { skillAllowRoots } from "../../supervisor/skills";
import { flagBool, flagString, type Parsed } from "../args";
import { loadOrDie, rootOrDie } from "./context";
import { die, write } from "../output";

/**
 * 红线预检。
 *
 * 返回码：0 放行 / 2 需授权 / 3 禁止。只判定，不执行，也不落记录。
 */
export function cmdGate(p: Parsed): number {
  const inline = flagString(p, "text") ?? "";
  const reqFile = flagString(p, "req") ?? "";
  const text = inline || (reqFile ? readFileSync(reqFile, "utf8") : "");
  if (!text) die("用法：capitalist gate --text <命令> 或 --req <请求文件>");
  const root = findRoot(flagString(p, "root"));
  const spec = flagString(p, "contract") ?? "minimal";
  const contract = root ? loadOrDie(root).contract : loadContract(spec, skillDirs());
  if (!contract) die(`找不到任务列表：${spec}`);

  const mode = root ? resolveModeFor(root, contract) : "default";
  const gate = evaluate(contract, text);
  gate.rule_decision = gate.decision;
  gate.mode = mode;
  gate.tightened = false;

  // 删除类红线带 defer：它们只标识“这是一次删除”，判定归更具体的路径检查，
  // 路径检查先跑。
  if (gate.hits.some((h) => h.defer === "local_delete")) {
    const del = localDeleteCheck(contract, root, text);
    if (del.decision === "deny") {
      if (flagBool(p, "json")) {
        write(`${JSON.stringify({ decision: "BLOCK", reason: "local_delete", mode, hits: del.hits }, null, 2)}\n`);
        return 3;
      }
      write("本机边界拦截：删除范围限于任务根以内。\n");
      for (const h of del.hits) write(`  ${h.path}\n    ${h.why}\n`);
      write("\n只删除任务根以内路径；要改根外路径，先征得用户同意。\n");
      return 3;
    }
  }

  const act = detectAction(text);
  /* 与 hook 同一口径：技能目录内的读取不算越界，预检不能比实际拦截更严。 */
  const extra = root ? skillExtraOf(root) : {};
  const local = root ? localCheck(contract, root, extractLocalPaths(text, root), act, extra) : null;
  const localDecision = local ? tightenLocal(mode, local.decision, act, decide) : null;

  if (flagBool(p, "json")) {
    write(`${JSON.stringify({ decision: gate.decision, mode, local: localDecision, hits: gate.hits }, null, 2)}\n`);
  } else {
    write(
      `红线预检：${gate.decision}${localDecision && localDecision !== "allow" ? ` | 本机边界：${localDecision}` : ""}\n`,
    );
    for (const h of gate.hits) write(`  [${h.level}] ${h.id} ${h.label}\n         命中：…${h.snippet}…\n`);
  }

  if (localDecision === "deny") return 3;
  if (localDecision === "justify") return 2;
  if (gate.decision === "BLOCK") return 3;
  if (gate.decision === "NEED_USER") return 2;
  return 0;
}

/**
 * 只读白名单的技能根，口径与 hook 侧（agent/dispatch）一致。
 */
function skillExtraOf(root: string): { skillRoots: string[]; skillCacheRoots: string[] } {
  const r = skillAllowRoots(root);
  return { skillRoots: r.skills, skillCacheRoots: r.cache };
}

/**
 * 本机边界预检。
 *
 * 只判一条路径，不执行。返回码：0 放行 / 2 需说明理由或被拒。
 */
export function cmdLocalCheck(p: Parsed): number {
  const root = rootOrDie(p);
  const { contract } = loadOrDie(root);
  const one = flagString(p, "path") ?? "";
  if (!one) die("用法：capitalist local-check --path <路径> [--action read|write|delete]");

  const action = (flagString(p, "action") ?? "read") as "read" | "write" | "delete";
  const mode = resolveModeFor(root, contract);
  const res = localCheck(contract, root, [one], action, skillExtraOf(root));
  const decided = tightenLocal(mode, res.decision, action, decide);

  if (flagBool(p, "json")) {
    write(`${JSON.stringify({ decision: decided, mode, rule_decision: res.decision, hits: res.hits }, null, 2)}\n`);
  } else {
    for (const h of res.hits) write(`${h.path}：${h.why}\n`);
    if (decided !== res.decision) write(`（档位 ${mode} 将原判 ${res.decision} 收紧为 ${decided}）\n`);
  }
  return decided === "deny" || decided === "justify" ? 2 : 0;
}

/** 疑似凭据内容：私钥头、常见令牌前缀、长串无分隔的随机字符。 */
const SECRET_RX =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk|ghp|gho|github_pat|xox[bap])[-_][A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|[A-Za-z0-9+/=]{32,})/;

/** 理由里不该出现凭据内容：理由会进台账，也会被监工读取。 */
function looksLikeSecret(text: string): boolean {
  return SECRET_RX.test(text);
}

/** 逗号、顿号、换行分隔的多个路径。路径内部的空格不切分。 */
function splitPaths(raw: string): string[] {
  return raw
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 提交越界或删除申请的理由。
 *
 * 理由与路径写进申请台账，由监工裁决。本命令不产生批准记录：批准由监工或用户给出，
 * 且只对一次动作有效。
 */
export function cmdJustify(p: Parsed): number {
  const [pathArg, reason] = p.positional;
  if (!pathArg || !reason) {
    die('用法：capitalist justify "<路径>[,<路径>]" "<为什么必须做这次操作>" [--id <编号>]');
  }
  const root = rootOrDie(p);

  if (looksLikeSecret(reason) || looksLikeSecret(pathArg)) {
    die(
      "理由里疑似包含凭据内容，已拒绝提交。\n" +
        "只写用途与影响，例如“读取构建配置以确认端口”。不要粘贴密钥、令牌或密码。",
    );
  }

  const paths = splitPaths(pathArg);
  const open = openGuardRequests(root);
  const wanted = String(flagString(p, "id") ?? "").trim();
  const hit = wanted
    ? open.find((r) => r.id === wanted)
    : open.find((r) => {
        const have = new Set(r.paths.map((x) => normLocal(x)));
        return paths.every((x) => have.has(normLocal(x)));
      });

  if (!hit) {
    const list = open
      .slice(-5)
      .map((r) => `  ${r.id}  ${r.kind === "delete" ? "删除" : "越界"}  ${r.paths.join("、")}`)
      .join("\n");
    die(
      "没有匹配的待裁决申请。\n" +
        "先执行原动作，被拦截后按回执里的编号提交：capitalist justify \"<路径>\" \"<理由>\" --id <编号>\n" +
        (list ? `当前待裁决：\n${list}` : "当前没有待裁决申请。"),
    );
  }

  /* 合并提交：补充的路径并入同一条申请，监工一次看全。 */
  const merged = [...new Set([...hit.paths, ...paths])];
  appendReason(root, hit.id, reason, merged);
  write(
    `已提交申请 ${hit.id}：${merged.join("、")}\n` +
      "等待监工裁决。批准后按原命令重试一次；未批准时不要反复重试。\n",
  );
  return 0;
}
