// remark 插件：给“已闭合”的围栏代码块打标记（流式输出时半截的 Mermaid 必然报错，没闭合的一律不渲染）。
import type { MdNode } from "../../shared/index.ts";

/** 加在 <code> 上的属性：值 "true" 表示收尾的 fence 已经收到。 */
export const CHART_CLOSED_ATTR = "data-chart-closed";

interface CodeNode extends MdNode {
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

// 引用、列表里的 fence 前面还有 `> `、缩进，开头统一容忍
const OPENING = /^[\s>]*(`{3,}|~{3,})/;
const CLOSING = /^[\s>]*(`{3,}|~{3,})\s*$/;

/** 这个 code 节点在原文里的片段，最后一行是不是和开头同样的 fence（同一种符号，长度 ≥ 开头）。 */
function isClosed(fragment: string): boolean {
  const lines = fragment.trimEnd().split("\n");
  if (lines.length < 2) return false;
  const open = OPENING.exec(lines[0]!)?.[1];
  const close = CLOSING.exec(lines[lines.length - 1]!)?.[1];
  return open !== undefined && close !== undefined && close[0] === open[0] && close.length >= open.length;
}

export function remarkChartBlocks() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : undefined;
    if (source === undefined) return;
    const walk = (node: CodeNode) => {
      const { start, end } = node.position ?? {};
      if (node.type === "code" && node.lang && start?.offset !== undefined && end?.offset !== undefined && isClosed(source.slice(start.offset, end.offset))) {
        node.data = { ...node.data, hProperties: { ...(node.data?.hProperties as object | undefined), [CHART_CLOSED_ATTR]: "true" } };
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
