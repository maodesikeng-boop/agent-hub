// 替网页弹桌面系统原生的“选择文件夹”（浏览器自带的选文件夹拿不到绝对路径）：
// - macOS：经 osascript 弹 Finder 选择对话框；
// - Windows（受桌面外壳监管时）：经本机窄回环桥接调 Tauri `tauri-plugin-dialog` 弹原生目录选择器；
// - 纯浏览器或 Linux 服务器：回 501，网页不显示“选择…”，用户手填路径（shared/server-info.ts）。
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { PICK_FOLDER_TIMEOUT_MS, serverInfoFor } from "../shared/index.ts";
import { isCrossPlatformAbsolutePath } from "./platform/index.ts";

/** Windows 桌面外壳注入的原生目录选择桥接环境变量（entry.ts 启动时读取后立即从 process.env 剥离）。 */
export const DESKTOP_DIALOG_URL_ENV = "AGENT_HUB_DESKTOP_DIALOG_URL";
export const DESKTOP_DIALOG_TOKEN_ENV = "AGENT_HUB_DESKTOP_DIALOG_TOKEN";

/** 对话框上的提示语。 */
const PICK_FOLDER_PROMPT = "选择主文件夹";

/**
 * AppleScript：argv 第一项是对话框开始的文件夹（调用方保证它存在）。路径走 argv，不拼进脚本，免得特殊字符破坏脚本。
 * activate 让对话框跳到最前面（守护进程是后台进程，不 activate 的话对话框可能压在浏览器后面）。
 */
const PICK_FOLDER_SCRIPT = [
  "on run argv",
  "tell me to activate",
  `return POSIX path of (choose folder with prompt "${PICK_FOLDER_PROMPT}" default location (POSIX file (item 1 of argv)))`,
  "end run",
];

/** osascript 取消对话框时 stderr 里的错误号（“User canceled. (-128)”），退出码是 1。 */
const USER_CANCELED = "-128";

/** 执行 osascript：成功给 stdout；失败（含超时被杀）抛出带 code / killed / stderr 的错误，和 execFile 一样。 */
export type RunOsascript = (args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>;

const runOsascript: RunOsascript = (args, { timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    execFile("osascript", args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolvePromise({ stdout });
    });
  });

export class PickFolderError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PickFolderError";
    this.statusCode = statusCode;
  }
}

export const PICK_FOLDER_BUSY_MESSAGE = "已经有一个选择文件夹的窗口开着了，先在那个窗口里选完或取消";
export const PICK_FOLDER_UNAVAILABLE_MESSAGE = "这台服务器不能弹出选择文件夹的窗口，请直接输入路径";

export interface FolderPickerOptions {
  run?: RunOsascript;
  /** 桌面外壳窄桥接（Windows Tauri `tauri-plugin-dialog`）：传入起始目录与超时，返回选中的目录或 null。 */
  pickViaDesktopBridge?: (startDir: string, options: { timeoutMs: number }) => Promise<string | null>;
  timeoutMs?: number;
  /** 没给起始文件夹或它不可用时的起点。 */
  homeDir?: string;
  /** 这台机器能不能弹原生对话框（默认只有 macOS）。false 且没传 run：pick 直接 501。传了 run（测试）不看它。 */
  available?: boolean;
}

export interface FolderPicker {
  /** 弹对话框，返回选中的绝对路径；取消或超时是 null；已经有一个开着 → PickFolderError 409；起不来 → PickFolderError 500 / 501。 */
  pick(startDir?: string): Promise<string | null>;
}

/** 起始文件夹：~ 展开；是文件就用它所在的文件夹；不存在、不是绝对路径就用家目录。 */
function startFolder(input: string | undefined, homeDir: string): string {
  const raw = input?.trim();
  if (!raw) return homeDir;
  const expanded =
    raw === "~"
      ? homeDir
      : raw.startsWith("~/") || raw.startsWith("~\\")
        ? resolve(homeDir, raw.slice(2))
        : raw;
  if (!isCrossPlatformAbsolutePath(expanded)) return homeDir;
  try {
    const path = resolve(expanded);
    return statSync(path).isDirectory() ? path : dirname(path);
  } catch {
    return homeDir;
  }
}

