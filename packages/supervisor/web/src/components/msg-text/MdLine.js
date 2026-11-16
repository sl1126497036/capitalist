/**
 * 行内渲染：把解析后的行内序列变成 VNode。
 *
 * 文本片段在此切成单号（`D-…`、`W-…`）、技能路径与普通文字，引用色块因此在
 * 加粗、列表、标题内都保留。行内代码与链接文字不切，按钮不进入代码样式。
 *
 * 用渲染函数而非 v-html：消息正文来自工作进程与模型输出，按不可信内容处理，
 * 文本节点交给 Vue 转义，不拼 HTML 字符串。
 */

import { defineComponent, h } from "vue";
import { splitMessageRefs } from "../../lib/msgRefs.js";
import { t } from "../../lib/i18n.js";

/** 单号与技能路径的色块，与纯文本模式下的 .mref / .mskill 同一套样式。 */
function refNode(seg, ctx, key) {
  if (seg.type === "skill") {
    return h("span", { key, class: "mskill", title: seg.raw }, seg.name || "skill");
  }
  const e = ctx.entry ? ctx.entry(seg.raw) : null;
  if (!e) return seg.raw;
  return h(
    "button",
    {
      key,
      class: "mref",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": ctx.activeRef === seg.raw ? "true" : "false",
      "aria-label": t("查看任务 #{no}", { no: e.no }),
      onClick: (ev) => {
        ev.stopPropagation();
        if (ctx.onRef) ctx.onRef(ev, seg.raw);
      },
    },
    `#${e.no}`,
  );
}

/** 纯文本片段切成引用与文字。 */
function textNodes(text, ctx) {
  const out = [];
  splitMessageRefs(text).forEach((seg, i) => {
    if (seg.type === "text") out.push(seg.text);
    else out.push(refNode(seg, ctx, `r${i}`));
  });
  return out;
}

function walk(tokens, ctx) {
  return tokens.map((tok, i) => {
    const key = `t${i}`;
    switch (tok.t) {
      case "br":
        return h("br", { key });
      case "text":
        return h("span", { key }, textNodes(tok.text, ctx));
      case "code":
        /* 行内代码里的单号保持原文，不生成按钮。 */
        return h("code", { key, class: "md-code" }, tok.text);
      case "strong":
        return h("strong", { key }, walk(tok.c, ctx));
      case "em":
        return h("em", { key }, walk(tok.c, ctx));
      case "del":
        return h("del", { key }, walk(tok.c, ctx));
      case "link": {
        const href = String(tok.href || "");
        /* 协议已在解析层过滤；此处再校验一次，避免属性注入。 */
        if (!/^(?:https?:\/\/|mailto:)/i.test(href)) {
          return h("span", { key }, walk(tok.c, ctx));
        }
        return h(
          "a",
          {
            key,
            class: "md-a",
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            onClick: (ev) => ev.stopPropagation(),
          },
          walk(tok.c, ctx),
        );
      }
      default:
        return null;
    }
  });
}

export default defineComponent({
  name: "MdLine",
  props: {
    tokens: { type: Array, default: () => [] },
    /** 单号 -> 任务条目；取不到时单号按纯文字显示。 */
    entry: { type: Function, default: null },
    activeRef: { type: String, default: "" },
    onRef: { type: Function, default: null },
  },
  setup(props) {
    return () => h("span", { class: "md-line" }, walk(props.tokens, props));
  },
});
