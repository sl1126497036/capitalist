/**
 * 自然语言调度解析（`instruct`），已废弃，因看板入口仍引用而保留，不新增能力。
 * 确定性解析：词典 + 子串匹配 + 打分，只产出动作计划，不执行；执行在 `loop.ts` 的 调度循环中完成。
 * 一次只出一个动作，只作用于当前阶段，不改写契约与派单内容；识别不出时返回候选清单。
 */

import type { Stage } from "../../core/types";

export interface InstructCandidate {
  id: string;
  name: string;
  /** 命中的词，用于说明匹配依据。 */
  hits: string[];
}

export type InstructPlan =
  | { kind: "pause"; reason: string; detail: string }
  | { kind: "resume"; reason: string; detail: string }
  | { kind: "skip"; stage: string; stageName: string; reason: string; detail: string }
  | { kind: "set-next"; arg: string; reason: string; detail: string }
  | { kind: "concurrency"; arg: string; reason: string; detail: string }
  | { kind: "retry"; arg: string; reason: string; detail: string }
  | { kind: "ask"; arg: string; reason: string; detail: string }
  | { kind: "clarify"; reason: string; detail: string; candidates: InstructCandidate[] };

/** 同义词组：命中组内任一词即把整组作为检索词，覆盖契约阶段名与输入用词不一致的情况。 */
const ALIAS: readonly (readonly string[])[] = [
  ["ui", "界面", "看板", "前端", "页面", "布局", "外壳", "样式", "视觉", "配色", "主题", "交互", "渲染", "对话区", "截图"],
  ["派单", "调度", "派发", "并行", "并发", "队列", "重派"],
  ["任务列表", "提示词", "门槛", "验收", "检查", "判据"],
  ["进程", "worker", "孤儿", "生命周期", "退出", "回收"],
  ["数据", "推流", "轮询", "缓存", "接口", "通路"],
];

/** 停用词，不参与匹配。 */
const STOPWARDS = new Set([
  "任务", "相关", "都停", "停掉", "停止", "停下", "不要", "别做", "先不", "暂缓",
  "所有", "全部", "一切", "这些", "那些", "这个", "那个", "一下", "已经", "还需",
  "把", "的", "了", "和", "跟", "与", "我让", "你让", "他说", "说过", "要求",
]);

const RE_STOP = /停|暂停|别做|不要|先不|暂缓|搁置|搁|刹车|halt|stop|abort|kill/i;
const RE_RESUME = /继续|恢复|接着|resume|go\s*on|往下/i;
const RE_NEXT = /接下来|下一步|然后|改为|改成|转去做|优先做/i;

/**
 * 展开检索词。中文无空格，长句切成 2–4 字滑动窗口；
 * 停用词与后续打分用于过滤噪声。
 */
export function expandTerms(text: string): string[] {
  const raw = String(text ?? "").toLowerCase();
  const out = new Set<string>();

  for (const w of raw.split(/[\s,，。、;；:：!！?？()（）"'“”《》\[\]【】]+/)) {
    const t = w.trim();
    if (t.length >= 2) out.add(t);
  }

  const chars = raw.replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= chars.length; i += 1) out.add(chars.slice(i, i + n));
  }

  for (const group of ALIAS) {
    if (group.some((k) => raw.includes(k))) for (const k of group) out.add(k);
  }

  return [...out].filter((w) => w.length >= 2 && !STOPWARDS.has(w));
}

export interface InstructInput {
  text: string;
  stages: Stage[];
  /** 当前阶段 id */
  currentStage: string;
  /** 各阶段的分片，由调用方展平后传入。 */
  shards: { stage: string; id: string; action: string }[];
}

/**
 * 阶段参与匹配的文本：名字、目标、下一步及各分片的 id 与 action。
 * 分片 action 通常信息量最大，须纳入检索范围。
 */
function stageHaystack(stage: Stage, shards: { id: string; action: string }[]): string {
  const parts = [stage.id, stage.name, stage.goal ?? "", stage.next ?? ""];
  for (const s of shards) parts.push(s.id, s.action);
  return parts.join(" ").toLowerCase();
}

/**
 * 解析自然语言为单个动作计划。判定优先级：pause -> resume -> set-next -> skip -> clarify；
 * 前一条命中即停止。仅能唯一定位到当前阶段时才产出 skip，否则返回候选清单。
 */