function errorField(err: unknown, field: string): unknown {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>)[field] : undefined;
}

export function trimPickedFolderPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^[A-Za-z]:\\+$/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  if (/^\/+$/.test(trimmed)) return "/";
  return trimmed.replace(/[\\/]+$/, "");
}

export function isAllowedLoopbackBridgeUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port !== "";
  } catch {
    return false;
  }
}

/** 构造通过本机回环窄桥接请求桌面外壳 `tauri-plugin-dialog` 的 `FolderPicker`。 */
export function createDesktopBridgeFolderPicker(input: {
  bridgeUrl: string;
  bridgeToken: string;
  timeoutMs?: number;
  homeDir?: string;
  fetchImpl?: typeof fetch;
}): FolderPicker {
  if (!isAllowedLoopbackBridgeUrl(input.bridgeUrl) || input.bridgeToken.trim() === "") {
    return createFolderPicker({ available: false, homeDir: input.homeDir });
  }
  const fetchFn = input.fetchImpl ?? fetch;
  return createFolderPicker({
    available: true,
    timeoutMs: input.timeoutMs,
    homeDir: input.homeDir,
    pickViaDesktopBridge: async (resolvedStartDir, { timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(input.bridgeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.bridgeToken}`,
          },
          body: JSON.stringify({ startDir: resolvedStartDir }),
          signal: controller.signal,
          redirect: "error",
        });
        if (res.status === 409) throw new PickFolderError(409, PICK_FOLDER_BUSY_MESSAGE);
        if (!res.ok) {
          throw new PickFolderError(500, `弹不出选择文件夹的窗口：桌面外壳返回 HTTP ${res.status}`);
        }
        const body = (await res.json()) as { path?: unknown };
        return typeof body.path === "string" ? trimPickedFolderPath(body.path) : null;
      } catch (err) {
        if (err instanceof PickFolderError) throw err;
        if (errorField(err, "name") === "AbortError") return null;
        throw new PickFolderError(500, "弹不出选择文件夹的窗口：无法连接本地桌面外壳");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export function createFolderPicker(options: FolderPickerOptions = {}): FolderPicker {
  const run = options.run ?? runOsascript;
  const bridge = options.pickViaDesktopBridge;
  const timeoutMs = options.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS;
  const homeDir = options.homeDir ?? homedir();
  const canUseDefaultOsascript = process.platform === "darwin";
  const available =
    options.run !== undefined ||
    bridge !== undefined ||
    ((options.available ?? serverInfoFor(process.platform).folderPicker) && canUseDefaultOsascript);
  let open = false;

  return {
    async pick(startDir) {
      if (!available) throw new PickFolderError(501, PICK_FOLDER_UNAVAILABLE_MESSAGE);
      if (open) throw new PickFolderError(409, PICK_FOLDER_BUSY_MESSAGE);
      open = true;
      try {
        const resolvedStart = startFolder(startDir, homeDir);
        if (bridge !== undefined) {
          return await bridge(resolvedStart, { timeoutMs });
        }
        const args = PICK_FOLDER_SCRIPT.flatMap((line) => ["-e", line]);
        // 额外参数交给 AppleScript 的 argv：osascript -e ... -e ... -- <起始文件夹>
        args.push("--", resolvedStart);
        const { stdout } = await run(args, { timeoutMs });
        return trimPickedFolderPath(stdout);
      } catch (err) {
        if (err instanceof PickFolderError) throw err;
        if (errorField(err, "killed") === true) return null; // 超时被杀：当作取消
        const stderr = String(errorField(err, "stderr") ?? "");
        if (stderr.includes(USER_CANCELED)) return null;
        if (errorField(err, "code") === "ENOENT") throw new PickFolderError(501, PICK_FOLDER_UNAVAILABLE_MESSAGE);
        // stderr 空（被信号结束之类）时别把 err.message 里整条命令抖出来
        const signal = errorField(err, "signal");
        const reason = stderr.trim() || (typeof signal === "string" ? `osascript 被 ${signal} 结束了` : "osascript 异常退出");
        throw new PickFolderError(500, `弹不出选择文件夹的窗口：${reason}`);
      } finally {
        open = false;
      }
    },
  };
}
