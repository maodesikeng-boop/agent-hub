export function stripMarkdown(text: string): string {
  const code: string[] = [];
  const stripped = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/`+([^`]*)`+/g, (_, inner: string) => `\u0000${code.push(inner) - 1}\u0000`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}
