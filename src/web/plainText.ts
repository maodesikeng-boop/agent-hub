// 左栏预览只有一行，Markdown 符号在里面没有意义：去掉符号，留下文字，换行压成空格。

/** 把 Markdown 文本变成一行纯文字。只处理常见写法，够预览用，不求完整解析。 */
export function stripMarkdown(text: string): string {
  // 行内代码里的符号是字面内容，先收起来，别的规则处理完再放回去
  const code: string[] = [];
  const stripped = text
    // 围栏代码块：去掉 ``` 和语言名那一行，留内容
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/`+([^`]*)`+/g, (_, inner: string) => `\u0000${code.push(inner) - 1}\u0000`)
    // 图片和链接：留文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 行首的标题、引用、列表符号
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    // 加粗、删除线
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    // 斜体：下划线只在词边界上算，snake_case_name 不动
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}
