// Slack that keeps text near the edge from flipping between layouts.
const SINGLE_ROW_SLACK_PX = 4;

let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (!measureContext) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      return null;
    }
  }
  return measureContext;
}

export function isWrapped(textarea: HTMLTextAreaElement, scrollHeight: number): boolean {
  const cs = getComputedStyle(textarea);
  const lineHeight = parseFloat(cs.lineHeight) || 0;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return scrollHeight > lineHeight + padY + 1;
}

export function fitsBetweenButtons(textarea: HTMLTextAreaElement, text: string, buttons: Array<HTMLElement | null>): boolean {
  const ctx = getMeasureContext();
  if (!ctx) return false;
  const cs = getComputedStyle(textarea);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const gap = parseFloat(getComputedStyle(textarea.parentElement ?? textarea).columnGap) || 0;
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const sides = buttons.reduce((sum, el) => sum + (el ? el.offsetWidth + gap : 0), 0);
  const room = textarea.clientWidth - sides - padX - SINGLE_ROW_SLACK_PX;
  return ctx.measureText(text).width <= room;
}
