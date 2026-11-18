// 史莱姆形象（docs/slime-cohesion-design.md）：项目经理的形象 = 造型 × 颜色，两样分开存、自由搭配。
// 不变量：
// - 造型的名录和顺序就是 shared/fruits.ts 的 PM_FRUITS（20 只水果史莱姆小动物，12×12 格像素稿）；颜色名录是 JELLY_COLOR_IDS，
//   前 20 种是各水果的原色（id 和水果同名），后面是新加的颜色。
// - 像素稿只用“角色字符”标颜色：描边、身体、暗面、浅色、腮红、花纹跟着颜色换；眼睛、叶子、喙、牙这类配件不换色。
// - 没存造型按编号取（pmFruitOf），没存颜色用这个造型自己的原色：老数据看起来和以前一模一样。
// - 网页头像、Piece 纸片分身、飞书群头像、应用图标都从这里画，不另存图片文件；同一个形象在哪画出来都一样。
import type { Pm, PmId } from "./domain.ts";
import { PM_FRUITS, type PmFruit } from "./fruits.ts";

/** 新加的颜色（不对应任何水果）。 */
export const EXTRA_JELLY_COLOR_IDS = ["sky", "teal", "sakura", "graphite"] as const;
export type ExtraJellyColorId = (typeof EXTRA_JELLY_COLOR_IDS)[number];
export type JellyColorId = PmFruit | ExtraJellyColorId;

/** 颜色名录，顺序就是选择器里色板的顺序。 */
export const JELLY_COLOR_IDS: readonly JellyColorId[] = [...PM_FRUITS, ...EXTRA_JELLY_COLOR_IDS];

/** 跟着颜色换的角色。 */
export type SlimeRole = "outline" | "body" | "shade" | "light" | "blush" | "mark";

/** 一套果冻色。 */
export interface JellyColor {
  id: JellyColorId;
  /** 界面上的英文名：色板的读屏名字和悬停提示。 */
  label: string;
  /** 像素稿里各角色的颜色。 */
  roles: Readonly<Record<SlimeRole, string>>;
  /** 主色：明亮，不放文字。进度图标、果皮轨、色板圆点用它。 */
  blob: string;
  /** 会话的 --primary：对白色的对比度 ≥ 4.5:1（WCAG 2.x 1.4.3），既当白字的底色也当白底上的字色。 */
  accent: string;
  accentForeground: string;
  /** 满铺浅底：飞书群头像的底色。 */
  backdrop: string;
}

/** 一只史莱姆的形象。 */
export interface SlimeLook {
  fruit: PmFruit;
  color: JellyColorId;
}

/** 存在项目经理身上的两项（pm_looks 表的 fruit、color）：null 是“用默认”。 */
export interface PmLookSetting {
  fruit: PmFruit | null;
  color: JellyColorId | null;
}

/** main 是项目经理的主形象；piece 是 Piece 的纸片分身（同一只压薄，不画明暗）。 */
export type SlimeKind = "main" | "piece";

/** 同一种颜色的格子并成的一条路径，坐标是 12×12 的格子。 */
export interface SlimePath {
  fill: string;
  d: string;
}

/** 后置：value 是名录里的颜色 id 时为真。 */
export function isJellyColorId(value: unknown): value is JellyColorId {
  throw new Error("未实现");
}

/** 后置：这种颜色的整套色值。同一个 id 每次返回同一个对象。 */
export function jellyColorOf(id: JellyColorId): JellyColor {
  throw new Error("未实现");
}

/** 后置：编号对应的默认形象，造型是 pmFruitOf(pmId)，颜色是这个造型的原色。 */
export function defaultLookOf(pmId: PmId): SlimeLook {
  throw new Error("未实现");
}

/**
 * 后置：项目经理现在的形象。avatarFruit、avatarColor 缺了、是 null、或不在名录里（比如新版本设备传来的颜色），各自退回 defaultLookOf 的那一项。
 * 同样的造型和颜色每次返回同一个对象（memo 的子组件不重画）。
 */
export function resolvePmLook(pm: Pick<Pm, "id" | "avatarFruit" | "avatarColor">): SlimeLook {
  throw new Error("未实现");
}

/**
 * 新建项目经理时分配的形象：不和 taken（没归档的项目经理现在的形象）撞造型。
 * 后置：取名录里第一个没被占的造型，配它的原色；20 种都占了，退回 defaultLookOf(pmId)。
 */
export function pickNewPmLook(taken: readonly SlimeLook[], pmId: PmId): SlimeLook {
  throw new Error("未实现");
}

/** 后置：形象的字符串键（如 "persimmon:sky"），飞书头像缓存按它认。parseLookKey(lookKey(x)) 等于 x。 */
export function lookKey(look: SlimeLook): string {
  throw new Error("未实现");
}

/** 后置：lookKey 的反过来；造型或颜色不在名录里返回 null。 */
export function parseLookKey(key: string): SlimeLook | null {
  throw new Error("未实现");
}

/**
 * 后置：这只史莱姆按 look 上色后的路径，一种颜色一条，坐标落在 12×12 格内。
 * 原色（color 等于 fruit）画出来和加换色之前的头像逐格相同。同样的输入每次返回同一个数组。
 */
export function slimePaths(look: SlimeLook, kind: SlimeKind): readonly SlimePath[] {
  throw new Error("未实现");
}

/**
 * 光学对齐要往上挪的格数：身体（不算耳朵、叶子、触角）的上下中点到画布中线的距离，纸片分身是 0。
 * 后置：0 到 2 之间；头像框里按它上移后，各只的身体都在框的正中。
 */
export function opticalLiftOf(fruit: PmFruit, kind: SlimeKind): number {
  throw new Error("未实现");
}

/** 后置：一张独立的 SVG 文本（viewBox 12×12，crispEdges，透明底，每种颜色一条 path，没有 id、渐变、滤镜）。 */
export function slimeSvg(look: SlimeLook, kind: SlimeKind): string {
  throw new Error("未实现");
}

/**
 * 满铺底色的位图，给飞书群头像和应用图标用（主形象）。
 * 后置：边长 size 是格子数的整数倍、最接近 targetPx；底色是 jellyColorOf(look.color).backdrop；每格整像素，没有插值；
 * 圆形裁切后离圆心最远的像素角到圆边至少留 padCells 格。同样的输入每次得到逐字节相同的 rgb。
 */
export function slimeBitmap(look: SlimeLook, targetPx: number, padCells: number): { size: number; rgb: Uint8Array } {
  throw new Error("未实现");
}
