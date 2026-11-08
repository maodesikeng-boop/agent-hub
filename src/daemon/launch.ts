// 启动文件（设计第 7.2 节）：每次启动 claude 前生成 launch/<会话>/ 下的 prompt.md 和 settings.json，
// 再给这一次启动的环境变量（HUB_TOKEN、HUB_SOCK、PATH，Worker 再加 policy.ts 的 WORKER_ENV）和 fingerprint。
// 项目经理和 Worker（M3）走同一个函数，只有提示词、设置文件、多设的环境变量按角色不同（m3-plan 第 2.1 节）。
// 分工：每次启动要变的东西（这两份文件和 env）只在这里定；固定的协议参数（stream-json、--resume 还是 --session-id、
// --model、--add-dir）在驱动层 driver/protocol.ts 的 buildClaudeArgs，子进程的环境变量在同一个文件的 buildChildEnv。
// 工作目录（项目经理是主文件夹，Worker 是它的 worktree 或主文件夹）由账本写在会话那一行的 cwd 上，驱动层照用。
// prompt.md 的内容由 prompt.ts 的 buildLaunchPrompt 拼；settings.json 是 policy.ts 的 buildSessionSettings（默认档、放行 hub
// 和 hub.sock），用户全局 ~/.claude 的设置照常生效。Worker 的可写范围（数据目录里只有自己的工作目录能写）是
// write-scope.ts 的 workerWriteScope，放在 LaunchFiles.writeScope 交给驱动层落实。
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, VENDOR_SPECS, WORKER_BACKGROUND_HOLD_MAX_MS, buildReadonlyPolicy, buildSessionSettings, sessionEnv, workerWriteScope } from "../shared/index.ts";
import type { AgentSessionRow, AgentVendor, LaunchContext, LaunchFiles, PersonaNote, PersonaUpdate, SessionId, SessionRole, SessionTokens, VendorAvailabilityMap } from "../shared/index.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { osSandboxAvailable } from "./driver/write-scope.ts";
import { projectWorktreesDir } from "../shared/paths.ts";
import { buildFingerprintPrompt, buildLaunchPrompt, personaUpdateNote } from "./prompt.ts";

