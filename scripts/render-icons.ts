// node scripts/render-icons.ts [母图输出路径] [--art gate|router] [--plate cream|forest]
// 网页图标出到 src/web/public/icons/，README 门面图出到 docs/screenshots/icon-256.png。
// macOS 由 build-mac-app.sh 从 icon-512.png 生成 ICNS。Windows 用 Tauri CLI 从 1024px 母图生成：
// pnpm dlx @tauri-apps/cli@2 icon <母图> -o <临时目录>，再把 32x32.png、128x128.png、128x128@2x.png、icon.ico、icon.png 拷进 apps/windows/crates/fusa-desktop/icons/。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { GATE_BELL_GRID, gateBellPaths, routerBellPaths, type SlimePath } from "../src/shared/slimes.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "src", "web", "public", "icons");
const CORNER = 0.225;
const MAC_PLATE = 824 / 1024;
/** maskable 图标只保证正中直径 80% 的圆不被裁（W3C Web App Manifest 的 safe zone），画稿缩到这个比例才落在圆里。 */
const MASKABLE_ART = 0.72;

type IconMode = "favicon" | "rounded" | "full" | "padded";

interface Plate {
  fill: string;
  shade: string;
}

interface IconArt {
  /** 画布边长（格）。能整除 16，favicon 在 16px、32px 时一格是整像素。 */
  box: number;
  draw: (mode: IconMode, plate: Plate) => string;
}

const PLATES: Readonly<Record<string, Plate>> = {
  cream: { fill: "#fff3d6", shade: "#f1dcae" },
  forest: { fill: "#2f6f43", shade: "#235634" },
};

const pathsOf = (paths: readonly SlimePath[]) => paths.map(({ d, fill }) => `<path d="${d}" fill="${fill}"/>`).join("");

const ARTS: Readonly<Record<string, IconArt>> = {
  gate: { box: GATE_BELL_GRID + 2, draw: () => `<g transform="translate(1 1)">${pathsOf(gateBellPaths())}</g>` },
  router: {
    box: 16,
    draw: (mode, plate) =>
      `<path fill="${plate.shade}" d="M3 13.5h10v1H3zM4 14.5h8v.5H4z"/><g transform="translate(2 ${mode === "favicon" ? 1 : 1.75})">${pathsOf(routerBellPaths())}</g>`,
  },
};

function pick<T>(table: Readonly<Record<string, T>>, flag: string, key: string): T {
  const found = table[key];
  if (found === undefined) throw new Error(`--${flag} 只能是 ${Object.keys(table).join("、")}，收到 ${key}`);
  return found;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { art: { type: "string", default: "gate" }, plate: { type: "string", default: "cream" } },
});
const art = pick(ARTS, "art", values.art);
const plate = pick(PLATES, "plate", values.plate);

function iconSvg(mode: IconMode): string {
  const { box } = art;
  const bell = `<g shape-rendering="crispEdges">${art.draw(mode, plate)}</g>`;
  const background = `<rect width="${box}" height="${box}" rx="${mode === "full" ? 0 : box * CORNER}" fill="${plate.fill}"/>`;
  const inset = (scale: number, body: string) => {
    const offset = (box * (1 - scale)) / 2;
    return `<g transform="translate(${offset} ${offset}) scale(${scale})">${body}</g>`;
  };
  const inner = mode === "padded" ? inset(MAC_PLATE, background + bell) : mode === "full" ? background + inset(MASKABLE_ART, bell) : background + bell;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${inner}</svg>\n`;
}

function renderPng(mode: IconMode, size: number, path: string) {
  const svg = iconSvg(mode).replace("<svg ", `<svg width="${size}" height="${size}" `);
  return sharp(Buffer.from(svg)).png().toFile(path);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "favicon.svg"), iconSvg("favicon"));
const master = positionals[0];
await Promise.all([
  renderPng("padded", 192, join(OUT, "icon-192.png")),
  renderPng("padded", 512, join(OUT, "icon-512.png")),
  renderPng("full", 512, join(OUT, "icon-maskable-512.png")),
  renderPng("full", 180, join(OUT, "apple-touch-icon.png")),
  renderPng("rounded", 256, join(ROOT, "docs", "screenshots", "icon-256.png")),
  ...(master ? [renderPng("rounded", 1024, master)] : []),
]);
