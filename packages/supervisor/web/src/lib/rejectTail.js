/** 被拒徽章的拒因回落链；保持零依赖，避免引入 fmt.js 的 vue 依赖影响 node 单测。 */

export function rejectTail(reason, detail) {
  const r = String(reason ?? "").trim();
  if (r) return r;
  return String(detail ?? "").trim();
}
