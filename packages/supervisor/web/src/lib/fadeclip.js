/**
 * 超宽标题右缘渐隐。指令挂在 overflow:hidden 的标题元素上，需配套 `.fadeclip` 的
 * mask-image 规则（见 queue-pane / chat-pane 的 styles.css）。
 */
const CLASS = "fadeclip";

function check(el) {
  el.classList.toggle(CLASS, el.scrollWidth > el.clientWidth + 1);
}

export const fadeclip = {
  mounted(el) {
    check(el);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => check(el));
    ro.observe(el);
    el.__fadeclipRO = ro;
  },
  updated(el) {
    check(el);
  },
  unmounted(el) {
    if (el.__fadeclipRO) {
      el.__fadeclipRO.disconnect();
      delete el.__fadeclipRO;
    }
  },
};
