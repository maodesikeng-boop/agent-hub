export function splitCardTitle(raw: string): { title: string; body: string } {
  const trimmed = raw.trim();
  const match = /^([^\r\n]+?)(?:\r?\n\s*\r?\n)([\s\S]+)$/u.exec(trimmed);
  if (match === null) return { title: trimmed, body: "" };
  return { title: match[1]!.trim(), body: match[2]!.trim() };
}

const FENCE = /^\s*(```|~~~)/u;
const BLANK = /^\s*$/u;

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
