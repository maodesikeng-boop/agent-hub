// 截图（docs/ui-polish-loop-design.md 第 3.2 节）：一条命令截全部界面。
// 不变量：同一个提交、同一份清单截两次，每张图的字节完全一样（视口、字号、时区、时钟、种子、动效都钉死，截图期间不改数据）。
import type { ViewportName } from "./limits.ts";
import type { MachineFinding } from "./checks.ts";

export interface CaptureOptions {
  repoRoot: string;
  /** 图和清单写到哪。 */
  outDir: string;
  /** 只截这些界面 id 或区域；不给就是全部。 */
  only?: readonly string[];
  /** 校准用：在这些界面上各注入哪些弄坏（mutations.ts），每个弄坏另出一张图，key 是 `<界面>@<视口>!<弄坏 id>`。 */
  mutate?: Readonly<Record<string, readonly string[]>>;
}

export interface CapturedShot {
  /** `<界面 id>@<视口>`，弄坏的图后面带 `!<弄坏 id>`。 */
  key: string;
  screenId: string;
  viewport: ViewportName;
  /** 相对 outDir。 */
  file: string;
  sha256: string;
  /** 有 focus 的界面另有一张局部的 2 倍图。 */
  focusFile?: string;
  focusSha256?: string;
  machineFindings: MachineFinding[];
}

/** 一次截图的清单，写成 outDir/manifest.json。 */
export interface CaptureManifest {
  /** 截的是哪个提交；工作区有没提交的改动时后面带 `+dirty`。 */
  commit: string;
  /** 浏览器版本，换了浏览器字节会变，对比前先看它。 */
  browser: string;
  shots: CapturedShot[];
}

/**
 * 前置：已经 `pnpm build`（dist/web 是当前工作区的）。
 * 后置：outDir 里是每张图的 PNG 和 manifest.json；任何一个界面到不了或超时，整个调用失败并说出是哪个界面，不留半截清单。
 * 自己起、自己关隔离的守护进程和浏览器，不碰用户正在跑的守护进程和数据目录。
 */
export async function captureAll(options: CaptureOptions): Promise<CaptureManifest> {
  throw new Error("未实现");
}

/** 两份清单里字节不一样的图的 key（一边有一边没有的也算）；都一样返回空数组。 */
export function diffManifests(a: CaptureManifest, b: CaptureManifest): string[] {
  throw new Error("未实现");
}
