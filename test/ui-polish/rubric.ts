// 评分标准（docs/ui-polish-loop-design.md 第 3.3、3.4 节）：四项、严重度、能引用的规则、分档、评分卡的形状。
// 评委提示词（judge-prompt.ts）、合分（score.ts）、给用户看的评分卡都从这一处取，不各写各的。
// 不变量：分数由发现按固定的表算出来，评委自己报的整体印象分只用来对账，不进最后的分数。
import { z } from "zod";
import { CONTRAST_SEVERITY_LINES, FINDING_TEXT_MAX_CHARS, MAX_FINDINGS_PER_CARD } from "./limits.ts";

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
 * 9 分的审美高线。没有硬伤只说明到了及格的毛坯，离 9 分还差“好看”。
 * 基准图本身也只有 6 到 7 分：它只定风格不跑偏，不是天花板。
 */
export const NINE_POINT_BAR: readonly string[] = [
  "没有裁切、错位、遮挡这些硬伤，不等于 9 到 10 分。",
  "9 分以上要对得上 Linear、Claude 桌面版、iA Writer、柳宗理器物那一级的完成度：克制，比例匀称，留白通透，细节做到位。",
  "功能正常、没有报错，但排版呆板拘谨、疏密失衡、层级平庸、没有呼吸感，这是 6 到 7 分的毛坯：引 A1 到 A8 里对应的那条，照实记 P1（这一项封顶 6 分）或 P2（封顶 7 到 8 分），并写出具体怎么改好看。",
  "基准图只管风格基因不跑偏，不是 9 分的样板。和基准图一样不等于好；在同一套气质里比基准图更好看是对的。",
];

