import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { PICK_FOLDER_TIMEOUT_MS, serverInfoFor } from "../shared/index.ts";
import { isCrossPlatformAbsolutePath } from "./platform/index.ts";

export const DESKTOP_DIALOG_URL_ENV = "AGENT_HUB_DESKTOP_DIALOG_URL";
export const DESKTOP_DIALOG_TOKEN_ENV = "AGENT_HUB_DESKTOP_DIALOG_TOKEN";

const PICK_FOLDER_PROMPT = "选择主文件夹";

/** The start folder goes through argv, not the script text, so special characters cannot break the AppleScript. */
const PICK_FOLDER_SCRIPT = [
  "on run argv",
  "tell me to activate",
  `return POSIX path of (choose folder with prompt "${PICK_FOLDER_PROMPT}" default location (POSIX file (item 1 of argv)))`,
  "end run",
];

const USER_CANCELED = "-128";

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
  pickViaDesktopBridge?: (startDir: string, options: { timeoutMs: number }) => Promise<string | null>;
  timeoutMs?: number;
  homeDir?: string;
  available?: boolean;
}

export interface FolderPicker {
  pick(startDir?: string): Promise<string | null>;
}

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
        args.push("--", resolvedStart);
        const { stdout } = await run(args, { timeoutMs });
        return trimPickedFolderPath(stdout);
      } catch (err) {
        if (err instanceof PickFolderError) throw err;
        if (errorField(err, "killed") === true) return null;
        const stderr = String(errorField(err, "stderr") ?? "");
        if (stderr.includes(USER_CANCELED)) return null;
        if (errorField(err, "code") === "ENOENT") throw new PickFolderError(501, PICK_FOLDER_UNAVAILABLE_MESSAGE);
        // Avoid echoing the whole command from err.message when stderr is empty.
        const signal = errorField(err, "signal");
        const reason = stderr.trim() || (typeof signal === "string" ? `osascript 被 ${signal} 结束了` : "osascript 异常退出");
        throw new PickFolderError(500, `弹不出选择文件夹的窗口：${reason}`);
      } finally {
        open = false;
      }
    },
  };
}
