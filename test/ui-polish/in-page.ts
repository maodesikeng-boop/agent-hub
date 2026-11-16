// 在截图用的浏览器页面里跑的函数：机器检查的测量、等字体、拖文件、校准用的弄坏。
// 这些函数由 Playwright 序列化进页面执行，所以不引别的模块，只用 DOM。
// 用 DOM 类型单独检查（tsconfig.in-page.json）；主工程排除这个文件，Node 端按文件路径动态加载（见 in-page-api.ts）。

/** 量出来的一条，同 checks.ts 的 RawHit。 */
interface RawHit {
  check: "clipped" | "page-overflow" | "overlap" | "touch-target" | "truncated-no-title" | "off-scale-font" | "dot-joined";
  rect: { x: number; y: number; w: number; h: number };
  evidence: string;
}

/** 等网页字体都加载完。 */
export async function fontsReady(): Promise<void> {
  await document.fonts.ready;
}

/** 在 selector 上模拟把这几个文件拖进来（只发 dragenter、dragover，不放下）。 */
export function dragFiles(args: { selector: string; names: readonly string[] }): void {
  const target = document.querySelector(args.selector);
  if (target === null) throw new Error(`找不到 ${args.selector}`);
  const transfer = new DataTransfer();
  for (const name of args.names) transfer.items.add(new File(["demo"], name, { type: "text/plain" }));
  const r = target.getBoundingClientRect();
  for (const type of ["dragenter", "dragover"]) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  }
}

