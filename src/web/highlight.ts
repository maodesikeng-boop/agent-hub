const THEME = "github-light";

// github-light tokens under 4.5:1 on the --panel code background, swapped for the nearest light-palette colors that pass.
export const CODE_COLOR_REPLACEMENTS: Readonly<Record<string, string>> = {
  "#d73a49": "#cf222e",
  "#22863a": "#1a7f37",
  "#e36209": "#bc4c00",
  "#6a737d": "#59636e",
};

export async function highlightHtml(code: string, language: string): Promise<string> {
  const { codeToHtml } = await import("shiki");
  return codeToHtml(code, { lang: language, theme: THEME, colorReplacements: { ...CODE_COLOR_REPLACEMENTS } });
}
