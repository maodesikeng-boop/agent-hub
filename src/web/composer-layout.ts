// Slack that keeps text near the edge from flipping between layouts.
const SINGLE_ROW_SLACK_PX = 4;

let measureContext: CanvasRenderingContext2D | null = null;
let lastCanvasFont = "";

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (!measureContext) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
      lastCanvasFont = "";
    } catch {
      return null;
    }
  }
  return measureContext;
}

function withFont(ctx: CanvasRenderingContext2D, font: string): void {
  if (lastCanvasFont !== font) {
    ctx.font = font;
    lastCanvasFont = font;
  }
}

interface TextareaMetrics {
  fontSizeKey: string;
  headCount: number;
  lineHeight: number;
  padY: number;
  padX: number;
  font: string;
  columnGap: number;
}

const metricsCache = new WeakMap<HTMLTextAreaElement, TextareaMetrics>();

function metricsOf(textarea: HTMLTextAreaElement): TextareaMetrics {
  const fontSizeKey = document.documentElement.style.fontSize;
  const headCount = document.head.childElementCount;
  const cached = metricsCache.get(textarea);
  if (cached !== undefined && cached.fontSizeKey === fontSizeKey && cached.headCount === headCount) return cached;
  const cs = getComputedStyle(textarea);
  const parent = textarea.parentElement;
  const columnGap = parent === null ? 0 : parseFloat(getComputedStyle(parent).columnGap) || 0;
  const next: TextareaMetrics = {
    fontSizeKey,
    headCount,
    lineHeight: parseFloat(cs.lineHeight) || 0,
    padY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
    padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    columnGap,
  };
  metricsCache.set(textarea, next);
  return next;
}

export function isWrapped(textarea: HTMLTextAreaElement, scrollHeight: number): boolean {
  const { lineHeight, padY } = metricsOf(textarea);
  return scrollHeight > lineHeight + padY + 1;
}

export function fitsBetweenButtons(textarea: HTMLTextAreaElement, text: string, buttons: Array<HTMLElement | null>): boolean {
  const ctx = getMeasureContext();
  if (!ctx) return false;
  const { font, columnGap, padX } = metricsOf(textarea);
  withFont(ctx, font);
  const sides = buttons.reduce((sum, el) => sum + (el ? el.offsetWidth + columnGap : 0), 0);
  const room = textarea.clientWidth - sides - padX - SINGLE_ROW_SLACK_PX;
  return ctx.measureText(text).width <= room;
}

export function fitsSingleRowWidth(textarea: HTMLTextAreaElement, text: string, widthPx: number): boolean {
  const ctx = getMeasureContext();
  if (!ctx) return false;
  const { font, padX } = metricsOf(textarea);
  withFont(ctx, font);
  return ctx.measureText(text).width <= widthPx - padX - SINGLE_ROW_SLACK_PX;
}
