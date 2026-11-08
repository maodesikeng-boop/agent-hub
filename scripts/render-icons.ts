// 画加到主屏幕的图标（联机 P4）：src/web/public/icons/ 下的 favicon.svg 和各尺寸 PNG。改了图案重跑一次，提交生成的文件。
//   node scripts/render-icons.ts
// PNG 用本机的 Chrome 无头模式截图（只在开发机上跑，CI 不跑）。CHROME 环境变量可以指定 Chrome 路径。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "src", "web", "public", "icons");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 底色：界面的主色（styles.css 的 --primary / --foreground）。 */
const INK = "#18181b";

/**
 * 512 的画布：中间一个点连着三个点（一台入口管几台设备 / 一个项目经理带几个 Worker）。
 * 图案都在中心 40% 半径以内，Android 的 maskable 怎么裁都不会切到。full：满铺不透明（iOS、maskable）；否则是圆角方块。
 */
function iconSvg(full: boolean): string {
  const r = 140;
  const dot = 38;
  // 上面一个点、下面两个点：整个图案的外框上下居中（中心点因此略低于画布中心）
  const c = 256 + (r - r * Math.sin(Math.PI / 6)) / 2;
  const nodes = [-90, 30, 150].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: 256 + r * Math.cos(a), y: c + r * Math.sin(a) };
  });
  const lines = nodes.map((n) => `<line x1="256" y1="${c}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" />`).join("");
  const dots = nodes.map((n) => `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${dot}" />`).join("");
  const bg = full ? `<rect width="512" height="512" fill="${INK}" />` : `<rect width="512" height="512" rx="112" fill="${INK}" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${bg}<g stroke="#fff" stroke-width="28" stroke-linecap="round">${lines}</g><g fill="#fff">${dots}<circle cx="256" cy="${c}" r="58" /></g></svg>\n`;
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
writeFileSync(join(OUT, "favicon.svg"), iconSvg(false));
renderPng(iconSvg(false), 192, join(OUT, "icon-192.png"));
renderPng(iconSvg(false), 512, join(OUT, "icon-512.png"));
renderPng(iconSvg(true), 512, join(OUT, "icon-maskable-512.png"));
renderPng(iconSvg(true), 180, join(OUT, "apple-touch-icon.png"));
console.log(`图标已写到 ${OUT}`);
