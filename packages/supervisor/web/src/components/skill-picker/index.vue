<script setup>
/**
 * 技能选择器：按钮 + 搜索弹层。
 *
 * 只负责“选哪些技能”这一件事，选中的名字通过 v-model 交回调用方渲染。输入框上方的
 * 标签、气泡上的标签都读同一份数组，选择逻辑只有这一处。清单来自 `/api/skills`，
 * 与监工派单注入、工作进程提示词用的是同一份扫描，不另建目录。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { CheckOutlined, ToolOutlined } from "@ant-design/icons-vue";
import { t } from "../../lib/i18n.js";

const props = defineProps({
  /** 已选技能名，顺序即选择顺序。 */
  modelValue: { type: Array, default: () => [] },
  /** 单条消息最多带几个：超过后不再追加，避免提示词被正文撑满。 */
  max: { type: Number, default: 3 },
});
const emit = defineEmits(["update:modelValue"]);

const open = ref(false);
const pos = ref({ left: "0px", bottom: "0px" });
const btnEl = ref(null);
const query = ref("");
const list = ref([]);
const loading = ref(false);
const note = ref("");

const picked = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

/** 按钮文案：已选时显示数量，未选时显示“技能”。 */
const label = computed(() => (picked.value.length ? `${t("技能")} ${picked.value.length}` : t("技能")));

/** 按名称与说明同时匹配；清空即全量。 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter(
    (s) => s.name.toLowerCase().includes(q) || String(s.desc || "").toLowerCase().includes(q),
  );
});

/* 关闭即清空搜索：收起可能来自选中后自动关闭、点 ×、点外部，全部按同一套处理。 */
watch(open, (v) => {
  if (!v) query.value = "";
});

async function load() {
  if (loading.value) return;
  loading.value = true;
  note.value = "";
  try {
    const res = await fetch("./api/skills", { cache: "no-store" });
    const data = await res.json();
    list.value = Array.isArray(data?.skills) ? data.skills : [];
  } catch (e) {
    note.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/* 弹层用 fixed：调用方的底栏多为 overflow:hidden，绝对定位会被裁掉。 */
function anchor() {
  const r = btnEl.value?.getBoundingClientRect();
  if (!r) return;
  pos.value = { left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 6}px` };
}

function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  anchor();
  if (!list.value.length) void load();
}

/* 选中后立即收起，便于继续写消息；再次点击取消选择。添加第二个技能需重新打开。 */
function pick(name) {
  const n = String(name || "");
  if (!n) return;
  const cur = picked.value;
  if (cur.includes(n)) {
    emit("update:modelValue", cur.filter((x) => x !== n));
    return;
  }
  if (cur.length >= props.max) return;
  emit("update:modelValue", [...cur, n]);
  open.value = false;
}

function closePops(e) {
  if (!open.value) return;
  const el = e.target;
  if (!(el instanceof Element)) return;
  if (el.closest(".skbox") || el.closest(".skbtn")) return;
  open.value = false;
}

onMounted(() => document.addEventListener("pointerdown", closePops, true));
onUnmounted(() => document.removeEventListener("pointerdown", closePops, true));
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
