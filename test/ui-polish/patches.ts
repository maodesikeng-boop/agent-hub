// 命名补丁（docs/ui-polish-loop-design.md 第 3.2 节）：真守护进程撑不住的瞬时状态（在忙、流式、额度、离线、接口出错、加载中），
// 在浏览器这一头改写接口的回包来摆出来。补丁只在这里定义，清单里按名字引用。
// 不变量：补丁改写的回包仍然是 src/shared/api.ts 里那个接口的类型；补丁不发任何请求给守护进程。
import type { Page } from "playwright";

export const PATCH_NAMES = [
  "state-pending",
  "state-500",
  "ws-reconnecting",
  "health-driver",
  "session-working",
  "session-streaming",
  "workers-busy",
  "blocker-checking",
  "vendors-mixed",
  "models-long-names",
  "router-working",
  "router-failed",
  "router-vendor-agy",
  "send-rejected",
  "device-reconnecting",
  "device-offline",
  "quota-normal",
  "quota-max",
  "provider-installing",
  "provider-login-code",
  "provider-failed",
  "vendor-sync-preview",
  "browsers-pending",
  "public-access-on",
  "public-access-long-domain",
] as const;
export type PatchName = (typeof PATCH_NAMES)[number];

/**
 * 前置：在页面第一次导航之前调用。
 * 后置：之后这个页面发的相关请求拿到的是改写过的回包。name 不在 PATCH_NAMES 里抛 RangeError。
 */
export async function applyPatch(page: Page, name: string): Promise<void> {
  throw new Error("未实现");
}

/**
 * 截图不改数据：这个页面发出的非 GET 接口请求一律拦掉（打开总助会把简报标成已读，不拦的话第二次截出来就不一样）。
 * allow 里列的路径放行（到达步骤确实要点保存的界面才用）。
 */
export async function blockWrites(page: Page, allow?: readonly string[]): Promise<void> {
  throw new Error("未实现");
}
