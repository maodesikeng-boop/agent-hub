// 故意弄坏（docs/ui-polish-loop-design.md 第 3.5 节）：校准评委用。往基准界面上注入一处已知的毛病，看评委抓不抓得到、分数拉不拉得开。
// 弄坏只发生在截图用的那个浏览器页面里，不改仓库里的任何界面代码。
import type { Page } from "playwright";
import { inPage } from "./in-page-api.ts";
import type { Dimension, Severity } from "./rubric.ts";

export interface Mutation {
  id: string;
  /** 弄坏了什么，给人看。 */
  what: string;
  /** 评委应该把它记在哪一项、至少多严重。 */
  expectDimension: Dimension;
  expectSeverity: Severity;
}

export const MUTATIONS: readonly Mutation[] = [
  { id: "clip-right", what: "右栏拍板卡的内容比卡宽，右边被裁掉", expectDimension: "standard", expectSeverity: "P0" },
  { id: "covered-message", what: "输入框往上挪，盖住最后一条消息", expectDimension: "standard", expectSeverity: "P0" },
  { id: "low-contrast", what: "消息正文改成浅灰，对比度不到 3:1", expectDimension: "standard", expectSeverity: "P0" },
  { id: "misalign", what: "左栏第 3 行整体右移 6px，头像和上下行不在一条线上", expectDimension: "aesthetic", expectSeverity: "P1" },
  { id: "gradient-shadow", what: "发送键换成蓝紫渐变加重阴影", expectDimension: "style", expectSeverity: "P1" },
  { id: "cramped", what: "右栏行高和内边距减半，行挤在一起", expectDimension: "style", expectSeverity: "P1" },
  { id: "two-primaries", what: "拍板卡里两个选项都是实心强调色", expectDimension: "aesthetic", expectSeverity: "P1" },
  { id: "small-preview", what: "左栏消息预览改成 11px", expectDimension: "style", expectSeverity: "P2" },
  { id: "dot-suffix", what: "顶栏名字后面加一段用“·”拼接的灰字", expectDimension: "style", expectSeverity: "P2" },
  { id: "radius-mix", what: "提问卡的圆角改成 4px，和别的卡不一样", expectDimension: "style", expectSeverity: "P2" },
];

/**
 * 前置：页面已经到达要弄坏的界面。
 * 后置：页面上多了 id 对应的那一处毛病，别处不变。id 不在 MUTATIONS 里抛 RangeError。
 */
export async function applyMutation(page: Page, id: string): Promise<void> {
  if (!MUTATIONS.some((m) => m.id === id)) throw new RangeError(`没有叫 ${id} 的弄坏`);
  await page.evaluate(inPage.applyMutationInPage, id);
}

/** 校准用的基准图：用户定的候选 A，项目经理对话三栏（桌面）。弄坏都注入在它上面。 */
export const CALIBRATION_BASELINE = "chat.normal@desktop";
/** 校准用的真实界面（图的 key）：好的差的都有。修复前的模型面板要检出 PR #337 之前的提交另截，这里用现在的。 */
export const CALIBRATION_REAL_SHOTS = ["router.model-picker@desktop", "profile.normal@desktop", "settings.providers@desktop", "rail.task-graph@desktop", "m-settings.home@mobile"] as const;
/** 正式评审每轮混进去的哨兵：基准图加上这两个弄坏（一重一轻），图和分数都取自最近一次校准。 */
export const SENTINEL_MUTATIONS = ["clip-right", "radius-mix"] as const;
