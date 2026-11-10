/**
 * 切换只改 `<html data-theme>`，色值由 styles/themes.css 的令牌提供，组件不存颜色。
 * 持久化到 localStorage['capitalist.theme']；main.js 在挂载前调用 initTheme，避免首帧使用默认色。
 * URL 参数 `?theme=` 仅用于预览且不写盘，显式选择后才持久化。
 */
import { ref } from "vue";

const KEY = "capitalist.theme";
const DEFAULT = "nebula";

/** 浅色主题集合，供原生控件与 antd 算法判断。 */
const LIGHT_IDS = new Set(["dawn", "mist"]);

export function isLightTheme(id) {
  return LIGHT_IDS.has(id);
}

/*
 * `sw` 为每套主题自带的小样，不随当前主题切换；色值内联，与 data-theme 无关。
 * 顺序固定为底色 / 主色 / 深色。
 */
export const THEMES = [
  { id: "nebula", label: "星云深空", en: "Nebula", sw: ["#172140", "#6b9dff", "#a78bfa"] },
  { id: "mist", label: "薄雾灰", en: "Mist", sw: ["#e3e2dd", "#3d6180", "#20272e"] },
  { id: "cyan", label: "冷青终端", en: "Cyan Terminal", sw: ["#0a2430", "#3ad2e6", "#081820"] },
  { id: "dawn", label: "晨光白", en: "Dawn", sw: ["#edf1f7", "#4b5fe0", "#101a28"] },
];

const IDS = new Set(THEMES.map((t) => t.id));

function fromQuery() {
  try {
    const p = new URLSearchParams(location.search).get("theme");
    return p && IDS.has(p) ? p : "";
  } catch {
    return "";
  }
}

function fromStore() {
  try {
    const v = localStorage.getItem(KEY);
    return v && IDS.has(v) ? v : "";
  } catch {
    return "";
  }
}

/** 当前主题 id，模板直接读取以同步下拉选中态。 */
export const themeId = ref(DEFAULT);

/** 写入 <html>：data-theme 供 CSS，colorScheme 供原生控件。 */
export function applyTheme(id, { persist = true } = {}) {
  const next = IDS.has(id) ? id : DEFAULT;
  const root = document.documentElement;
  root.setAttribute("data-theme", next);
  /* 浅色主题需同步 colorScheme，使原生滚动条、autofill 与日期选择器一并切换。 */
  root.style.colorScheme = isLightTheme(next) ? "light" : "dark";
  /* 先改 DOM 再改响应式值：ChatPane 的 antd 主题依赖 computed(themeId) 读取新样式，顺序颠倒会取到上一套色值。 */
  themeId.value = next;
  if (persist) {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* 隐私模式下写入失败仅影响下次加载，本会话仍生效，刷新回落默认。 */
    }
  }
}

/** 启动取值优先级：URL 预览、持久化值、默认。 */
export function initTheme() {
  applyTheme(fromQuery() || fromStore() || DEFAULT, { persist: false });
}

/** 显式选择立即生效并持久化。 */
export function setTheme(id) {
  applyTheme(id, { persist: true });
}

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}
