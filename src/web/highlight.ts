const THEME = "github-light";

export async function highlightHtml(code: string, language: string): Promise<string> {
  const { codeToHtml } = await import("shiki");
  return codeToHtml(code, { lang: language, theme: THEME });
}
