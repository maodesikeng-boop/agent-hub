// node scripts/render-wood.ts
// Renders the shell's wood textures into src/web/assets/: the frame grain as a seamless SVG tile and the year rings of the
// PM list as a 2x AVIF overlay. Both are seeded, so a rerun writes the same files. docs/ui-standard.md section 2.4 lists the
// colors and opacities they are tuned against.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const OUT = join(import.meta.dirname, "..", "src", "web", "assets");

type Range = readonly [number, number];

const GRAIN = {
  width: 1200,
  height: 1000,
  seed: 11,
  column: [8, 16] as Range,
  length: [160, 420] as Range,
  gap: [12, 70] as Range,
  dark: "#160a03",
  darkOpacity: [0.068, 0.129] as Range,
  light: "#f3cfa3",
  lightOpacity: 0.048,
};

const RINGS = {
  width: 480,
  height: 1400,
  scale: 2,
  // Ring center for a list of the default width and a typical height, so arcs read the same on every screen size.
  centerX: -0.55 * 264,
  centerY: 0.38 * 800,
  period: 18,
  ink: [26, 12, 3] as const,
  opacity: 0.194,
  fadeRight: 80,
  fadeBottom: 240,
};

function prng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fixed = (n: number) => n.toFixed(1);

interface Stroke {
  x: number;
  y: number;
  length: number;
  bend: [number, number, number];
  width: number;
  opacity: number;
}

function columnPositions(random: () => number): number[] {
  const between = (r: Range) => r[0] + (r[1] - r[0]) * random();
  const steps: number[] = [];
  for (let total = 0; total < GRAIN.width; ) {
    const step = between(GRAIN.column);
    steps.push(step);
    total += step;
  }
  const scale = GRAIN.width / steps.reduce((a, b) => a + b, 0);
  const positions: number[] = [];
  let x = between([2, 8]);
  for (const step of steps) {
    positions.push(x);
    x += step * scale;
  }
  return positions;
}

function columnStrokes(x: number, random: () => number): Stroke[] {
  const between = (r: Range) => r[0] + (r[1] - r[0]) * random();
  const strokes: Stroke[] = [];
  const start = between([0, GRAIN.height]);
  const end = start + GRAIN.height;
  for (let y = start; end - y > GRAIN.length[0] * 0.4 + GRAIN.gap[0]; ) {
    const room = end - y - between(GRAIN.gap);
    const length = Math.min(between(GRAIN.length), room);
    if (length < GRAIN.length[0] * 0.4) break;
    strokes.push({
      x: x + between([-2, 2]),
      y,
      length,
      bend: [between([-3, 3]), between([-3, 3]), between([-2, 2])],
      width: between([1.1, 2.1]),
      opacity: between(GRAIN.darkOpacity),
    });
    y += length + between(GRAIN.gap);
  }
  return strokes;
}

function strokePath({ x, y, length, bend }: Stroke, dx: number, dy: number): string {
  const sx = x + dx;
  const sy = y + dy;
  return `M${fixed(sx)} ${fixed(sy)}C${fixed(sx + bend[0])} ${fixed(sy + length / 3)} ${fixed(sx + bend[1])} ${fixed(sy + (2 * length) / 3)} ${fixed(sx + bend[2])} ${fixed(sy + length)}`;
}

// Each stroke repeats one tile away wherever it crosses an edge, so the tile wraps without a seam.
function wrapOffsets(stroke: Stroke): [number, number][] {
  const xs = [0];
  if (stroke.x < 6) xs.push(GRAIN.width);
  if (stroke.x > GRAIN.width - 6) xs.push(-GRAIN.width);
  const ys = [0];
  if (stroke.y + stroke.length > GRAIN.height) ys.push(-GRAIN.height);
  return xs.flatMap((dx) => ys.map((dy): [number, number] => [dx, dy]));
}

export function grainSvg(): string {
  const random = prng(GRAIN.seed);
  const strokes = columnPositions(random).flatMap((x) => columnStrokes(x, random));
  const dark: string[] = [];
  const light: string[] = [];
  for (const stroke of strokes) {
    for (const [dx, dy] of wrapOffsets(stroke)) {
      dark.push(`<path d="${strokePath(stroke, dx, dy)}" stroke-width="${stroke.width.toFixed(2)}" stroke-opacity="${stroke.opacity.toFixed(3)}"/>`);
      light.push(`<path d="${strokePath(stroke, dx + stroke.width * 0.9 + 0.6, dy)}"/>`);
    }
  }
  const { width, height } = GRAIN;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<g fill="none" stroke="${GRAIN.light}" stroke-linecap="round" stroke-width="1" stroke-opacity="${GRAIN.lightOpacity}">${light.join("")}</g>`,
    `<g fill="none" stroke="${GRAIN.dark}" stroke-linecap="round">${dark.join("")}</g>`,
    `</svg>\n`,
  ].join("");
}

function hash(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t: number) => t * t * (3 - 2 * t);

function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * noise(x * frequency, y * frequency, seed + octave * 17);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

const smoothstep = (e0: number, e1: number, x: number) => fade(Math.min(1, Math.max(0, (x - e0) / (e1 - e0))));

/** -1 is the darkest latewood line and 0 or above is bare wood, at a CSS-pixel position of the list. */
export function ringTone(x: number, y: number): number {
  const warp = 26 * (fbm(x * 0.006, y * 0.006, 3, 53) - 0.5) * 2 + 3 * (fbm(x * 0.06, y * 0.06, 2, 67) - 0.5) * 2;
  const radius = Math.hypot(x - RINGS.centerX, y - RINGS.centerY) + warp;
  const phase = radius / RINGS.period + 0.9 * fbm(radius * 0.012, 3.3, 2, 79);
  const f = phase - Math.floor(phase);
  const late = smoothstep(0.66, 0.95, f) * (1 - smoothstep(0.965, 1, f));
  const fine = fbm(x * 0.35, y * 0.35, 2, 83) - 0.5;
  return Math.max(-1, Math.min(1, -0.95 * late + 0.5 * fine));
}

// One ink color keeps the color channels flat, so the encoder spends its bits on the rings in the alpha channel.
function ringsPixels(): Buffer {
  const width = RINGS.width * RINGS.scale;
  const height = RINGS.height * RINGS.scale;
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = (col + 0.5) / RINGS.scale;
      const y = (row + 0.5) / RINGS.scale;
      const edge = (1 - smoothstep(RINGS.width - RINGS.fadeRight, RINGS.width, x)) * (1 - smoothstep(RINGS.height - RINGS.fadeBottom, RINGS.height, y));
      const at = (row * width + col) * 4;
      pixels[at] = RINGS.ink[0];
      pixels[at + 1] = RINGS.ink[1];
      pixels[at + 2] = RINGS.ink[2];
      pixels[at + 3] = Math.round(255 * Math.max(0, -ringTone(x, y)) * RINGS.opacity * edge);
    }
  }
  return pixels;
}

export async function ringsAvif(): Promise<Buffer> {
  const raw = { width: RINGS.width * RINGS.scale, height: RINGS.height * RINGS.scale, channels: 4 as const };
  return sharp(ringsPixels(), { raw }).avif({ quality: 70, effort: 6 }).toBuffer();
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "wood-grain.svg"), grainSvg());
  writeFileSync(join(OUT, "wood-rings.avif"), await ringsAvif());
}
