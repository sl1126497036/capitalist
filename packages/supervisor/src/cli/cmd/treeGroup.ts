/**
 * `capitalist tree group` 子命令：组的查看与结构变更。
 *
 * 放在 `tree` 下的理由：组是树结构的一部分，语义与 `tree list` / `tree rebuild` 一致；
 * 顶层新增 `case` 会继续推高 `main.ts` 的规模（结构守卫有硬上限）。
 *
 * 所有改结构的动作都调 `core/dispatch/treeOps`，本文件只做参数解析与打印。
 * 校验规则（成员父一致、成环、组是否解散）不在这里重写一遍。
 */

import { readDispatches } from "../../core/record/supervisor";
import { groupNoLabel, normalizeGroupId } from "../../core/record/idMap";
import { parseRef } from "../../core/record/nodeRef";
import { groupIndexOf, issueGroupNo, readGroups } from "../../core/record/groups";
import { groupIndexFrom } from "../../core/dispatch/groupOps";
import { groupStatusOf, groupStateWord, groupSettled } from "../../core/dispatch/groupGraph";
import { assignGroup, closeGroup, reassignParent } from "../../core/dispatch/treeOps";
import { dispatchOfRef } from "../../supervisor/usage/threadNo";
import { clipLine } from "../../core/text";
import { flagString, type Parsed } from "../args";

/**
 * 把命令行里的引用解析成派单 id。
 *
 * 编号换算统一走 `dispatchOfRef`（与看板按号操作、调度挂依赖同一入口）：任务号取
 * 派单序最大的那一单，旧格式单回查历史编号表。此前这里另按“编号表值 + 字符串前缀”
 * 匹配，旧格式单的裸号是补零形态（`07`），`"07".startsWith("7-")` 为假，于是无法按号定位。
 *
 * 排结构要能指向已经结束的单，故不按状态过滤。
 */
export function resolveIds(
  root: string,
  toks: readonly string[],
): { ids: string[]; errors: string[] } {
  const rows = readDispatches(root);
  const ids: string[] = [];
  const errors: string[] = [];
  for (const tok of toks) {
    const r = parseRef(tok);
    /* 组号不是派单；历史 `D-` 号与线程键不是编号形态，这条命令只收编号与派单 id。 */
    if (r.kind === "group" || r.kind === "other") {
      errors.push(`“${tok}”不是派单编号：用 #任务号 或派单 id`);
      continue;
    }
    const hit = dispatchOfRef(root, tok, { rows, anyStatus: true });
    if (hit) {
      ids.push(String(hit.id));
      continue;
    }
    errors.push(r.kind === "task-no" ? `任务 ${tok} 没有对应的派单` : `派单 ${tok} 不在台账里`);
  }
  return { ids: [...new Set(ids)], errors };
}

function printGroups(root: string): number {
  const groups = readGroups(root);
  if (groups.length === 0) {
    process.stdout.write("暂无分组。将并行派单归入一组：capitalist tree group new <标题> #03 #04\n");
    return 0;
  }
  const rows = readDispatches(root);
  const idx = groupIndexOf(rows, groups);
  for (const g of groups) {
    const st = groupStatusOf(g.id, rows, idx);
    if (!st) continue;
    const head =
      `${groupNoLabel(g.id)} ${clipLine(g.title, 32)}  ` +
      `${st.done}/${st.total} 完成 | ${groupStateWord(st.state)}` +
      (st.brokenAt ? ` | 断链 ${st.brokenAt}` : "");
    process.stdout.write(`${head}\n`);
    const byId = new Map(rows.map((d) => [String(d.id), d] as const));
    for (const m of idx.members.get(g.id) ?? []) {
      const d = byId.get(m);
      const mark = d ? String(d.status ?? "") : "（已归档）";
      const mine = st.brokenAt === m ? "  ← 断链" : "";
      process.stdout.write(`  ${m}  ${mark}${mine}\n`);
    }
    const settled = groupSettled(g.id, rows, idx);
    if (!settled.settled && settled.pending.length > 0) {
      process.stdout.write(`  待完成：${settled.pending.join("、")}\n`);
    }
    /*
     * 卡在等待或断链时给出下一步。此前的输出只列待完成号，用户看不出该重派、该作废，
     * 还是该放弃整组；三条出口各自影响的范围不同，必须写清。
     */
    if (!settled.settled && (st.state === "waiting" || st.state === "blocked")) {
      const first = st.pending[0] ?? st.failed[0] ?? "";
      process.stdout.write(
        `  下一步：重派该成员用看板的重试按钮；放弃该成员 capitalist close ${first}；` +
          `放弃整组 capitalist tree group close ${groupNoLabel(g.id)}\n`,
      );
    }
  }
  return 0;
}

