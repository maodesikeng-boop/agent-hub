// tailscale 和系统有关的部分（docs/multi-device-design.md 第 3.1、5 节）：命令行在哪、serve 转发到哪。
// 别的代码只调这里，不自己判断 process.platform。
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { ENV_SERVE_TARGET, ENV_TAILSCALE } from "../../shared/index.ts";

type Env = Record<string, string | undefined>;

/** macOS 的 Tailscale App（App Store 版、官网独立版）里自带的命令行。Homebrew 装的在 PATH 里，叫 tailscale。 */
export const MACOS_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** Windows 默认安装目录下的 Tailscale CLI。 */
export const WIN32_TAILSCALE_DEFAULT_CLI = "C:\\Program Files\\Tailscale\\tailscale.exe";

// 下面的 platform 不给就是本机的 process.platform（测试里传）。

/** tailscale 命令行：AGENT_HUB_TAILSCALE 优先；macOS / Windows 优先各自官方安装路径；否则 PATH 里的 tailscale。 */
export function tailscaleCommand(opts: { platform?: string; env: Env; exists?: (path: string) => boolean }): string {
  const platform = opts.platform ?? process.platform;
  const fromEnv = opts.env[ENV_TAILSCALE]?.trim();
  if (fromEnv) return fromEnv;
  const exists = opts.exists ?? existsSync;
  if (platform === "darwin" && exists(MACOS_TAILSCALE_APP_CLI)) return MACOS_TAILSCALE_APP_CLI;
  if (platform === "win32") {
    const progFiles = opts.env.ProgramFiles?.trim() || "C:\\Program Files";
    const winCli = win32.join(progFiles, "Tailscale", "tailscale.exe");
    if (exists(winCli)) return winCli;
    if (winCli !== WIN32_TAILSCALE_DEFAULT_CLI && exists(WIN32_TAILSCALE_DEFAULT_CLI)) {
      return WIN32_TAILSCALE_DEFAULT_CLI;
    }
  }
  return "tailscale";
}

/**
 * serve 把 https 请求转发到哪：
 * - unix：守护进程另听一个 0600 的 socket（run/ui.sock），只有 root 跑的 tailscaled 和自己能连，本机别的用户伪造不了 serve 流量。Linux 默认。
 * - tcp：转发到 127.0.0.1:<端口>。macOS 默认：Tailscale App 有沙箱，连不了数据目录里的 socket。
 */
export type ServeTargetKind = "unix" | "tcp";
export type ServeTarget = { kind: "unix"; path: string } | { kind: "tcp"; port: number };

/** AGENT_HUB_SERVE_TARGET（unix | tcp）能改，别的值不认。 */
export function serveTargetKind(opts: { platform?: string; env: Env }): ServeTargetKind {
  const fromEnv = opts.env[ENV_SERVE_TARGET]?.trim();
  if (fromEnv === "unix" || fromEnv === "tcp") return fromEnv;
  return (opts.platform ?? process.platform) === "linux" ? "unix" : "tcp";
}

/**
 * 启动时提示给用户的 serve 命令（只在 tailnet 里可见，不是 Funnel）。
 * Linux 前面加 sudo：tailscaled 以 root 跑，改 serve 配置要 root（Tailscale 文档的要求，代理 unix socket 也要 root）。
 * socket 是 0600、属于跑守护进程的用户，root 跑的 tailscaled 照样连得上，别的普通用户连不上。
 * macOS 的 App 版不用 sudo。
 */
export function serveCommandLine(opts: { platform?: string; cli: string; target: ServeTarget }): string {
  const { cli, target } = opts;
  const to = target.kind === "unix" ? `unix:${target.path}` : `http://127.0.0.1:${target.port}`;
  const sudo = (opts.platform ?? process.platform) === "linux" ? "sudo " : "";
  return `${sudo}${cli} serve --bg ${to}`;
}
