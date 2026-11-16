// 卡片正文怎么分块（docs/ui-standard.md 第 22 条）：标题 → 摘要 → 文件 → 细节。
// 约定：正文的第一段是摘要，后面的段落（交棒、提交、PR、附带说明这类）是细节，卡片里默认收起。
// 写卡片正文的地方（检查点卡、hub ask、router report）把最要紧的一句放在第一段。

/** 卡片文字的第一行是标题，空一行以后是正文；没有空行就只有标题。 */
export function splitCardTitle(raw: string): { title: string; body: string } {
  const trimmed = raw.trim();
  const match = /^([^\r\n]+?)(?:\r?\n\s*\r?\n)([\s\S]+)$/u.exec(trimmed);
  if (match === null) return { title: trimmed, body: "" };
  return { title: match[1]!.trim(), body: match[2]!.trim() };
}

const FENCE = /^\s*(```|~~~)/u;
const BLANK = /^\s*$/u;

/** Markdown 正文按第一个段落分界（代码块外的空行）拆成摘要和细节，两边都去掉首尾空白。 */
export function splitLead(markdown: string): { lead: string; details: string } {
  const lines = markdown.trim().split(/\r?\n/u);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined && (fence === null || fence === marker)) fence = fence === null ? marker : null;
    else if (fence === null && BLANK.test(line)) {
      return { lead: lines.slice(0, i).join("\n").trim(), details: lines.slice(i + 1).join("\n").trim() };
    }
  }
  return { lead: lines.join("\n").trim(), details: "" };
}
