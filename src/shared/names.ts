// 名字：agent 敲的命令名、产品内部标识和显示名只在这里定。前后端都能引。
// 内部标识（PRODUCT_ID）用于数据目录默认名（paths.ts）、日志开头、localStorage 键（web/notify.ts）、给 agent 看的提示词等，改显示名时不动；
// 显示名（PRODUCT_NAME）用于网页标题、PWA 名字、登录页等用户看得到的地方。

/** agent 在 shell 里敲的系统命令名，也是 run/bin/ 下外壳的文件名。 */
export const HUB_COMMAND = "hub";

/** 产品内部标识：数据目录、日志前缀、存储键、给 agent 看的提示词等内部标识一律用它，改显示名时保持不变。 */
export const PRODUCT_ID = "agent-hub";

/** 产品显示名：给人看的界面标题、PWA 名字、登录页等用。 */
export const PRODUCT_NAME = "Piece";

/** 日志、报错开头的“agent-hub:”。 */
export const LOG_PREFIX = `${PRODUCT_ID}:`;

/** 默认数据目录在用户主目录下的名字（AGENT_HUB_HOME 没设时用，见 paths.ts）。 */
export const DATA_DIR_NAME = `.${PRODUCT_ID}`;

/** Worker 分支名的前缀（设计 7.7：hub/<编号>-<短名>，见 worker.ts 的 workerBranchName）。 */
export const WORKER_BRANCH_PREFIX = `${HUB_COMMAND}/`;
