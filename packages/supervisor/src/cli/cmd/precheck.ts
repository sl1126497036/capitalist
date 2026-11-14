/**
 * 预检类命令：红线预检（gate）、本机边界预检（local-check）、越界理由登记（justify）。
 *
 * 三者都在动作发生之前回答同一个问题：这条命令能不能执行、碰这个路径要不要先说明理由。
 * 放在一起是因为它们共用判定层（core/localGuard、core/contract），且都不改任务阶段。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluate, loadContract } from "../../core/contract/contract";
import { appendJsonl } from "../../core/record/json";
import {
  detectAction,
  extractLocalPaths,
  localCheck,
  localDeleteCheck,
  tightenLocal,
} from "../../core/guard/localGuard";
import { findRoot, supervisorDir } from "../../core/record/paths";
import { decide } from "../../core/guard/permission";
import { resolveModeFor } from "../../core/record/state";
import { skillDirs } from "../../agent/locations";
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
  const spec = flagString(p, "contract") ?? "generic";
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
      write("\n只删任务根以内的东西；要动根外的，先问用户。\n");
      return 3;
    }
  }

  const act = detectAction(text);
  const local = root ? localCheck(contract, root, extractLocalPaths(text, root), act) : null;
  const localDecision = local ? tightenLocal(mode, local.decision, act, decide) : null;

  if (flagBool(p, "json")) {
    write(`${JSON.stringify({ decision: gate.decision, mode, local: localDecision, hits: gate.hits }, null, 2)}\n`);
  } else {
    write(
      `红线预检：${gate.decision}${localDecision && localDecision !== "allow" ? ` ｜ 本机边界：${localDecision}` : ""}\n`,
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
  const res = localCheck(contract, root, [one], action);
  const decided = tightenLocal(mode, res.decision, action, decide);

  if (flagBool(p, "json")) {
    write(`${JSON.stringify({ decision: decided, mode, rule_decision: res.decision, hits: res.hits }, null, 2)}\n`);
  } else {
    for (const h of res.hits) write(`${h.path}：${h.why}\n`);
    if (decided !== res.decision) write(`（档位 ${mode} 将原判 ${res.decision} 收紧为 ${decided}）\n`);
  }
  return decided === "deny" || decided === "justify" ? 2 : 0;
}

/** 登记越界理由。 */
export function cmdJustify(p: Parsed): number {
  const [path, reason] = p.positional;
  if (!path || !reason) die('用法：capitalist justify "<路径>" "<为什么必须碰它>"');
  const root = rootOrDie(p);
  const ttl = Number(flagString(p, "ttl") ?? 300) || 300;
  appendJsonl(join(supervisorDir(root), "justify.jsonl"), {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    path,
    reason,
    ttl,
    session: process.env.CAPITALIST_SESSION_ID ?? "",
  });
  write(
    `已登记理由：${path}\n` +
      `  有效期：${ttl} 秒，对登记路径及其子项生效。\n` +
      "  重试原命令即放行；放行时记入待复核队列（capitalist review 查看）。\n",
  );
  return 0;
}
