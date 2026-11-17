/**
 * 技能清单接口。
 *
 * 看板的技能下拉从这里取数据。扫描逻辑与工作进程注入提示词用的是同一份
 * （`supervisor/skills`），避免“看板能选的”与“工作进程能加载的”出现两份口径。
 *
 * 只返回名称与一行说明，正文按需由工作进程读取，不在此接口下发。
 */

import type { BoardCtx } from "../types";
import { listSkills } from "../../skills";

/** /api/skills */
export function handleSkills(ctx: BoardCtx): void {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
    ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: "只支持 GET" }));
    return;
  }
  const skills = listSkills(ctx.opts.root).map((s) => ({ name: s.name, desc: s.desc, path: s.path }));
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ count: skills.length, skills }));
}