/** 归口规则：同一处毛病只能算在一条规则、一项上，严重度照这里定死，不由评委自选。 */
export const ATTRIBUTION_RULES: readonly string[] = [
  "同一处根因只记一条发现，不准拆成几条，也不准跨几条规则、几项重复记。",
  `对比度只归行业标准：只引 \`WCAG 1.4.3\`、\`WCAG 1.4.11\` 或 \`machine:contrast\`。对比度低于 ${CONTRAST_SEVERITY_LINES.P0_BELOW}:1 记 P0；${CONTRAST_SEVERITY_LINES.P0_BELOW}:1 到 ${CONTRAST_SEVERITY_LINES.P1_BELOW}:1 之间记 P1。不在 U5、S1、A6 里再记。`,
  "`machine:overlap` 只有盖住文字、图标或控件主体，导致看不全、点不到时记 P0；相邻按钮透明的可点范围边缘擦碰几个像素、看上去没有遮挡的，一律记 P2。",
  "一屏或一张卡里出现两个实心主按钮抢主次，只记 `A1` P1，不在 U1、S1、ui-standard 里再记。",
  "同类区域的行高或内边距比基准图压缩一半以上、文字挤成一团，记 `S3` 或 `S5` 的 P1（二选一，不重复记）。",
];

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
  { id: "S1", dimension: "style", title: "配色", source: "基准图的风格说明；ui-standard 第 4 条", check: "大面积底色极淡中性或微暖；强调色只在主按钮、选中态、小圆点这几处小面积出现，选中和门禁用 10% 浅果冻底；颜色跑出这套气质才记，对比度不在这里记" },
  { id: "S2", dimension: "style", title: "字号层级", source: "基准图的风格说明；ui-standard 第 3 条", check: "一屏里的字号只有 12、13.5、15、17 四档（资料页名字 22 除外），字重只有 400、500、600" },
  { id: "S3", dimension: "style", title: "间距节奏", source: "基准图的风格说明；ui-standard 第 1 条", check: "间距落在 ui-standard 的间距档位上，同类容器的内边距、同类行的行高在本屏内一致；不要求和基准图的像素一样，比基准图更舒展匀称是加分；同类区域的行高或内边距比基准图压缩一半以上、文字挤成一团记 P1" },
  { id: "S4", dimension: "style", title: "形状", source: "基准图的风格说明；ui-standard 第 2、4 条", check: "圆角只有三档；除聊天输入框外没有阴影；没有渐变和毛玻璃；分隔只用 1px 细线或底色" },
  { id: "S5", dimension: "style", title: "疏密", source: "基准图的风格说明", check: "导航栏紧凑、阅读区宽裕，过程细节默认收起；不要求留白占比和基准图一样，更通透更好；同类区域的行高或内边距比基准图压缩一半以上、文字挤成一团记 P1，空得说不出理由记 P2" },
  { id: "S6", dimension: "style", title: "语气", source: "ui-standard 第 3、13、14 条；frontend-rules 第 2 条", check: "外壳用英文、句首大写；状态词是 Working… 这一套；不用“·”“|”“/”拼接；没有解释性的灰色小字" },

  { id: "A1", dimension: "aesthetic", title: "层级", source: "Wathan、Schoger《Refactoring UI》的层级一章；设计评审常用的眯眼测试", check: "把图缩到四分之一：第一眼落在这一屏最重要的东西上，次要信息明显退后；主操作只有一个，一屏或一张卡里出现两个实心主按钮抢主次记 P1" },
  { id: "A2", dimension: "aesthetic", title: "对齐", source: "Müller-Brockmann《Grid Systems in Graphic Design》；Robin Williams 的对齐原则", check: "数一数各块左边缘连成的竖线，同一栏里应当只有一到两条；数字、图标、文字的基线对得上" },
  { id: "A3", dimension: "aesthetic", title: "亲疏", source: "格式塔的接近律和相似律", check: "相关的东西挨得近、无关的离得远；组内间距小于组间间距；同类的东西长得一样" },
  { id: "A4", dimension: "aesthetic", title: "留白", source: "原研哉《白》；Rams 十条第 10 条“尽可能少的设计”", check: "内容不顶边、不挤在一起，也没有说不出理由的大块空白；留白是匀的，不是一头挤一头空" },
  { id: "A5", dimension: "aesthetic", title: "字体排印", source: "Bringhurst《The Elements of Typographic Style》", check: "正文一行 45 到 75 个西文字符或 25 到 40 个汉字；行高让上下行不粘；中英文之间有空格；数字等宽对齐" },
  { id: "A6", dimension: "aesthetic", title: "色彩纪律", source: "Itten《色彩艺术》的面积对比；Tufte 的“最小有效差异”", check: "一屏以中性色为主，强调色面积很小；靠深浅分层级，不靠多种颜色；状态色只表示状态" },
  { id: "A7", dimension: "aesthetic", title: "克制", source: "Rams 十条第 5、10 条；Tufte《The Visual Display of Quantitative Information》的数据墨水比", check: "逐个元素问“删掉它用户会不会少知道什么”：多余的边框、底色胶囊、图标、分隔线都算毛病" },
  { id: "A8", dimension: "aesthetic", title: "细节完成度", source: "Rams 十条第 8 条“细致到最后一个细节”；民艺运动的“用之美”（柳宗悦提出，柳宗理在产品设计里沿用）", check: "没有被裁的字和图标；嵌套圆角内小外大；图标粗细一致；截断处有省略号；光学上居中的看着居中" },

  { id: "U1", dimension: "ux", title: "一眼知道做什么", source: "Krug《Don't Make Me Think》；Nielsen 十条第 6 条“认得出，不用回忆”", check: "不看说明能说出这一屏是干什么的、下一步点哪里；能点的东西看着就能点；两个实心主按钮抢主次归 A1，不在这里再记" },
  { id: "U2", dimension: "ux", title: "状态看得见", source: "Nielsen 十条第 1 条“系统状态可见”", check: "在忙、空、出错、离线各有交代；空状态和错误告诉用户下一步怎么办" },
  { id: "U3", dimension: "ux", title: "好点", source: "Fitts 定律；Apple HIG 触控目标 44pt；WCAG 2.2 的 2.5.8", check: "常用操作的目标够大、离手近；手机上可点范围不小于 44px；挨着的目标不会点错" },
  { id: "U4", dimension: "ux", title: "防错和可撤回", source: "Nielsen 十条第 3、5 条", check: "撤不回的操作有二次确认；危险按钮和普通按钮分得开；主按钮能点就一定交得上去" },
  { id: "U5", dimension: "ux", title: "看得全", source: "WCAG 2.2 的 1.4.1；Nielsen 十条第 6 条", check: "被截断的内容有办法看全；不靠颜色一种手段传达状态；对比度不在这里记，归行业标准" },
  { id: "U6", dimension: "ux", title: "位置一致", source: "Nielsen 十条第 4 条“一致和标准”", check: "同一个功能在各屏的位置、样子、叫法相同（关闭在右上、主按钮在最右、返回在左上）" },
  { id: "U7", dimension: "ux", title: "不打扰", source: "frontend-rules 第 2、5 条；Nielsen 十条第 8 条“简洁”", check: "细节默认收起；没有飘来飘去的动效；一屏里要用户注意的东西不超过一处" },
  { id: "U8", dimension: "ux", title: "手机顺手", source: "Hoober 的拇指热区研究；ui-standard 第 19、20 条", check: "主要操作在屏幕下半；输入框贴着键盘；没有横向滚动；安全区里不放内容" },
];