export interface LaunchPreparerOptions {
  launchDir: string;
  /** 数据目录的真实路径（paths.ts 的 home，realpath 过）：Worker 的可写范围用。 */
  dataDir: string;
  /** 数据目录 state/ 的真实路径（paths.ts 的 stateDir，realpath 过）：Worker 设置文件里的兜底拒绝规则用。 */
  stateDir: string;
  /** 用户主目录（只读策略的密钥清单用），默认本机的 homedir；测试可以指定。会 realpath。 */
  homeDir?: string;
  /** Worker 会不会包进 OS 沙箱，默认按本机每次启动时查询（driver/write-scope.ts 的 osSandboxAvailable）；测试可以指定布尔或回调。 */
  osSandboxed?: boolean | (() => boolean);
  /** Worker worktree 的根目录（paths.ts 的 worktreesDir，和账本的 LedgerOptions.worktreesDir 同一个）。 */
  worktreesDir: string;
  /** 账本的 getLaunchContext。 */
  getLaunchContext: (sessionId: SessionId) => LaunchContext;
  /** 同一个会话每次给同一个令牌（SessionTokens.issue 的约定）。 */
  tokens: Pick<SessionTokens, "issue">;
  /** hub.sock 的真实路径（realpath 过，见 policy.ts 的 SessionSettingsInput）。 */
  hubSock: string;
  /** hub 外壳所在目录（paths.ts 的 hubBinDir），放在 PATH 最前面。 */
  hubBinDir: string;
  /** 接在 hubBinDir 后面的 PATH，默认守护进程自己的 process.env.PATH。 */
  basePath?: string;
  /** 这台设备上各家厂商的状态（缓存里的，不等查询）：项目经理提示词只列能选的。不给就全列。 */
  vendorAvailability?: () => VendorAvailabilityMap;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sessionRole(ctx: LaunchContext): SessionRole {
  if (ctx.role === "pm" || ctx.role === "worker") return ctx.role;
  throw new Error(`session ${ctx.sessionId} has role ${ctx.role}; only pm and worker sessions can be launched`);
}

/**
 * 给驱动层的 prepareLaunch（组装代码接到 DriverOptions.prepareLaunch）。每次都重写两份文件，内容没变 fingerprint 就不变；
 * 令牌只放 env，不进文件。可以反复调（驱动层两轮之间判断要不要重启时也调）。
 * 每次启动 claude 要变的东西（提示词、设置文件、HUB_TOKEN、HUB_SOCK、PATH、Worker 多设的环境变量）只在这里定；
 * 驱动层只把它们原样变成参数（driver/protocol.ts 的 buildClaudeArgs：固定的 stream-json 参数、--resume 还是 --session-id、
 * 会话那一行的 --model 和 --add-dir），环境变量是守护进程自己的去掉父会话那几个（buildChildEnv）再盖上这里的 env。
 * 有项目的会话启动前先 mkdir -p <worktreesDir>/<项目编号>/：项目经理的 --add-dir 里有它，claude 要求目录在（LaunchContext 的注释）。
 */
export function createLaunchPreparer(options: LaunchPreparerOptions): (session: AgentSessionRow) => Promise<LaunchFiles> {
  const { launchDir, dataDir, stateDir, worktreesDir, getLaunchContext, tokens, hubSock, hubBinDir } = options;
  const basePath = options.basePath ?? process.env.PATH ?? "";
  const homeDir = realpathOr(options.homeDir ?? homedir());
  return async (session) => {
    const osSandboxed = typeof options.osSandboxed === "function" ? options.osSandboxed() : (options.osSandboxed ?? osSandboxAvailable());
    const ctx = { ...getLaunchContext(session.id), vendorAvailability: options.vendorAvailability?.() };
    const role = sessionRole(ctx);
    if (ctx.project !== null) mkdirSync(projectWorktreesDir(worktreesDir, ctx.project.id), { recursive: true });
    const prompt = buildLaunchPrompt(ctx, session.cwd);
    const readonly = role === "worker" && ctx.worker !== null && ctx.worker.readonly;
    // 只读不再让 agy、codex 去反读 claude 设置文件里的权限档：统一定义放 LaunchFiles.readonly（shared/readonly-policy.ts）
    const readonlyPolicy = readonly ? buildReadonlyPolicy({ homeDir, stateDir }) : undefined;
    // claude 的只读 Worker 用自带沙箱落实（writeGuard native，设计第 2.3 节）：设置文件换成只读翻译，进程不再包外层沙箱（macOS 沙箱不能嵌套）。
    // 别家的设置文件驱动不读，照普通 Worker 生成；它们的只读翻译在各自驱动层。
    const nativeReadonly = readonlyPolicy !== undefined && VENDOR_SPECS[session.vendor as AgentVendor]?.readonlyMode === "settings";
    const settings = JSON.stringify(
      buildSessionSettings({
        role,
        readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [session.cwd, ...session.addDirs].map(realpathOr) } : undefined,
        hubSock,
        stateDir,
        osSandboxed,
      }),
      null,
      2,
    ) + "\n";
    const dir = join(launchDir, String(session.id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = join(dir, "prompt.md");
    const settingsFile = join(dir, "settings.json");
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    writeFileSync(settingsFile, settings, { mode: 0o600 });
    const writeScope = nativeReadonly ? null : workerWriteScope({ role, dataDir, cwd: session.cwd });
    return {
      promptFile,
      settingsFile,
      env: {
        [ENV_HUB_TOKEN]: tokens.issue(session.id),
        [ENV_HUB_SOCK]: hubSock,
        PATH: basePath === "" ? hubBinDir : `${hubBinDir}:${basePath}`,
        ...sessionEnv(role),
      },
      // 性格设定、模式不进指纹：变了不重启，驱动层按 personaRevision 在下一条消息前加说明（createPersonaNoter）
      fingerprint: launchFingerprint({ prompt: buildFingerprintPrompt(ctx, session.cwd), settings, readonly: readonlyPolicy }),
      personaRevision: role === "pm" ? ctx.pm.personaRevision : undefined,
      ...(writeScope === null ? {} : { writeScope }),
      ...(readonlyPolicy === undefined ? {} : { readonly: readonlyPolicy }),
      // Worker 有后台命令时这一轮不汇报、项目经理在等，兜底比项目经理的短（limits.ts）
      ...(role === "worker" ? { backgroundHoldMaxMs: WORKER_BACKGROUND_HOLD_MAX_MS } : {}),
    };
  };
}

/**
 * 给驱动层的 personaNote（DriverOptions.personaNote）：问账本 sinceRevision 之后性格设定、模式改了什么，拼成说明（prompt.ts 的 personaUpdateNote）。
 * 不是项目经理的会话、版本号没变返回 null。
 */
export function createPersonaNoter(
  personaUpdate: (sessionId: SessionId, sinceRevision: number) => PersonaUpdate | null,
): (sessionId: SessionId, sinceRevision: number) => PersonaNote | null {
  return (sessionId, sinceRevision) => {
    const update = personaUpdate(sessionId, sinceRevision);
    if (update === null || update.revision === sinceRevision) return null;
    return { revision: update.revision, note: personaUpdateNote(update) };
  };
}
