// 画应用图标：src/web/public/icons/ 下的 favicon.svg 和各尺寸 PNG。改了图案重跑一次，提交生成的文件。
//   node scripts/render-icons.ts
// PNG 用本机的 Chrome 无头模式截图（只在开发机上跑，CI 不跑）。CHROME 环境变量可以指定 Chrome 路径。
// Mac 应用的 AppIcon.icns 由 scripts/build-mac-app.sh 从 icon-512.png 转出来。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "src", "web", "public", "icons");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 底色：palette.ts 里“橙”的水果主色。 */
const BG = "#ff7a1a";
/** 果肉：比底色浅一点（底色掺 25% 白），和底色分得出、又不跳。 */
const FLESH = "#ff9b53";

/**
 * 一瓣橘子（Fusa = 日语“房”）：512 画布上一个正放的四分之一圆，直角在左下、果皮弧在右上。
 * 白色果皮和两侧切面，中间三块实心果肉。
 */
const WEDGE = {
  /** 半径；外框（R×R 的正方形）在画布正中。 */
  R: 290,
  /** 果皮（白）到果肉的厚度：弧那边。 */
  peel: 44,
  /** 两条直边到果肉的白边。 */
  side: 12,
  /** 果肉块之间的白膜。 */
  membrane: 12,
  /** 圆角：整瓣外轮廓、果肉块。 */
  corner: 18,
  fleshCorner: 10,
} as const;

type Point = [number, number];
const dir = (deg: number): Point => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const fmt = (n: number) => n.toFixed(1);

/** 以 a 为顶点、半径 r、从角 a1 到 a2（度，y 朝下）的扇形，两条直边各往里缩 e1/e2，弧往里缩 ea（弧的圆心不变）。 */
function sectorPath(a: Point, r: number, a1: number, a2: number, e1: number, e2: number, ea: number): string {
  const n1 = dir(a1 + 90);
  const n2 = dir(a2 - 90);
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  const p: Point = [a[0] + (e1 * n2[1] - n1[1] * e2) / det, a[1] + (n1[0] * e2 - e1 * n2[0]) / det];
  const rr = r - ea;
  const hit = (d: Point): Point => {
    const w: Point = [p[0] - a[0], p[1] - a[1]];
    const wd = w[0] * d[0] + w[1] * d[1];
    const t = -wd + Math.sqrt(wd * wd - (w[0] ** 2 + w[1] ** 2) + rr * rr);
    return [p[0] + t * d[0], p[1] + t * d[1]];
  };
  const q1 = hit(dir(a1));
  const q2 = hit(dir(a2));
  return `M${fmt(p[0])} ${fmt(p[1])}L${fmt(q1[0])} ${fmt(q1[1])}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(q2[0])} ${fmt(q2[1])}Z`;
}

/** 圆角扇形：路径再往里缩 corner，用同色圆角描边补回来。 */
function roundedSector(a: Point, r: number, a1: number, a2: number, e1: number, e2: number, ea: number, corner: number, color: string): string {
  const d = sectorPath(a, r, a1, a2, e1 + corner, e2 + corner, ea + corner);
  return `<path d="${d}" fill="${color}" stroke="${color}" stroke-width="${2 * corner}" stroke-linejoin="round"/>`;
}

function wedge(): string {
  const { R, peel, side, membrane, corner, fleshCorner } = WEDGE;
  const apex: Point = [256 - R / 2, 256 + R / 2];
  const a1 = -90;
  const a2 = 0;
  const parts = [roundedSector(apex, R, a1, a2, 0, 0, 0, corner, "#ffffff")];
  const step = (a2 - a1) / 3;
  for (let i = 0; i < 3; i++) {
    const e1 = i === 0 ? side : membrane / 2;
    const e2 = i === 2 ? side : membrane / 2;
    parts.push(roundedSector(apex, R, a1 + i * step, a1 + (i + 1) * step, e1, e2, peel, fleshCorner, FLESH));
  }
  return parts.join("");
}

/**
 * - rounded：满画布的圆角方块（网页 favicon）。
 * - full：满铺不透明（iOS 的 apple-touch、Android 的 maskable）；图案缩到中心 40% 半径以内，maskable 怎么裁都不会切到。
 * - padded：按 macOS 图标规范四周留透明边（1024 里 824 的圆角方块），icon-192/512 和 Mac 的 icns 用。
 */
function iconSvg(mode: "rounded" | "full" | "padded"): string {
  const body = wedge();
  let inner: string;
  if (mode === "full") inner = `<rect width="512" height="512" fill="${BG}"/><g transform="translate(256 256) scale(0.88) translate(-256 -256)">${body}</g>`;
  else if (mode === "padded") inner = `<g transform="translate(50 50) scale(${412 / 512})"><rect width="512" height="512" rx="115" fill="${BG}"/>${body}</g>`;
  else inner = `<rect width="512" height="512" rx="112" fill="${BG}"/>${body}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${inner}</svg>\n`;
}

function renderPng(svg: string, size: number, file: string): void {
  const dir = mkdtempSync(join(tmpdir(), "hub-icon-"));
  try {
    const html = join(dir, "icon.html");
    writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`);
    execFileSync(CHROME, [
      "--headless=new",
      // 只渲染上面自己生成的 SVG；关掉 Chrome 自己的沙箱，在受限的终端（比如 agent 的沙箱）里也能跑
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${join(dir, "profile")}`,
      "--hide-scrollbars",
      "--default-background-color=00000000",
      "--force-device-scale-factor=1",
      `--window-size=${size},${size}`,
      `--screenshot=${file}`,
      `file://${html}`,
    ], { stdio: "ignore" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "favicon.svg"), iconSvg("rounded"));
renderPng(iconSvg("padded"), 192, join(OUT, "icon-192.png"));
renderPng(iconSvg("padded"), 512, join(OUT, "icon-512.png"));
renderPng(iconSvg("full"), 512, join(OUT, "icon-maskable-512.png"));
renderPng(iconSvg("full"), 180, join(OUT, "apple-touch-icon.png"));
console.log(`图标已写到 ${OUT}`);