/**
 * 发现里 rule 一栏能写什么。行业标准这一项不列在 PRINCIPLES 里，直接引条款：
 * `ui-standard §<条>`、`frontend-rules §<条>`、`WCAG <条款号>`、`HIG touch-44`、`machine:<机器检查的 id>`。
 */
export const RULE_REF_PATTERN = /^(?:S[1-6]|[AU][1-8]|ui-standard §\d{1,2}(?:\.\d)?|frontend-rules §[1-5]|WCAG \d\.\d\.\d{1,2}|HIG touch-44|machine:[a-z][a-z-]*)$/;

const PRINCIPLE_DIMENSIONS = new Map<string, Dimension>(PRINCIPLES.map((p) => [p.id, p.dimension]));

/** 这条规则算在哪一项上：S、A、U 开头的看 PRINCIPLES，其余都算行业标准。rule 不合 RULE_REF_PATTERN 抛 RangeError。 */
export function dimensionOfRule(rule: string): Dimension {
  if (!RULE_REF_PATTERN.test(rule)) {
    throw new RangeError(`不能引用的规则：${rule}`);
  }
  return PRINCIPLE_DIMENSIONS.get(rule) ?? "standard";
}

/**
 * 分档表，算分和给评委看的分档文字都从这一份来：一项里某种严重度的发现到了 count 条，这一项最多 cap 分。
 * P0 不分项：数的是整张图上的 P0，四项一起封顶（内容看不到、功能用不了时四项都不成立）。
 * 同一严重度里 count 升序、cap 降序。
 */
export const SEVERITY_CAPS: Readonly<Record<Severity, ReadonlyArray<{ count: number; cap: number }>>> = {
  P0: [
    { count: 1, cap: 4 },
    { count: 2, cap: 2 },
  ],
  P1: [
    { count: 1, cap: 6 },
    { count: 2, cap: 5 },
    { count: 3, cap: 4 },
  ],
  P2: [
    { count: 1, cap: 8 },
    { count: 2, cap: 7 },
    { count: 4, cap: 6 },
  ],
  P3: [
    { count: 1, cap: 9 },
    { count: 3, cap: 8 },
  ],
};

function capOf(caps: typeof SEVERITY_CAPS, severity: Severity, count: number): number {
  return Math.min(10, ...caps[severity].filter((step) => count >= step.count).map((step) => step.cap));
}

