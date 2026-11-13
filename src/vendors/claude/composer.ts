// Claude Code 的输入框实现（接口见 daemon/vendors/types.ts，实测见 docs/composer-commands.md）：
// - 命令列表：initialize 控制请求回应里的 commands（{name, description, argumentHint, aliases?, builtin?}）；builtin 留着：
//   隐藏名单只藏 builtin 的，用户自己的命令、skill 叫 debug、new 这类名字也要留着、手打也要发得出去；
// - 会话没在跑时另起的 claude 在项目目录里起（项目的命令、skill 才查得到），但不跑钩子、不连 MCP（protocol.ts 的 INITIALIZE_QUERY_ARGS）；
// - 这个文件不引入起进程的代码（账本只要这里的纯数据）：起进程的函数由 daemon.ts 登记时传进来（ClaudeComposerOptions.queryInitialize）；
// - 隐藏名单、拦下的原因：spec.ts 的 composer；
// - `@path` 会被 claude 自动读进文件内容（T5），带空格的只认 `@"a b.md"`（T6）；
// - 只有最后一个 text 块以 / 开头才当命令展开（T4）：我们加的字各放一块在前面，原文单独放最后一块。
import { COMMANDS_QUERY_TIMEOUT_MS } from "../../shared/index.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase, parseComposerCommands } from "../_common/composer.ts";
import type { ClaudeModelQueryOptions } from "./catalog.ts";

/** initialize 回应、commands_changed 里的 commands 就是通用形状（_common/composer.ts）。 */
export const parseClaudeCommands = parseComposerCommands;

/** 不用起进程的那部分（驱动层拼消息、账本拦命令，经 daemon/vendors/index.ts 的 composerBaseOf 拿）。 */
export const claudeComposerBase: VendorComposerBase = createSpecComposerBase("claude");

export interface ClaudeComposerOptions {
  executablePath: string | (() => string);
  /** 起一个 claude 发 initialize 控制请求、返回回应（catalog.ts 的 queryClaudeInitialize；这里不直接引它，见文件开头）。 */
  queryInitialize: (options: ClaudeModelQueryOptions) => Promise<Record<string, unknown>>;
  /** 起 claude 的环境变量，默认守护进程自己的。 */
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  timeoutMs?: number;
}

export function createClaudeComposer(options: ClaudeComposerOptions): VendorComposer {
  return {
    ...claudeComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      const claudePath = typeof options.executablePath === "function" ? options.executablePath() : options.executablePath;
      const env = typeof options.env === "function" ? options.env() : options.env;
      const response = await options.queryInitialize({
        claudePath,
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(env ? { env } : {}),
      });
      const commands = parseClaudeCommands(response.commands);
      if (commands === null) throw new Error("initialize 回应里没有 commands");
      return commands;
    },
  };
}