/** `capitalist tree group ...` 入口。返回进程退出码。 */
export function cmdTreeGroup(p: Parsed, root: string): number {
  const sub = p.positional[1] ?? "ls";
  const rest = p.positional.slice(2);

  if (sub === "ls" || sub === "list") return printGroups(root);

  if (sub === "new") {
    const title = rest[0] ?? "";
    if (!title) {
      process.stdout.write("用法：capitalist tree group new <组标题> <派单...>\n");
      return 2;
    }
    const { ids, errors } = resolveIds(root, rest.slice(1));
    if (errors.length > 0) {
      process.stdout.write(`未建组：${errors.join("；")}\n`);
      return 2;
    }
    if (ids.length < 2) {
      process.stdout.write("未建组：至少需要两条派单才能分组。单条派单直接挂父节点。\n");
      return 2;
    }
    /*
     * 先建组再挂成员：`assignGroup` 要校验组存在，空组是合法中间态。
     * 若成员挂载被拒（父节点不一致），组仍会建立但无成员。空组不参与任何判定，`group ls` 里如实显示 0/N。
     */
    const created = issueGroupNo(root, { title, created_by: "user" });
    if (!created.ok) {
      process.stdout.write(`未建组：${created.error}\n`);
      return 1;
    }
    const r = assignGroup(root, ids, created.group.id);
    if (!r.ok) {
      process.stdout.write(
        `组 ${groupNoLabel(created.group.id)} 已建立，但成员挂载失败：\n` +
          r.errors.map((e) => `  ${e.id}：${e.reason}`).join("\n") +
          "\n成员父节点需一致；先 tree group attach 统一父节点，再加成员。\n",
      );
      return 1;
    }
    process.stdout.write(`已建组 ${groupNoLabel(created.group.id)} ${title}：${r.changed.join("、")}\n`);
    return 0;
  }

  const gid = normalizeGroupId(rest[0] ?? "");
  if (!gid) {
    process.stdout.write(`用法：capitalist tree group ${sub} <#G组号> ...\n`);
    return 2;
  }

  if (sub === "add" || sub === "rm") {
    const { ids, errors } = resolveIds(root, rest.slice(1));
    if (errors.length > 0) {
      process.stdout.write(`未改动：${errors.join("；")}\n`);
      return 2;
    }
    /* 移出组用空组号：`assignGroup` 对空值即删除 `group` 字段。 */
    const r = assignGroup(root, ids, sub === "add" ? gid : "");
    if (!r.ok) {
      process.stdout.write(`未改动：\n${r.errors.map((e) => `  ${e.id}：${e.reason}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`${sub === "add" ? "已加入" : "已移出"} ${groupNoLabel(gid)}：${r.changed.join("、")}\n`);
    return 0;
  }

  if (sub === "attach") {
    const target = rest[1] ?? "";
    if (!target) {
      process.stdout.write("用法：capitalist tree group attach <#G组号> <父节点|none>\n");
      return 2;
    }
    const rows = readDispatches(root);
    const idx = groupIndexFrom(root, rows);
    const members = idx.members.get(gid) ?? [];
    if (members.length === 0) {
      process.stdout.write(`${groupNoLabel(gid)} 没有成员，无需改挂。\n`);
      return 2;
    }
    const reason = flagString(p, "reason") || "命令行统一改挂整组";
    const r = reassignParent(root, members, /^(none|无)$/i.test(target) ? "" : target, reason);
    if (!r.ok) {
      process.stdout.write(`未改动：\n${r.errors.map((e) => `  ${e.id}：${e.reason}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`已把 ${groupNoLabel(gid)} 的 ${r.changed.length} 名成员改挂到 ${target}\n`);
    return 0;
  }

  if (sub === "close") {
    const r = closeGroup(root, gid, "命令行解散");
    if (!r.ok) {
      process.stdout.write(`未改动：${r.errors.map((e) => e.reason).join("；")}\n`);
      return 1;
    }
    process.stdout.write(`已解散 ${groupNoLabel(gid)}：挂在组下的派单按已收尾放行。\n`);
    return 0;
  }

  process.stdout.write(
    "用法：capitalist tree group [ls]\n" +
      "      capitalist tree group new <组标题> <派单...>\n" +
      "      capitalist tree group add|rm <#G组号> <派单...>\n" +
      "      capitalist tree group attach <#G组号> <父节点|none>\n" +
      "      capitalist tree group close <#G组号>\n",
  );
  return 2;
}

/**
 * `capitalist tree move` / `tree detach`：单点或成批改挂父节点。
 *
 * 与 `tree group attach` 的区别是动的单位：`attach` 动整组（改组的位置），
 * `move` / `detach` 动指定的单。设计里写明“已有树想改结构用 tree move”，
 * 所以这条命令是用户入口，不仅提供 LLM 的 INSERT 路径。
 *
 * 组内成员不能单点改挂：成员父不一致会让组在树上失去位置（组的位置由成员父推导）。
 * 这种情况拒绝并给出两条出路，不自动升级成整组变更：用户以为只改一处，实际会改多处。
 */
export function cmdTreeMove(p: Parsed, root: string, detach: boolean): number {
  const toks = p.positional.slice(1).filter((x) => !x.startsWith("-"));
  if (toks.length === 0) {
    process.stdout.write(
      detach
        ? "用法：capitalist tree detach <派单...>\n"
        : "用法：capitalist tree move <派单...> --under <父节点|#G组号> [--reason X]\n",
    );
    return 2;
  }
  const { ids, errors } = resolveIds(root, toks);
  if (errors.length > 0) {
    process.stdout.write(`未改动：\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    return 1;
  }

  /* 组内成员单点改挂会拆散组：先拦下来，给出整组与移出两条出路。 */
  const rows = readDispatches(root);
  const idx = groupIndexFrom(root, rows);
  const split = ids
    .map((id) => ({ id, gid: idx.groupOf.get(id) ?? "" }))
    .filter((x) => x.gid !== "");
  if (split.length > 0) {
    process.stdout.write(
      `未改动：\n${split.map((s) => `  ${s.id} 是 ${groupNoLabel(s.gid)} 的成员`).join("\n")}\n` +
        `  改整组位置：capitalist tree group attach ${groupNoLabel(split[0]?.gid ?? "")} <父节点>\n` +
        `  先移出组：capitalist tree group rm ${groupNoLabel(split[0]?.gid ?? "")} ${split.map((s) => s.id).join(" ")}\n`,
    );
    return 1;
  }

  const under = detach ? "" : flagString(p, "under");
  if (!detach && !under) {
    process.stdout.write("未改动：改挂须指定 --under <父节点|#G组号>；摘成根用 capitalist tree detach\n");
    return 2;
  }
  const reason = flagString(p, "reason") || (detach ? "命令行摘成根节点" : "命令行改挂");

  /*
   * `--under` 也接受派单编号：解析成台账 id 再交给 `reassignParent`，
   * 否则 `--under #03` 会被当成一个叫 `#03` 的父节点而报“不在台账里”。
   */
  let target = under ?? "";
  if (target && !normalizeGroupId(target)) {
    const hit = resolveIds(root, [target]);
    if (hit.ids.length === 0) {
      process.stdout.write(`未改动：${hit.errors.length ? `父节点“${target}”未解析成功（${hit.errors.join("；")}）` : `未找到父节点“${target}”`}。\n`);
      return 1;
    }
    target = hit.ids[0] ?? "";
  }

  const r = reassignParent(root, ids, target, reason);
  if (!r.ok) {
    process.stdout.write(`未改动：\n${r.errors.map((e) => `  ${e.id}：${e.reason}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(
    detach
      ? `已把 ${r.changed.length} 条派单摘成根节点\n`
      : `已把 ${r.changed.length} 条派单改挂到 ${target}\n`,
  );
  return 0;
}
