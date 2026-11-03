// 名字（用户问过以后能不能改）：agent 敲的命令名和产品名只在这里定。前后端都能引。
// 改名时只改这里，再跑一遍测试：提示词（daemon/prompt.ts）、放行规则（policy.ts 的 HUB_ALLOW_RULE）、hub 外壳的文件名
// （agent-api/shim.ts）、hub 的用法和报错（hub/cli.ts）、回给 agent 的话（ledger/）、Worker 的分支名、数据目录的默认名
// （paths.ts）、日志开头、网页标题和左上角都跟着变。
// 环境变量名（AGENT_HUB_HOME 这些，在 limits.ts）不跟着变：用户可能已经在 shell 里设了。
// 已经有数据目录 ~/.agent-hub 的，改了 PRODUCT_NAME 以后默认数据目录跟着变，旧目录要自己搬或用 AGENT_HUB_HOME 指过去（还没做兼容）。

/** agent 在 shell 里敲的系统命令名，也是 run/bin/ 下外壳的文件名。 */
export const HUB_COMMAND = "hub";

/** 产品名：给人看、给 agent 看的话里用。 */
export const PRODUCT_NAME = "agent-hub";

/** 日志、报错开头的“agent-hub:”。 */
export const LOG_PREFIX = `${PRODUCT_NAME}:`;

/** 默认数据目录在用户主目录下的名字（AGENT_HUB_HOME 没设时用，见 paths.ts）。 */
export const DATA_DIR_NAME = `.${PRODUCT_NAME}`;

/** Worker 分支名的前缀（设计 7.7：hub/<编号>-<短名>，见 worker.ts 的 workerBranchName）。 */
export const WORKER_BRANCH_PREFIX = `${HUB_COMMAND}/`;
