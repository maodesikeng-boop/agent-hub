// 启动文件（设计第 7.2 节）：每次启动 claude 前生成 launch/<会话>/ 下的 prompt.md、settings.json 和空的 MCP 配置，
// 再给这一次启动的环境变量（HUB_TOKEN、HUB_SOCK、PATH）和 fingerprint。
// 分工：每次启动要变的东西（这三份文件和 env）只在这里定；固定的协议参数（stream-json、--resume 还是 --session-id、
// --model、--add-dir）在驱动层 driver/protocol.ts 的 buildClaudeArgs，子进程的环境变量在同一个文件的 buildChildEnv。
// prompt.md 的内容由 prompt.ts 的 buildLaunchPrompt 拼；settings.json 只放行 hub 和 hub.sock（shared/hub.ts 的 buildHubSettings），
// 用户全局 ~/.claude 的设置照常生效。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, buildHubSettings } from "../shared/index.ts";
import type { AgentSessionRow, LaunchContext, LaunchFiles, SessionId, SessionTokens } from "../shared/index.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { buildLaunchPrompt } from "./prompt.ts";

export interface PmLaunchPreparerOptions {
  launchDir: string;
  /** 账本的 getLaunchContext。 */
  getLaunchContext: (sessionId: SessionId) => LaunchContext;
  /** 同一个会话每次给同一个令牌（SessionTokens.issue 的约定）。 */
  tokens: Pick<SessionTokens, "issue">;
  /** hub.sock 的真实路径（realpath 过，见 buildHubSettings）。 */
  hubSock: string;
  /** hub 外壳所在目录（paths.ts 的 hubBinDir），放在 PATH 最前面。 */
  hubBinDir: string;
  /** 接在 hubBinDir 后面的 PATH，默认守护进程自己的 process.env.PATH。 */
  basePath?: string;
}

/**
 * M2 给驱动层的 prepareLaunch（W6 接到 DriverOptions.prepareLaunch）。每次都重写三份文件，内容没变 fingerprint 就不变；
 * 令牌只放 env，不进文件。可以反复调（驱动层两轮之间判断要不要重启时也调）。
 * 每次启动 claude 要变的东西（提示词、设置文件、MCP 配置、HUB_TOKEN、HUB_SOCK、PATH）只在这里定；
 * 驱动层只把它们原样变成参数（driver/protocol.ts 的 buildClaudeArgs：固定的 stream-json 参数、--resume 还是 --session-id、
 * 会话那一行的 --model 和 --add-dir），环境变量是守护进程自己的去掉父会话那几个（buildChildEnv）再盖上这里的 env。
 */
export function createPmLaunchPreparer(options: PmLaunchPreparerOptions): (session: AgentSessionRow) => Promise<LaunchFiles> {
  const { launchDir, getLaunchContext, tokens, hubSock, hubBinDir } = options;
  const basePath = options.basePath ?? process.env.PATH ?? "";
  return async (session) => {
    const ctx = getLaunchContext(session.id);
    const prompt = buildLaunchPrompt(ctx, session.cwd);
    const settings = JSON.stringify(buildHubSettings(hubSock), null, 2) + "\n";
    const mcpConfig = JSON.stringify({ mcpServers: {} }) + "\n";
    const dir = join(launchDir, String(session.id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = join(dir, "prompt.md");
    const settingsFile = join(dir, "settings.json");
    const mcpConfigFile = join(dir, "mcp.json");
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    writeFileSync(settingsFile, settings, { mode: 0o600 });
    writeFileSync(mcpConfigFile, mcpConfig, { mode: 0o600 });
    return {
      promptFile,
      settingsFile,
      mcpConfigFile,
      env: {
        [ENV_HUB_TOKEN]: tokens.issue(session.id),
        [ENV_HUB_SOCK]: hubSock,
        PATH: basePath === "" ? hubBinDir : `${hubBinDir}:${basePath}`,
      },
      fingerprint: launchFingerprint({ prompt, settings, mcpConfig }),
    };
  };
}
