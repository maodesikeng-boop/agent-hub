#!/usr/bin/env node
// 评测里 claude 的分流脚本（docs/orchestration-eval-design.md 3.3）：守护进程按 AGENT_HUB_CLAUDE 起的就是它。
// - Worker 的会话（环境变量里有 Worker 才设的 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1，src/vendors/claude/settings.ts 的 WORKER_ENV）：
//   换成假 claude（test/fake-claude/fake-claude.ts），按场景剧本交回真实提交和真实汇报；
// - 其余（项目经理、厂商探测、写交接的复制）：scripted 模式也给假 claude（剧本项目经理，自测用）；
//   real 模式给真 claude，并包进 macOS 沙箱（isolation.ts 生成的规则：真数据目录、真仓库读写都拦，ssh/rsync/真 gh 不能执行，
//   不能给别的进程发信号，连不上真守护进程），再把 --settings 里 claude 自带的沙箱关掉（macOS 沙箱不能嵌套）。
// 配置在 EVAL_ROUTER_CONFIG 指的 JSON 文件里（RouterConfig）。用 process.execve 换掉自己：进程号不变，守护进程按进程组管它照常管得住。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RouterConfig {
  mode: "scripted" | "real";
  /** node 的路径（跑假 claude 用）。 */
  node: string;
  fakeClaude: string;
  /** real 模式：真 claude 的绝对路径。 */
  realClaude?: string;
  /** real 模式：sandbox-exec 和规则文件；null 表示不包（只在不是 macOS 的自测里）。 */
  sandbox?: { exec: string; profile: string } | null;
  /** 改过的 --settings 文件写在这里。 */
  settingsDir: string;
}

const WORKER_MARK = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

export function isWorkerEnv(env: NodeJS.ProcessEnv): boolean {
  return env[WORKER_MARK] === "1";
}

/** 把 --settings 换成关掉 claude 自带沙箱的一份（内容哈希做文件名，同样的设置只写一次）。 */
export function settingsWithoutOwnSandbox(args: string[], settingsDir: string): string[] {
  const i = args.indexOf("--settings");
  if (i < 0 || args[i + 1] === undefined) return args;
  const raw = args[i + 1]!;
  const text = raw.trimStart().startsWith("{") ? raw : readFileSync(raw, "utf8");
  const settings = JSON.parse(text) as { sandbox?: Record<string, unknown> };
  settings.sandbox = { ...settings.sandbox, enabled: false };
  const body = JSON.stringify(settings);
  mkdirSync(settingsDir, { recursive: true });
  const file = join(settingsDir, `settings-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.json`);
  writeFileSync(file, body, { mode: 0o600 });
  return [...args.slice(0, i + 1), file, ...args.slice(i + 2)];
}

/** 分流结果：要 execve 的程序和完整参数（含 argv[0]）。 */
export function route(config: RouterConfig, args: string[], env: NodeJS.ProcessEnv): { file: string; argv: string[] } {
  if (config.mode === "scripted" || isWorkerEnv(env)) {
    return { file: config.node, argv: [config.node, config.fakeClaude, ...args] };
  }
  if (!config.realClaude) throw new Error("claude 分流：real 模式没有 realClaude");
  if (!config.sandbox) return { file: config.realClaude, argv: [config.realClaude, ...args] };
  const patched = settingsWithoutOwnSandbox(args, config.settingsDir);
  return { file: config.sandbox.exec, argv: [config.sandbox.exec, "-f", config.sandbox.profile, config.realClaude, ...patched] };
}

if (import.meta.main) {
  const configFile = process.env.EVAL_ROUTER_CONFIG;
  if (!configFile) {
    process.stderr.write("claude 分流（评测）：没有 EVAL_ROUTER_CONFIG\n");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configFile, "utf8")) as RouterConfig;
  const { file, argv } = route(config, process.argv.slice(2), process.env);
  process.execve!(file, argv, process.env as Record<string, string>);
}
