<script setup>
/**
 * 顶栏跨监工读数条：任务数字读 /api/overview.tasks，与左栏、指标条同源；接口缺项显示破折号，不按 0 处理。
 * 只读，随 App 的结构轮询更新。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { t } from "../../lib/i18n.js";
import { fmtTokens, billParts, totalUsageText } from "../../lib/usage.js";

const props = defineProps({
  /** /api/overview 原样（App 已拉）；未传则自行取数。 */
  overview: { type: Object, default: null },
  /** { root: metrics } 各根指标缓存（App 的 metricsByRoot）；传入则不自取。 */
  byRoot: { type: Object, default: null },
});

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const show = (v) => (n(v) === null ? "—" : String(v));

const ownOv = ref(null);
const ownByRoot = ref({});

const ov = computed(() => props.overview ?? ownOv.value);
const byRoot = computed(() => props.byRoot ?? ownByRoot.value);

async function json(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let busy = false;
let timer = 0;

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    if (!props.overview) {
      try {
        ownOv.value = await json("./api/overview");
      } catch {
        ownOv.value = null;
      }
    }
    if (!props.byRoot) {
      const roots = (ov.value?.roots || []).map((r) => r?.root).filter(Boolean);
      const next = {};
      for (const root of roots) {
        try {
          next[root] = await json(`./api/metrics?root=${encodeURIComponent(root)}`);
        } catch {
          /* 单根失败跳过，不计入合计。 */
        }
      }
      ownByRoot.value = next;
    }
  } finally {
    busy = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 8000);
});
onUnmounted(() => clearInterval(timer));

/** 任务统计首选 /api/overview.tasks，缺失时按各根 /api/metrics.stats 相加；接口未给保持 null。 */
const sum = computed(() => {
  const out = { total: null, running: null, queued: null, failed: null, done: null, accepted: null, roots: 0 };
  const add = (key, v) => {
    const num = n(v);
    if (num === null) return;
    out[key] = (out[key] || 0) + num;
  };
  const ovTasks = ov.value?.tasks;
  if (ovTasks && typeof ovTasks === "object") {
    out.roots = (ov.value?.roots || []).length;
    for (const key of ["total", "running", "queued", "failed", "done", "accepted"]) add(key, ovTasks[key]);
    return out;
  }
  for (const k of Object.keys(byRoot.value || {})) {
    const m = byRoot.value[k];
    if (!m) continue;
    out.roots += 1;
    const c = m.stats || {};
    for (const key of ["total", "running", "queued", "failed", "done", "accepted"]) add(key, c[key]);
  }
  return out;
});

/** 消耗取 /api/overview.usage；单位由 lib/usage.js 的 totalUsageText 统一。 */
const totalTok = computed(() => totalUsageText(ov.value?.usage) || null);

const res = computed(() => ov.value?.resources || null);
const cpuPct = computed(() => n(res.value?.cpu_percent));
const memPressure = computed(() => n(res.value?.memory_pressure_percent));
const mem = computed(() => (memPressure.value === null ? null : `${Math.round(memPressure.value)}%`));

const cpuTitle = computed(() => {
  const r = res.value;
  if (cpuPct.value !== null) return t("整机处理器占用率，与活动监视器口径一致");
  return t("处理器采样不可用：{why}", { why: r?.unavailable_reason || "后台采样器尚无数据" });
});
const memTitle = computed(() => {
  const r = res.value;
  if (mem.value) return t("整机内存压力：100% 减去可用内存占比（memory_pressure）");
  return t("内存压力读取不可用：{why}", { why: r?.unavailable_reason || "暂无数据" });
});

/** 额度单位沿用服务端（可能是积分、token 或现金），格式化走 lib/usage.js 的 billParts。 */
const unit = computed(() => String(ov.value?.credit_unit || "").trim());
const creditLeft = computed(() => billParts(ov.value?.credit_left, unit.value).text);
const creditTitle = computed(() => {
  const why = String(ov.value?.credit_unavailable_reason || "");
  const bits = [
    t("账号级额度，全部监工共用"),
    String(ov.value?.credit_source || "").trim() ? t("来源：{s}", { s: ov.value.credit_source }) : "",
  ].filter(Boolean);
  if (why) bits.push(why);
  return bits.join(" ");
});