/** 在页面里跑：只读 DOM 和样式。函数要能序列化进页面，所以不引外面的东西。 */
export function measureInPage(options: { touch: boolean }): RawHit[] {
  const hits: RawHit[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rectOf = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  const describe = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== document.body && parts.length < 4) {
      const label = node.getAttribute("aria-label");
      const name = node.tagName.toLowerCase() + (label ? `[aria-label="${label}"]` : node.id ? `#${node.id}` : "");
      parts.unshift(name);
      node = node.parentElement;
    }
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${parts.join(" > ")}${text ? ` “${text}”` : ""}`;
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && Number(style.opacity) > 0 && el.closest("[aria-hidden='true'], [inert]") === null;
  };
  /** 消息正文、代码块、图表里的字不算外壳，不量字号和拼接符号。 */
  const content = (el: Element) => el.closest(".markdown, pre, code, svg, textarea, [contenteditable='true'], .vega-embed") !== null;
  const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
  const all = [...document.body.querySelectorAll("*")].filter(visible);

  // 裁切：元素有一部分落在会裁切它的祖先外面
  const reported = new Set<Element>();
  for (const el of all) {
    const leaf = ownText(el) || ["svg", "img", "input", "button", "textarea", "select"].includes(el.tagName.toLowerCase()) || el.getAttribute("role") === "radio";
    if (!leaf || content(el)) continue;
    let skip = false;
    for (let p = el.parentElement; p !== null; p = p.parentElement) if (reported.has(p)) skip = true;
    if (skip) continue;
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") break;
      const cls = a.classList;
      const xClips = style.overflowX === "hidden" || style.overflowX === "clip" || ((style.overflowX === "auto" || style.overflowX === "scroll") && !cls.contains("overflow-x-auto") && !cls.contains("overflow-auto") && !cls.contains("overflow-x-scroll") && !cls.contains("overflow-scroll"));
      const yClips = style.overflowY === "hidden" || style.overflowY === "clip";
      if (!xClips && !yClips) continue;
      const c = a.getBoundingClientRect();
      const left = c.left + a.clientLeft;
      const top = c.top + a.clientTop;
      const right = left + a.clientWidth;
      const bottom = top + a.clientHeight;
      const outX = xClips && (r.right > right + 1 || r.left < left - 1);
      const outY = yClips && (r.bottom > bottom + 1 || r.top < top - 1);
      const partly = r.right > left && r.left < right && r.bottom > top && r.top < bottom;
      if ((outX || outY) && partly) {
        reported.add(el);
        const over = outX ? `右边超出 ${(r.right - right).toFixed(1)}px、左边超出 ${(left - r.left).toFixed(1)}px` : `下边超出 ${(r.bottom - bottom).toFixed(1)}px、上边超出 ${(top - r.top).toFixed(1)}px`;
        hits.push({ check: "clipped", rect: rectOf(r), evidence: `${describe(el)}（${over}，被 ${describe(a).split(" “")[0]} 裁掉）` });
        break;
      }
    }
  }

  // 横向滚动：整页，或弹窗本身
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) hits.push({ check: "page-overflow", rect: { x: 0, y: 0, w: vw, h: vh }, evidence: `页面宽 ${root.scrollWidth}px，视口 ${root.clientWidth}px` });
  for (const dialog of document.querySelectorAll("[role='dialog']")) {
    if (dialog.scrollWidth > dialog.clientWidth + 1 && visible(dialog)) hits.push({ check: "page-overflow", rect: rectOf(dialog.getBoundingClientRect()), evidence: `弹窗内容宽 ${dialog.scrollWidth}px，弹窗 ${dialog.clientWidth}px` });
  }

  // 能点的东西：只算真点得到的（中心点上最上面的就是它自己或它里面的东西）
  const clickable = all.filter((el) => el.matches("button, a[href], input:not([type='hidden']), textarea, select, [role='button'], [role='radio'], [role='checkbox'], [role='switch'], [role='tab'], [role='menuitem'], [role='option']") && !(el as HTMLButtonElement).disabled);
  const hittable = clickable.filter((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === el || el.contains(top));
  });
  for (let i = 0; i < hittable.length; i++) {
    for (let j = i + 1; j < hittable.length; j++) {
      const a = hittable[i]!;
      const b = hittable[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) hits.push({ check: "overlap", rect: { x: Math.max(ra.left, rb.left), y: Math.max(ra.top, rb.top), w, h }, evidence: `${describe(a)} 和 ${describe(b)} 重叠 ${w.toFixed(0)}×${h.toFixed(0)}px` });
    }
  }

  if (options.touch) {
    for (const el of hittable) {
      const r = el.getBoundingClientRect();
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      if (!inline && (r.width < 43.5 || r.height < 43.5)) hits.push({ check: "touch-target", rect: rectOf(r), evidence: `${describe(el)} ${r.width.toFixed(0)}×${r.height.toFixed(0)}px` });
    }
  }

  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const tiers = [0.75, 0.84375, 0.9375, 1.0625, 1.375].map((rem) => rem * rootPx);
  for (const el of all) {
    if (!ownText(el) || content(el)) continue;
    const style = getComputedStyle(el);
    // 截断却没有全文
    if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.closest("[title]") === null) {
      hits.push({ check: "truncated-no-title", rect: rectOf(el.getBoundingClientRect()), evidence: describe(el) });
    }
    const size = parseFloat(style.fontSize);
    const formField = el.matches("input, textarea, select") && size === 16;
    if (!formField && !tiers.some((t) => Math.abs(t - size) < 0.05)) {
      hits.push({ check: "off-scale-font", rect: rectOf(el.getBoundingClientRect()), evidence: `${describe(el)} 字号 ${size}px（四档是 ${tiers.slice(0, 4).map((t) => t.toFixed(2)).join("、")}px）` });
    }
    const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("");
    if (/\S\s*[·|]\s*\S/.test(text)) hits.push({ check: "dot-joined", rect: rectOf(el.getBoundingClientRect()), evidence: describe(el) });
  }
  return hits;
}

/** 校准用的弄坏（mutations.ts 的 MUTATIONS）：只改这个页面里的样式和元素，id 认不出抛错。 */
export function applyMutationInPage(id: string): void {
  throw new Error(`弄坏 ${id} 还没写`);
}
