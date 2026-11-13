// 启动文件（设计第 7.2 节）：每次启动 agent 前生成 launch/<会话>/ 下的 prompt.md，要设置文件的厂商再加 settings.json，
// 再给这一次启动的环境变量（HUB_TOKEN、HUB_SOCK、PATH，加上厂商多设的）和 fingerprint。
// 项目经理和 Worker（M3）走同一个函数，只有提示词、设置文件、多设的环境变量按角色不同（m3-plan 第 2.1 节）。
// 分工：每次启动要变的东西（这几份文件和 env）只在这里定；固定的协议参数（--resume 还是新会话、--model、--add-dir）在各家驱动的
// protocol.ts，子进程的环境变量在 driver/protocol.ts 的 buildChildEnv。
// 工作目录（项目经理是主文件夹，Worker 是它的 worktree 或主文件夹）由账本写在会话那一行的 cwd 上，驱动层照用。
// prompt.md 的内容由 prompt.ts 的 buildLaunchPrompt 拼；厂商专属的设置文件和环境变量由那家 daemon.ts 的 launchFiles 给
// （claude：src/vendors/claude/settings.ts，默认档、放行 hub 和 hub.sock），没写的厂商不生成（docs/vendor-plugin-design.md 的 A15）。
// Worker 的可写范围（数据目录里只有自己的工作目录能写）是 write-scope.ts 的 workerWriteScope，放在 LaunchFiles.writeScope 交给驱动层落实。
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, WORKER_BACKGROUND_HOLD_MAX_MS, buildReadonlyPolicy, isAgentVendor, taskGraphSkillCatalogEntry, vendorSpec, workerWriteScope } from "../shared/index.ts";
import type { AgentSessionRow, LaunchContext, LaunchFiles, PersonaNote, PersonaUpdate, SessionId, SessionRole, SessionTokens, VendorAvailabilityMap } from "../shared/index.ts";
import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { osSandboxAvailable } from "./driver/write-scope.ts";
import { truncatePmMemoryForPrompt } from "./pm-memory.ts";
import { projectWorktreesDir, sessionLaunchDir } from "../shared/paths.ts";
import { buildFingerprintPrompt, buildLaunchPrompt, personaUpdateNote } from "./prompt.ts";
import { removeProductSkills, taskGraphSkillFile, writeProductSkills } from "./task-graph-skill.ts";
import { prepareRouterSandboxLaunch } from "./router/sandbox.ts";

