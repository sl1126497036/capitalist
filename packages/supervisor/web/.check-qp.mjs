import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

const fails = [];
let n = 0;
const ok = (cond, msg) => {
  n++;
  if (!cond) fails.push(msg);
};

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });

try {
  const Pane = (await server.ssrLoadModule("/src/components/queue-pane/probe.vue")).default;
  const now = Date.now();
  const iso = (secAgo) => new Date(now - secAgo * 1000).toISOString();

  const mk = (o) => ({ worker: "w", stage: "U2", started_at: iso(100), last_at: iso(10), ...o });

  /* ---- 1. 四种状态与右侧文案 ---- */
  const four = [
    mk({ id: "a-run", shard: "s1", status: "running", title: "运行中的任务" }),
    mk({ id: "a-done", shard: "s2", status: "done", title: "完成的任务", duration_sec: 75 }),
    mk({ id: "a-queue", shard: "s3", status: "queued", title: "排队的任务" }),
    mk({ id: "a-wait", shard: "s4", status: "weird", title: "未调度任务" }),
    mk({ id: "a-bad", shard: "s5", status: "failed", title: "失败的任务" }),
  ];
  const html = await renderToString(
    createSSRApp({ render: () => h(Pane, { threads: four, current: "", total: four.length, capitalist: { online: true, status: "online", stage: "U2", stage_index: 0, stage_total: 3, parallel: 3 } }) }),
  );
  const row = (id) => {
    const i = html.indexOf(`data-tid="${id}"`);
    return i < 0 ? "" : html.slice(i, html.indexOf("</button>", i));
  };
  ok(/class="tb tb-warn"[^>]*>排队</.test(row("a-queue")), "排队行状态词应为「排队」");
  ok(!row("a-queue").includes("排队中"), "排队行不应出现「排队中」");
  ok(/class="tb tb-idle"[^>]*>待调度</.test(row("a-wait")), "未知状态应落「待调度」");
  ok(/class="tb tb-bad"[^>]*>异常</.test(row("a-bad")), "异常行状态词应为「异常」");
  ok(row("a-run").includes("耗时 01:40") || row("a-run").includes("耗时 01:4"), "运行中应显示已运行时长");
  ok(row("a-done").includes("耗时 01:15"), "已完成应显示实际耗时");
  ok(!row("a-run").includes("class=\"tb\""), "运行中不显示状态词格（只给时长）");
  ok(!row("a-done").includes("class=\"tb\""), "已完成不显示状态词格（只给时长）");

  /* ---- 2. 同分片重派不合并 ---- */
  const retries = [
    mk({ id: "r1", shard: "same", status: "failed", title: "第一胎", started_at: iso(900) }),
    mk({ id: "r2", shard: "same", status: "running", title: "第二胎", started_at: iso(300) }),
    mk({ id: "r3", shard: "same", status: "running", title: "第三胎", started_at: iso(100) }),
  ];
  const h2 = await renderToString(
    createSSRApp({ render: () => h(Pane, { threads: retries, total: 3, capitalist: {} }) }),
  );
  const count = (h3, id) => (h3.match(new RegExp(`data-tid="${id}"`, "g")) || []).length;
  ok(count(h2, "r1") === 1 && count(h2, "r2") === 1 && count(h2, "r3") === 1, "同分片三胎应各占一行，不合并");
  ok(/第三胎<\/span>[\s\S]{0,120}重派 3/.test(h2), "第三胎应标「重派 3」");
  ok(/第二胎<\/span>[\s\S]{0,120}重派 2/.test(h2), "第二胎应标「重派 2」");
  ok(!/第一胎[\s\S]{0,120}重派 1/.test(h2), "首胎不标重派号");

  /* ---- 3. 截断提示 ---- */
  const many = Array.from({ length: 60 }, (_, i) =>
    mk({ id: `m${i}`, shard: `s${i}`, status: "done", title: `任务${i}`, started_at: iso(1000 + i * 10) }),
  );
  const h3 = await renderToString(createSSRApp({ render: () => h(Pane, { threads: many, total: 60, capitalist: {} }) }));
  ok((h3.match(/data-tid="m\d+"/g) || []).length === 50, "一屏应只画 50 行");
  ok(/还有 <b>10<\/b> 个进程未显示/.test(h3), "截断提示应为「还有 10 个进程未显示」");

  const h4 = await renderToString(
    createSSRApp({ render: () => h(Pane, { threads: many, total: 60, capitalist: {}, __all: true }) }),
  );
  ok((h4.match(/data-tid="m\d+"/g) || []).length === 60, "点开后应画出全部 60 行");
  ok(!/个进程未显示/.test(h4), "展开后截断提示应收起");

  const h5 = await renderToString(
    createSSRApp({ render: () => h(Pane, { threads: many, total: 137, capitalist: {} }) }),
  );
  ok(/还有 <b>87<\/b> 个进程未显示/.test(h5), "余量按 max(本地行, total) 算：137−50=87");

  /* ---- 4. 搜索范围 ---- */
  const searchers = [
    mk({ id: "W-778", shard: "query-pane", status: "running", title: "左栏搜索", worker: "W-778" }),
    mk({ id: "s2", shard: "other", status: "running", title: "另一条", worker: "W-999", model: "claude-4" }),
  ];
  const hit = async (q) => {
    const s = await renderToString(
      createSSRApp({ render: () => h(Pane, { threads: searchers, total: 2, capitalist: {}, __q: q }) }),
    );
    return (s.match(/data-tid="[^"]+"/g) || []).length;
  };
  ok((await hit("W-778")) === 1, "搜索应命中 worker 字段");
  ok((await hit("query-pane")) === 1, "搜索应命中 shard");
  ok((await hit("左栏")) === 1, "搜索应命中标题");
  ok((await hit("U2")) === 0, "搜索不匹配 stage");
  ok((await hit("claude-4")) === 0, "搜索不匹配 model");

  /* ---- 5. 计数不被搜索改写 ---- */
  const h6 = await renderToString(
    createSSRApp({ render: () => h(Pane, { threads: many, total: 60, capitalist: {}, __q: "任务1" }) }),
  );
  const m = h6.match(/data-filter="all"[\s\S]*?<b class="fnum">(\d+)<\/b>/);
  ok(m && m[1] === "60", `搜索时「全部」计数仍应为全量 60（实际 ${m && m[1]}）`);
} finally {
  await server.close();
}

if (fails.length) {
  console.log(`FAILED ${fails.length}/${n}`);
  fails.forEach((f) => console.log("  × " + f));
  process.exit(1);
}
console.log(`SSR 自检通过：${n} 项断言`);