/** 仅在存在文件锁时显示占用数与持有者。 */
const fileLocks = computed(() => {
  const v = ov.value?.file_locks;
  if (!v || typeof v !== "object") return null;
  const items = Array.isArray(v.items) ? v.items : [];
  return { count: Number(v.count) || 0, items };
});
const fileLockTip = computed(() => {
  const v = fileLocks.value;
  if (!v) return "";
  if (v.items.length === 0) return t("没有文件被锁");
  return v.items
    .map((e) => {
      const mode = e.mode === "write" ? t("写锁") : t("读锁");
      const age = Number(e.age_sec);
      const ago = Number.isFinite(age) && age >= 0 ? t("{n} 秒前有心跳", { n: age }) : t("无心跳");
      return `${mode}  ${String(e.path ?? "")}\n   ← ${String(e.holder ?? "")}（${ago}）`;
    })
    .join("\n");
});

/** 待回收进程指存活但任务记录里无归属的进程；采不到进程表时为空。 */
const zombies = computed(() => {
  const arr = ov.value?.unreclaimed_pids;
  return Array.isArray(arr) ? arr.length : null;
});

/** 明细只列出本项目拉起过的进程，不含其它项目的 node 进程。 */
const zombieTip = computed(() => {
  const arr = ov.value?.unreclaimed_detail;
  if (!Array.isArray(arr) || arr.length === 0) {
    return t("无待回收进程。仅统计本项目拉起的进程。");
  }
  return arr
    .map((x) => {
      const when = String(x.at ?? "").slice(0, 19).replace("T", " ");
      return `#${x.pid} ${x.kind} ${x.id}\n   ${t("起于 {t}", { t: when || t("未知") })}\n   ${x.why}`;
    })
    .join("\n");
});

const creditLeftNum = computed(() => n(ov.value?.credit_left));

const cells = computed(() => {
  const s = sum.value;
  const dash = (v) => (s.roots ? show(v) : "—");
  return [
    { k: t("总任务"), v: dash(s.total), tone: "total", tip: t("当前任务总数（全部监工合计，等于各状态之和）") },
    { k: t("运行"), v: dash(s.running), tone: "run", tip: t("当前处于运行中的任务数（与左栏“运行”同一份统计）") },
    { k: t("排队"), v: dash(s.queued), tone: "warn", tip: t("当前排队中的任务数（与左栏“排队”同一份统计）") },
    { k: t("异常"), v: dash(s.failed), tone: "bad", tip: t("当前异常任务数（与左栏“异常”同一份统计）") },
    { k: t("完成"), v: dash(s.done), tone: "total", tip: t("当前已完成的任务数（与左栏“已完成”同一份统计）") },
    { k: t("处理器"), v: cpuPct.value === null ? "—" : `${Math.round(cpuPct.value)}%`, tip: cpuTitle.value },
    { k: t("内存"), v: mem.value ?? "—", tip: memTitle.value },
    ...(creditLeft.value
      ? [{ k: t("剩余"), v: creditLeft.value, tone: creditLeftNum.value === 0 ? "bad" : "", tip: creditTitle.value }]
      : []),
    /* 消耗读数统计当前任务根下全部工作进程的合计。 */
    ...(totalTok.value
      ? [{ k: t("本轮消耗"), v: totalTok.value, tip: t("本轮全部工作进程的用量合计") }]
      : []),
    ...(fileLocks.value && fileLocks.value.count > 0
      ? [
          {
            k: t("文件锁"),
            v: String(fileLocks.value.count),
            tone: "warn",
            tip: fileLockTip.value,
          },
        ]
      : []),
    {
      k: t("待回收进程"),
      v: zombies.value === null ? "—" : String(zombies.value),
      tone: zombies.value ? "bad" : "",
      tip: zombieTip.value,
    },
  ];
});
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
