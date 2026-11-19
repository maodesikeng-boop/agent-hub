import { describe, it } from "vitest";

describe("颜色名录", () => {
  it.todo("isJellyColorId：名录里的 id 为真，别的字符串、数字、null 为假");
  it.todo("jellyColorOf：每种颜色的 accent 对白色 ≥ 4.5:1，悬停变深（brightness-90）之后仍 ≥ 4.5:1");
  it.todo("jellyColorOf：每种颜色掺 --mix-bubble-me 的用户气泡底配前景色字 ≥ 4.5:1，果冻底上的次要文字 ≥ 4.5:1");
  it.todo("jellyColorOf：同一个 id 两次返回同一个对象");
  it.todo("前 20 种颜色的 id 和 PM_FRUITS 一一对应，顺序相同");
});

describe("项目经理的形象", () => {
  it.todo("defaultLookOf：造型是 pmFruitOf(编号)，颜色是这个造型的原色");
  it.todo("resolvePmLook：avatarFruit、avatarColor 缺了或是 null 时各自退回默认");
  it.todo("resolvePmLook：只换颜色时造型仍是按编号默认的那只");
  it.todo("resolvePmLook：不在名录里的造型或颜色（新版本设备传来的）退回默认，不抛错");
  it.todo("resolvePmLook：同样的造型和颜色两次返回同一个对象");
  it.todo("pickNewPmLook：取名录里第一个没被占的造型，配它的原色");
  it.todo("pickNewPmLook：20 种造型都被占了退回 defaultLookOf(编号)");
  it.todo("lookKey 和 parseLookKey 互逆；造型或颜色不在名录里 parseLookKey 返回 null");
});

describe("画史莱姆", () => {
  it.todo("slimePaths：原色画出来的主形象和加换色之前的 20 只每种颜色、每条路径都相同");
  it.todo("slimePaths(piece)：同一种颜色下 20 个造型画出来完全一样，换颜色才不同");
  it.todo("slimePaths(piece)：只有描边、身体、暗面、浅色和眼睛五种颜色，占的格子上下居中");
  it.todo("slimePaths：换颜色只换描边、身体、暗面、浅色、腮红、花纹，眼睛、叶子、喙、牙不变");
  it.todo("slimePaths：所有造型 × 所有颜色、主形象和 Piece 分身，坐标都在 12×12 格内，没有 NaN");
  it.todo("slimePaths：同样的输入两次返回同一个数组");
  it.todo("opticalLiftOf：主形象在 0 到 2 格之间，上移后身体上下中点落在画布中线；Piece 分身是 0");
  it.todo("slimeSvg：viewBox 12×12、crispEdges、透明底，没有 id、渐变、滤镜和位图");
  it.todo("slimeBitmap：边长是格子数的整数倍、最接近目标边长，底色是这个颜色的 backdrop，圆形裁切后像素角离圆边至少 padCells 格");
  it.todo("slimeBitmap：同样的输入两次得到逐字节相同的 rgb，换颜色后不同");
});
