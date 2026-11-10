// 聊天输入框的单行 / 多行判断（Composer.tsx 用）：空或一行字时回形针、文字区、发送键在同一行；
// 文字超过一行（换行符或自动换行）时文字区占满一行，按钮落到它下面。

/** 判断“能放进单行”时留的余量（px），避免文字刚好贴着边时在两种布局间来回切 */
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

/** 文字区现在是不是不止一行：内容高度（scrollHeight，调用者在内容变化后读一次传进来）超过“一行 + 上下内边距”。 */
export function isWrapped(textarea: HTMLTextAreaElement, scrollHeight: number): boolean {
  const cs = getComputedStyle(textarea);
  const lineHeight = parseFloat(cs.lineHeight) || 0;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return scrollHeight > lineHeight + padY + 1;
}

/**
 * 文字区现在占满整行（多行布局）时，这段没有换行符的文字放进“回形针和发送键中间那一段”是否还放得下。
 * 用 canvas 量文字宽度（不触发排版）；量不了（没有 canvas）就当放不下，保持多行布局。
 */
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
