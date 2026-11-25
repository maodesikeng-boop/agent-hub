// 在截图用的浏览器页面里跑的函数：机器检查的测量、等字体、拖文件、校准用的弄坏。
// 这些函数由 Playwright 序列化进页面执行，所以不引别的模块，只用 DOM。
// 用 DOM 类型单独检查（tsconfig.in-page.json）；主工程排除这个文件，Node 端按文件路径动态加载（见 in-page-api.ts）。

/** 量出来的一条，同 checks.ts 的 RawHit。 */
interface RawHit {
  check: "clipped" | "page-overflow" | "overlap" | "touch-target" | "truncated-no-title" | "off-scale-font" | "dot-joined";
  rect: { x: number; y: number; w: number; h: number };
  evidence: string;
}

export async function fontsReady(): Promise<void> {
  await document.fonts.ready;
}

/** 等布局过完两帧再设滚动位置，免得和对话首帧自动贴底的 ResizeObserver 打架。 */
export async function scrollToPosition(el: HTMLElement, where: "top" | "bottom" | number): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  el.scrollTop = where === "top" ? 0 : where === "bottom" ? el.scrollHeight : where;
}

/** 在 selector 上模拟把这几个文件拖进来；drop 为 true 时顺便放下。 */
export function dragFiles(args: { selector: string; names: readonly string[]; drop?: boolean }): void {
  const target = document.querySelector(args.selector);
  if (target === null) throw new Error(`找不到 ${args.selector}`);
  const transfer = new DataTransfer();
  for (const name of args.names) transfer.items.add(new File(["demo"], name, { type: "text/plain" }));
  const r = target.getBoundingClientRect();
  const types = args.drop === true ? ["dragenter", "dragover", "drop"] : ["dragenter", "dragover"];
  for (const type of types) {
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

  const reported = new Set<Element>();
  for (const el of all) {
    const leaf = ownText(el) || ["svg", "img", "input", "button", "textarea", "select"].includes(el.tagName.toLowerCase()) || el.getAttribute("role") === "radio";
    if (!leaf || content(el)) continue;
    let skip = false;
    for (let p = el.parentElement; p !== null; p = p.parentElement) if (reported.has(p)) skip = true;
    if (skip) continue;
    const r = el.getBoundingClientRect();
    let scrolledX = false;
    let scrolledY = false;
    for (let a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") break;
      const cls = a.classList;
      const intentionalScrollX = cls.contains("overflow-x-auto") || cls.contains("overflow-auto") || cls.contains("overflow-x-scroll") || cls.contains("overflow-scroll");
      if (intentionalScrollX && a.scrollWidth > a.clientWidth + 1) scrolledX = true;
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && a.scrollHeight > a.clientHeight + 1) scrolledY = true;
      const xClips = !scrolledX && (style.overflowX === "hidden" || style.overflowX === "clip" || ((style.overflowX === "auto" || style.overflowX === "scroll") && !intentionalScrollX));
      const yClips = !scrolledY && (style.overflowY === "hidden" || style.overflowY === "clip");
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

  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) hits.push({ check: "page-overflow", rect: { x: 0, y: 0, w: vw, h: vh }, evidence: `页面宽 ${root.scrollWidth}px，视口 ${root.clientWidth}px` });
  for (const dialog of document.querySelectorAll("[role='dialog']")) {
    if (dialog.scrollWidth > dialog.clientWidth + 1 && visible(dialog)) hits.push({ check: "page-overflow", rect: rectOf(dialog.getBoundingClientRect()), evidence: `弹窗内容宽 ${dialog.scrollWidth}px，弹窗 ${dialog.clientWidth}px` });
  }

  const clickable = all.filter((el) => el.matches("button, a[href], input:not([type='hidden']), textarea, select, [role='button'], [role='radio'], [role='checkbox'], [role='switch'], [role='tab'], [role='menuitem'], [role='option']") && !(el as HTMLButtonElement).disabled);
  const layerOf = (el: Element) => el.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='alertdialog'], [data-vaul-drawer], [data-back-to-bottom]");
  const hittable = clickable.filter((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === el || el.contains(top));
  });
  /** 元素真正点得到的那一块：滚出滚动区、被祖先裁掉的部分点不到，不算。 */
  const clickableRect = (el: Element) => {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    for (let a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, c.left + a.clientLeft);
        right = Math.min(right, c.left + a.clientLeft + a.clientWidth);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, c.top + a.clientTop);
        bottom = Math.min(bottom, c.top + a.clientTop + a.clientHeight);
      }
    }
    return { left, top, right, bottom };
  };
  for (let i = 0; i < hittable.length; i++) {
    for (let j = i + 1; j < hittable.length; j++) {
      const a = hittable[i]!;
      const b = hittable[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      // 浮层、弹窗、抽屉本来就盖在页面上面：只比同一层里的
      if (layerOf(a) !== layerOf(b)) continue;
      const ra = clickableRect(a);
      const rb = clickableRect(b);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) hits.push({ check: "overlap", rect: { x: Math.max(ra.left, rb.left), y: Math.max(ra.top, rb.top), w, h }, evidence: `${describe(a)} 和 ${describe(b)} 重叠 ${w.toFixed(0)}×${h.toFixed(0)}px` });
    }
  }

  if (options.touch) {
    for (const el of hittable) {
      const r = el.getBoundingClientRect();
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      // 可点范围 = 元素自己的框，或者它用 ::after 撑开的那一块（styles.css 的 .touch-target，docs/ui-standard.md 第 19 条），取大的
      const after = getComputedStyle(el, "::after");
      const expanded = after.content !== "none" && after.position === "absolute";
      const w = expanded ? Math.max(r.width, parseFloat(after.width) || 0) : r.width;
      const h = expanded ? Math.max(r.height, parseFloat(after.height) || 0) : r.height;
      if (!inline && (w < 43.5 || h < 43.5)) hits.push({ check: "touch-target", rect: rectOf(r), evidence: `${describe(el)} ${w.toFixed(0)}×${h.toFixed(0)}px` });
    }
  }

  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const tiers = [0.75, 0.84375, 0.9375, 1, 1.375].map((rem) => rem * rootPx);
  for (const el of all) {
    if (!ownText(el) || content(el)) continue;
    const style = getComputedStyle(el);
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

/** Same shapes as structure-checks.ts FrameBox and EdgeItem; this file cannot import them. */
interface FrameBox {
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  sides: [number, number, number, number];
  dashed: boolean;
  ring: number;
  dot: boolean;
  control: boolean;
  media: boolean;
  quote: boolean;
  frameParent: number;
}
interface EdgeItem {
  column: string;
  label: string;
  left: number;
  top: number;
  bottom: number;
}

/** Reads every visible border, inset ring, and navigation-column row start; structure-checks.ts judges them. Read-only. */
export function collectStructureInPage(): { frames: FrameBox[]; edges: EdgeItem[] } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // describe and visible repeat measureInPage's: Playwright serializes each page function alone, so they cannot share helpers.
  const describe = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== document.body && parts.length < 4) {
      const label = node.getAttribute("aria-label");
      parts.unshift(node.tagName.toLowerCase() + (label ? `[aria-label="${label}"]` : node.id ? `#${node.id}` : ""));
      node = node.parentElement;
    }
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${parts.join(" > ")}${text ? ` “${text}”` : ""}`;
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && Number(style.opacity) > 0 && el.closest("[aria-hidden='true'], [inert]") === null;
  };
  const CONTROL = "button, a[href], input, textarea, select, [role='button'], [role='radio'], [role='radiogroup'], [role='checkbox'], [role='switch'], [role='tab'], [role='tablist'], [role='menuitem'], [role='option'], [role='combobox'], [role='textbox']";
  // A frame drawn around one text field (the composer, a card's reply, a search box) is that field's edge, not a box.
  const FIELD_SHELL = ":has(> input:not([type='hidden']), > textarea, > select, > [contenteditable='true'])";
  const OVERLAY = "[role='dialog'], [role='alertdialog'], [data-radix-popper-content-wrapper], [role='listbox'], [role='menu'], [data-vaul-drawer], .shell-sheet";
  const alphaOf = (color: string): number => {
    if (color === "" || color === "transparent") return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash !== null) return parseFloat(slash[1]!) / (slash[2] === "%" ? 100 : 1);
    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
    return rgba === null ? 1 : parseFloat(rgba[1]!);
  };
  const SIDES = ["top", "right", "bottom", "left"] as const;
  const ringOf = (shadow: string): number => {
    let widest = 0;
    for (const part of shadow === "none" ? [] : shadow.split(/,(?![^(]*\))/)) {
      if (!part.includes("inset")) continue;
      const color = /(?:rgba?|color|oklab|oklch|hsla?)\([^)]*\)/.exec(part)?.[0] ?? "";
      const [x, y, blur, spread] = (part.replace(color, "").match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      if (x === 0 && y === 0 && blur === 0 && spread !== undefined && alphaOf(color) >= 0.05) widest = Math.max(widest, spread);
    }
    return widest;
  };

  const index = new Map<Element, number>();
  const frames: FrameBox[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.parentElement?.closest("svg") || !visible(el)) continue;
    const style = getComputedStyle(el);
    const sides = SIDES.map((side) => {
      const kind = style.getPropertyValue(`border-${side}-style`);
      if (kind === "none" || kind === "hidden" || alphaOf(style.getPropertyValue(`border-${side}-color`)) < 0.05) return 0;
      return parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
    }) as [number, number, number, number];
    const ring = ringOf(style.boxShadow);
    if (Math.max(...sides) === 0 && ring === 0) continue;
    const r = el.getBoundingClientRect();
    index.set(el, frames.length);
    frames.push({
      label: describe(el),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      sides,
      dashed: SIDES.some((side) => style.getPropertyValue(`border-${side}-style`) === "dashed"),
      ring,
      dot: (parseFloat(style.borderTopLeftRadius) || 0) >= Math.min(r.width, r.height) / 2 - 0.5,
      control: el.closest(CONTROL) !== null || el.matches(FIELD_SHELL),
      media: el.matches("img, video, canvas") || (el.children.length === 1 && el.firstElementChild!.matches("img, video, canvas")),
      quote: el.matches("blockquote"),
      frameParent: -1,
    });
  }
  for (const [el, i] of index) {
    for (let a = el.parentElement; a !== null && !a.matches(OVERLAY); a = a.parentElement) {
      const j = index.get(a);
      if (j !== undefined && frames[j]!.sides.every((w) => w > 0)) {
        frames[i]!.frameParent = j;
        break;
      }
    }
  }

  const COLUMNS = [
    [".sidebar-list", "左栏"],
    [".right-rail-scroll", "右栏"],
    ["[role='tablist'][aria-orientation='vertical']", "设置分类"],
  ] as const;
  const edges: EdgeItem[] = [];
  for (const [selector, column] of COLUMNS) {
    for (const root of document.querySelectorAll(selector)) {
      if (!visible(root)) continue;
      for (const el of root.querySelectorAll("*")) {
        const graphic = el.matches("svg, img, [data-slot='avatar']");
        // Avatars and icons are aria-hidden decoration, but they are what the eye lines a row up by.
        const drawn = graphic ? el.getBoundingClientRect().width >= 2 && getComputedStyle(el).visibility !== "hidden" : visible(el);
        if (!drawn || el.closest(".markdown") !== null) continue;
        let left: number | null = null;
        if (graphic) {
          if (el.parentElement?.closest("svg, [data-slot='avatar']")) continue;
          left = el.getBoundingClientRect().left;
        } else {
          const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
          if (text === undefined) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          left = range.getClientRects()[0]?.left ?? null;
        }
        if (left === null) continue;
        const r = el.getBoundingClientRect();
        edges.push({ column, label: describe(el), left, top: r.top, bottom: r.bottom });
      }
    }
  }
  return { frames, edges };
}

/** 校准用的弄坏（mutations.ts 的 MUTATIONS）：只改这个页面里的样式和元素，id 认不出抛错。前置：页面是基准图那一屏（小林的对话三栏）。 */
export function applyMutationInPage(id: string): void {
  const one = (selector: string, root: ParentNode = document): HTMLElement => {
    const el = root.querySelector<HTMLElement>(selector);
    if (el === null) throw new Error(`弄坏 ${id}：找不到 ${selector}`);
    return el;
  };
  const byText = (root: ParentNode, selector: string, text: string): HTMLElement => {
    const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (e.textContent ?? "").includes(text));
    if (el === undefined) throw new Error(`弄坏 ${id}：${selector} 里找不到“${text}”`);
    return el;
  };
  const cardOf = (el: HTMLElement): HTMLElement => {
    for (let p: HTMLElement | null = el; p !== null; p = p.parentElement) if (parseFloat(getComputedStyle(p).borderTopWidth) > 0 && p !== el) return p;
    throw new Error(`弄坏 ${id}：找不到卡片`);
  };
  const rail = one('[aria-label="Pieces"]');
  const log = one('[aria-label="Messages"]');
  const nav = one('[aria-label="Studio Mac"]');
  const pmRows = () => nav.querySelectorAll<HTMLElement>(".project-row > button");
  // 拍板的选项只在对话里那张提问卡上（右栏里那一步是一行跳转，没有选项）
  const askOptions = [...byText(log, '[role="group"][aria-label="Options"]', "60 秒").querySelectorAll<HTMLElement>("button")];
  switch (id) {
    case "clip-right": {
      const option = askOptions[0]!;
      cardOf(option).style.overflow = "hidden";
      for (const b of askOptions) b.style.width = "calc(100% + 72px)";
      return;
    }
    case "covered-message": {
      const frame = one("[data-multiline]");
      frame.style.transform = "translateY(-104px)";
      frame.style.position = "relative";
      frame.style.zIndex = "10";
      return;
    }
    case "low-contrast":
      for (const el of log.querySelectorAll<HTMLElement>(".markdown, article")) el.style.color = "#cdcdcd";
      return;
    case "misalign": {
      const row = pmRows()[2];
      if (row === undefined) throw new Error("弄坏 misalign：左栏不到 3 行");
      row.style.transform = "translateX(6px)";
      return;
    }
    case "gradient-shadow": {
      const send = one('[aria-label="Send"]');
      Object.assign(send.style, { backgroundImage: "linear-gradient(135deg, #4f46e5, #a855f7)", boxShadow: "0 8px 22px rgba(79, 70, 229, 0.55)", color: "#fff", opacity: "1" });
      return;
    }
    case "cramped":
      for (const el of [rail, ...rail.querySelectorAll<HTMLElement>("*")]) {
        const style = getComputedStyle(el);
        el.style.paddingTop = `${parseFloat(style.paddingTop) / 2}px`;
        el.style.paddingBottom = `${parseFloat(style.paddingBottom) / 2}px`;
        if (style.rowGap !== "normal") el.style.rowGap = `${parseFloat(style.rowGap) / 2}px`;
        el.style.lineHeight = "1.1";
      }
      return;
    case "two-primaries": {
      // 提问卡的选项平时都是白底细边框；把头两个都涂成实心强调色
      const vars = getComputedStyle(log);
      const fill = vars.getPropertyValue("--primary").trim();
      const ink = vars.getPropertyValue("--primary-foreground").trim();
      for (const option of askOptions.slice(0, 2)) {
        Object.assign(option.style, { backgroundColor: fill, color: ink, borderColor: fill });
        for (const child of option.querySelectorAll<HTMLElement>("*")) Object.assign(child.style, { color: ink, backgroundColor: "transparent", borderColor: ink });
      }
      return;
    }
    case "small-preview": {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      for (const row of pmRows()) for (const el of row.querySelectorAll<HTMLElement>("*")) if (parseFloat(getComputedStyle(el).fontSize) < body - 0.5) el.style.fontSize = "11px";
      return;
    }
    case "dot-suffix": {
      const heading = one('main h1');
      const extra = document.createElement("span");
      extra.textContent = " · agent-hub · Orchestrate · 3 Pieces";
      Object.assign(extra.style, { color: "#71717a", fontWeight: "400", fontSize: "0.84375rem", marginLeft: "6px" });
      heading.append(extra);
      return;
    }
    case "radius-mix": {
      const options = byText(log, '[role="group"][aria-label="Options"]', "60 秒");
      cardOf(options).style.borderRadius = "4px";
      return;
    }
    default:
      throw new Error(`没有叫 ${id} 的弄坏`);
  }
}
