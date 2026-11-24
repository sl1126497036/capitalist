/**
 * 用户消息的送达档位与合并口径。
 *
 * 档位由服务端 `delivery` 下发，界面只按码出词；`status` 文案仅供展示，不参与判定。
 *
 * 本模块不依赖界面运行时，界面与测试共用同一判据。
 */

/** 档位次序：未送达 2，已送达 1，待送达 0。 */
function rank(tone) {
  return tone === "bad" ? 2 : tone === "ok" ? 1 : 0;
}

/**
 * 消息的送达档位：`ok` 已送达，`pending` 待送达，`bad` 未送达。
 *
 * 缺字段按待送达：本地回显在服务端落库前没有档位，此时尚未送达。
 */
export function deliveryOf(m) {
  const d = String(m?.delivery || "");
  return d === "bad" || d === "ok" ? d : "pending";
}

/**
 * 同一条消息两次下发时的取舍。
 *
 * 常规情况整条取新对象。用户插话例外：档位只前进不后退，旧对象带回的待送达不能把已送达
 * 覆盖回去，否则尾标在两个词之间来回切换。回退时把 `delivery` 与 `status` 一起保留，
 * 短词与悬停文案须保持一致。
 */
export function mergeInterject(oldM, newM) {
  const interject = String(oldM?.role || "") === "user" && String(oldM?.kind || "") === "say";
  if (!interject) return newM;
  if (rank(deliveryOf(newM)) >= rank(deliveryOf(oldM))) return newM;
  return { ...newM, delivery: oldM.delivery, status: oldM.status };
}
