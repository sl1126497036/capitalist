<script setup>
/**
 * 标识由 `src/assets/capitalist-logo.svg` 经 `?raw` 读入，运行时去掉固定宽高并将写死颜色换为 `currentColor`。
 * 颜色映射保持明暗层级，镜片取 0.34 透明度；filter / clipPath 的 id 加前缀，避免与页面其它内联 svg 冲突。
 */
import rawLogo from "../../assets/capitalist-logo.svg?raw";

const svg = rawLogo
  .replace(/<\?xml[^>]*\?>/g, "")
  /* 原文件的固定宽高会覆盖样式，去掉后由 CSS 按 --f-brand 缩放。 */
  .replace(/\swidth="617"/, "")
  .replace(/\sheight="210"/, "")
  .replace(/fill="#2D343A"/g, 'fill="currentColor"')
  .replace(/stroke="#2D343A"/g, 'stroke="currentColor"')
  .replace(/fill="#DDDBD5"/g, 'fill="currentColor" opacity="0.34"')
  .replace(/fill="#ffffff"/g, 'fill="currentColor"')
  .replace(/id="soft"/g, 'id="bl-soft"')
  .replace(/id="lens"/g, 'id="bl-lens"')
  .replace(/url\(#soft\)/g, "url(#bl-soft)")
  .replace(/url\(#lens\)/g, "url(#bl-lens)")
  .replace("<svg", '<svg class="blsvg"');
</script>

<template>
  <span class="bl" role="img" aria-label="capitalist" v-html="svg" />
</template>

<style scoped>
.bl {
  display: inline-flex;
  align-items: center;
  /* 颜色继承顶栏文字主色，随主题切换。 */
  color: var(--t1);
}

/* 标记按字号 1.3 倍显示，下移 1px 与顶栏文字对齐。 */
.bl :deep(.blsvg) {
  display: block;
  height: calc(var(--f-brand) * 1.3);
  width: auto;
  transform: translateY(1px);
}
</style>
