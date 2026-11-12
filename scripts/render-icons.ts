// 画应用图标：src/web/public/icons/ 下的 favicon.svg 和各尺寸 PNG，以及 Windows 桌面端（Tauri）的图标。改了图案重跑一次，提交生成的文件。
//   node scripts/render-icons.ts
// PNG 用本机的 Chrome 无头模式截图（只在开发机上跑，CI 不跑）。CHROME 环境变量可以指定 Chrome 路径。
// Mac 应用的 AppIcon.icns 由 scripts/build-mac-app.sh 从 icon-512.png 转出来。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "src", "web", "public", "icons");
/** Windows 桌面端 tauri.conf.json 的 bundle.icon 列的那几个文件。 */
const WINDOWS_OUT = join(import.meta.dirname, "..", "apps", "windows", "crates", "fusa-desktop", "icons");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 底色：和纸的生成り，比页面底（styles.css 的 --background #fcfbf9）深半档，放在白色的标签栏、程序坞上也看得出方块。 */
const PAPER = "#f5f1e8";
/** 纹章色：蜜柑色（palette.ts 里“橙”的水果主色 #ec8a2c 再沉一点，16px 下也压得住和纸底）。 */
const MIKAN = "#e57f24";

/**
 * 果房纹（Fusa = 日语「房」，柑橘的果瓣聚成一轮）：照家纹的平面几何画，单色、对称、不加高光。
 * 512 画布正中一个外圈（丸），里面等分的果瓣，瓣与瓣之间、瓣与外圈之间留同一口气，中心留一枚轴心圆。
 * 网页右栏的切面进度轮（SliceWheelIcon.tsx）是同一套几何。
 */
const CREST = {
  /** 果瓣数。 */
  petals: 6,
  /** 外圈（丸）的外半径、粗细。 */
  ringR: 196,
  ring: 22,
  /** 外圈到果瓣的缝。 */
  gap: 16,
  /** 瓣与瓣之间的缝。 */
  seam: 14,
  /** 中心轴心圆（留白）的半径。 */
  hub: 40,
  /** 果瓣的圆角。 */
  corner: 12,
} as const;

/** 16～32px 的标签页小图标：外圈和缝都加粗一点，缩小之后不糊成一团（光学尺寸）。 */
const CREST_SMALL = { ...CREST, ring: 30, gap: 22, seam: 24, hub: 46 } as const;

type Point = [number, number];
type Crest = { readonly [K in keyof typeof CREST]: number };
const dir = (deg: number): Point => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const fmt = (n: number) => n.toFixed(1);

/** 以圆心 c 为顶点、半径 r、从角 a1 到 a2（度，y 朝下）的扇形，两条直边各往里缩 e（瓣间缝的一半）。 */
function sectorPath(c: Point, r: number, a1: number, a2: number, e: number): string {
  const n1 = dir(a1 + 90);
  const n2 = dir(a2 - 90);
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  const p: Point = [c[0] + (e * n2[1] - n1[1] * e) / det, c[1] + (n1[0] * e - e * n2[0]) / det];
  const hit = (d: Point): Point => {
    const w: Point = [p[0] - c[0], p[1] - c[1]];
    const wd = w[0] * d[0] + w[1] * d[1];
    const t = -wd + Math.sqrt(wd * wd - (w[0] ** 2 + w[1] ** 2) + r * r);
    return [p[0] + t * d[0], p[1] + t * d[1]];
  };
  const q1 = hit(dir(a1));
  const q2 = hit(dir(a2));
  return `M${fmt(p[0])} ${fmt(p[1])}L${fmt(q1[0])} ${fmt(q1[1])}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(q2[0])} ${fmt(q2[1])}Z`;
}

