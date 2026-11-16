// 评分标准（docs/ui-polish-loop-design.md 第 3.3、3.4 节）：四项、严重度、能引用的规则、分档、评分卡的形状。
// 评委提示词（judge-prompt.ts）、合分（score.ts）、给用户看的评分卡都从这一处取，不各写各的。
// 不变量：分数由发现按固定的表算出来，评委自己报的整体印象分只用来对账，不进最后的分数。
import { z } from "zod";
import { FINDING_TEXT_MAX_CHARS, MAX_FINDINGS_PER_CARD } from "./limits.ts";

export const DIMENSIONS = ["style", "standard", "aesthetic", "ux"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** 四项对应用户原话：产品的整体风格、行业严格标准、艺术家和美学家的美学表现、用户使用体验。 */
export const DIMENSION_TITLES: Record<Dimension, string> = {
  style: "风格一致",
  standard: "行业标准",
  aesthetic: "美学",
  ux: "使用体验",
};

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** 严重度怎么定：评委照这四句判，不凭感觉。 */
export const SEVERITY_MEANS: Record<Severity, string> = {
  P0: "内容看不到或功能用不了：被裁掉、互相盖住、字看不清、点不到",
  P1: "不用对比就看得出的毛病：明显错位、层级乱、违反标准里写明的条款",
  P2: "要和基准图或同类界面对比才看得出：局部不协调、间距档位不对、同类控件样子不一致",
  P3: "吹毛求疵：一两个像素的光学对齐、措辞可以更短",
};

/**
 * 一条能引用的原则。评委的每条发现都要引一条规则，引不出来的发现不算数。
 * “艺术家、美学家”落在 aesthetic 这一组：每条写明出处和在图上怎么核对。
 */
export interface Principle {
  id: string;
  dimension: Dimension;
  title: string;
  /** 出自哪里：人、书或规范。 */
  source: string;
  /** 在截图上怎么核对。 */
  check: string;
}

export const PRINCIPLES: readonly Principle[] = [
  { id: "S1", dimension: "style", title: "配色", source: "基准图的风格说明；ui-standard 第 4 条", check: "底色、字色、线色都在风格说明的色板里；强调色只出现在主按钮、选中态、小圆点这几处" },
  { id: "S2", dimension: "style", title: "字号层级", source: "基准图的风格说明；ui-standard 第 3 条", check: "一屏里的字号只有 12、13.5、15、17 四档（资料页名字 22 除外），字重只有 400、500、600" },
  { id: "S3", dimension: "style", title: "间距节奏", source: "基准图的风格说明；ui-standard 第 1 条", check: "同类容器的内边距、同类行的行高和基准图里的一样；间距都落在间距档位上" },
  { id: "S4", dimension: "style", title: "形状", source: "基准图的风格说明；ui-standard 第 2、4 条", check: "圆角只有三档；除聊天输入框外没有阴影；没有渐变和毛玻璃；分隔只用 1px 细线或底色" },
  { id: "S5", dimension: "style", title: "疏密", source: "基准图的风格说明", check: "和基准图里同类的区域比，不更挤也不更空：行与行的间隔、留白占比相当" },
  { id: "S6", dimension: "style", title: "语气", source: "ui-standard 第 3、13、14 条；frontend-rules 第 2 条", check: "外壳用英文、句首大写；状态词是 Working… 这一套；不用“·”“|”“/”拼接；没有解释性的灰色小字" },

  { id: "A1", dimension: "aesthetic", title: "层级", source: "Wathan、Schoger《Refactoring UI》的层级一章；设计评审常用的眯眼测试", check: "把图缩到四分之一：第一眼落在这一屏最重要的东西上，主操作只有一个，次要信息明显退后" },
  { id: "A2", dimension: "aesthetic", title: "对齐", source: "Müller-Brockmann《Grid Systems in Graphic Design》；Robin Williams 的对齐原则", check: "数一数各块左边缘连成的竖线，同一栏里应当只有一到两条；数字、图标、文字的基线对得上" },
  { id: "A3", dimension: "aesthetic", title: "亲疏", source: "格式塔的接近律和相似律", check: "相关的东西挨得近、无关的离得远；组内间距小于组间间距；同类的东西长得一样" },
  { id: "A4", dimension: "aesthetic", title: "留白", source: "原研哉《白》；Rams 十条第 10 条“尽可能少的设计”", check: "内容不顶边、不挤在一起，也没有说不出理由的大块空白；留白是匀的，不是一头挤一头空" },
  { id: "A5", dimension: "aesthetic", title: "字体排印", source: "Bringhurst《The Elements of Typographic Style》", check: "正文一行 45 到 75 个西文字符或 25 到 40 个汉字；行高让上下行不粘；中英文之间有空格；数字等宽对齐" },
  { id: "A6", dimension: "aesthetic", title: "色彩纪律", source: "Itten《色彩艺术》的面积对比；Tufte 的“最小有效差异”", check: "一屏以中性色为主，强调色面积很小；靠深浅分层级，不靠多种颜色；状态色只表示状态" },
  { id: "A7", dimension: "aesthetic", title: "克制", source: "Rams 十条第 5、10 条；Tufte《The Visual Display of Quantitative Information》的数据墨水比", check: "逐个元素问“删掉它用户会不会少知道什么”：多余的边框、底色胶囊、图标、分隔线都算毛病" },
  { id: "A8", dimension: "aesthetic", title: "细节完成度", source: "Rams 十条第 8 条“细致到最后一个细节”；民艺运动的“用之美”（柳宗悦提出，柳宗理在产品设计里沿用）", check: "没有被裁的字和图标；嵌套圆角内小外大；图标粗细一致；截断处有省略号；光学上居中的看着居中" },

  { id: "U1", dimension: "ux", title: "一眼知道做什么", source: "Krug《Don't Make Me Think》；Nielsen 十条第 6 条“认得出，不用回忆”", check: "不看说明能说出这一屏是干什么的、下一步点哪里；能点的东西看着就能点" },
  { id: "U2", dimension: "ux", title: "状态看得见", source: "Nielsen 十条第 1 条“系统状态可见”", check: "在忙、空、出错、离线各有交代；空状态和错误告诉用户下一步怎么办" },
  { id: "U3", dimension: "ux", title: "好点", source: "Fitts 定律；Apple HIG 触控目标 44pt；WCAG 2.2 的 2.5.8", check: "常用操作的目标够大、离手近；手机上可点范围不小于 44px；挨着的目标不会点错" },
  { id: "U4", dimension: "ux", title: "防错和可撤回", source: "Nielsen 十条第 3、5 条", check: "撤不回的操作有二次确认；危险按钮和普通按钮分得开；主按钮能点就一定交得上去" },
  { id: "U5", dimension: "ux", title: "读得清", source: "WCAG 2.2 的 1.4.3、1.4.11", check: "文字和底色的对比度够；被截断的内容有办法看全；不靠颜色一种手段传达状态" },
  { id: "U6", dimension: "ux", title: "位置一致", source: "Nielsen 十条第 4 条“一致和标准”", check: "同一个功能在各屏的位置、样子、叫法相同（关闭在右上、主按钮在最右、返回在左上）" },
  { id: "U7", dimension: "ux", title: "不打扰", source: "frontend-rules 第 2、5 条；Nielsen 十条第 8 条“简洁”", check: "细节默认收起；没有飘来飘去的动效；一屏里要用户注意的东西不超过一处" },
  { id: "U8", dimension: "ux", title: "手机顺手", source: "Hoober 的拇指热区研究；ui-standard 第 19、20 条", check: "主要操作在屏幕下半；输入框贴着键盘；没有横向滚动；安全区里不放内容" },
];

/**
 * 发现里 rule 一栏能写什么。行业标准这一项不列在 PRINCIPLES 里，直接引条款：
 * `ui-standard §<条>`、`frontend-rules §<条>`、`WCAG <条款号>`、`HIG touch-44`、`machine:<机器检查的 id>`。
 */
export const RULE_REF_PATTERN = /^(?:[SAU][1-8]|ui-standard §\d{1,2}(?:\.\d)?|frontend-rules §[1-5]|WCAG \d\.\d\.\d{1,2}|HIG touch-44|machine:[a-z][a-z-]*)$/;

/** 这条规则算在哪一项上：S、A、U 开头的看 PRINCIPLES，其余都算行业标准。rule 不合 RULE_REF_PATTERN 抛 RangeError。 */
export function dimensionOfRule(rule: string): Dimension {
  throw new Error("未实现");
}

/** 分档：一项的分数长什么样。分数由发现算出来（scoreFromFindings），这张表是给人看的对照。 */
export const SCORE_BANDS: ReadonlyArray<{ score: number; means: string }> = [
  { score: 10, means: "这一项一条发现都没有" },
  { score: 9, means: "只有一两条 P3，不改也不影响发布" },
  { score: 8, means: "有 1 条 P2，或 3 条以上 P3" },
  { score: 7, means: "有 2 到 3 条 P2" },
  { score: 6, means: "有 1 条 P1，或 4 条以上 P2" },
  { score: 5, means: "有 2 条 P1" },
  { score: 4, means: "有 3 条以上 P1；或这张图上有 1 条 P0（P0 不分项，四项一起压到这一档）" },
  { score: 2, means: "这张图上有 2 条以上 P0：这一屏基本没法用" },
];

const box = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

export const findingSchema = z.object({
  /** 违反了哪条（RULE_REF_PATTERN）。 */
  rule: z.string().regex(RULE_REF_PATTERN),
  severity: z.enum(SEVERITIES),
  /** 在整屏图上的位置，左上角和宽高，都是占整张图的比例。 */
  box,
  /** 哪里不对，说看得见的事实。 */
  what: z.string().min(1).max(FINDING_TEXT_MAX_CHARS),
  /** 建议怎么改。 */
  fix: z.string().min(1).max(FINDING_TEXT_MAX_CHARS),
});
export type Finding = z.infer<typeof findingSchema>;

const score = z.number().int().min(1).max(10);

/** 评委对一张图交的评分卡（一个 JSON 文件）。 */
export const scoreCardSchema = z.object({
  /** `<界面 id>@<视口>`。 */
  shot: z.string().min(1),
  /** `<厂商>/<模型>`。 */
  judge: z.string().min(1),
  /** 这个评委第几次评这张图，从 1 起。 */
  run: z.number().int().min(1),
  /** 评的是哪张图：整屏图的 sha256，和截图清单对得上才收。 */
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(findingSchema).max(MAX_FINDINGS_PER_CARD),
  /** 评委自己的整体印象分，只用来和算出来的分对账。 */
  holistic: z.object({ style: score, standard: score, aesthetic: score, ux: score }),
  /** 一句话总评。 */
  summary: z.string().max(FINDING_TEXT_MAX_CHARS),
});
export type ScoreCard = z.infer<typeof scoreCardSchema>;

export type DimensionScores = Record<Dimension, number>;

/**
 * 按 SCORE_BANDS 把一张图的发现算成四项分数。
 * 后置：每项从 10 分起，按这一项里各严重度的条数取表里最低的那一档；没有发现的项是 10。
 * P0 不分项：内容看不到、功能用不了时四项都不成立，所以任何一条 P0 把四项都按 P0 的条数压到 4 分或 2 分。
 * 同样的发现不管顺序算出来一样。
 */
export function scoreFromFindings(findings: ReadonlyArray<Pick<Finding, "rule" | "severity">>): DimensionScores {
  throw new Error("未实现");
}

/** 一张图的页面分：四项里最低的那一项。 */
export function pageScore(scores: DimensionScores): number {
  throw new Error("未实现");
}

/**
 * 读评委写的评分卡。
 * 后置：形状不对、rule 不在能引用的范围里、发现超过上限，返回 ok: false 和给评委看的原因（照着改就能过）；不抛错。
 */
export function parseScoreCard(json: string): { ok: true; card: ScoreCard } | { ok: false; reason: string } {
  throw new Error("未实现");
}
