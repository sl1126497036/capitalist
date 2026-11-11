/**
 * 用量读数格式化出口。数据取自 `/api/threads` 每条线程的 `usage`，由服务端解析工作进程日志。
 * 字段缺失写“未上报”而不补 0；左栏与右侧面板共用本模块，组件只负责排版。
 */

import { t } from "./i18n.js";

/**
 * 路由别名。`fast-model` 由宿主在两个 flash 模型间路由，展示时保留原 id，
 * 轮换信息由 `note` 单独标注，不并入名称。
 */
const MODEL_ALIAS = {
  "fast-model": { name: "fast-model", ver: "", note: t("轮换") },
};

/** 模型 id -> `{ name, ver, raw }`；非别名原样展示，连字符与大小写属于 id 本身，不拆分。 */
export function modelOf(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const alias = MODEL_ALIAS[s.toLowerCase()];
  if (alias) return { ...alias, raw: s };
  return { name: s, ver: "", raw: s };
}

/** 模型选项展示名，线程卡与两个模型弹窗共用；原始 id 由调用方放入提示位并按原 id 下发。 */
export function modelLabel(raw) {
  const parsed = modelOf(raw);
  return parsed ? [parsed.name, parsed.ver].filter(Boolean).join(" ") : String(raw || "");
}

export function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * 本根累计消耗的展示文本，左栏与顶栏共用。
 * 按载荷的 `credit_unit` 选择积分或 token；无读数时返回空串。
 */
export function totalUsageText(usage) {
  const u = usage || {};
  if (String(u.credit_unit ?? "").trim()) {
    const c = Number(u.total_credit);
    if (u.total_credit === null || u.total_credit === undefined) return "";
    if (!Number.isFinite(c) || c <= 0) return "";
    return `${Math.round(c).toLocaleString("en-US")} ${t("积分")}`;
  }
  const tok = Number(u.total_tokens);
  if (!Number.isFinite(tok) || tok <= 0) return "";
  return `${fmtTokens(tok)} ${t("token")}`;
}

/**
 * 上下文读数格式化：有分母时把已用夹到分母以内，`over` 为真仍标“超限”。
 * 显示层不加 `≈` 前缀；本模块是唯一的上下文格式化来源。
 */
export function fmtCtx(used, win, over = false) {
  const usedNum = Number(used);
  if (!Number.isFinite(usedNum)) return "";
  const winNum = Number(win);
  const hasWin = Number.isFinite(winNum) && winNum > 0;
  const shown = hasWin ? Math.min(usedNum, winNum) : usedNum;
  const u = `${fmtTokens(shown) || String(shown)}`;
  const w = hasWin ? fmtTokens(winNum) : "";
  const mark = over ? `（${t("超限")}）` : "";
  return w ? `${u}/${w}${mark}` : `${u}${mark}`;
}

/**
 * 额度按“数值 + 单位”格式化，顶栏与左栏共用。单位随宿主而异（积分、token、现金），
 * 现金保留两位小数；格式化只在本模块进行。返回 `{ text, num, unit }`。
 */
export function billParts(n, unit) {
  /* 空值返回空串，供调用方判定该格不显示。 */
  if (n === null || n === undefined || n === "") return { text: "", num: "", unit: "" };
  const v = Number(n);
  if (!Number.isFinite(v)) return { text: "", num: "", unit: "" };
  const u = String(unit || "").toLowerCase();
  if (u === "cny" || u === "rmb" || u === "yuan" || u === "¥" || u === "￥") {
    const s = `¥${v.toFixed(2)}`;
    return { text: s, num: s, unit: "¥" };
  }
  if (u === "usd" || u === "dollar" || u === "dollars" || u === "$") {
    const s = `$${v.toFixed(2)}`;
    return { text: s, num: s, unit: "$" };
  }
  if (u === "token" || u === "tokens" || u === "tok") {
    const num = fmtTokens(v) || String(Math.round(v));
    return { text: `${num} ${t("token")}`, num, unit: t("token") };
  }
  if (u === "credit" || u === "credits" || u === "point" || u === "points" || u === "积分" || u === "点") {
    const num = Math.round(v).toLocaleString("en-US");
    return { text: `${num} ${t("积分")}`, num, unit: t("积分") };
  }
  /* 有值但无单位时按原值输出，不推断单位。 */
  const num = v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return { text: u ? `${num} ${String(unit)}` : num, num, unit: u ? String(unit) : "" };
}

/** 消耗取值优先级：积分、金额（>0）、token。 */
export function spendOf(usage) {
  const u = usage || {};
  /*
   * 积分来自账号级台账，与日志是否可读无关：日志被清理或路径失效时仍要显示已摊算的积分，
   * 因此先于 `reported` 判断。
   */
  if (Number.isFinite(Number(u.credit)) && u.credit !== null) {
    return {
      text: `${Math.round(Number(u.credit)).toLocaleString("en-US")} ${t("积分")}`,
      tip: t(
        "计费接口增量摊算（输入 {a} + 输出 {b} token）；面板未开启期间不摊算",
        { a: fmtTokens(u.input_tokens) || t("未上报"), b: fmtTokens(u.output_tokens) || t("未上报") },
      ),
    };
  }
  if (!u.reported) return { text: "", tip: String(u.unavailable_reason || t("这条线程没有用量读数")) };
  if (u.billing_unit === "usd" && Number(u.cost_usd) > 0) {
    return { text: `$${Number(u.cost_usd).toFixed(2)}`, tip: t("金额取自日志 result 行的 total_cost_usd") };
  }
  if (Number.isFinite(Number(u.total_tokens))) {
    /*
     * `credit_metered` 下的积分读数由计费接口增量摊算；接口返回 0 时 `credit` 为 null，
     * 此时不回落 token（token 为会话累计），按“未上报”处理。
     */
    if (u.credit_metered) {
      return {
        text: "",
        tip: t(
          "按积分计费，本线程未分摊到读数；输入 {a} + 输出 {b} token",
          { a: fmtTokens(u.input_tokens) || t("未上报"), b: fmtTokens(u.output_tokens) || t("未上报") },
        ),
      };
    }
    return {
      text: `${fmtTokens(u.total_tokens)} ${t("token")}`,
      tip: t(
        "输入 {a} + 输出 {b}；缓存命中 {c} 单列，不计入总量",
        {
          a: fmtTokens(u.input_tokens) || t("未上报"),
          b: fmtTokens(u.output_tokens) || t("未上报"),
          c: fmtTokens(u.cache_read_tokens) || t("未上报"),
        },
      ),
    };
  }
  return { text: "", tip: t("这条读数有用量但没有 token 字段") };
}
