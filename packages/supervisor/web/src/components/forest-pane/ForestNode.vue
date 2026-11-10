<script setup>
/**
 * 节点卡片，靠 SFC 自引用递归渲染。层级由 index.vue 的 nest() 还原，
 * 本组件只负责父上子下、兄弟并排的排版。
 */
import { t } from "../../lib/i18n.js";
import { hhmm, dur } from "../../lib/fmt.js";

defineProps({
  /** { node, kids }：node 为后端下发的节点视图，kids 为同形状子项。 */
  item: { type: Object, required: true },
});

/** 标题加后端下发的任务编号 `#NN ` 前缀，与左栏任务行、监工对话同源；无编号时保留原标题。 */
function ntitle(node) {
  const t = node.title || node.id;
  return node.no ? `#${node.no} ${t}` : t;
}

/**
 * 未启动派单的 `started_at` 由后端回填为建单时刻，直接显示会被误读为已运行；
 * 仅已启动状态显示时间读数。
 */
function started(node) {
  const s = String(node.state || "");
  return s === "running" || s === "review" || s === "done" || s === "failed" || s === "closed";
}

/** 启动时刻（HH:MM），与左栏任务卡共用格式化口径。 */
function atText(node) {
  return hhmm(String(node.started_at || ""));
}

/**
 * 运行时长：运行中派单无 `ended_at`，按当前时刻计算；终态用结束时刻。
 * 与左栏任务卡共用同一算路。
 */
function durText(node) {
  const start = Date.parse(String(node.started_at || ""));
  if (!Number.isFinite(start) || start <= 0) return "";
  const end = Date.parse(String(node.ended_at || ""));
  const to = Number.isFinite(end) && end > 0 ? end : Date.now();
  return dur(Math.max(0, Math.round((to - start) / 1000)));
}
</script>

<template>
  <div class="fv-col">
    <div
      class="fv-node"
      :class="[item.node.state, { cut: item.node.blocked && item.node.state !== 'failed', cycle: item.node.inCycle }]"
    >
      <div class="fv-nl1">
        <i class="fv-dot" :class="item.node.state" />
        <span class="fv-ntitle">{{ ntitle(item.node) }}</span>
      </div>
      <div class="fv-nmeta">
        <span v-if="started(item.node)" class="fv-tm">
          <em>{{ t("启动") }}</em>
          <b :class="{ dim: !atText(item.node) }">{{ atText(item.node) || t("未记录") }}</b>
        </span>
        <span v-if="started(item.node)" class="fv-tm">
          <em>{{ t("耗时") }}</em>
          <b :class="{ dim: !durText(item.node) }">{{ durText(item.node) || t("无采样") }}</b>
        </span>
        <span class="fv-tm fv-tmmodel">
          <em>{{ t("模型") }}</em>
          <b :class="{ dim: !item.node.model }">{{ item.node.model || t("未记录") }}</b>
        </span>
        <span v-if="item.node.retries" class="warn">{{ t("重派 {n} 次", { n: item.node.retries }) }}</span>
        <span v-if="item.node.childCount">{{ t("{n} 个子单", { n: item.node.childCount }) }}</span>
      </div>

      <p v-if="item.node.state === 'failed'" class="fv-nreason">
        {{ t("失败原因：{why}", { why: item.node.reason || t("台账未记录") }) }}
      </p>
      <p v-if="item.node.state === 'failed'" class="fv-nflag">
        {{ item.node.childCount ? t("断链 其下子树无法推进") : t("断链") }}
      </p>
      <p v-else-if="item.node.inCycle" class="fv-nflag">{{ t("成环 无可达根节点") }}</p>
      <p v-else-if="item.node.blocked" class="fv-nflag">{{ t("受 #{id} 断链影响", { id: item.node.blockedBy }) }}</p>
      <p v-else-if="item.node.state === 'waiting'" class="fv-nwait">{{ t("卡在 #{id}", { id: item.node.stuckOn }) }}</p>
    </div>

    <div v-if="item.kids.length" class="fv-kids">
      <ForestNode v-for="k in item.kids" :key="k.node.id" :item="k" />
    </div>
  </div>
</template>

<style scoped src="./node.css"></style>
