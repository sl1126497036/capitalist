/**
 * 块级渲染：段落、标题、列表、引用、围栏代码块、分隔线。
 *
 * 引用块内不展开块级语法，行与行之间按硬换行呈现：看板消息里的引用多为整段摘录，
 * 无需递归解析。
 */

import { defineComponent, h } from "vue";
import MdLine from "./MdLine.js";

export default defineComponent({
  name: "MdBlocks",
  props: {
    blocks: { type: Array, default: () => [] },
    entry: { type: Function, default: null },
    activeRef: { type: String, default: "" },
    onRef: { type: Function, default: null },
  },
  setup(props) {
    const line = (inlines, key) =>
      h(MdLine, {
        key,
        tokens: inlines || [],
        entry: props.entry,
        activeRef: props.activeRef,
        onRef: props.onRef,
      });

    return () => {
      const out = [];
      (props.blocks || []).forEach((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case "h":
            out.push(
              h("div", { key, class: ["md-h", `md-h${b.level}`] }, [line(b.inlines, `${key}-l`)]),
            );
            break;
          case "ul":
          case "ol": {
            const items = (b.items || []).map((it, j) =>
              h("li", { key: `${key}-${j}` }, [line(it.inlines, `${key}-${j}-l`)]),
            );
            out.push(
              b.t === "ul"
                ? h("ul", { key, class: "md-ul" }, items)
                : h("ol", { key, class: "md-ol", start: b.start || 1 }, items),
            );
            break;
          }
          case "quote":
            out.push(h("blockquote", { key, class: "md-quote" }, [line(b.inlines, `${key}-l`)]));
            break;
          case "code":
            out.push(
              h("pre", { key, class: "md-pre" }, [
                h("code", { class: b.lang ? `lang-${b.lang}` : "" }, b.text),
              ]),
            );
            break;
          case "hr":
            out.push(h("hr", { key, class: "md-hr" }));
            break;
          case "p":
          default:
            out.push(h("div", { key, class: "md-p" }, [line(b.inlines, `${key}-l`)]));
        }
      });
      return out;
    };
  },
});
