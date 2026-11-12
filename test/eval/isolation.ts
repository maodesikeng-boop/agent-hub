// 编排验证的隔离（docs/orchestration-eval-design.md 3.7）：评测里的项目经理是真模型、能在本机跑任意命令，挡住这几样——
// 1. 真账本、真守护进程：每次试跑独立的数据目录（AGENT_HUB_HOME）、端口 0；继承来的 HUB_TOKEN、HUB_SOCK、AGENT_HUB_* 先清掉；
//    真模型项目经理的 macOS 沙箱里，真数据目录（~/.agent-hub）整个禁读禁写，连不上真守护进程的 hub.sock 和默认端口。
// 2. 真仓库、真 PR：主文件夹是基准提交的一份克隆，远端是本地裸仓库（gitconfig 的 insteadOf 把 GitHub 地址改写到它）；
//    gh、git push 换成 PATH 最前面的替身（只记录不外发）；真 gh 没有登录态（GH_CONFIG_DIR 空目录、GH_TOKEN 清空），沙箱里也不许执行。
// 3. 真部署：ssh、scp、sftp、rsync、launchctl、osascript、pkill、killall、open 换成只记录的替身；沙箱里真的那几个不许执行，
//    出站 22 端口禁掉，SSH_AUTH_SOCK 清空；不能给沙箱外的进程发信号（杀不到真守护进程、Fusa.app）。
// 4. 现任项目经理的上下文：被测项目经理的性格设定是中性的空设定（scenarios/），沙箱里禁读真仓库（node_modules 除外）、
//    ~/.agent-hub（性格设定、记忆目录、pm-notes）、claude 给真仓库和真 worktree 存的会话记录与自动记忆。
// 每次运行开头 preflight 在真沙箱里逐条试一遍，有一条没挡住就不跑。
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { claudeProjectDirName } from "../../src/vendors/claude/transcript.ts";
import { DEFAULT_UI_PORT, ENV_HOME, ENV_HUB_SOCK, ENV_HUB_TOKEN, ENV_PORT } from "../../src/shared/index.ts";
import type { RouterConfig } from "./fakes/claude-router.ts";

const FAKES_DIR = new URL("./fakes/", import.meta.url).pathname;
export const ROUTER = join(FAKES_DIR, "claude-router.ts");
export const FAKE_CLAUDE = new URL("../fake-claude/fake-claude.ts", import.meta.url).pathname;
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** 换成“只记录、不执行”的替身的命令。 */
export const RECORD_ONLY_TOOLS = ["ssh", "scp", "sftp", "rsync", "launchctl", "osascript", "pkill", "killall", "open"] as const;
/** 真模型项目经理的沙箱里不许执行的真命令（替身之外的第二道）。gh 另按 PATH 里找到的真 gh 加。 */
const DENY_EXEC = ["/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/sftp", "/usr/bin/rsync", "/bin/launchctl", "/usr/bin/osascript", "/usr/bin/pkill", "/usr/bin/killall", "/usr/bin/open"];

/** 评测进程一开始就从自己的环境里去掉的变量：连真后台的、真 GitHub 的、真 ssh 代理的，和用户 shell 里设的 AGENT_HUB_*。 */
export function scrubbedEnvNames(env: NodeJS.ProcessEnv): string[] {
  const fixed = [ENV_HUB_TOKEN, ENV_HUB_SOCK, "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"];
  return [...fixed, ...Object.keys(env).filter((k) => k.startsWith("AGENT_HUB_"))];
}

export function scrubProcessEnv(): void {
  for (const name of scrubbedEnvNames(process.env)) delete process.env[name];
}

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** PATH 里所有叫 name 的可执行文件（除了 skipDir 里的替身），连同它们的真实路径。 */
export function findAll(name: string, pathEnv = process.env.PATH ?? "", skipDir?: string): string[] {
  const found = new Set<string>();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || (skipDir && realOr(dir) === realOr(skipDir))) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      found.add(candidate);
      found.add(realOr(candidate));
    }
  }
  return [...found];
}

