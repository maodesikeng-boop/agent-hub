import { describe, it } from "vitest";

describe("tubePaths", () => {
  it.todo("center 依次连过每个点，只有横竖线段，没有 C、Q、A 曲线命令");
  it.todo("highlight 是 center 往左上各挪半格：竖段在芯的左半，横段在芯的上半");
  it.todo("相邻两点不横平也不竖直时抛错");
});

describe("orthogonalRoute", () => {
  it.todo("相邻两点之间先横后竖，结果相邻两点横平或竖直");
  it.todo("首尾两点对齐到格子后和输入相同，没有连续重复的点");
});

describe("pixelArrowPaths", () => {
  it.todo("朝右的箭头尖端落在 tip，高 9 格、宽 5 格，外圈描边、里面是芯");
  it.todo("朝下的箭头是朝右的转过来");
});

describe("stepBeadPaths", () => {
  it.todo("每种珠子都画在以 center 为中心的 7×7 格内，四角各缺一格");
  it.todo("done 有高光和暗面，running 中间 3×3 是芯，pending 只有灰描边，waitingPm 是琥珀色");
  it.todo("doneCoil 两道实心横条，nextCoil 同样形状但空心");
  it.todo("同样的输入两次得到同样的结果");
});
