// 界面打磨循环（docs/ui-polish-loop-design.md）可调的数集中在这一处：视口、固定时钟、分数线、校准门槛、轮数上限、批大小。
// 循环不进产品运行时，这些数只管它自己；产品的上限仍在 src/shared/limits.ts。

/** 截图用的视口。deviceScaleFactor 都是 2：1px 的细线和错位在 1 倍图上看不出来。 */
export const VIEWPORTS = {
  /** 三栏宽屏。 */
  desktop: { width: 1440, height: 900, touch: false },
  /** 1100px 以下：左栏收成 72px 头像窄栏（ui-standard 第 16 条）。 */
  narrow: { width: 1000, height: 800, touch: false },
  /** 720px 以下：右栏挪到顶栏下面，设置弹窗的分类变成顶上一排（第 10、12 条）。 */
  slim: { width: 700, height: 800, touch: false },
  /** 手机外壳（第 19、20 条）。 */
  mobile: { width: 390, height: 844, touch: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const DEVICE_SCALE_FACTOR = 2;

/** 种子数据里的“现在”和浏览器里的“现在”：都钉死，时间显示、相对时间每次一样。 */
export const SEED_START_ISO = "2026-11-16T14:00:00+08:00";
export const BROWSER_NOW_ISO = "2026-11-16T17:36:00+08:00";
export const SHOT_TIMEZONE = "Asia/Shanghai";
export const SHOT_LOCALE = "en-US";

/** 截图和种子用的固定目录：路径会出现在界面上（主文件夹路径），不能带随机后缀。每次开头清空。 */
export const SHOT_WORK_DIR = "/tmp/fusa-ui-shots";
/** 每轮产物（截图、评分卡）默认放这里的 R<轮次>/ 下，Worker 和评委都读写得到。 */
export const ROUND_OUTPUT_DIR = "/tmp/fusa-ui-polish";
/** 进仓库的记录：基准图、风格说明、校准报告、每轮一份 JSON。 */
export const RECORD_DIR = "docs/ui-polish";

/** 一个界面等到“画稳了”最多等多久，超了这张算失败、整条命令失败。 */
export const SHOT_READY_TIMEOUT_MS = 15_000;
/** 同时开几个浏览器上下文截图。 */
export const SHOT_PARALLEL = 4;

/** 达标线：每一项、每个评委都不低于它（“9 分怎么算”见方案第 3.4 节）。 */
export const PASS_SCORE = 9;
/** 连续几次独立评审全部达标才停。 */
export const PASS_STREAK = 2;
/** 最多修几轮，到了把剩下的问题列给用户。 */
export const MAX_FIX_ROUNDS = 6;
/** 连续几轮“不达标界面数没少、最低分没涨”就停下来报给用户。 */
export const STALL_ROUNDS = 2;

/** 校准：同一张图每个评委评几次。 */
export const CALIBRATION_RUNS = 3;
/** 校准：同一张图同一项几次评分最大差多少还算稳。 */
export const CALIBRATION_MAX_SPREAD = 1;
/** 校准：几成的校准图要满足上面那条。 */
export const CALIBRATION_STABLE_SHARE = 0.9;
/** 校准：基准图比“弄坏到 P0、P1”的图至少高几分；比“弄坏到 P2”的至少高几分。 */
export const CALIBRATION_MIN_GAP_SEVERE = 3;
export const CALIBRATION_MIN_GAP_MINOR = 1;
/** 校准：故意弄坏的地方 3 次里至少被指出几次才算抓到；P0、P1 的弄坏要有几成被抓到。 */
export const CALIBRATION_MIN_HITS = 2;
export const CALIBRATION_DETECT_SHARE = 0.9;
/** 校准：两家评委同一张图的页面分差不超过 1 的图至少占几成。 */
export const CALIBRATION_AGREE_SHARE = 0.8;
/** 校准不过就把评分标准写细再来，最多几次，再不过报给用户。 */
export const CALIBRATION_MAX_ATTEMPTS = 3;

/** 每轮混进去的哨兵图（基准图和两张弄坏的）：它们的分和校准时差得超过这个数，这一次评审作废重评。 */
export const SENTINEL_MAX_DRIFT = 1;

/**
 * 一个评委 Worker 一次评几张图。校准时每一档都测，正式评审用过了校准门槛的最大一档；
 * 大的那档过不了就用小的那档，分波次串行跑，不加并发。
 */
export const JUDGE_BATCH_CANDIDATES = [14, 28] as const;
/** 同时在跑的评委 Worker 最多几个（这台 Mac 吃紧）。任务图里靠分波次排依赖做到。 */
export const JUDGE_MAX_CONCURRENT = 6;
/** 一次评审两家评委合起来最多派几个 Worker。136 张图每批 28 张是每家 5 个，正好 10 个。 */
export const JUDGE_MAX_WORKERS_PER_REVIEW = 10;
/** 两家评委的发现算同一处：框的交并比不低于它，或同一张图引了同一条规则。 */
export const FINDING_MATCH_IOU = 0.3;
/** 一张评分卡最多几条发现：超了多半是评委把同一个问题拆碎了，按格式错误打回重评。 */
export const MAX_FINDINGS_PER_CARD = 20;
/** 每条发现“哪里不对”“怎么改”各最多多少字。 */
export const FINDING_TEXT_MAX_CHARS = 300;
