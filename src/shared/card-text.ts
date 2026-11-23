export function splitCardTitle(raw: string): { title: string; body: string } {
  const trimmed = raw.trim();
  const match = /^([^\r\n]+?)(?:\r?\n\s*\r?\n)([\s\S]+)$/u.exec(trimmed);
  if (match === null) return { title: trimmed, body: "" };
  return { title: match[1]!.trim(), body: match[2]!.trim() };
}

