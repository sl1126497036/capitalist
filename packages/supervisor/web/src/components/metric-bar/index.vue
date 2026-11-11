<script setup>
/**
 * 监工指标条：运行 / 排队 / 异常 / 已验收与并行分子读 /api/supervisor.tasks 的聚合，与左栏、顶栏同源。
 * 接口缺项显示“—”，不按 0 处理。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { fmtTokens, modelLabel } from "../../lib/usage.js";
import { t } from "../../lib/i18n.js";
import { loadModels, setSupervisorModel, setConcurrency } from "../../lib/models.js";

const props = defineProps({
  /** `/api/supervisor`：running / queued / tasks / usage 都从这里来。 */
  capitalist: { type: Object, default: () => ({}) },
  /** 指令按任务根下发（/api/capitalist-command 的 root）；多监工时各面板只作用于自己的根。 */
  root: { type: String, default: "" },
  /** 上层传入时以它为准，否则回落 /api/supervisor 的 paused；接口有缓存，成功后由上层先上屏。 */
  paused: { type: Boolean, default: null },
});

const emit = defineEmits(["pause", "refresh"]);

const busy = ref(false);
const note = ref("");
const noteBad = ref(false);
let noteTimer = 0;

/** 操作回执：成功不上屏（界面状态已体现），失败显示 6 秒。 */
function flash(text, bad = false) {
  clearTimeout(noteTimer);
  if (!bad) {
    note.value = "";
    return;
  }
  note.value = text;
  noteBad.value = true;
  noteTimer = setTimeout(() => (note.value = ""), 6000);
}

const paused = computed(() => (props.paused === null ? Boolean(props.capitalist?.paused) : props.paused));

/** 进入加载态防止重复下发，请求返回后才退出。 */
const pausePending = ref("");

const pauseLabel = computed(() => {
  if (pausePending.value === "resume") return t("恢复中…");
  if (pausePending.value === "pause") return t("停止中…");
  return paused.value ? t("恢复调度") : t("停止调度");
});

/**
 * 刚切换成功的目标模型（`""` 为宿主默认）：轮询把 supervisor_model 带回来之前先用它显示。
 * 不这样做，蒙版撤掉时顶栏仍停在旧模型，看起来像是“关了蒙版还要再等一会儿”。
 */
const modelPending = ref(null);

/** 监工对话层模型只来自 supervisor_model，与派单模型互不回落；已提交但未回读时以所选值为准。 */
const rawModel = computed(() => {
  const seen = String(props.capitalist?.supervisor_model || "").trim();
  if (modelPending.value !== null && modelPending.value !== seen) return modelPending.value;
  return seen;
});

/* 观测值追上所选值后放开，回到服务端读数。 */
watch(
  () => String(props.capitalist?.supervisor_model || "").trim(),
  (v) => {
    if (modelPending.value !== null && modelPending.value === v) modelPending.value = null;
  },
);

/** 切换在途：值为正在切换的目标模型（"" 为宿主默认），null 为空闲。期间面板铺蒙版、各行禁用。 */
const modelBusy = ref(null);

/** 显式指定的监工模型；空 = 宿主默认。列表打勾用。 */
const supervisorCur = rawModel;

/** 宿主自己配置的默认模型（`/api/models` 的 default_model，取自宿主的 settings.json）。 */
const hostModelsDefault = ref("");

/** 宿主默认模型：优先取宿主配置的 model，清单未加载时取监工接口的观测值。 */
const hostDefault = computed(
  () => hostModelsDefault.value || String(props.capitalist?.model || "").trim(),
);

/** 按原 id 展示；路由别名换算成实际模型，解析不出来就原样显示。 */
const modelLabelText = computed(() => {
  /* 未显式指定时显示默认的具体模型，与弹层标“默认”的那行一致。 */
  const raw = rawModel.value || hostDefault.value;
  if (!raw) return t("宿主默认");
  return modelLabel(raw);
});