export function planInstruct(input: InstructInput): InstructPlan {
  const text = String(input.text ?? "").trim();
  if (!text) {
    return { kind: "clarify", reason: "内容为空", detail: "请写明要执行的操作，例如“把 UI 相关的任务都停掉”", candidates: [] };
  }

  const byStage = new Map<string, { id: string; action: string }[]>();
  for (const s of input.shards) {
    const list = byStage.get(s.stage) ?? [];
    list.push({ id: s.id, action: s.action });
    byStage.set(s.stage, list);
  }

  const terms = expandTerms(text);
  const scored = input.stages.map((stage) => {
    const hay = stageHaystack(stage, byStage.get(stage.id) ?? []);
    const hits = terms.filter((t) => hay.includes(t));
    return { stage, hits, score: hits.length };
  });

  const wanted = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const cur = scored.find((x) => x.stage.id === input.currentStage);

  const candidates = (): InstructCandidate[] =>
    wanted.slice(0, 5).map((x) => ({ id: x.stage.id, name: x.stage.name, hits: x.hits.slice(0, 4) }));

  /* 先匹配明确动作与参数，再走停 / 续 / 改的模糊匹配。 */
  const conc = /(?:并发|并行度|并行数|同时跑|并行)\D{0,6}(\d{1,2})/.exec(text);
  if (conc) {
    return {
      kind: "concurrency",
      arg: conc[1] as string,
      reason: "识别到“并行度 + 数字”",
      detail: `并行度调为 ${conc[1]}（下一次派单的槽位数以此计算）`,
    };
  }

  if (/(?:重派|重跑|重试|再派一次|再跑一遍|重新跑)/.test(text)) {
    // 分片名取契约中出现的 id。
    const hit = input.shards.find((sh) => text.includes(sh.id));
    return {
      kind: "retry",
      arg: hit ? hit.id : "",
      reason: hit ? `识别到“重派”+ 分片 ${hit.id}` : "识别到“重派”，但未指明分片",
      detail: hit ? `重派分片 ${hit.id}` : "重派：未指明分片，请补充分片名",
    };
  }

  // 问句判定优先于停止与恢复。
  if (/(?:^|那|现在|问|啥|什么|为什么|怎么|哪)/.test(text) && /(?:情况|进展|进度|状态|卡在|怎么样|多少|哪一步|跑到)/.test(text)) {
    return {
      kind: "ask",
      arg: text,
      reason: "识别到提问",
      detail: "这是提问：只回答，不暂停派单、不改下一步、不动门槛",
    };
  }

  const isStop = RE_STOP.test(text);
  const isResume = RE_RESUME.test(text);
  const isNext = RE_NEXT.test(text);

  if (isResume && !isStop) {
    return {
      kind: "resume",
      reason: "识别到“继续/恢复”",
      detail: "恢复派单：下一轮起重新开单",
    };
  }

  if (isNext && !isStop) {
    /*
     * `arg` 保留原文供调度层流转；派单前由对话层整理为结构完整、无歧义的提示词。
     * 语言一致性要求追加在任务说明末尾；排序与依赖等调度说明留在对话层，不写入工作进程提示词。
     */
    return {
      kind: "set-next",
      arg: text,
      reason: "识别到“接下来/改成”（原话登记，派单前由对话层整理）",
      detail:
        `原话已登记：${text}。派单前对话层要把它整理成结构完整、无歧义的提示词，` +
        "理解不透先向用户澄清，不许原样转发；排序、依赖等调度说明由对话层自己执行，不写入单子。" +
        "组单时在任务说明末尾追加语言一致性要求：以用户当前使用的语言写作，语言跟随用户实际语言，不固定为某一种。" +
        "该设置只影响整阶段补派的派单，有分片的阶段不受影响——要停止某类任务用“停掉…”",
    };
  }

  if (!isStop) {
    return {
      kind: "clarify",
      reason: "未识别出目标动作",
      detail: `原话已登记：${text}`,
      candidates: candidates(),
    };
  }

  // “全部 / 都停”且未指向具体阶段时暂停派单。
  const allScope = /全部|所有|一切|统统|都停|全停|全都/.test(text);
  if (allScope && wanted.length === 0) {
    return { kind: "pause", reason: "识别到“全部停”", detail: "暂停派单：运行中的进程停止并退回排队，不再派发新单" };
  }

  // 命中当前阶段时跳过该阶段。
  if (cur && cur.score > 0) {
    const shards = byStage.get(cur.stage.id) ?? [];
    const why = cur.hits.slice(0, 4).join("、");
    return {
      kind: "skip",
      stage: cur.stage.id,
      stageName: cur.stage.name,
      reason: `“${why}”命中了当前阶段 ${cur.stage.id} ${cur.stage.name}`,
      detail:
        `跳过 ${cur.stage.id} ${cur.stage.name}` +
        (shards.length ? `（该阶段有 ${shards.length} 个分片，按整阶段处理——本通道只支持阶段粒度）` : "") +
        "；跳过将记为欠账，终审时仍会清算",
    };
  }

  // 仅命中其它阶段时不变更：它们尚未开始或已结束。
  if (wanted.length > 0) {
    const names = wanted.slice(0, 4).map((x) => `${x.stage.id} ${x.stage.name}`).join("、");
    return {
      kind: "clarify",
      reason: "命中的不是当前阶段",
      detail: `当前阶段为 ${input.currentStage}。该输入更接近指定 ${names}——它们不在当前阶段，未做变更。停止当前阶段请指明阶段名，或使用“全部停掉”`,
      candidates: candidates(),
    };
  }

  // 无命中时返回当前阶段信息作为候选。
  return {
    kind: "clarify",
    reason: "没有识别出具体对象",
    detail:
      `当前阶段为 ${input.currentStage}。无法识别“${text}”指向的阶段。` +
      "可改用阶段 id，或使用“全部停掉”",
    candidates: cur ? [{ id: cur.stage.id, name: cur.stage.name, hits: [] }] : [],
  };
}