/** 按分档表写出每一档长什么样，从 10 分到最低一档。 */
export function scoreBands(caps: typeof SEVERITY_CAPS): Array<{ score: number; means: string }> {
  const conditions = new Map<number, string[]>();
  for (const severity of SEVERITIES) {
    caps[severity].forEach((step, i) => {
      const next = caps[severity][i + 1];
      const range = next === undefined ? `${step.count} 条以上` : next.count - 1 === step.count ? `${step.count} 条` : `${step.count} 到 ${next.count - 1} 条`;
      const text = severity === "P0" ? `这张图上有 ${range} P0（P0 不分项，四项一起压到这一档）` : `这一项有 ${range} ${severity}`;
      conditions.set(step.cap, [...(conditions.get(step.cap) ?? []), text]);
    });
  }
  const scores = [...conditions.keys()].sort((a, b) => b - a);
  return [{ score: 10, means: "这一项一条发现都没有" }, ...scores.map((score) => ({ score, means: conditions.get(score)!.join("；或") }))];
}

export const SCORE_BANDS = scoreBands(SEVERITY_CAPS);

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
  /** 盲测编号 `item-NNN`（blind.ts），读进来以后由 cli 换回 `<界面 id>@<视口>`。 */
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
 * 按 SEVERITY_CAPS 把一张图的发现算成四项分数。
 * 后置：每项从 10 分起，按这一项里各严重度的条数取表里最低的那一档；没有发现的项是 10。
 * 任何一条 P0 把四项都按整张图上 P0 的条数封顶。同样的发现不管顺序算出来一样。
 */
export function scoreFromFindings(findings: ReadonlyArray<Pick<Finding, "rule" | "severity">>): DimensionScores {
  const counts = Object.fromEntries(DIMENSIONS.map((d) => [d, { P0: 0, P1: 0, P2: 0, P3: 0 }])) as Record<Dimension, Record<Severity, number>>;
  let p0 = 0;
  for (const item of findings) {
    const dim = dimensionOfRule(item.rule);
    if (item.severity === "P0") p0++;
    else counts[dim][item.severity]++;
  }
  const p0Cap = capOf(SEVERITY_CAPS, "P0", p0);
  const score = (dim: Dimension) => Math.min(p0Cap, ...(["P1", "P2", "P3"] as const).map((sev) => capOf(SEVERITY_CAPS, sev, counts[dim][sev])));
  return { style: score("style"), standard: score("standard"), aesthetic: score("aesthetic"), ux: score("ux") };
}

/** 一张图的页面分：四项里最低的那一项。 */
export function pageScore(scores: DimensionScores): number {
  return Math.min(scores.style, scores.standard, scores.aesthetic, scores.ux);
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path;
  if (path[0] === "findings" && typeof path[1] === "number") {
    const idx = path[1];
    const field = path.slice(2).join(".");
    const prefix = `第 ${idx + 1} 条发现（findings[${idx}]${field ? `.${field}` : ""}）`;
    if (field === "rule") {
      return `${prefix}：rule 不在允许引用的范围里（只能引 S1-S6、A1-A8、U1-U8、ui-standard §<条>、frontend-rules §<1-5>、WCAG <条款号>、HIG touch-44 或 machine:<id>）`;
    }
    return `${prefix}：${issue.message}`;
  }
  if (path[0] === "findings" && path.length === 1 && issue.code === "too_big") {
    return `findings 超过上限（最多 ${MAX_FINDINGS_PER_CARD} 条，请把同一根因合并）`;
  }
  const label = path.length === 0 ? "根对象" : path.join(".");
  return `${label}：${issue.message}`;
}

/**
 * 读评委写的评分卡。
 * 后置：形状不对、rule 不在能引用的范围里、发现超过上限，返回 ok: false 和给评委看的原因（照着改就能过）；不抛错。
 */
export function parseScoreCard(json: string): { ok: true; card: ScoreCard } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, reason: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = scoreCardSchema.safeParse(raw);
  if (parsed.success) return { ok: true, card: parsed.data };
  return { ok: false, reason: parsed.error.issues.map(formatIssue).join("；") };
}
