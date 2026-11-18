/* 一次性行级替换脚本：main.ts 终端文案包 t(en, zh)。用后即删。 */
const fs = require("fs");
const file = "src/cli/main.ts";
const src = fs.readFileSync(file, "utf8");
const lines = src.split("\n");

const edits = [
  { s: 74, e: 74, expect: `die("用法：capitalist start`, text: `  const target = p.positional[0] ?? die(t("Usage: capitalist start <target> --contract <task-list-name>", "用法：capitalist start <目标> --contract <任务列表名>"));` },
  { s: 80, e: 80, expect: `write(\`已有任务根`, text: `    write(t(\`Existing task root: \${existing}\\nTarget: \${st?.target ?? "?"} | Stage: \${st?.stage ?? "?"}\\n\`, \`已有任务根：\${existing}\\n目标：\${st?.target ?? "?"} ｜ 阶段：\${st?.stage ?? "?"}\\n\`));` },
  { s: 89, e: 89, expect: `die("用法：capitalist init`, text: `  const target = p.positional[0] ?? die(t("Usage: capitalist init <target> --contract <task-list-name>", "用法：capitalist init <目标> --contract <任务列表名>"));` },
  { s: 97, e: 97, expect: `die('用法：capitalist restart`, text: `  if (!target) die(t('Usage: capitalist restart "<target>" --contract <task-list-name>', '用法：capitalist restart "<目标>" --contract <任务列表名>'));` },
  { s: 103, e: 103, expect: `die("监工运行中`, text: `    if (isSupervisorAlive(root)) die(t("Supervisor is running. Run capitalist supervise-stop first, then restart", "监工运行中：先执行 capitalist supervise-stop，退出后再执行 restart"));` },
  { s: 106, e: 106, expect: `write(\`旧任务根已归档`, text: `    write(t(\`Old task root archived: \${dir}.closed.\${stamp}\\n\`, \`旧任务根已归档：\${dir}.closed.\${stamp}\\n\`));` },
  { s: 111, e: 111, expect: "die(`找不到任务列表", text: `  if (!contract) die(t(\`Task list not found: \${spec ?? "minimal"}\`, \`找不到任务列表：\${spec ?? "minimal"}\`));` },
  { s: 115, e: 115, expect: "write(`任务根：", text: `  write(t(\`Task root: \${root}\\nTask list: \${contract.name} (\${contract.domain || "domain not set"})\\nTarget: \${target}\\n\`, \`任务根：\${root}\\n任务列表：\${contract.name}（\${contract.domain || "未标注领域"}）\\n目标：\${target}\\n\`));` },
  { s: 123, e: 123, expect: "die(`找不到任务列表", text: `    die(t(\`Task list not found: \${spec}\\nAvailable: \${contractNames(skillDirs()).join(", ") || "(none)"}\`, \`找不到任务列表：\${spec}\\n可用任务列表：\${contractNames(skillDirs()).join(", ") || "(无)"}\`));` },
  { s: 126, e: 126, expect: "die(`已存在受监督任务", text: `  if (existsSync(statePath(root))) die(t(\`A supervised task already exists: \${root} (see capitalist status)\`, \`已存在受监督任务：\${root}（用 capitalist status 查看）\`));` },
  { s: 129, e: 129, expect: "die(`任务列表", text: `  if (!stage) die(t(\`Task list \${contract.name} defines no stages\`, \`任务列表 \${contract.name} 没有定义任何阶段\`));` },
  { s: 135, e: 138, expect: "write(\n    `任务根：", text: `  write(
    t(\`Task root: \${root}\\nTask list: \${contract.name} (\${contract.domain || "domain not set"})\\n\` +
      \`Stage: \${stage.id} \${stage.name}\\nNext: \${stage.next ?? ""}\\n\`,
    \`任务根：\${root}\\n任务列表：\${contract.name}（\${contract.domain || "未标注领域"}）\\n\` +
      \`阶段：\${stage.id} \${stage.name}\\n下一步：\${stage.next ?? ""}\\n\`),
  );` },
  { s: 141, e: 145, expect: "write(\n      `\\n未指定领域任务列表", text: `    write(
      t(
        \`\\nNo domain task list specified; the generic one is in use.\\n\` +
          \`      Generic redlines apply, but "what counts as done in this domain" is undefined.\\n\` +
          \`      For a domain task: capitalist adopt --contract <\${others}>\\n\`,
        \`\\n未指定领域任务列表，已使用通用任务列表（generic）。\\n\` +
          \`      通用红线生效，但“这个领域什么算做完”没有定义。\\n\` +
          \`      若这是明确领域任务：capitalist adopt --contract <\${others}>\\n\`,
      ),
    );` },
  { s: 151, e: 151, expect: `die("用法：capitalist adopt`, text: `  const spec = flagString(p, "contract") ?? die(t("Usage: capitalist adopt --contract <name|path>", "用法：capitalist adopt --contract <名|路径>"));` },
  { s: 155, e: 155, expect: "die(`找不到任务列表", text: `  if (!contract) die(t(\`Task list not found: \${spec}\\nAvailable: \${contractNames(skillDirs()).join(", ") || "(none)"}\`, \`找不到任务列表：\${spec}\\n可用任务列表：\${contractNames(skillDirs()).join(", ") || "(无)"}\`));` },
  { s: 168, e: 168, expect: `die("状态写入冲突`, text: `  if (ok === null) die(t("State write conflict; the retry failed too. Run the command again", "状态写入冲突，重试后仍未成功：请再执行一次"));` },
  { s: 197, e: 197, expect: `未达门槛，不推进`, text: `    process.stderr.write(t(\`\${sid} \${stage?.name ?? ""} gate not met, not advancing:\\n\`, \`\${sid} \${stage?.name ?? ""} 未达门槛，不推进：\\n\`));` },
  { s: 199, e: 199, expect: `确需强制推进`, text: `    process.stderr.write(t('\\nTo force anyway (recorded in the event log): capitalist advance --force\\n', '\\n确需强制推进（会记入事件日志）：capitalist advance --force\\n'));` },
  { s: 215, e: 215, expect: "write(`强制推进", text: `    write(t(\`Forced; \${check.missing.length} gate item(s) unmet\\n\`, \`强制推进，遗留 \${check.missing.length} 项未满足\\n\`));` },
  { s: 219, e: 219, expect: "write(`已是最后阶段", text: `    write(t(\`Already the last stage \${sid}; wrap-up is allowed once its gate passes.\\n\`, \`已是最后阶段 \${sid}。收工条件满足时允许收工。\\n\`));` },
  { s: 225, e: 225, expect: "die(`任务列表", text: `  if (!next) die(t(\`No stage after \${sid} in task list \${contract.name}\`, \`任务列表 \${contract.name} 里找不到 \${sid} 的下一阶段\`));` },
  { s: 228, e: 228, expect: `die("状态写入冲突`, text: `    die(t("State write conflict; the retry failed too. Run the command again", "状态写入冲突，重试后仍未成功：请再执行一次"));` },
  { s: 230, e: 234, expect: "write(\n    `阶段推进：", text: `  write(
    t(\`Stage advanced: \${sid} -> \${next.id} \${next.name}\\n\` +
      (next.goal ? \`Goal: \${next.goal}\\n\` : "") +
      \`Next: \${next.next ?? ""}\\n\`,
    \`阶段推进：\${sid} -> \${next.id} \${next.name}\\n\` +
      (next.goal ? \`目标：\${next.goal}\\n\` : "") +
      \`下一步：\${next.next ?? ""}\\n\`),
  );` },
  { s: 246, e: 246, expect: `die('用法：capitalist record`, text: `  if (!file || json === undefined) die(t('Usage: capitalist record <name> \\'{"field":"value"}\\'', '用法：capitalist record <名> \\'{"字段":"值"}\\''));` },
  { s: 253, e: 253, expect: "die(`JSON 解析失败", text: `    die(t(\`JSON parse failed: \${err instanceof Error ? err.message : String(err)}\`, \`JSON 解析失败：\${err instanceof Error ? err.message : String(err)}\`));` },
  { s: 258, e: 258, expect: "die(`只能记到", text: `  if (!isInside(target, supervisorDir(root))) die(t(\`Only paths inside .capitalist/ are allowed: \${name}\`, \`只能记到 .capitalist/ 以内：\${name}\`));` },
  { s: 260, e: 260, expect: "die(`写入失败：${target}`", text: `  if (!appendJsonl(target, obj)) die(t(\`Write failed: \${target}\`, \`写入失败：\${target}\`));` },
  { s: 261, e: 261, expect: "write(`已记录到", text: `  write(t(\`Recorded to .capitalist/\${name}\\n\`, \`已记录到 .capitalist/\${name}\\n\`));` },
  { s: 268, e: 268, expect: `die('用法：capitalist ask`, text: `  if (!text) die(t('Usage: capitalist ask "<question>"', '用法：capitalist ask "<问题>"'));` },
  { s: 293, e: 293, expect: "write(`问题已登记", text: `  write(t(\`Question registered as \${id}\\nStopping here is allowed. To return: capitalist inbox \${id}\\n\`, \`问题已登记 问\${id}\\n现在可以停下（这是合法停顿）。回来用：capitalist inbox \${id}\\n\`));` },
  { s: 308, e: 314, expect: "write(\n      `已忽略", text: `    write(
      t(
        \`Ignored \${ignored.length} malformed record(s) (not reviewed): \` +
          \`\${ignored
            .slice(0, 5)
            .map((i) => \`line \${i.line}: \${i.reason}\`)
            .join("; ")}\${ignored.length > 5 ? " …" : ""}\\n\`,
        \`已忽略 \${ignored.length} 条畸形记录（不参与裁决）：\` +
          \`\${ignored
            .slice(0, 5)
            .map((i) => \`第 \${i.line} 行 \${i.reason}\`)
            .join("；")}\${ignored.length > 5 ? " …" : ""}\\n\`,
      ),
    );` },
  { s: 316, e: 316, expect: "write(`（同目录只读", text: `      write(t(\`(Read-only \${INBOX_LEDGER} in the same directory; skipped \${skipped.length} non-ledger file(s): \${skipped.slice(0, 5).join(", ")})\\n\`, \`（同目录只读 \${INBOX_LEDGER}，已跳过 \${skipped.length} 个非台账文件：\${skipped.slice(0, 5).join("、")}）\\n\`));` },
  { s: 321, e: 321, expect: "没有待裁决问题", text: `    write(t("No open questions\\n", "没有待裁决问题\\n"));` },
  { s: 326, e: 326, expect: "write(`问${q.id}", text: `    write(t(\`\${q.id} [\${String(q.stage ?? "")}] \${q.text}\\n\`, \`问\${q.id} [\${String(q.stage ?? "")}] \${q.text}\\n\`));` },
  { s: 341, e: 341, expect: "write(`已按 ${ds.length}", text: `    write(t(\`Backfilled the task pool from \${ds.length} dispatch record(s)\\n\`, \`已按 \${ds.length} 条历史派单回填任务池\\n\`));` },
  { s: 348, e: 348, expect: "没有发现同义重复项", text: `      write(t("No duplicate entries found\\n", "没有发现同义重复项\\n"));` },
  { s: 351, e: 351, expect: "write(`可归并", text: `    write(t(\`\${groups.length} merge group(s) covering \${total} duplicate item(s)\\n\`, \`可归并 \${groups.length} 组，涉及 \${total} 项重复\\n\`));` },
  { s: 353, e: 353, expect: "write(`  ${g.keep}", text: `      write(t(\`  \${g.keep} <- \${g.drop.length} item(s): \${g.title.slice(0, 56)}\\n\`, \`  \${g.keep} ← \${g.drop.length} 项：\${g.title.slice(0, 56)}\\n\`));` },
  { s: 355, e: 355, expect: "write(`  …另有 ${groups.length - 25}", text: `    if (groups.length > 25) write(t(\`  …and \${groups.length - 25} more group(s)\\n\`, \`  …另有 \${groups.length - 25} 组\\n\`));` },
  { s: 357, e: 357, expect: "这只是预览", text: `      write(t("\\nPreview only. Add --apply to confirm (merged items become void, not deleted; traceable)\\n", "\\n这只是预览。确认后加 --apply 执行（被并走的项转 void，不删除，可追溯）\\n"));` },
  { s: 361, e: 361, expect: "write(`已归并：", text: `    write(t(\`Merged: \${groups.length} group(s), \${n} item(s) closed (merged_into points to the kept one)\\n\`, \`已归并：\${groups.length} 组，\${n} 项转为已关闭（merged_into 指向代表项）\\n\`));` },
  { s: 371, e: 371, expect: "任务池是空的", text: `    write(t("(The task pool is empty: no dispatches yet. Each dispatch registers one entry.)\\n", "（任务池是空的：还没有派过单。每建一张派单会自动登记一项。）\\n"));` },
  { s: 376, e: 383, expect: `const label: Record<TaskState, string>`, text: `  const label: Record<TaskState, string> = {
    failed: t("failed", "失败待重试"),
    submitted: t("submitted (self-reported done, unreviewed)", "待确认（自称做完，未验收）"),
    dispatched: t("in progress", "进行中"),
    pending: t("queued", "待派"),
    accepted: t("accepted", "已验收"),
    void: t("closed", "已关闭"),
  };` },
  { s: 387, e: 387, expect: "write(`\\n[${label[st]}] ${list.length} 项", text: `    write(t(\`\\n[\${label[st]}] \${list.length} item(s)\\n\`, \`\\n[\${label[st]}] \${list.length} 项\\n\`));` },
  { s: 392, e: 392, expect: "…另有 ${list.length - 40}", text: `    if (list.length > 40) write(t(\`  …and \${list.length - 40} more\\n\`, \`  …另有 \${list.length - 40} 项\\n\`));` },
  { s: 448, e: 448, expect: "write(`\\n监工：", text: `  write(t(\`\\nSupervisor: \${supervisorLabel}\${capitalist.state === "online" ? \` (pid \${capitalist.pid}, \${capitalist.detail})\` : \` — \${capitalist.detail}\`}\\n\`, \`\\n监工：\${supervisorLabel}\${capitalist.state === "online" ? \`（pid \${capitalist.pid}，\${capitalist.detail}）\` : \` —— \${capitalist.detail}\`}\\n\`));` },
  { s: 450, e: 450, expect: "write(`看板：", text: `  if (boardUrl) write(t(\`Board: \${boardUrl}\\n\`, \`看板：\${boardUrl}\\n\`));` },
  { s: 452, e: 452, expect: "write(`已暂停 · 自", text: `  if (pause) write(t(\`Paused since \${pause.at}; reason: \${pause.reason} (no new dispatches, workers stopped; resume with capitalist resume)\\n\`, \`已暂停 · 自 \${pause.at} · 原因：\${pause.reason}（不派新单、进程已停；恢复：capitalist resume）\\n\`));` },
  { s: 457, e: 460, expect: "write(\n      `暂停单", text: `    write(
      t(\`Paused dispatches: \${pausedRows.length} (left unfinished by the last interruption; not auto-run).\\n\` +
        \`Wake all with capitalist wake --user, or one by one with capitalist wake --user <dispatch-id>\\n\`,
      \`暂停单 \${pausedRows.length} 张（上次中断未完成，不自动执行）：\` +
        \`capitalist wake --user 全部唤醒，或 capitalist wake --user <派单id> 逐张唤醒\\n\`),
    );` },
  { s: 465, e: 471, expect: "if (lease.holder) {", text: `  if (lease.holder) {
    write(
      t(\`Instance: holder pid \${lease.holder.pid} (\${lease.holder.instance_id}); instances \${lease.instance_count}; heartbeat \${lease.heartbeat_age_sec}s ago\\n\`,
        \`实例：持有者 pid \${lease.holder.pid}（\${lease.holder.instance_id}） ｜ 实例数 \${lease.instance_count} ｜ 心跳 \${lease.heartbeat_age_sec}s 前\\n\`),
    );
  } else {
    write(t(\`Instance: no live holder; instances \${lease.instance_count}\\n\`, \`实例：无存活持有者 ｜ 实例数 \${lease.instance_count}\\n\`));
  }` },
  { s: 472, e: 472, expect: "write(`警告：", text: `  if (lease.warn) write(t(\`Warning: \${lease.warn}\\n\`, \`警告：\${lease.warn}\\n\`));` },
  { s: 481, e: 481, expect: "write(`待生效指令：", text: `    write(t(\`Pending directives: \${pending.length} (apply to the next dispatch only; not yet merged into the action)\\n\`, \`待生效指令：\${pending.length} 条（只对下一次派单生效，尚未拼入 action）\\n\`));` },
  { s: 485, e: 486, expect: 'const scope = tk.all', text: `    const scope = tk.all ? t("the whole task root", "整个任务根") : t(\`shard(s) \${tk.shards.join(", ")}\`, \`分片 \${tk.shards.join("、")}\`);
    write(t(\`Under takeover: \${scope} (reason: \${tk.reason}); auto-redispatch and auto-review are suspended for it\\n\`, \`接管中：\${scope}（原因：\${tk.reason}）；监工暂停该片自动重派与自动验收\\n\`));` },
  { s: 491, e: 491, expect: "⚠ 工作区准备失败", text: `    write(t(\`\\n⚠ Workspace preparation failed (\${ws.impl}): \${ws.message}\\n\${ws.fix}\\n\`, \`\\n⚠ 工作区准备失败（\${ws.impl}）：\${ws.message}\\n\${ws.fix}\\n\`));` },
  { s: 508, e: 510, expect: "text +=\n      `\\n▸ 任务已暂停", text: `    text += t(
      \`\\n▸ Task paused (since \${pause.at}; reason: \${pause.reason}). Dispatching is suspended; the "Next" above is on hold.\\n\` +
        \`  Waiting for capitalist resume. Do not start work before it.\\n\`,
      \`\\n▸ 任务已暂停（自 \${pause.at}，原因：\${pause.reason}）：监工暂停派单，上面的“下一步”暂不执行。\\n\` +
        \`  等待操作者执行 capitalist resume；恢复之前不要继续开工。\\n\`,
    );` },
  { s: 527, e: 527, expect: "write(`生效档位：", text: `    write(t(\`Effective mode: \${effective}, \${describeMode(effective)}\\n\\nAvailable modes:\\n\`, \`生效档位：\${effective}，\${describeMode(effective)}\\n\\n可用档位：\\n\`));` },
  { s: 535, e: 535, expect: "die(`未知档位：", text: `  if (!next) die(t(\`Unknown mode: \${value}\\nAvailable: \${modeNames().join(", ")}\`, \`未知档位：\${value}\\n可用：\${modeNames().join(", ")}\`));` },
  { s: 537, e: 537, expect: `die("状态写入冲突`, text: `    die(t("State write conflict; the retry failed too. Run the command again", "状态写入冲突，重试后仍未成功：请再执行一次"));` },
  { s: 539, e: 539, expect: "write(`档位：", text: `  write(t(\`Mode: \${effective} -> \${next} (\${describeMode(next)})\\n\`, \`档位：\${effective} 改为 \${next}（\${describeMode(next)}）\\n\`));` },
  { s: 541, e: 541, expect: "bypass 档位放宽", text: `    write(t("Bypass relaxes the mode and local-boundary checks; task-list redlines still block as before. For controlled environments only.\\n", "bypass 档位放宽档位与本机边界判定，任务列表红线仍按原级别拦截。该档位仅用于受控环境。\\n"));` },
  { s: 549, e: 549, expect: "die(`用法：capitalist ${name}", text: `  if (!text) die(t(\`Usage: capitalist \${name} "<text>" [--shard <shard>] [--thread <thread>] | capitalist \${name} --help\`, \`用法：capitalist \${name} "<文本>" [--shard <分片>] [--thread <线程>] ｜ capitalist \${name} --help\`));` },
  { s: 550, e: 550, expect: "文本过长", text: `  if (text.length > 4000) die(t("Text too long (max 4000 chars)", "文本过长（上限 4000 字）"));` },
  { s: 580, e: 580, expect: "写入失败：.capitalist/direct.jsonl", text: `  if (!rec) die(t("Write failed: .capitalist/direct.jsonl", "写入失败：.capitalist/direct.jsonl"));` },
  { s: 582, e: 590, expect: "const scope = target", text: `  const scope = target
    ? t(\`dispatch \${target}\`, \`目标单 \${target}\`)
    : shard
      ? t(\`shard \${shard}\`, \`分片 \${shard}\`)
      : thread
        ? t(\`worker \${thread}\`, \`进程 \${thread}\`)
        : lane
          ? t(\`thread \${lane}\`, \`线程 \${lane}\`)
          : t("any next dispatch", "下次任意派单");` },
  { s: 591, e: 595, expect: "write(\n    `追加消息已登记", text: `  write(
    t(\`Message registered (\${scope}).\\n\` +
      \`A not-yet-started dispatch merges it at launch; a running one receives it from the hook before the next tool call, without interruption.\\n\` +
      \`Delivery marks it used, no repeat injection; see the direct_inject / direct_deliver events in the ledger.\\n\`,
    \`追加消息已登记（\${scope}）。\\n\` +
      \`生效时机：未开工的单在启动时并入原派单；执行中的单由 hook 在下一次工具调用前送达，执行进程不中断。\\n\` +
      \`送达即标记已用，不会重复注入；登记与送达在台账 direct_inject / direct_deliver 事件里可查。\\n\`),
  );` },
  { s: 622, e: 622, expect: "const scope = rec.shard", text: `  const scope = rec.shard ? t(\`shard \${rec.shard}\`, \`分片 \${rec.shard}\`) : t("the whole task root (all shards)", "整个任务根（所有分片）");` },
  { s: 623, e: 627, expect: "write(\n    `已接管", text: `  write(
    t(\`Taken over: \${scope} (reason: \${rec.reason}).\\n\` +
      \`From the next round the supervisor neither re-dispatches nor auto-reviews it; restore with capitalist release.\\n\` +
      \`Takeover only changes supervisor behavior; to stop the process use capitalist stop-worker <id>.\\n\`,
    \`已接管 \${scope}（原因：\${rec.reason}）。\\n\` +
      \`监工从下一轮调度起：不自动重派该片、不自动验收该片，等 capitalist release 恢复。\\n\` +
      \`接管只改变监工行为，不终止运行中的进程；中断进程使用 capitalist stop-worker <id>。\\n\`),
  );` },
  { s: 637, e: 637, expect: "没有处于接管状态的片", text: `    write(t(shard ? \`Shard \${shard} is not under takeover; nothing to release.\\n\` : "No shard is under takeover; nothing to release.\\n", shard ? \`分片 \${shard} 没有被接管，无需交还。\\n\` : "当前没有处于接管状态的片，无需交还。\\n"));` },
  { s: 640, e: 643, expect: "write(\n    `已交还", text: `  write(
    t(\`Released: \${released.map((s) => (s === "*" ? t("the whole task root", "整个任务根") : t(\`shard \${s}\`, \`分片 \${s}\`))).join(", ")}.\\n\` +
      \`From the next round the supervisor resumes auto-redispatch and auto-review for them.\\n\`,
    \`已交还 \${released.map((s) => (s === "*" ? "整个任务根" : \`分片 \${s}\`)).join("、")}。\\n\` +
      \`生效时机：下一轮调度起监工恢复该片的自动重派与自动验收。\\n\`),
  );` },
  { s: 657, e: 657, expect: "暂停状态写入失败", text: `    die(t(\`Failed to write the pause file: \${err instanceof Error ? err.message : String(err)}\`, \`暂停状态写入失败：\${err instanceof Error ? err.message : String(err)}\`));` },
  { s: 660, e: 664, expect: "write(\n    `已暂停（自", text: `  write(
    t(\`Paused (since \${rec.at}; reason: \${rec.reason}).\\n\` +
      \`From the next round no new dispatches; running workers stop and their dispatches requeue, restoring in order after resume.\\n\` +
      \`Old paused dispatches stay paused after resume; wake them with capitalist wake --user. Resume: capitalist resume\\n\`,
    \`已暂停（自 \${rec.at}，原因：\${rec.reason}）。\\n\` +
      \`监工从下一轮调度起不再派新单；运行中的进程停止，对应派单退回排队，恢复后按原顺序重派。\\n\` +
      \`已暂停的旧派单不随恢复调度解除暂停，需通过 capitalist wake --user 单独唤醒。恢复调度：capitalist resume\\n\`),
  );` },
  { s: 679, e: 679, expect: "无需恢复", text: `    write(t("Nothing is paused; nothing to resume.\\n", "当前没有处于暂停状态，无需恢复。\\n"));` },
  { s: 685, e: 689, expect: "拒绝：恢复派单需要用户动作", text: `    write(
      t(
        "Resuming requires a user action.\\n" +
          "Not in an interactive terminal, so the pause stays and the queue is kept.\\n" +
          "To resume explicitly: capitalist resume --user, or click resume on the board.\\n",
        "拒绝：恢复派单需要用户动作。\\n" +
          "当前不在交互终端（宿主会话里的命令执行），按启动规则保持暂停，队列原样保留。\\n" +
          "用户明确要求恢复时：capitalist resume --user；或在看板点击“恢复调度”。\\n",
      ),
    );` },
  { s: 695, e: 695, expect: "暂停状态删除失败", text: `    die(t(\`Failed to remove the pause file: \${err instanceof Error ? err.message : String(err)}\`, \`暂停状态删除失败：\${err instanceof Error ? err.message : String(err)}\`));` },
  { s: 699, e: 702, expect: "已恢复：监工从下一轮调度起恢复派单", text: `  write(
    t(
      "Resumed: from the next round dispatching starts again; only manually created dispatches run, none are auto-created from the contract.\\n" +
        "Old paused dispatches still need capitalist wake --user.\\n",
      "已恢复：监工从下一轮调度起恢复派单，只执行派入的派单，不按契约自动建单。" +
        "被暂停的旧派单仍需通过 capitalist wake --user 唤醒。\\n",
    ),
  );` },
  { s: 719, e: 720, expect: "installNeedsConfirm", text: `      caps.install ? (caps.installNeedsConfirm ? t("install(confirm)", "install(需确认)") : "install") : null,
      caps.workerLaunch ? (caps.workerAutoDetect ? "worker(auto)" : t("worker(explicit)", "worker(显式)")) : null,` },
  { s: 740, e: 740, expect: '"名称".padEnd', text: `  write(t(\`\${"id".padEnd(idW)}  \${"name".padEnd(labelW)}  capabilities\\n\`, \`\${"id".padEnd(idW)}  \${"名称".padEnd(labelW)}  能力\\n\`));` },
  { s: 744, e: 744, expect: "配置 ${r.configDir}", text: `    write(t(\`\\n\${"".padEnd(idW + labelW + 6)}config \${r.configDir}\`, \`\\n\${"".padEnd(idW + labelW + 6)}配置 \${r.configDir}\`));` },
  { s: 745, e: 745, expect: "别名 ${r.aliases", text: `    if (r.aliases.length > 0) write(t(\`  aliases \${r.aliases.join(",")}\`, \`  别名 \${r.aliases.join(",")}\`));` },
  { s: 748, e: 748, expect: "能力由 impl 声明的 facet 推导", text: `  write(t("\\n# Capabilities derive from the facets declared by each impl; view the event mapping with capitalist-hook --selftest --agent <id>.\\n", "\\n# 能力由 impl 声明的 facet 推导；事件映射用 capitalist-hook --selftest --agent <id> 查看。\\n"));` },
  { s: 780, e: 780, expect: "工作区准备抛出异常", text: `        message: t(\`Workspace preparation threw: \${err instanceof Error ? err.message : String(err)}\`, \`工作区准备抛出异常：\${err instanceof Error ? err.message : String(err)}\`),` },
  { s: 796, e: 801, expect: "工作区配置目录写入被拒绝", text: `    return t(
      [
        "The workspace config directory could not be written (permissions / read-only / locked). Fixes:",
        \`  1. Check the current user can write to the task root (Windows: folder Properties -> Security, or icacls "\${root}")\`,
        "  2. Close processes that may hold the config files (settings.json / project config): editors, other agent sessions, IDEs",
        "  3. If the task root is on a read-only mount or a controlled directory, pick a writable directory and run capitalist start again",
        "  4. Re-check with capitalist status, or start capitalist supervise again",
      ].join("\\n"),
      [
        "工作区配置目录写入被拒绝（权限 / 只读 / 被占用）。可操作的修复：",
        \`  1. 确认当前用户对任务根有写权限（Windows：右键目录->属性->安全；或 icacls "\${root}"）\`,
        "  2. 关闭可能占用配置文件（settings.json / 项目配置）的进程：编辑器、其它 agent 会话、IDE",
        "  3. 若任务根在只读挂载或受控目录，换一个可写目录重新 capitalist start",
        "  4. 修复后执行 capitalist status 复检，或重新 capitalist supervise",
      ].join("\\n"),
    );` },
  { s: 803, e: 803, expect: "查看上面的失败信息并修复后重试", text: `  return t("Fix per the failure above and retry: capitalist status | capitalist supervise", "查看上面的失败信息并修复后重试：capitalist status ｜ capitalist supervise");` },
  { s: 849, e: 853, expect: "这个命令属于监工", text: `      write(
        t(\`Supervisor-only command; workers cannot run it: \${p.cmd}\\n\` +
          \`Workers may only report and inspect: report / ask / notify / block / say / record / status / tasks.\\n\` +
          \`To change scheduling (close, pause, dispatch, advance), file it with capitalist notify for the supervisor to judge.\\n\`,
        \`这个命令属于监工，工作进程不能执行：\${p.cmd}\\n\` +
          \`工作进程能做的只有上报与查看：report / ask / notify / block / say / record / status / tasks。\\n\` +
          \`要改变调度（关闭、暂停、派单、推进阶段）请用 capitalist notify 说明诉求，由监工裁决。\\n\`),
      );` },
  { s: 928, e: 936, expect: "本地版本", text: `      write(t(\`Local version  \${r.status.local}\\n\`, \`本地版本  \${r.status.local}\\n\`));
      write(t(\`Latest on npm \${r.status.latest}\\n\`, \`npm 上最新 \${r.status.latest}\\n\`));
      if (r.status.outdated) {
        write(t(\`\\nNew version available. Upgrade: npm i -g capitalist\\n\`, \`\\n有新版本。升级：npm i -g capitalist\\n\`));
        write(t(\`After upgrading, rerun capitalist install: the hook records the absolute path of the entry script.\\n\`, \`升级后重跑 capitalist install：hook 里记的是入口脚本的绝对路径。\\n\`));
      } else {
        write(t(\`\\nUp to date.\\n\`, \`\\n已是最新版本。\\n\`));
      }
      if (r.cached) write(t(\`(From cache \${r.status.checkedAt}; use --force to re-check online)\\n\`, \`（结论来自缓存 \${r.status.checkedAt}，加 --force 重新联网）\\n\`));` },
  { s: 1017, e: 1018, expect: "⚠ 工作区准备失败", text: `        write(t(\`⚠ Workspace preparation failed (\${ws.impl}): \${ws.message}\\n\${ws.fix}\\n\`, \`⚠ 工作区准备失败（\${ws.impl}）：\${ws.message}\\n\${ws.fix}\\n\`));
        write(t("(If the workspace is not ready the worker may sit on a confirmation page and not run; fix per the above, then start.)\\n", "（工作区未就绪时 worker 可能停在确认页，不会自动执行；按上述说明修复后启动。）\\n"));` },
  { s: 1194, e: 1194, expect: "die(\"用法：capitalist guard", text: `        return die(t("Usage: capitalist guard <root> <capitalist-pid> (internal; started by the supervisor)", "用法：capitalist guard <root> <capitalist-pid>（内部命令，由监工自动拉起）"));` },
  { s: 1232, e: 1232, expect: "该命令已移除", text: `      write(t("This command was removed: the plugin never stores or reads tokens from disk; auth uses the host credentials read at startup.\\n", "该命令已移除：插件不从磁盘保存或读取令牌，认证由启动时读取的宿主凭证完成。\\n"));` },
  { s: 1243, e: 1243, expect: "未知命令：", text: `      process.stderr.write(t(\`Unknown command: \${p.cmd}\\n\\n\${HELP}\`, \`未知命令：\${p.cmd}\\n\\n\${HELP}\`));` },
];

let failures = [];
const sorted = [...edits].sort((a, b) => b.s - a.s);
for (const ed of sorted) {
  const cur = lines.slice(ed.s - 1, ed.e).join("\n");
  if (!cur.includes(ed.expect)) {
    failures.push(`line ${ed.s}-${ed.e}: expect not found: ${ed.expect}`);
    continue;
  }
  const replacement = ed.text.split("\n");
  lines.splice(ed.s - 1, ed.e - ed.s + 1, ...replacement);
}
if (failures.length) {
  console.error("MISMATCH:\n" + failures.join("\n"));
  process.exit(1);
}
fs.writeFileSync(file, lines.join("\n"));
console.log("OK, applied", edits.length, "edits");
