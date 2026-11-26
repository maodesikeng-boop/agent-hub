// 界面打磨循环（docs/ui-polish-loop-design.md）可调的数集中在这一处：视口、固定时钟、分数线、校准门槛、轮数上限、批大小。
// 循环不进产品运行时，这些数只管它自己；产品的上限仍在 src/shared/limits.ts。

/** 截图用的视口。deviceScaleFactor 都是 2：1px 的细线和错位在 1 倍图上看不出来。 */
export const VIEWPORTS = {
  /** 三栏宽屏。 */
  desktop: { width: 1440, height: 900, touch: false },
  /** The desktop window minimum: the PM list at its minimum keeps avatars and names, and a side panel covers the conversation (stack tier). */
  narrow: { width: 860, height: 800, touch: false },
  /** Below the desktop window minimum and 720px, reachable in a browser: the conversation narrows past its minimum; Settings puts its categories on top. */
  slim: { width: 700, height: 800, touch: false },
  /** 手机外壳（第 19、20 条）。 */
  mobile: { width: 390, height: 844, touch: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const DEVICE_SCALE_FACTOR = 2;

/** 种子数据里的“现在”和浏览器里的“现在”：都钉死，时间显示、相对时间每次一样。 */
export const SEED_START_ISO = "2026-11-16T14:00:00+08:00";
/** 种子里每写一条（消息、事件）时钟走多少。 */
export const SEED_STEP_MS = 1_000;
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
/** 在途请求都回来后再静多久才截（界面拿到回包还要画一帧）。 */
export const SHOT_NETWORK_QUIET_MS = 300;
/** 连截两张一样才算画稳：两次之间隔多久。 */
export const SHOT_STABLE_POLL_MS = 150;
/** 浏览器里预置成“看过了”的对话编号是 2 到这个数（编号 1 的小林留着没看过，左栏才有一个“等你”）。 */
export const SHOT_SEEN_CONVERSATIONS = 400;

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
/** 校准：基准图页面分（每家评委多次评分的中位数）应落在这个区间。基准图是没有硬伤的 6 到 7 分毛坯，评到 9 分以上说明审美高线没立住。 */
export const CALIBRATION_BASELINE_PAGE_RANGE = { min: 6, max: 8 } as const;
/** 校准：故意弄坏的地方 3 次里至少被指出几次才算抓到；P0、P1 的弄坏要有几成被抓到。 */
export const CALIBRATION_MIN_HITS = 2;
export const CALIBRATION_DETECT_SHARE = 0.9;
/** 校准：两家评委同一张图的页面分差不超过 1 的图至少占几成。 */
export const CALIBRATION_AGREE_SHARE = 0.8;

/** 每轮混进去的哨兵图（基准图和两张弄坏的）：它们的分和校准时差得超过这个数，这一次评审作废重评。 */
export const SENTINEL_MAX_DRIFT = 1;

/**
 * 一个评委 Worker 一次评几张图。校准时每一档都测，正式评审用过了校准门槛的最大一档；
 * 大的那档过不了就用小的那档，分波次串行跑，不加并发。
 */
export const JUDGE_BATCH_CANDIDATES = [14, 28] as const;
/** 同时在跑的评委 Worker 最多几个（这台 Mac 吃紧）。任务图里靠分波次排依赖做到。 */
export const JUDGE_MAX_CONCURRENT = 6;
/** 两家评委的发现算同一处：框的交并比不低于它，或同一张图引了同一条规则。 */
export const FINDING_MATCH_IOU = 0.3;
/** 对比度的严重度线（WCAG 1.4.3、1.4.11）：不到 P0_BELOW 记 P0，不到 P1_BELOW 记 P1。评委和机器检查都照它判。 */
export const CONTRAST_SEVERITY_LINES = { P0_BELOW: 3, P1_BELOW: 4.5 } as const;
/** 一张评分卡最多几条发现：超了多半是评委把同一个问题拆碎了，按格式错误打回重评。 */
export const MAX_FINDINGS_PER_CARD = 20;
/** 每条发现“哪里不对”“怎么改”各最多多少字。 */
export const FINDING_TEXT_MAX_CHARS = 300;
/** Structure checks: a line wider than LINE_MAX_PX is not a hairline (docs/ui-standard.md lines are 1px). */
export const LINE_MAX_PX = 1.5;
/** Two row starts in one column closer than this band are a near miss, not an intended indent. */
export const EDGE_NEAR_MISS_PX = { min: 1.5, max: 8 } as const;
/** Structure checks: two resting composers side by side share one row; more than this between their edges is a misalignment. */
export const COMPOSER_ROW_TOLERANCE_PX = 0.5;
