<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { THEMES, setTheme, themeById, themeId } from "../../lib/theme.js";
import { lang, t, toggleLang } from "../../lib/i18n.js";
import BrandLogo from "../brand-logo";
import OverviewStrip from "../overview-strip";
const props = defineProps({
  online: { type: Boolean, default: false },
  /** 离线原因：lost 心跳失联 / ended 上一轮已结束 / never 未启动。在线时为空。 */
  state: { type: String, default: "" },
  detail: { type: String, default: "" },
  running: { type: Number, default: 0 },
  port: { type: String, default: "7788" },
  /** 当前任务根。不传则让服务端用默认根，与 App 的默认选中一致。 */
  root: { type: String, default: "" },
  /** 取数层下发的通道态：live / degraded / online / fail / connecting。留空表示由本组件自测。 */
  conn: { type: String, default: "" },
  /** 配合 conn="fail"：连续失败次数。 */
  fails: { type: Number, default: 0 },
  /** 当前根的暂停态；App 传了就以它为准，本组件自测只拉默认根。 */
  paused: { type: Boolean, default: null },
  /** /api/overview ：跨监工读数条的数据源，由 App 传入。 */
  overview: { type: Object, default: null },
  /** 当前宿主 id（worker_host）。与标签同时为空时顶栏不显示该胶囊。 */
  host: { type: String, default: "" },
  /** 当前宿主在注册表里的显示名；未注册宿主为空，此时回落显示 id。 */
  hostLabel: { type: String, default: "" },
});

/* 标签优先，缺失时回落显示 id：未注册宿主只有 id，此时显示 id 值。 */
const hostText = computed(() => props.hostLabel || props.host);

const selfPaused = ref(false);
const pausedAlive = ref(0);
/* App 传了 paused 就以它为准；自测只拉默认根。 */
const paused = computed(() => (props.paused === null ? selfPaused.value : props.paused));

const selfConn = ref("connecting");
const selfFails = ref(0);
const connState = computed(() => props.conn || selfConn.value);
const connFails = computed(() => (props.conn ? props.fails : selfFails.value));
const connBad = computed(() => connState.value === "fail");
const connText = computed(() => {
  const s = connState.value;
  if (s === "live") return t("已连接");
  if (s === "degraded") return t("降级 轮询");
  if (s === "online") return t("在线");
  if (s === "fail") return t("连接失败（第 {n} 次）", { n: connFails.value });
  return t("连接中…");
});

function metricsUrl() {
  return props.root ? `./api/metrics?root=${encodeURIComponent(props.root)}` : "./api/metrics";
}

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const r = await fetch(metricsUrl(), { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    selfPaused.value = Boolean(d.paused);
    pausedAlive.value = Number.isFinite(Number(d.alive)) ? Number(d.alive) : 0;
    selfConn.value = "online";
    selfFails.value = 0;
  } catch {
    /* 取数失败时保留上一次的暂停态，只把通道标成失败。 */
    selfFails.value += 1;
    selfConn.value = "fail";
  } finally {
    polling = false;
  }
}

/* 在线状态显示运行中的进程数；离线状态按原因分别显示提示。 */
const nodeText = computed(() => {
  if (props.online) return t("监工在线 {n} 个进程运行中", { n: props.running });
  if (props.state === "lost") return t("监工心跳失联");
  if (props.state === "ended") return t("上一轮已结束");
  return t("监工未启动");
});

function pickStyle(s) {
  if (s.id === themeId.value) return;
  setTheme(s.id);
}

/**
 * 构建期由 vite 注入的版本号与仓库地址。
 *
 * 用 typeof 保护：未经 vite 构建（例如直接读源码的单测）时这两个标识符不存在，
 * 直接引用会抛 ReferenceError，导致整个头部渲染失败。
 */
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const REPO_URL = typeof __APP_REPO__ === "string" ? __APP_REPO__ : "";

const acctOpen = ref(false);
const menuBox = ref(null);function onDocClickMenu(e) {
  if (!acctOpen.value) return;
  if (menuBox.value && !menuBox.value.contains(e.target)) acctOpen.value = false;
}

/** 暂停按「在线 + 暂停」两条件成立判定；仅在线为假时才是真的不在线。 */
const pausedOnline = computed(() => props.online && paused.value);
const abnormal = computed(
  () => !props.online || pausedOnline.value || connBad.value || connState.value === "degraded",
);
/** 右侧 chip 不含暂停态：暂停与连接故障同时发生时两根都要可见。 */
const connAbnormal = computed(
  () => !props.online || connBad.value || connState.value === "degraded",
);
const abnormalText = computed(() => {
  /* 连接故障时优先显示该状态：此时无法取得监工状态，不沿用上一次的值。 */
  if (connBad.value) return connText.value;
  if (!props.online) return nodeText.value;
  if (pausedOnline.value) return t("已暂停调度");
  return connText.value;
});
/** 红点仅标记连接故障；暂停用黄点。 */
const abnormalBad = computed(() => !props.online || connBad.value);

function needSelf() {
  return props.paused === null || !props.conn || paused.value;
}

let pollTimer = 0;
onMounted(() => {
  if (needSelf()) poll();
  pollTimer = setInterval(() => {
    if (needSelf()) poll();
  }, 3000);
  document.addEventListener("click", onDocClickMenu);
});
onUnmounted(() => {
  clearInterval(pollTimer);
  document.removeEventListener("click", onDocClickMenu);
});
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