function crest(k: Crest, bg: string): string {
  const c: Point = [256, 256];
  const parts = [`<circle cx="256" cy="256" r="${fmt(k.ringR - k.ring / 2)}" fill="none" stroke="${MIKAN}" stroke-width="${k.ring}"/>`];
  // 圆角：路径再往里缩 corner，用同色圆角描边补回来
  const r = k.ringR - k.ring - k.gap - k.corner;
  for (let i = 0; i < k.petals; i++) {
    const a1 = -90 + (i * 360) / k.petals;
    const d = sectorPath(c, r, a1, a1 + 360 / k.petals, k.seam / 2 + k.corner);
    parts.push(`<path d="${d}" fill="${MIKAN}" stroke="${MIKAN}" stroke-width="${2 * k.corner}" stroke-linejoin="round"/>`);
  }
  parts.push(`<circle cx="256" cy="256" r="${k.hub}" fill="${bg}"/>`);
  return parts.join("");
}

/**
 * - rounded：满画布的圆角方块（网页 favicon 用小尺寸版；Windows 桌面端的各尺寸用标准版，Windows 不留 macOS 那圈透明边）。
 * - full：满铺不透明（iOS 的 apple-touch、Android 的 maskable）；图案缩到中心 40% 半径以内，maskable 怎么裁都不会切到。
 * - padded：按 macOS 图标规范四周留透明边（1024 里 824 的圆角方块），icon-192/512 和 Mac 的 icns 用。
 */
function iconSvg(mode: "rounded" | "full" | "padded", k: Crest = CREST): string {
  const body = crest(k, PAPER);
  let inner: string;
  if (mode === "full") inner = `<rect width="512" height="512" fill="${PAPER}"/><g transform="translate(256 256) scale(0.88) translate(-256 -256)">${body}</g>`;
  else if (mode === "padded") inner = `<g transform="translate(50 50) scale(${412 / 512})"><rect width="512" height="512" rx="115" fill="${PAPER}"/>${body}</g>`;
  else inner = `<rect width="512" height="512" rx="112" fill="${PAPER}"/>${body}`;
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

/** 把几张 PNG 打成一个 .ico（Vista 起的 ICO 允许直接内嵌 PNG：6 字节头 + 每张 16 字节目录 + PNG 原样拼在后面）。 */
function writeIco(pngFiles: { size: number; file: string }[], out: string): void {
  const images = pngFiles.map(({ size, file }) => ({ size, data: readFileSync(file) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "favicon.svg"), iconSvg("rounded", CREST_SMALL));
renderPng(iconSvg("padded"), 192, join(OUT, "icon-192.png"));
renderPng(iconSvg("padded"), 512, join(OUT, "icon-512.png"));
renderPng(iconSvg("full"), 512, join(OUT, "icon-maskable-512.png"));
renderPng(iconSvg("full"), 180, join(OUT, "apple-touch-icon.png"));
console.log(`图标已写到 ${OUT}`);

mkdirSync(WINDOWS_OUT, { recursive: true });
const icoParts: { size: number; file: string }[] = [];
const icoDir = mkdtempSync(join(tmpdir(), "hub-ico-"));
try {
  for (const size of [16, 32, 48, 256]) {
    const file = join(icoDir, `${size}.png`);
    renderPng(iconSvg("rounded", size <= 32 ? CREST_SMALL : CREST), size, file);
    icoParts.push({ size, file });
  }
  writeIco(icoParts, join(WINDOWS_OUT, "icon.ico"));
} finally {
  rmSync(icoDir, { recursive: true, force: true });
}
renderPng(iconSvg("rounded", CREST_SMALL), 32, join(WINDOWS_OUT, "32x32.png"));
renderPng(iconSvg("rounded"), 128, join(WINDOWS_OUT, "128x128.png"));
renderPng(iconSvg("rounded"), 256, join(WINDOWS_OUT, "128x128@2x.png"));
renderPng(iconSvg("rounded"), 512, join(WINDOWS_OUT, "icon.png"));
console.log(`Windows 桌面端图标已写到 ${WINDOWS_OUT}`);
