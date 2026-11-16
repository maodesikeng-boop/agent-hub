import { describe, it } from "vitest";

describe("mergeRound", () => {
  it.todo("两家在同一处提的发现并成一条，by 里是两家");
  it.todo("只有一家提的 P0 到 P2 计分，只有一家提的 P3 不计分");
  it.todo("机器检查的发现计进行业标准这一项");
  it.todo("被驳回的发现带上理由、不计分");
  it.todo("每项取两家里低的，页面分取四项里最低的");
  it.todo("低于 PASS_SCORE 的图进 below");
  it.todo("评委整体印象分和算出来的分差 2 分以上的图进 disagreements");
  it.todo("缺卡或 sha256 对不上时抛 Error，列出是哪张图哪家评委");
});

describe("calibrationReport", () => {
  it.todo("四条门槛都过时 pass 是 true，failures 是空的");
  it.todo("同一张图同一项三次评分差 2 分时这张图不算稳");
  it.todo("P0 的弄坏比基准图只低 2 分时这个弄坏不合格");
  it.todo("弄坏的位置三次里只被指出一次时不合格");
  it.todo("指出的位置对但记在别的项上不算指出");
  it.todo("基准图上有 P1 时列进 baselineSevere 并且 pass 是 false");
  it.todo("两家页面分差不超过 1 的图不到八成时 pass 是 false");
});

describe("pickBatchSize", () => {
  it.todo("14 和 28 两档都过时返回 28");
  it.todo("只有 14 过时返回 14");
  it.todo("都没过时返回 null");
});

describe("sentinelDrift", () => {
  it.todo("哨兵图的页面分和校准中位数差 2 分时返回它的 key");
  it.todo("差 1 分以内返回空数组");
});

describe("regressions", () => {
  it.todo("出现上一轮没有的 P2 算变坏，带上新出现的发现");
  it.todo("只多了 P3 不算变坏");
  it.todo("上一轮就有的发现还在不算变坏");
});

describe("decideNext", () => {
  it.todo("有图低于 PASS_SCORE 时是 fix，带上这些图");
  it.todo("第一次全部达标是 confirm");
  it.todo("同一个提交连续两次全部达标是 done");
  it.todo("两次达标之间提交变了，重新从 confirm 算");
  it.todo("修满 MAX_FIX_ROUNDS 轮还有不达标的是 ask-user、max-rounds");
  it.todo("连续 STALL_ROUNDS 轮不达标图数没少、最低分没涨是 ask-user、stalled");
});
