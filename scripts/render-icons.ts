// node scripts/render-icons.ts [母图输出路径]
// macOS 从 icon-512.png 生成 ICNS。Windows 用 Tauri CLI 从 1024px 母图生成。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { routerBellPaths } from "../src/shared/slimes.ts";

const OUT = join(import.meta.dirname, "..", "src", "web", "public", "icons");
const BG = "#2f6f43";
const SHADOW = "#235634";

type IconMode = "favicon" | "rounded" | "full" | "padded";

function iconSvg(mode: IconMode): string {
  const body = routerBellPaths().map(({ d, fill }) => `<path d="${d}" fill="${fill}"/>`).join("");
  const bellY = mode === "favicon" ? 1 : 1.75;
  const bell = `<g shape-rendering="crispEdges"><path fill="${SHADOW}" d="M3 13.5h10v1H3zM4 14.5h8v.5H4z"/><g transform="translate(2 ${bellY})">${body}</g></g>`;
  const background = `<rect width="16" height="16" rx="${mode === "full" ? 0 : 3.6}" fill="${BG}"/>`;
  const inner = mode === "padded"
    ? `<g transform="translate(1.5625 1.5625) scale(.8046875)">${background}${bell}</g>`
    : mode === "full"
      ? `${background}<g transform="translate(2.24 2.24) scale(.72)">${bell}</g>`
      : `${background}${bell}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${inner}</svg>\n`;
}

function renderPng(mode: IconMode, size: number, path: string) {
  const svg = iconSvg(mode).replace("<svg ", `<svg width="${size}" height="${size}" `);
  return sharp(Buffer.from(svg)).png().toFile(path);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "favicon.svg"), iconSvg("favicon"));
const master = process.argv[2];
await Promise.all([
  renderPng("padded", 192, join(OUT, "icon-192.png")),
  renderPng("padded", 512, join(OUT, "icon-512.png")),
  renderPng("full", 512, join(OUT, "icon-maskable-512.png")),
  renderPng("full", 180, join(OUT, "apple-touch-icon.png")),
  ...(master ? [renderPng("rounded", 1024, master)] : []),
]);
