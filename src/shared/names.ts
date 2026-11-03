// 名字（用户问过以后能不能改）：agent 敲的命令名和产品名只在这里定。前后端都能引。
// 改名时：这里改一处，提示词（daemon/prompt.ts）、启动文件（daemon/launch.ts）、放行规则（policy.ts 的 HUB_ALLOW_RULE）
// 跟着变；还没改用这里的地方见 m3-plan 第 3 节 W5（hub 外壳的文件名、hub/cli.ts 的用法和报错）。

/** agent 在 shell 里敲的系统命令名，也是 run/bin/ 下外壳的文件名。 */
export const HUB_COMMAND = "hub";

/** 产品名：给人看、给 agent 看的话里用。 */
export const PRODUCT_NAME = "agent-hub";
