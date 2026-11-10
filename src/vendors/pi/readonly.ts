// 只读 Pi Worker 的沙箱参数翻译层（docs/vendors/pi.md 第 5 节）：
// 1. 命令行追加 `--exclude-tools edit,write --no-mcp` 关闭写文件工具与外部 MCP 连接器；
// 2. 外层由 write-scope.ts 的 wrapInReadonlyOsSandbox 包入只读 OS 沙箱（macOS seatbelt / Linux bubblewrap）：
//    只放行会话私有临时目录、Pi 运行时目录（sessions、logs）与通用缓存目录可写；
//    为保证 Pi 主进程启动时能读取自身模型商凭据与自定义模型定义，外层沙箱仅对当前 Pi 配置目录下的 auth.json 与 models.json 放开只读（不可写），
//    其余全部敏感路径、通配（.env、私钥）及别家凭据一律禁读。
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ReadonlyPolicy } from "../../shared/index.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  type ReadonlySandboxInput,
} from "../../daemon/driver/write-scope.ts";

export const READONLY_PI_NEEDS_SANDBOX_MESSAGE = WORKER_NEEDS_OS_SANDBOX_MESSAGE;

/** 只读 Worker 附加的命令行参数：排除 edit/write 内置写工具并禁用 MCP（避免非只读连接器越权）。 */
export const PI_READONLY_CLI_ARGS: readonly string[] = ["--exclude-tools", "edit,write", "--no-mcp"];

/** Pi 运行时需写入的子目录，相对配置目录（默认 ~/.pi/agent 或 PI_CODING_AGENT_DIR）。不放 settings.json、auth.json、extensions。 */
export const PI_RUNTIME_DIRS: readonly string[] = ["sessions", "logs"];

/** 通用缓存目录，相对用户主目录。 */
export const PI_READONLY_CACHE_DIRS: readonly string[] = [".cache", "Library/Caches", ".npm"];

/** Pi 自身启动认证必需读取的配置文件（相对配置目录）：仅从 Pi 自身外层沙箱禁读列表中豁免只读，仍严禁写入。 */
const PI_SELF_READABLE_CONFIG_FILES: readonly string[] = ["auth.json", "models.json"];

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolvePiConfigDir(homeDir: string, env?: Readonly<Record<string, string | undefined>>): string {
  const override = env?.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim() !== "") return trimSlash(override.trim());
  return join(trimSlash(homeDir), ".pi", "agent");
}

export function piReadonlySandboxInput(input: {
  homeDir: string;
  tmpDir: string;
  policy: ReadonlyPolicy;
  env?: Readonly<Record<string, string | undefined>>;
  realpath?: (p: string) => string;
}): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  const configDir = trimSlash(real(resolvePiConfigDir(home, input.env)));
  const sessionDirOverride = input.env?.PI_CODING_AGENT_SESSION_DIR?.trim();

  const writableDirs = [
    ...PI_RUNTIME_DIRS.map((d) => `${configDir}/${d}`),
    ...(sessionDirOverride ? [trimSlash(real(sessionDirOverride))] : []),
    ...PI_READONLY_CACHE_DIRS.map((d) => `${home}/${d}`),
  ];

  const selfReadable = new Set(PI_SELF_READABLE_CONFIG_FILES.map((f) => trimSlash(real(`${configDir}/${f}`))));
  return {
    tmpDir: real(input.tmpDir),
    writableDirs: [...new Set(writableDirs)],
    writableFileGlobs: [],
    writableFileRegexes: [],
    secretPaths: input.policy.secretPaths.map(real).filter((p) => !selfReadable.has(trimSlash(p))),
    secretGlobs: [...input.policy.secretGlobs],
  };
}
