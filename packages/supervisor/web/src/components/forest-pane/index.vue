<script setup>
/**
 * 工作树看板。数据只从 `GET /api/forest?root=` 取，层级由 nest() 按 depth 还原，
 * 节点由 ForestNode.vue 递归渲染。打开时立即拉取并每 5 秒轮询，关闭即停。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ForestNode from "./ForestNode.vue";
import { t } from "../../lib/i18n.js";
/* t 为多处形参名，i18n 的 t 以 tr 导入，避免被遮蔽。 */
const tr = t;

const props = defineProps({
  /** 当前任务根；空串由服务端用默认根。 */
  root: { type: String, default: "" },
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const view = ref(null);
const loading = ref(false);
const error = ref("");
/* 取数与轮询仅在浏览器运行：服务端渲染与静态分析无 window，不发起请求。 */
const IN_BROWSER = typeof window !== "undefined" && typeof fetch === "function";
let pollTimer = 0;
let polling = false;

function forestUrl() {
  return props.root ? `./api/forest?root=${encodeURIComponent(props.root)}` : "./api/forest";
}

async function load() {
  if (polling) return;
  polling = true;
  loading.value = !view.value;
  try {
    const r = await fetch(forestUrl(), { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    view.value = await r.json();
    error.value = "";
  } catch (e) {
    /* 取数失败保留上一次数据，不清空已显示的图。 */
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    polling = false;
  }
}

function start() {
  if (pollTimer || !IN_BROWSER) return;
  pollTimer = setInterval(load, 8000);
}
function stop() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = 0;
}

watch(
  () => props.open,
  (v) => {
    if (v && IN_BROWSER) {
      load();
      start();
    } else {
      stop();
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (props.open && IN_BROWSER) {
    load();
    start();
  }
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  stop();
  document.removeEventListener("keydown", onKey);
});

function onKey(e) {
  if (props.open && e.key === "Escape") emit("close");
}

/**
 * 先序列表 → 嵌套结构。后端保证父先于子且 depth 连续递增，成环数据已隔离到降级树，
 * 循环按 depth 用栈收口后终止。
 */
function nest(tree) {
  const roots = [];
  const stack = [];
  for (const n of tree.nodes || []) {
    const item = { node: n, kids: [] };
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].kids.push(item);
    else roots.push(item);
    stack.push({ depth: n.depth, kids: item.kids });
  }
  return roots;
}

const trees = computed(() => (view.value?.trees || []).map((t) => ({ ...t, forest: nest(t) })));
const totals = computed(() => view.value?.totals || null);
const empty = computed(() => Boolean(view.value && view.value.empty));
const degraded = computed(() => String(view.value?.degraded || ""));

function progress(t) {
  const s = t.stats;
  const parts = [tr("{n} 个节点", { n: s.total }), tr("{n} 个已完成", { n: s.done + s.closed })];
  const left = [];
  if (s.running) left.push(tr("{n} 进行中", { n: s.running }));
  if (s.queued) left.push(tr("{n} 排队", { n: s.queued }));
  if (s.waiting) left.push(tr("{n} 等父节点", { n: s.waiting }));
  if (s.review) left.push(tr("{n} 待验收", { n: s.review }));
  if (s.failed) left.push(tr("{n} 失败", { n: s.failed }));
  parts.push(left.length ? tr("还差 {list}", { list: left.join(" / ") }) : tr("全部完成"));
  return parts.join(" ");
}

const summary = computed(() => {
  const t = totals.value;
  if (!t) return "";
  const bits = [tr("{n} 棵树", { n: trees.value.length }), tr("{n} 个节点", { n: t.total }), tr("{n} 个已完成", { n: t.done + t.closed })];
  if (t.running) bits.push(tr("{n} 进行中", { n: t.running }));
  if (t.waiting) bits.push(tr("{n} 等父节点", { n: t.waiting }));
  if (t.failed) bits.push(tr("{n} 失败", { n: t.failed }));
  if (t.blocked) bits.push(tr("{n} 个落在断链子树", { n: t.blocked }));
  return bits.join(" ");
});

/**
 * 树标题取根节点派单标题，缺失时回落单号。编号不拼进标题：树头徽标已显示 `#NN`，
 * 同屏不重复；节点卡片仍按节点视图带号。
 */
function rootTitle(t) {
  const head = (t.nodes || [])[0];
  if (!head) return t.rootId;
  return head.title || t.rootId;
}

/**
 * 树头徽标用后端下发的真实任务编号 `#NN`，与节点卡片、左栏任务行同源。
 * 编号未建时不显示徽标；树序号表示位置，不作任务编号使用。
 */
function rootNo(t) {
  const head = (t.nodes || [])[0];
  return head && head.no ? `#${head.no}` : "";
}

const LEGEND = [
  { k: "running", text: tr("进行中") },
  { k: "queued", text: tr("排队") },
  { k: "waiting", text: tr("等父节点") },
  { k: "review", text: tr("待验收") },
  { k: "done", text: tr("已完成") },
  { k: "failed", text: tr("失败") },
  { k: "closed", text: tr("已关") },
];
</script>

<template src="./template.html"></template>
<style scoped src="./styles.css"></style>
