// 替网页弹 macOS 原生的“选择文件夹”（浏览器自带的选文件夹拿不到绝对路径，守护进程就跑在用户这台 Mac 上）。
// 起 osascript 的逻辑都在这里；执行函数可注入，测试里不会真的弹窗。
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { PICK_FOLDER_TIMEOUT_MS } from "../shared/index.ts";

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

export const runOsascript: RunOsascript = (args, { timeoutMs }) =>
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
export const PICK_FOLDER_UNAVAILABLE_MESSAGE = "这台电脑上没有 osascript，不能弹出选择文件夹的窗口（只支持 macOS），请直接输入路径";

export interface FolderPickerOptions {
  run?: RunOsascript;
  timeoutMs?: number;
  /** 没给起始文件夹或它不可用时的起点。 */
  homeDir?: string;
}

export interface FolderPicker {
  /** 弹对话框，返回选中的绝对路径；取消或超时是 null；已经有一个开着 → PickFolderError 409；起不来 → PickFolderError 500 / 501。 */
  pick(startDir?: string): Promise<string | null>;
}

/** 起始文件夹：~ 展开；是文件就用它所在的文件夹；不存在、不是绝对路径就用家目录。 */
function startFolder(input: string | undefined, homeDir: string): string {
  const raw = input?.trim();
  if (!raw) return homeDir;
  const expanded = raw === "~" ? homeDir : raw.startsWith("~/") ? resolve(homeDir, raw.slice(2)) : raw;
  if (!expanded.startsWith("/")) return homeDir;
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

export function createFolderPicker(options: FolderPickerOptions = {}): FolderPicker {
  const run = options.run ?? runOsascript;
  const timeoutMs = options.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS;
  const homeDir = options.homeDir ?? homedir();
  let open = false;

  return {
    async pick(startDir) {
      if (open) throw new PickFolderError(409, PICK_FOLDER_BUSY_MESSAGE);
      open = true;
      try {
        const args = PICK_FOLDER_SCRIPT.flatMap((line) => ["-e", line]);
        // 额外参数交给 AppleScript 的 argv：osascript -e ... -e ... -- <起始文件夹>
        args.push("--", startFolder(startDir, homeDir));
        const { stdout } = await run(args, { timeoutMs });
        const path = stdout.trim().replace(/(.)\/+$/, "$1");
        return path === "" ? null : path;
      } catch (err) {
        if (errorField(err, "killed") === true) return null; // 超时被杀：当作取消
        const stderr = String(errorField(err, "stderr") ?? "");
        if (stderr.includes(USER_CANCELED)) return null;
        if (errorField(err, "code") === "ENOENT") throw new PickFolderError(501, PICK_FOLDER_UNAVAILABLE_MESSAGE);
        const reason = stderr.trim() || (err instanceof Error ? err.message : String(err));
        throw new PickFolderError(500, `弹不出选择文件夹的窗口：${reason}`);
      } finally {
        open = false;
      }
    },
  };
}
