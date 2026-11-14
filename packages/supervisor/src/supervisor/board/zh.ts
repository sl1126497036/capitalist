/**
 * 看板文案转换器：把内部枚举交给 terms.ts 的术语表，取不到时原样返回。
 *
 * 前端复用同一份术语表，这里只做一层容错包装，避免各处自行写映射。
 */

import { zhCommandLabel, zhContractKind, zhStatus } from "../terms";

export function zhCall(fn: unknown, value: unknown, extra?: unknown): string {
  if (typeof fn !== "function") return String(value ?? "");
  try {
    return String((fn as (v: unknown, e?: unknown) => unknown)(value, extra) ?? "");
  } catch {
    return String(value ?? "");
  }
}

export const zh = {
  status: (v: unknown): string => zhCall(zhStatus, v),
  cmd: (a: unknown, u?: unknown): string => zhCall(zhCommandLabel, a, u),
  kind: (k: unknown): string => zhCall(zhContractKind, k),
};