export interface LaunchPreparerOptions {
  launchDir: string;
  /** 数据目录的真实路径（paths.ts 的 home，realpath 过）：Worker 的可写范围用。 */
  dataDir: string;
  /** 数据目录 state/ 的真实路径（paths.ts 的 stateDir，realpath 过）：厂商设置文件里的兜底拒绝规则用（claude）。 */
  stateDir: string;
  /** 用户主目录（只读策略的密钥清单用），默认本机的 homedir；测试可以指定。会 realpath。 */
  homeDir?: string;
  /** Worker 会不会包进 OS 沙箱，默认按本机每次启动时查询（driver/write-scope.ts 的 osSandboxAvailable）；测试可以指定布尔或回调。 */
  osSandboxed?: boolean | (() => boolean);
  /** Worker worktree 的根目录（paths.ts 的 worktreesDir，和账本的 LedgerOptions.worktreesDir 同一个）。 */
  worktreesDir: string;
  /** 额外的受保护根目录（跨卷同盘 `.fusa-wt` 等，三平台统一进 WriteScope.protectedRoots）。 */
  protectedRoots?: () => readonly string[];
  /** 账本的 getLaunchContext。 */
  getLaunchContext: (sessionId: SessionId) => LaunchContext;
  /** 同一个会话每次给同一个令牌（SessionTokens.issue 的约定）。 */
  tokens: Pick<SessionTokens, "issue">;
  /** hub.sock 的真实路径（realpath 过：写进 HUB_SOCK 和厂商设置文件的放行规则）。 */
  hubSock: string;
  /** hub 外壳所在目录（paths.ts 的 hubBinDir），放在 PATH 最前面。 */
  hubBinDir: string;
  /** 接在 hubBinDir 后面的 PATH，默认守护进程自己的 process.env.PATH。 */
  basePath?: string | (() => string);
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
 * 给驱动层的 prepareLaunch（组装代码接到 DriverOptions.prepareLaunch）。每次都重写这几份文件，内容没变 fingerprint 就不变；
 * 令牌只放 env，不进文件。可以反复调（驱动层两轮之间判断要不要重启时也调）。
 * 每次启动 agent 要变的东西（提示词、厂商的设置文件、HUB_TOKEN、HUB_SOCK、PATH、厂商多设的环境变量）只在这里定；
 * 驱动层只把它们原样变成参数（各家 protocol.ts：--resume 还是新会话、会话那一行的 --model 和 --add-dir），
 * 环境变量是守护进程自己的去掉父会话那几个（buildChildEnv）再盖上这里的 env。
 * 有项目的会话启动前先 mkdir -p <worktreesDir>/<项目编号>/：项目经理的 --add-dir 里有它，agent 要求目录在（LaunchContext 的注释）。
 */
export function createLaunchPreparer(options: LaunchPreparerOptions): (session: AgentSessionRow) => Promise<LaunchFiles> {
  const { launchDir, dataDir, stateDir, worktreesDir, getLaunchContext, tokens, hubSock, hubBinDir } = options;
  const resolveBasePath = () =>
    typeof options.basePath === "function"
      ? options.basePath()
      : (options.basePath ?? process.env.PATH ?? process.env.Path ?? "");
  const homeDir = realpathOr(options.homeDir ?? homedir());
  return async (session) => {
    const basePath = resolveBasePath();
    if (session.role === "assistant") {
      return prepareRouterSandboxLaunch(session, {
        launchDir,
        dataDir,
        stateDir,
        protectedRoots: options.protectedRoots?.(),
        homeDir,
        osSandboxed: options.osSandboxed,
        tokens,
        hubSock,
        hubBinDir,
        basePath,
        vendorAvailability: options.vendorAvailability?.(),
      });
    }
    const osSandboxed = typeof options.osSandboxed === "function" ? options.osSandboxed() : (options.osSandboxed ?? osSandboxAvailable());
    const rawCtx = getLaunchContext(session.id);
    const ctx: LaunchContext = {
      ...rawCtx,
      ...(rawCtx.role === "pm" ? { pm: { ...rawCtx.pm, persona: truncatePmMemoryForPrompt(rawCtx.pm.persona).text } } : {}),
      vendorAvailability: options.vendorAvailability?.(),
    };
    const role = sessionRole(ctx);
    if (ctx.project !== null) mkdirSync(projectWorktreesDir(worktreesDir, ctx.project.id), { recursive: true });
    const dir = sessionLaunchDir(launchDir, session.id);
    // 任务图手册只给项目经理（docs/orchestration-skill-design.md 第 6.4 节）：提示词里写它在这次会话启动目录里的路径
    const promptOptions = role === "pm" ? { taskGraphSkillFile: taskGraphSkillFile(dir) } : {};
    const prompt = buildLaunchPrompt(ctx, session.cwd, promptOptions);
    const readonly = role === "worker" && ctx.worker !== null && ctx.worker.readonly;
    const extraRoots = options.protectedRoots?.();
    // 只读不再让 agy、codex 去反读 claude 设置文件里的权限档：统一定义放 LaunchFiles.readonly（shared/readonly-policy.ts）
    const readonlyPolicy = readonly
      ? buildReadonlyPolicy({
          homeDir,
          stateDir,
          ...(extraRoots && extraRoots.length > 0 ? { protectedRoots: [dataDir, ...extraRoots] } : {}),
        })
      : undefined;
    // 用设置文件落实只读的厂商（spec 的 capabilities.readonly 是 "settings"，如 claude 的自带沙箱，设计第 2.3 节）：设置文件换成只读翻译，
    // 进程不再包外层沙箱（macOS 沙箱不能嵌套）。别家的只读翻译在各自驱动层。
    const vendor = isAgentVendor(session.vendor) ? session.vendor : null;
    const nativeReadonly = readonlyPolicy !== undefined && vendor !== null && vendorSpec(vendor).capabilities.readonly === "settings";
    const vendorFiles = vendor !== null
      ? VENDOR_DAEMONS[vendor].launchFiles?.({
          role,
          readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [session.cwd, ...session.addDirs].map(realpathOr) } : undefined,
          hubSock,
          stateDir,
          osSandboxed,
        })
      : undefined;
    const settings = vendorFiles?.settings;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    let settingsFile: string | undefined;
    if (settings !== undefined) {
      settingsFile = join(dir, "settings.json");
      writeFileSync(settingsFile, settings, { mode: 0o600 });
    }
    let skillsDir: string | undefined;
    if (role === "pm") skillsDir = writeProductSkills(dir);
    else removeProductSkills(dir);
    const writeScope = nativeReadonly
      ? null
      : workerWriteScope({
          role,
          dataDir,
          ...(extraRoots && extraRoots.length > 0 ? { protectedRoots: extraRoots } : {}),
          cwd: session.cwd,
        });
    return {
      promptFile,
      ...(settingsFile === undefined ? {} : { settingsFile }),
      ...(skillsDir === undefined ? {} : { skillsDir }),
      env: {
        [ENV_HUB_TOKEN]: tokens.issue(session.id),
        [ENV_HUB_SOCK]: hubSock,
        PATH: basePath === "" ? hubBinDir : `${hubBinDir}${delimiter}${basePath}`,
        ...vendorFiles?.env,
      },
      // 性格设定、模式不进指纹：变了不重启，驱动层按 personaRevision 在下一条消息前加说明（createPersonaNoter）
      fingerprint: launchFingerprint({
        prompt: buildFingerprintPrompt(ctx, session.cwd, promptOptions),
        settings: settings ?? "",
        readonly: readonlyPolicy,
        ...(skillsDir === undefined ? {} : { skills: taskGraphSkillCatalogEntry() }),
      }),
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
 * 不是项目经理的会话、版本号没变返回 null。launchDir 给了，模式那一节里的任务图手册路径写成这个会话启动目录里的（同 createLaunchPreparer）。
 */
export function createPersonaNoter(
  personaUpdate: (sessionId: SessionId, sinceRevision: number) => PersonaUpdate | null,
  launchDir?: string,
): (sessionId: SessionId, sinceRevision: number) => PersonaNote | null {
  return (sessionId, sinceRevision) => {
    const update = personaUpdate(sessionId, sinceRevision);
    if (update === null || update.revision === sinceRevision) return null;
    const truncatedUpdate: PersonaUpdate =
      update.persona === null
        ? update
        : {
            ...update,
            persona: {
              ...update.persona,
              text: truncatePmMemoryForPrompt(update.persona.text).text,
            },
          };
    const skillFile = launchDir === undefined ? undefined : taskGraphSkillFile(sessionLaunchDir(launchDir, sessionId));
    return { revision: update.revision, note: personaUpdateNote(truncatedUpdate, skillFile) };
  };
}