export function whichFirst(name: string, pathEnv = process.env.PATH ?? ""): string | null {
  return findAll(name, pathEnv)[0] ?? null;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ShimPaths {
  binDir: string;
  ghDir: string;
  recordFile: string;
}

/**
 * 在 binDir 里放替身：gh（回放）、git（push 只记录，别的转给真 git）、RECORD_ONLY_TOOLS（只记录）。
 * 替身的程序拷进 binDir/lib/（.mts 单独跑），不引用仓库里的文件：真模型项目经理的沙箱禁读真仓库。
 */
export function writeShims(paths: ShimPaths, opts: { node: string; realGit: string }): void {
  const lib = join(paths.binDir, "lib");
  mkdirSync(lib, { recursive: true });
  mkdirSync(paths.ghDir, { recursive: true });
  copyFileSync(join(FAKES_DIR, "gh.ts"), join(lib, "gh.mts"));
  copyFileSync(join(FAKES_DIR, "record.ts"), join(lib, "record.mts"));
  const write = (name: string, body: string) => {
    const file = join(paths.binDir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  write("gh", `exec ${sq(opts.node)} ${sq(join(lib, "gh.mts"))} "$@"`);
  for (const tool of RECORD_ONLY_TOOLS) write(tool, `exec ${sq(opts.node)} ${sq(join(lib, "record.mts"))} ${tool} "$@"`);
  // git：找出子命令（跳过 -C、-c 这类带值的全局参数），push 只记录，别的原样交给真 git
  write(
    "git",
    `sub=
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix) skip=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done
if [ "$sub" = push ]; then exec ${sq(opts.node)} ${sq(join(lib, "record.mts"))} git "$@"; fi
exec ${sq(opts.realGit)} "$@"`,
  );
}

export interface IsolationInput extends ShimPaths {
  workDir: string;
  /** 本地裸仓库：GitHub 上那个仓库的地址都改写到它。 */
  originBare: string;
  /** 场景里的 GitHub 仓库（owner/name）。 */
  repo: string;
  routerConfig: RouterConfig;
  jq: string | null;
}

/** 给守护进程的环境变量（项目经理、Worker 都从它继承）：替身在 PATH 最前面，真 gh、真 git 远端、ssh 代理都断开。 */
export function isolationEnv(input: IsolationInput): Record<string, string> {
  const ghConfig = join(input.workDir, "gh-config");
  mkdirSync(ghConfig, { recursive: true });
  const gitconfig = join(input.workDir, "gitconfig");
  const urls = [`https://github.com/${input.repo}.git`, `https://github.com/${input.repo}`, `git@github.com:${input.repo}.git`, `ssh://git@github.com/${input.repo}.git`];
  writeFileSync(
    gitconfig,
    [
      "[user]",
      "\tname = eval",
      "\temail = eval@example.invalid",
      `[url "${input.originBare}"]`,
      ...urls.flatMap((u) => [`\tinsteadOf = ${u}`, `\tpushInsteadOf = ${u}`]),
      "",
    ].join("\n"),
  );
  // claude 的 Bash 先套用户登录 shell 的快照（用户的 .zprofile 会把 ~/.local/bin、homebrew 提到 PATH 最前面，真 gh 就在那里），
  // 再 source CLAUDE_ENV_FILE：在这里把替身目录放回最前面。真 gh 万一还是被调到，沙箱也不许它执行（pmSandboxProfile）。
  const claudeEnvFile = join(input.workDir, "claude-env.sh");
  writeFileSync(claudeEnvFile, `export PATH=${sq(input.binDir)}:"$PATH"\n`);
  const routerConfigFile = join(input.workDir, "router.json");
  writeFileSync(routerConfigFile, JSON.stringify(input.routerConfig));
  return {
    PATH: `${input.binDir}${delimiter}${process.env.PATH ?? ""}`,
    GH_CONFIG_DIR: ghConfig,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GH_PROMPT_DISABLED: "1",
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: join(input.binDir, "ssh"),
    CLAUDE_ENV_FILE: claudeEnvFile,
    EVAL_GH_DIR: input.ghDir,
    EVAL_RECORD_FILE: input.recordFile,
    EVAL_ROUTER_CONFIG: routerConfigFile,
    ...(input.jq ? { EVAL_JQ: input.jq } : {}),
  };
}

// ---- 真模型项目经理的 macOS 沙箱 ----

export interface PmSandboxInput {
  /** 用户主目录（realpath 过）。 */
  home: string;
  /** 真的 Fusa 数据目录（默认 ~/.agent-hub，用户设了 AGENT_HUB_HOME 也算上）。 */
  realDataDirs: string[];
  /** 跑评测的这份仓库（用户的主文件夹）：禁读禁写，node_modules 放行读（被测版本的 node_modules 软链到这里）。 */
  realRepo: string;
  /** claude 的配置目录（默认 ~/.claude）。 */
  claudeConfigDir: string;
  /** 不许执行的真命令（ssh、rsync、真 gh……）。 */
  denyExec: string[];
  /** 真守护进程可能听的本机端口。 */
  daemonPorts: number[];
}

/** 真守护进程在数据目录 run/ 下的 socket（src/shared/paths.ts）。 */
const DAEMON_SOCKETS = ["run/hub.sock", "run/admin.sock", "run/ui.sock", "run/public.sock", "run/peer.sock", "run/tunnel/hub.sock"];

const sbString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sbRegexLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** macOS sandbox-exec 规则（SBPL）：默认放行，后写的规则优先。 */
export function pmSandboxProfile(input: PmSandboxInput): string {
  const projects = join(input.claudeConfigDir, "projects");
  const lines = [
    "(version 1)",
    "(allow default)",
    ";; 真数据目录（账本、性格设定、记忆目录、pm-notes、worktree）和真仓库：禁读禁写",
    `(deny file-read* file-write* ${[...input.realDataDirs, input.realRepo].map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    ";; 被测版本的 node_modules 软链到真仓库的 node_modules：只放行读",
    `(allow file-read* (subpath ${sbString(join(input.realRepo, "node_modules"))}))`,
    ";; claude 给真仓库、真 worktree 存的会话记录和自动记忆：禁读禁写",
    `(deny file-read* file-write* (subpath ${sbString(join(projects, claudeProjectDirName(input.realRepo)))})${input.realDataDirs
      .map((d) => ` (regex #"^${sbRegexLiteral(join(projects, claudeProjectDirName(join(d, "worktrees"))))}")`)
      .join("")})`,
    ";; 连不上真守护进程：它的几个 unix socket 和本机端口",
    `(deny network-outbound ${input.realDataDirs
      .flatMap((d) => DAEMON_SOCKETS.map((rel) => `(remote unix-socket (path-literal ${sbString(join(d, rel))}))`))
      .join(" ")} ${input.daemonPorts.map((p) => `(remote ip "localhost:${p}")`).join(" ")})`,
    ";; 不出 ssh（部署、推代码）",
    `(deny network-outbound (remote tcp "*:22"))`,
    ";; 真的 ssh、rsync、gh、launchctl……不许执行（PATH 里的替身之外的第二道）",
    `(deny process-exec ${input.denyExec.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    ";; 只能给自己这一棵进程发信号：杀不到真守护进程、Fusa.app、评测自己的守护进程",
    "(deny signal (target others))",
    "(allow signal (target same-sandbox))",
    "",
  ];
  return lines.join("\n");
}

/** 按这台机器的情况拼沙箱的输入。 */
export function pmSandboxInput(realRepo: string, originalEnv: NodeJS.ProcessEnv, binDirToSkip?: string): PmSandboxInput {
  const home = realOr(homedir());
  const dataDirs = new Set([join(home, ".agent-hub")]);
  const userHome = originalEnv[ENV_HOME];
  if (userHome) dataDirs.add(realOr(userHome));
  const ports = new Set([DEFAULT_UI_PORT]);
  const userPort = Number(originalEnv[ENV_PORT]);
  if (Number.isInteger(userPort) && userPort > 0) ports.add(userPort);
  const denyExec = new Set(DENY_EXEC.flatMap((p) => [p, realOr(p)]));
  for (const gh of findAll("gh", originalEnv.PATH, binDirToSkip)) denyExec.add(gh);
  return {
    home,
    realDataDirs: [...dataDirs],
    realRepo: realOr(realRepo),
    claudeConfigDir: realOr(originalEnv.CLAUDE_CONFIG_DIR ?? join(home, ".claude")),
    denyExec: [...denyExec],
    daemonPorts: [...ports],
  };
}

export interface PreflightResult {
  ok: boolean;
  lines: string[];
}

/**
 * 在真沙箱里逐条试：该挡的挡住了、该放的放了（不花模型的钱）。只在 macOS 上跑；有一条不对就不跑评测。
 * probeDir：评测自己的目录（要能写）；evalPid：沙箱外的一个进程（发信号要被拒）。
 */
export function preflight(profileFile: string, input: PmSandboxInput, opts: { probeDir: string; evalPid: number; realClaude: string }): PreflightResult {
  const lines: string[] = [];
  let ok = true;
  const trySh = (what: string, script: string, expectOk: boolean) => {
    const r = spawnSync(SANDBOX_EXEC, ["-f", profileFile, "/bin/sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
    const succeeded = r.status === 0;
    const good = succeeded === expectOk;
    if (!good) ok = false;
    lines.push(`${good ? "✓" : "✗"} ${what}${good ? "" : `（期望${expectOk ? "能做" : "被拦"}，实际${succeeded ? "做成了" : `失败：${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`}）`}`);
  };
  trySh("沙箱能起来、评测目录能写", `touch ${sq(join(opts.probeDir, ".preflight"))}`, true);
  for (const d of input.realDataDirs) {
    if (existsSync(d)) trySh(`禁读真数据目录 ${d}`, `ls ${sq(d)} >/dev/null`, false);
    if (existsSync(d)) trySh(`禁写真数据目录 ${d}`, `touch ${sq(join(d, ".eval-probe"))}`, false);
  }
  trySh(`禁读真仓库 ${input.realRepo}`, `cat ${sq(join(input.realRepo, "package.json"))} >/dev/null`, false);
  if (existsSync(join(input.realRepo, "node_modules"))) trySh("真仓库的 node_modules 能读", `ls ${sq(join(input.realRepo, "node_modules"))} >/dev/null`, true);
  // sh 执行不了（沙箱拒绝 exec）时退出码是 126：只认这个，不靠命令自己的退出码
  for (const exe of input.denyExec.filter((p) => existsSync(p))) trySh(`不许执行 ${exe}`, `${sq(exe)} --version >/dev/null 2>&1; [ $? -eq 126 ]`, true);
  trySh("不能给沙箱外的进程发信号", `kill -0 ${opts.evalPid}`, false);
  for (const d of input.realDataDirs) {
    const sock = join(d, "run", "hub.sock");
    if (existsSync(sock) && existsSync("/usr/bin/nc")) trySh(`连不上真守护进程的 ${sock}`, `/usr/bin/nc -U ${sq(sock)} </dev/null >/dev/null 2>&1`, false);
  }
  trySh("真 claude 能在沙箱里起来", `${sq(opts.realClaude)} --version >/dev/null`, true);
  return { ok, lines };
}

/**
 * 用真 claude 走一遍真实路径（不是靠推断）：在同一个沙箱里、带着和评测一样的 PATH 与 CLAUDE_ENV_FILE，让它用 Bash 跑
 * `command -v gh`，答案必须是替身。用户 shell 的配置（.zprofile 把 ~/.local/bin 提前）会不会压住替身，只有这样才看得出来。
 * 用最小的模型、不存会话，约 1 美分。
 */
export function probeClaudeShimPath(profileFile: string, opts: { realClaude: string; dir: string; model: string }): { ok: boolean; line: string } {
  const binDir = join(opts.dir, "bin");
  writeShims({ binDir, ghDir: join(opts.dir, "gh"), recordFile: join(opts.dir, "recorded.jsonl") }, { node: process.execPath, realGit: realGitPath() });
  const envFile = join(opts.dir, "claude-env.sh");
  writeFileSync(envFile, `export PATH=${sq(binDir)}:"$PATH"\n`);
  const prompt = "Use the Bash tool to run exactly this command: command -v gh ; then reply with only its output, nothing else.";
  const r = spawnSync(
    SANDBOX_EXEC,
    ["-f", profileFile, opts.realClaude, "-p", prompt, "--model", opts.model, "--allowedTools", "Bash(command -v gh:*)", "--max-turns", "4", "--no-session-persistence", "--settings", JSON.stringify({ sandbox: { enabled: false } })],
    { cwd: opts.dir, encoding: "utf8", timeout: 180_000, env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, CLAUDE_ENV_FILE: envFile } },
  );
  const out = `${r.stdout ?? ""}`.trim();
  const ok = r.status === 0 && out.includes(join(binDir, "gh"));
  return { ok, line: `${ok ? "✓" : "✗"} 真 claude 的 Bash 里 gh 是替身${ok ? "" : `（实际：${(out || r.stderr || r.error?.message || "").trim().slice(0, 300)}）`}` };
}

/** 这台机器上真 git 的路径（替身转给它）。 */
export function realGitPath(): string {
  return realOr(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim() || "/usr/bin/git");
}
