<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { supervisorTone } from "../../lib/fmt.js";
/* t 为循环变量，i18n 的 t 以 t18 导入，避免被遮蔽。 */
import { t as t18 } from "../../lib/i18n.js";

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  current: { type: String, default: "" },
});
defineEmits(["pick"]);


const strip = ref(null);

async function revealCurrent() {
  await nextTick();
  const el = strip.value?.querySelector(".tab.on");
  if (!el || typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* 老浏览器不支持时忽略。 */
  }
}

watch(() => props.current, revealCurrent);

/* 监工增删后顺序变化，需重新对齐。 */
const rootKey = computed(() => props.tasks.map((t) => t?.root || "").join("|"));
watch(rootKey, revealCurrent);


/** tab 标签不重复目标名；多个监工时按 tasks 顺序编号区分。 */
function tabName(i) {
  return props.tasks.length > 1 ? t18("监工 {n}", { n: i + 1 }) : t18("监工");
}

function tone(t) {
  if (String(t?.status || "") === "paused") return "wait";
  return supervisorTone(t);
}
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
