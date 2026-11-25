// Node 端拿 in-page.ts 里的函数：它要用 DOM 类型单独检查，主工程不 import 它（import 会把它拉进不带 DOM 的类型检查），
// 改成按路径动态加载，类型照这里写的接口用。Playwright 把函数源码序列化进页面执行。
import type { RawHit } from "./checks.ts";
import type { ComposerBox, EdgeItem, FrameBox } from "./structure-checks.ts";

export interface InPageApi {
  fontsReady(): Promise<void>;
  scrollToPosition(el: unknown, where: "top" | "bottom" | number): Promise<void>;
  dragFiles(args: { selector: string; names: readonly string[]; drop?: boolean }): void;
  measureInPage(options: { touch: boolean }): RawHit[];
  collectStructureInPage(): { frames: FrameBox[]; edges: EdgeItem[]; composers: ComposerBox[] };
  applyMutationInPage(id: string): void;
}

const IN_PAGE = new URL("./in-page.ts", import.meta.url).href;

export const inPage = (await import(IN_PAGE)) as InPageApi;
