import type { MdNode } from "../../shared/index.ts";

export const CHART_CLOSED_ATTR = "data-chart-closed";

interface CodeNode extends MdNode {
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const OPENING = /^[\s>]*(`{3,}|~{3,})/;
const CLOSING = /^[\s>]*(`{3,}|~{3,})\s*$/;

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
