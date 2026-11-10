<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { splitMessageRefs } from "../../lib/msgRefs.js";
import { t } from "../../lib/i18n.js";

const props = defineProps({
  text: { type: String, default: "" },
  /** Map<原始编号, { no, threadId, title, status, stage, dispatch, worker }> */
  refs: { type: Map, default: () => new Map() },
});
const emit = defineEmits(["pick"]);

const segs = computed(() => splitMessageRefs(props.text));

function entry(raw) {
  const m = props.refs;
  if (!m) return null;
  return typeof m.get === "function" ? m.get(raw) : m[raw] || null;
}


const card = ref(null);
const pos = ref({});

function openRef(ev, raw) {
  const e = entry(raw);
  if (!e) return;
  const r = ev.currentTarget.getBoundingClientRect();
  const W = 272;
  const H = 218;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(gap, Math.min(r.left, vw - W - gap));
  let top = r.bottom + gap;
  if (top + H > vh - gap) top = Math.max(gap, r.top - H - gap);
  pos.value = { left: `${left}px`, top: `${top}px`, width: `${W}px` };
  card.value = { ...e, raw };
}

function close() {
  card.value = null;
}

function go() {
  const id = card.value?.threadId;
  close();
  if (id) emit("pick", id);
}

function onKey(e) {
  if (e.key === "Escape") close();
}

function onDown(e) {
  if (!card.value) return;
  const t = e.target;
  if (t instanceof Element && (t.closest(".mrc") || t.closest(".mref"))) return;
  close();
}

/** 滚动后收起卡片，避免与锚点错位。 */
function onScroll() {
  if (card.value) close();
}

onMounted(() => {
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("scroll", onScroll, true);
});
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
