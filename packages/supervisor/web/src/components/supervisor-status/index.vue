<script setup>
/** 顶栏监工状态块。只负责排版，数据由使用方经 props 传入，不自行取数。 */
defineProps({
  /** 只有监工会话下显示；为 false 时整块不渲染。 */
  visible: { type: Boolean, default: false },
  /** 阶段清单，与右栏阶段明细同源（/api/supervisor.stages）。 */
  stages: { type: Array, default: () => [] },
  /** 当前阶段下标，-1 表示还没进入阶段。 */
  stageIndex: { type: Number, default: -1 },
  stageName: { type: String, default: "" },
  /** 状态徽章：{ k, v, tone, dot, tip }，与右栏同一份。 */
  stats: { type: Array, default: () => [] },
});

function done(s, i, cur) {
  return Boolean(s?.done) || i < cur;
}
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
