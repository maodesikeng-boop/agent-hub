// 代码高亮：Shiki 只在打开预览、要上色的时候才加载（动态 import，构建时拆成单独的块）。
/** 浅色主题，和页面的白底配。 */
const THEME = "github-light";

/** 返回带 <span class="line"> 的 <pre><code> 的 HTML（Shiki 会把代码转义）。语言 Shiki 不认识时抛错，调用方保留纯文本显示。 */
export async function highlightHtml(code: string, language: string): Promise<string> {
  const { codeToHtml } = await import("shiki");
  return codeToHtml(code, { lang: language, theme: THEME });
}
