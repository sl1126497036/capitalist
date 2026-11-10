<script setup>
import Tooltip from "ant-design-vue/es/tooltip";

defineProps({
  /** tooltip 文案 + aria-label，必填 */
  label: { type: String, required: true },
  /** sm 18px / md 22px / lg 32px 热区 */
  size: { type: String, default: "md" },
  /** muted | accent | danger | ok */
  tone: { type: String, default: "muted" },
  /** 实心强调底（发送钮这种主操作） */
  solid: { type: Boolean, default: false },
  /** 圆形热区 */
  round: { type: Boolean, default: false },
  /** 常驻选中态（如暂停中） */
  active: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  /** 折叠开关的展开态，写入 aria-expanded；null 表示非开关。 */
  expanded: { type: Boolean, default: null },
  placement: { type: String, default: "top" },
});

defineEmits(["click"]);
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