/** 发监工指令，失败抛出带原因的 Error；忙碌态与回执由调用方管理。 */
async function command(action) {
  const r = await fetch("./api/capitalist-command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, root: props.root || undefined }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || d.reason || `HTTP ${r.status}`);
  return d;
}

async function post(action) {
  if (busy.value) return;
  busy.value = true;
  try {
    const d = await command(action);
    flash(d.effective || t("指令已登记，下一轮调度生效"), false);
  } catch (e) {
    flash(t("操作未生效：{m}", { m: e instanceof Error ? e.message : String(e) }), true);
  } finally {
    busy.value = false;
  }
}

/** 成功后立即 emit 目标态上屏，不等轮询（接口有缓存），随后以服务端值为准；失败清除加载态并上屏原因。 */
async function togglePause() {
  if (busy.value) return;
  const action = paused.value ? "resume" : "pause";
  pausePending.value = action;
  busy.value = true;
  try {
    const d = await command(action);
    emit("pause", action === "pause");
    emit("refresh");
    flash(d.effective || t("指令已登记，下一轮调度生效"), false);
  } catch (e) {
    flash(t("操作未生效：{m}", { m: e instanceof Error ? e.message : String(e) }), true);
  } finally {
    busy.value = false;
    pausePending.value = "";
  }
}

/** 重启按 root 作用于当前监工。 */
const confirmAsk = ref(null);

function confirmYes() {
  const run = confirmAsk.value?.run;
  confirmAsk.value = null;
  run?.();
}

function restartSupervisor() {
  confirmAsk.value = {
    title: t("重启监工"),
    text: t("当前进程立即退出，正在执行的工作进程一并结束；新进程随后自动拉起。任务记录、阶段与看板地址都不变。"),
    ok: t("重启"),
    danger: false,
    /* 先铺蒙版再发请求：监工收到命令即退场，期间界面无反馈；事件由 App 接住铺满视口，/api/supervisor 恢复后撤除。 */
    run: () => {
      window.dispatchEvent(new CustomEvent("capitalist:restarting"));
      return post("restart");
    },
  };
}

/* 此处更换监工对话层模型（supervisor.json 的 supervisor_model），下一轮调用生效；输入区下拉更换派单模型。 */
const modelOpen = ref(false);
/* 指标条在顶部，弹层向下展开，落点取 top。 */
const modelPos = ref({ left: 0, top: 0 });
const modelBtnEl = ref(null);
const hostModels = ref([]);
const modelNote = ref("");
const modelLoading = ref(false);

async function ensureModels() {
  modelLoading.value = true;
  try {
    const v = await loadModels();
    hostModels.value = v.models;
    hostModelsDefault.value = v.default_model || "";
    modelNote.value = v.reason || "";
  } finally {
    modelLoading.value = false;
  }
}

async function toggleModels() {
  modelOpen.value = !modelOpen.value;
  if (!modelOpen.value) return;
  const r = modelBtnEl.value?.getBoundingClientRect();
  if (r) modelPos.value = { left: r.left, top: r.bottom + 6 };
  if (!hostModels.value.length) void ensureModels();
}

/** 点空白处关闭：用 pointerdown 捕获阶段，并排除 .mpick / .mval，否则 click 会再次打开弹层。 */
function onDocDown(e) {
  if (!modelOpen.value && !concOpen.value) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest(".mpick") || t.closest(".mval")) return;
  modelOpen.value = false;
  concOpen.value = false;
}

onMounted(() => document.addEventListener("pointerdown", onDocDown, true));
onUnmounted(() => document.removeEventListener("pointerdown", onDocDown, true));

async function pickSupervisorModel(m) {
  const val = String(m || "");
  /* 请求在途时不接受第二次点击：面板已被蒙版盖住，这里再兜一层。 */
  if (modelBusy.value !== null) return;
  modelBusy.value = val;
  try {
    const res = await setSupervisorModel(props.root, val);
    /* 先让所选值上屏，再关面板：蒙版撤掉时顶栏已经是新模型，中间不留空窗。 */
    modelPending.value = val;
    emit("refresh");
    modelOpen.value = false;
    /* 两分钟超时放开：重派未发生时观测值追不上所选值，超时后回到服务端读数。 */
    setTimeout(() => {
      if (modelPending.value === val) modelPending.value = null;
    }, 120_000);
    flash(res.effective || t("模型已切换"), false);
  } catch (e) {
    modelNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    modelBusy.value = null;
  }
}

