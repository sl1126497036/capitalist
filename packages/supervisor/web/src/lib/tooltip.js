/**
 * 浮层提示由 `data-tip` 驱动：浏览器不识别该属性，不会自行弹出原生提示。
 * 监听放在捕获阶段：组件内多处 stopPropagation，冒泡阶段会漏。
 */

const DELAY = 300;

export function installTooltip() {
  const tip = document.createElement("div");
  tip.className = "su-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let timer = 0;
  let node = null;

  function hide() {
    clearTimeout(timer);
    timer = 0;
    node = null;
    tip.classList.remove("on");
  }

  /** 读取 `data-tip`；遗留 `title`（第三方组件）读取后移除并替换为 data-tip。 */
  function textOf(el) {
    const v = el.getAttribute("data-tip");
    if (v != null && v.trim()) return v.trim();
    const legacy = el.getAttribute("title");
    if (legacy != null) {
      el.setAttribute("data-tip", legacy);
      el.removeAttribute("title");
      return legacy.trim();
    }
    return "";
  }

  function draw(el) {
    /*
     * 绘制时重读 `data-tip`：部分提示在 mouseenter 之后才写入，且 mouseover 与
     * mouseenter 的触发顺序因浏览器而异，mouseover 时的快照可能取不到文案。
     */
    const text = textOf(el);
    if (!text) return;
    tip.textContent = text;
    /* 先移出视口量尺寸，避免首帧出现在左上角后跳位。 */
    tip.style.left = "-9999px";
    tip.style.top = "0px";
    tip.classList.add("on");

    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const r = el.getBoundingClientRect();

    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) {
      top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.max(8, window.innerHeight - h - 8);
    }

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const el = t.closest("[data-tip], [title]");
      if (!el) return hide();
      if (el === node) return;
      /* 在同一提示目标内部移动不视为换目标，不重置延迟。 */
      if (node && node.contains(el)) return;

      hide();
      node = el;
      timer = window.setTimeout(() => draw(el), DELAY);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      if (!node) return;
      const to = e.relatedTarget;
      if (to instanceof Node && node.contains(to)) return;
      hide();
    },
    true,
  );

  /* 滚动会使气泡与元素错位，直接隐藏，下次进入重新计算位置。 */
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
