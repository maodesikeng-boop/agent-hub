import { describe, it } from "vitest";

describe("pixelRailPath", () => {
  it.todo("solid 是一格宽的竖条，宽高都是 cell 的整数倍");
  it.todo("dotted 是一格见方的点，点和点之间空一格，最后一个点不越过 y2");
  it.todo("y1 等于 y2 时返回空字符串");
});

describe("pixelPolylinePath", () => {
  it.todo("横竖两段的折线在拐角削成一格台阶，线宽处处是一格");
  it.todo("输出只有横竖边，没有 C、Q、A 曲线命令，也没有斜线");
  it.todo("不越过输入折线的外包框");
  it.todo("相邻两点不横平也不竖直时抛错");
});

describe("orthogonalRoute", () => {
  it.todo("相邻两点之间先横后竖，结果相邻两点横平或竖直");
  it.todo("首尾两点对齐到格子后和输入相同，没有连续重复的点");
});

describe("pixelArrowPath", () => {
  it.todo("朝右的箭头尖端落在 tip，高 5 格、宽 3 格，三级台阶");
  it.todo("朝下的箭头是朝右的转过来");
});

describe("stepGlyphPath", () => {
  it.todo("每种状态都画在以 center 为中心的 5×5 格内");
  it.todo("done、waitingPm 实心，running 空心带芯，pending 空心，doneCoil 三道横杠，nextCoil 竖排三个点");
  it.todo("同样的输入两次得到同一个字符串");
});