function shutdown() {
  confirmAsk.value = {
    title: t("关停监工"),
    text: t("进程立即退出，正在执行的工作进程一并结束。恢复需要重新执行 capitalist supervise。"),
    ok: t("关停"),
    danger: true,
    run: () => post("stop"),
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const count = (v) => {
  const n = num(v);
  return n === null ? "—" : n.toLocaleString("en-US");
};
const tokens = (v) => {
  const n = num(v);
  if (n === null) return "—";
  return fmtTokens(n) || String(n);
};

/** 任务统计读 /api/supervisor 的 tasks，与左栏筛选、顶栏同源。 */
const taskStats = computed(() => props.capitalist?.tasks || {});
const stat = (k) => (Number.isFinite(Number(taskStats.value?.[k])) ? Number(taskStats.value[k]) : null);

const run = computed(() => stat("running"));

/** 并行度上限取监工写入的 max_workers（--workers 或面板指令值）。 */
const par = computed(() => {
  const n = num(props.capitalist?.parallel);
  return n === null ? null : n;
});

const usage = computed(() => props.capitalist?.usage || {});

/* 并行度经监工既有的 concurrency 指令通道（/api/capitalist-command）提交，与命令行等价；非正整数不提交。 */
const concOpen = ref(false);
const concVal = ref("");
const concBtnEl = ref(null);
const concEl = ref(null);
const concPos = ref({ left: 0, top: 0 });
let concAnchorRect = null;

/** 输入合法当且仅当是 ≥1 的整数；空串单独提示“未填写”。 */
const concN = computed(() => (/^\d+$/.test(String(concVal.value).trim()) ? Number(String(concVal.value).trim()) : null));
const concInvalid = computed(() => concN.value === null || concN.value < 1);

function openConc() {
  if (par.value === null) return;
  concVal.value = String(par.value);
  /* v-for 内的 ref 在 Vue 里是数组（ref_for: true），须按数组取值，否则 getBoundingClientRect 抛错。 */
  const el = Array.isArray(concBtnEl.value) ? concBtnEl.value[0] : concBtnEl.value;
  concAnchorRect = el?.getBoundingClientRect() || null;
  /* 先给贴按钮下缘的初值，避免首帧浮层出现在左上角；渲染完成后按实际尺寸修正。 */
  if (concAnchorRect) concPos.value = { left: concAnchorRect.left, top: concAnchorRect.bottom + 6 };
  concOpen.value = true;
  void nextTick(placeConc);
}

/** 按渲染后的实际宽高把浮层夹回视口内（留 8px 边距），下方放不下就翻到按钮上方。 */
function placeConc() {
  const r = concAnchorRect;
  if (!r) return;
  const w = concEl.value?.offsetWidth || 200;
  const h = concEl.value?.offsetHeight || 150;
  const edge = 8;
  const gap = 6;
  const left = Math.min(Math.max(edge, r.left), Math.max(edge, window.innerWidth - w - edge));
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - edge) top = Math.max(edge, r.top - h - gap);
  concPos.value = { left, top };
}

/* 步进按钮只加减 1，上限由执行侧裁决。 */
function stepConc(d) {
  const base = concN.value ?? par.value ?? 1;
  concVal.value = String(Math.max(1, base + d));
}

async function submitConc() {
  if (concInvalid.value || busy.value) return;
  try {
    const res = await setConcurrency(props.root, concN.value);
    concOpen.value = false;
    flash(res.effective || "", false);
  } catch (e) {
    /* 后端拒绝时回显原因，浮层保留。 */
    flash(t("操作未生效：{m}", { m: e instanceof Error ? e.message : String(e) }), true);
  }
}

/* 读数按任务进程、流量与上下文两组排列，组间用 sep 分隔线。 */
const cells = computed(() => [
  {
    k: t("并行"),
    /* 分子（当前运行数）与分母（并行度上限）分别上色，走模板的 vparts 分段渲染。 */
    v: par.value === null ? "—" : `${run.value === null ? "—" : run.value}/${par.value}`,
    vparts:
      par.value === null || run.value === null
        ? null
        : [{ t: String(run.value), cls: "run" }, { t: `/${par.value}` }],
    na: par.value === null,
    btn: par.value !== null,
    tip: par.value === null ? t("未取得并行度") : t("调整并行度"),
  },
  {
    k: t("排队中"),
    v: count(stat("queued")),
    tone: "warn",
    na: stat("queued") === null,
    tip: t("已派出、还未领取的派单数（与左栏“排队”同一份统计）"),
  },
  {
    k: t("异常"),
    v: count(stat("failed")),
    tone: (stat("failed") ?? 0) > 0 ? "bad" : "",
    na: stat("failed") === null,
    tip: t("失败、丢失、孤立或已消失的线程数（与左栏“异常”同一份统计）"),
  },
  {
    k: t("已验收"),
    v: count(stat("accepted")),
    tone: "ok",
    na: stat("accepted") === null,
    tip: t("验收通过的项数"),
  },
  { sep: true },
  {
    k: t("上行"),
    v: tokens(usage.value.total_input_tokens),
    tone: "vio",
    na: num(usage.value.total_input_tokens) === null,
    tip: t("当前任务全部工作进程的累计输入用量"),
  },
  {
    k: t("下行"),
    v: tokens(usage.value.total_output_tokens),
    tone: "vio",
    na: num(usage.value.total_output_tokens) === null,
    tip: t("当前任务全部工作进程的累计输出用量"),
  },
]);
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
