// 机器检查（docs/ui-polish-loop-design.md 第 3.3 节）：截图的同时在页面里量出来的硬毛病。
// 裁切、溢出、对比度、点击区域这些是量得出来的，不交给评委用眼睛猜；量出来的直接算成“行业标准”这一项的发现，也当作事实告诉评委。
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { inPage } from "./in-page-api.ts";
import { CONTRAST_SEVERITY_LINES, FINDING_TEXT_MAX_CHARS } from "./limits.ts";
import type { Finding, Severity } from "./rubric.ts";
import { composerRowHits, nestedFrameHits, raggedEdgeHits, thickLineHits } from "./structure-checks.ts";

export const MACHINE_CHECKS = [
  { id: "clipped", severity: "P0", what: "元素的内容超出了会裁切它的祖先，露不全（没有截断样式的）", fix: "让装它的容器在这个方向上放得下（grid-cols-1、min-w-0、换行），或者给它截断样式和 title" },
  { id: "page-overflow", severity: "P0", what: "页面或弹窗出现横向滚动", fix: "找出最宽的那个子元素，限制宽度或允许换行" },
  { id: "overlap", severity: "P2", what: "两个能点的东西的可点范围边缘互相擦碰（两者中心都点得到）", fix: "拉开两者的间距，或者收小其中一个的可点范围" },
  { id: "contrast", severity: "P1", what: "文字对比度不到 WCAG AA（axe-core 的 color-contrast），不到 3:1 的记 P0", fix: "字色换深一档，或底色换浅一档，到 4.5:1（大字 3:1）" },
  { id: "touch-target", severity: "P1", what: "触屏视口下可点范围小于 44×44px", fix: "可点范围扩到 44×44px（加内边距或用伪元素扩大点击区）" },
  { id: "truncated-no-title", severity: "P2", what: "文字被截成省略号，却没有 title 放全文", fix: "给截断的元素加 title 写全文" },
  { id: "off-scale-font", severity: "P2", what: "界面外壳的字号不在四档字号里", fix: "改用 text-xs、text-minor、text-body、text-title 四档之一" },
  { id: "dot-joined", severity: "P2", what: "界面外壳的字里用“·”“|”拼接", fix: "拆成两个元素，用间距或换行分开，不用符号拼接" },
  { id: "thick-line", severity: "P1", what: "线比 1px 粗（实线边框或内描边超过 1.5px；虚线拖放框、Markdown 引用竖条和圆点的隔离圈除外）", fix: "改成 1px：结构线用 --border，控件描边用 --border-strong，选中用 1px --select-line 内描边" },
  { id: "box-in-box", severity: "P1", what: "带框的盒子套在另一个带框的盒子里（框套框；弹窗、浮层、工作区纸面不算外框，按钮和输入框不算盒子）", fix: "去掉里面那层框，用间距或一条细分隔线分开；里面是标签就改成平的色块" },
  { id: "ragged-edge", severity: "P2", what: "同一栏里几行的起点只差一两个像素（差 1.5 到 8px，不像缩进，像没对齐）", fix: "让标题、图标、头像和行文字落在同一条左边缘上，或者明确缩进一档（12px 以上）" },
  { id: "composer-row", severity: "P1", what: "并排的两个输入框（对话和右栏 Worker）顶边或底边没对齐（差 0.5px 以上）", fix: "两边都用同一个 composer-dock 底座，让两块面板的底边落在同一条线上" },
] as const;
export type MachineCheckId = (typeof MACHINE_CHECKS)[number]["id"];

/** 机器量出来的一条：形状同评委的发现，rule 是 `machine:<检查 id>`，另带量到的数。 */
export interface MachineFinding extends Finding {
  /** 量到的数和选择器，给修的人定位。 */
  evidence: string;
}

/** 页面里量出来的原始一条：哪种检查、元素的框（CSS 像素）、量到的数。 */
export interface RawHit {
  check: MachineCheckId;
  rect: { x: number; y: number; w: number; h: number };
  evidence: string;
  /** 量到的数决定严重度时填（对比度），不填用 MACHINE_CHECKS 里的。 */
  severity?: Severity;
}

/**
 * 前置：页面已经画稳。
 * 后置：返回这一屏量出来的全部毛病，位置是占视口的比例；同一个元素同一种毛病只报一条。
 * 只读页面，不改 DOM、不滚动。
 */
export async function runMachineChecks(page: Page, options: { touch: boolean }): Promise<MachineFinding[]> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("页面没有固定视口，量不了位置");
  const hits = await page.evaluate(inPage.measureInPage, { touch: options.touch });
  const structure = await page.evaluate(inPage.collectStructureInPage);
  hits.push(...thickLineHits(structure.frames), ...nestedFrameHits(structure.frames), ...raggedEdgeHits(structure.edges), ...composerRowHits(structure.composers));
  hits.push(...(await contrastHits(page)));
  const seen = new Set<string>();
  const findings: MachineFinding[] = [];
  for (const hit of hits) {
    const id = `${hit.check}|${hit.evidence}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const check = MACHINE_CHECKS.find((c) => c.id === hit.check)!;
    findings.push({
      rule: `machine:${check.id}`,
      severity: hit.severity ?? check.severity,
      box: toBox(hit.rect, viewport),
      what: clip(`${check.what}：${hit.evidence}`),
      fix: check.fix,
      evidence: hit.evidence,
    });
  }
  return findings;
}

const clip = (text: string) => (text.length <= FINDING_TEXT_MAX_CHARS ? text : `${text.slice(0, FINDING_TEXT_MAX_CHARS - 1)}…`);

/** CSS 像素的框换成占视口的比例，裁到视口里；看不见的元素给一个最小的框，形状仍然合法。 */
function toBox(rect: RawHit["rect"], viewport: { width: number; height: number }): Finding["box"] {
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const x1 = Math.min(Math.max(rect.x, 0), viewport.width - 1);
  const y1 = Math.min(Math.max(rect.y, 0), viewport.height - 1);
  const x2 = Math.min(Math.max(rect.x + rect.w, x1 + 1), viewport.width);
  const y2 = Math.min(Math.max(rect.y + rect.h, y1 + 1), viewport.height);
  return { x: round(x1 / viewport.width), y: round(y1 / viewport.height), w: round((x2 - x1) / viewport.width), h: round((y2 - y1) / viewport.height) };
}

async function contrastHits(page: Page): Promise<RawHit[]> {
  const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  const hits: RawHit[] = [];
  for (const violation of result.violations) {
    for (const node of violation.nodes) {
      const target = node.target.map(String).join(" ");
      const box = await page.locator(target).first().boundingBox().catch(() => null);
      const data = node.any[0]?.data as { contrastRatio?: number; fgColor?: string; bgColor?: string; expectedContrastRatio?: string } | undefined;
      const ratio = data?.contrastRatio === undefined ? "" : `${data.contrastRatio}:1，要 ${data.expectedContrastRatio ?? "4.5:1"}，字 ${data.fgColor} 底 ${data.bgColor}，`;
      const severity: Severity = data?.contrastRatio !== undefined && data.contrastRatio < CONTRAST_SEVERITY_LINES.P0_BELOW ? "P0" : "P1";
      hits.push({ check: "contrast", rect: box === null ? { x: 0, y: 0, w: 1, h: 1 } : { x: box.x, y: box.y, w: box.width, h: box.height }, evidence: `${ratio}${target}`, severity });
    }
  }
  return hits;
}
