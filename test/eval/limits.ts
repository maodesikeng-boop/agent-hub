// 编排验证（docs/orchestration-eval-design.md）可调的数集中在这一处：试跑上限、等待节奏、结果目录的上限和保留期、回放包大小。
// 评测不进产品运行时，这些数只管评测自己；产品的上限仍在 src/shared/limits.ts。

/** 一次试跑里项目经理最多出场几轮（设计 3.3），超了记“超时”，不计分。 */
export const EVAL_MAX_PM_TURNS = 12;
/** 一次试跑（真模型）最多跑多久（设计 3.3）。 */
export const EVAL_TRIAL_TIMEOUT_MS = 20 * 60_000;
/** 剧本项目经理（不花钱的自测）一次试跑最多跑多久。 */
export const EVAL_SCRIPTED_TRIAL_TIMEOUT_MS = 60_000;

/** 轮询守护进程状态的间隔：真模型慢，剧本快。 */
export const EVAL_POLL_MS = 1_000;
export const EVAL_SCRIPTED_POLL_MS = 100;
/**
 * “安静”多久算这一段结束（没有会话在忙、没有没回的提问、没有待注入的事件）：
 * 真 claude 后台命令跑完到自己再开一轮之间有几秒空档，留足余量。
 */
export const EVAL_QUIET_MS = 30_000;
export const EVAL_SCRIPTED_QUIET_MS = 1_500;

/**
 * 回放假 Worker 预设的轮次用完后又被追加消息（真 PM 多发了一轮 hub worker send）时，先停这么久再回兜底汇报：
 * 0 毫秒瞬回会让真 PM 误以为 Worker 运行时坏了。单测可经 TrialTimings.overrunDelayMs 缩短。
 */
export const EVAL_WORKER_OVERRUN_DELAY_MS = 1_500;

/** 同时跑几个试跑（设计 7：并行上限 4，瞬时磁盘约 0.6GB）。 */
export const EVAL_DEFAULT_PARALLEL = 3;
export const EVAL_MAX_PARALLEL = 4;

/** 结果：留最近 20 次运行，或 30 天，先到为准（设计 7）；每次 `pnpm eval` 开头自动清。 */
export const EVAL_KEEP_RUNS = 20;
export const EVAL_KEEP_RUN_DAYS = 30;
/** 没通过的试跑现场（数据目录、主文件夹克隆、worktree）最多留几个，再多删最旧的（设计 7：约 1.5GB）。 */
export const EVAL_KEEP_FAILED_WORK = 10;
/** 被测版本的源码（git archive 出来的）最多缓存几份。 */
export const EVAL_KEEP_VERSIONS = 4;

/** 回放包：总共不超过 5MB，单个文件不超过 500KB（设计 7），fixtures.test.ts 守着。 */
export const EVAL_REPLAY_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const EVAL_REPLAY_MAX_FILE_BYTES = 500 * 1024;

/** 结果文件里每条证据、每条消息正文最多留多少字（完整过程另存，也按这个截）。 */
export const EVAL_EVIDENCE_MAX_CHARS = 300;
export const EVAL_TRANSCRIPT_MAX_CHARS = 4_000;
/** 一条检查最多附几条证据。 */
export const EVAL_EVIDENCE_MAX_ITEMS = 8;
/** gh 替身回放失败日志时一次最多输出多少字节（真日志约 136KB，原样给）。 */
export const EVAL_GH_LOG_MAX_BYTES = 512 * 1024;

/** 单次落盘文本的 UTF-8 字节上限。 */
export const EVAL_TEXT_MAX_BYTES = 2 * 1024 * 1024;
