/**
 * 分栏宽度换算，只做算术。拖动宽度按指针绝对位移计算：
 * width = startWidth + (x - startX)，不以相对父容器的位置为起点。
 */

/** 宽度夹到 [min, max]；非法输入回落到默认宽度。 */
export function clampWidth(px, min, max, fallback) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 拖动中的新宽度。
 *
 * @param {{startX:number,startWidth:number,x:number,min:number,max:number}} p
 */
export function dragWidth({ startX, startWidth, x, min, max }) {
  const dx = Number(x) - Number(startX);
  const base = Number(startWidth);
  if (!Number.isFinite(dx) || !Number.isFinite(base)) return clampWidth(NaN, min, max, min);
  return clampWidth(base + dx, min, max, min);
}
