// 浏览器 OAuth URL 拦截器与 CLI 登录输出提取原语（照 t3code antigravityAuthSupport 扩展全平台支持）：
// 1. 生成 0700 会话私有临时目录，注入 `BROWSER` 拦截脚本与 POSIX `open`/`xdg-open` 垫片，捕获 CLI 欲打开的授权 URL 而不真在无头服务端弹窗；
// 2. 提供可选的 Node TTY 垫片（供要求 `process.stdin.isTTY === true` 的 Node CLI 子命令在受管管道内顺畅运行）；
// 3. 提供从 ANSI 输出中提取授权链接与 Device Code 的纯函数。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { PROVIDER_AUTH_URL_MAX_CHARS } from "../../../shared/index.ts";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/gu;
const CAPTURE_POLL_MS = 80;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** 从 CLI 输出文本中提取第一个合法的 HTTP(S) 授权链接（排除纯本机 127.0.0.1/localhost 回调地址）。 */
export function extractAuthorizeUrlFromOutput(raw: string): string | null {
  const cleaned = stripAnsi(raw);
  const matches = cleaned.match(/https?:\/\/[^\s"'<>)\]]+/giu);
  if (!matches) return null;
  for (const rawCandidate of matches) {
    const candidate = rawCandidate.replace(/[.,;]+$/u, "");
    if (candidate.length > PROVIDER_AUTH_URL_MAX_CHARS) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]") {
        continue;
      }
      return parsed.href;
    } catch {
      continue;
    }
  }
  return null;
}

/** 从 CLI 输出文本中提取 Device Code（如 `Open https://... and enter code: WXYZ-5678`）。 */
export function extractDeviceCodeFromOutput(
  raw: string,
): { verificationUrl: string; userCode: string } | null {
  const cleaned = stripAnsi(raw);
  const url = extractAuthorizeUrlFromOutput(cleaned);
  if (!url) return null;
  const codePatterns = [
    /(?:enter\s+code|one-time\s+code|device\s+code|user\s+code|code)\s*[:\-]?\s*\b([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+)\b/iu,
    /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4,6})\b/u,
  ];
  for (const re of codePatterns) {
    const m = re.exec(cleaned);
    if (m && m[1]) {
      return { verificationUrl: url, userCode: m[1].trim() };
    }
  }
  return null;
}

export interface BrowserCaptureSession {
  /** 为登录子进程合成带 BROWSER 与拦截垫片目录的环境变量。 */
  applyEnv(
    baseEnv: Record<string, string | undefined>,
    options?: { interceptSystemOpeners?: boolean; fakeNodeTty?: boolean },
  ): Record<string, string>;
  /** 立即检查一次捕获文件是否已有新 URL。 */
  pollOnce(): void;
  /** 停止监听并清理临时目录。 */
  dispose(): void;
}

export function createBrowserCaptureSession(options: {
  onUrl: (url: string) => void;
  platform?: string;
  execPath?: string;
}): BrowserCaptureSession {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const rootDir = mkdtempSync(join(tmpdir(), "fusa-auth-cap-"));
  if (platform !== "win32") {
    try {
      chmodSync(rootDir, 0o700);
    } catch {
      // ignore
    }
  }

  const openersDir = join(rootDir, "openers");
  mkdirSync(openersDir, { recursive: true, mode: 0o700 });
  const capturedFile = join(rootDir, "captured-urls.jsonl");
  const captureScriptFile = join(rootDir, "capture.cjs");
  const ttyShimFile = join(rootDir, "tty-shim.cjs");

  // Node 拦截脚本：找出参数中第一个合法 HTTP(S) URL，追加写入 captured-urls.jsonl
  const captureScriptSource = [
    'const { appendFileSync } = require("node:fs");',
    "const maxLen = Number(process.env.FUSA_CAPTURE_MAX_CHARS || 8192);",
    "const out = process.env.FUSA_CAPTURE_OUT;",
    "if (out) {",
    "  for (const arg of process.argv.slice(2)) {",
    '    if (typeof arg !== "string") continue;',
    "    const trimmed = arg.trim();",
    '    if ((trimmed.startsWith("https://") || trimmed.startsWith("http://")) && trimmed.length <= maxLen) {',
    '      try { new URL(trimmed); appendFileSync(out, JSON.stringify({ url: trimmed }) + "\\n", { mode: 0o600 }); break; } catch {}',
    "    }",
    "  }",
    "}",
    "process.exit(0);",
  ].join("\n");
  writeFileSync(captureScriptFile, captureScriptSource, { mode: 0o600 });

  // 可选 Node TTY 垫片：仅在管道非 TTY 时标记 isTTY = true 并兜底空操作 setRawMode
  const ttyShimSource = [
    "if (!process.stdin.isTTY) {",
    "  process.stdin.isTTY = true;",
    '  if (typeof process.stdin.setRawMode !== "function") {',
    "    process.stdin.setRawMode = function setRawMode() { return process.stdin; };",
    "  }",
    "}",
    "if (!process.stdout.isTTY) { process.stdout.isTTY = true; }",
  ].join("\n");
  writeFileSync(ttyShimFile, ttyShimSource, { mode: 0o600 });

  let browserLauncherPath: string;
  if (platform === "win32") {
    browserLauncherPath = join(rootDir, "fusa-browser.cmd");
    writeFileSync(
      browserLauncherPath,
      '@echo off\r\n"%FUSA_CAPTURE_NODE%" "%FUSA_CAPTURE_SCRIPT%" %*\r\n',
      "utf8",
    );
  } else {
    browserLauncherPath = join(rootDir, "fusa-browser");
    const posixShim = '#!/bin/sh\nexec "$FUSA_CAPTURE_NODE" "$FUSA_CAPTURE_SCRIPT" "$@"\n';
    writeFileSync(browserLauncherPath, posixShim, { mode: 0o700 });
    chmodSync(browserLauncherPath, 0o700);
    for (const openerName of ["open", "xdg-open", "sensible-browser"]) {
      const p = join(openersDir, openerName);
      writeFileSync(p, posixShim, { mode: 0o700 });
      chmodSync(p, 0o700);
    }
  }

  let seenLines = 0;
  let disposed = false;
  const deliveredUrls = new Set<string>();

  const pollOnce = () => {
    if (disposed || !existsSync(capturedFile)) return;
    try {
      const content = readFileSync(capturedFile, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      while (seenLines < lines.length) {
        const line = lines[seenLines]!;
        seenLines += 1;
        try {
          const parsed = JSON.parse(line) as { url?: unknown };
          if (
            typeof parsed.url === "string" &&
            parsed.url.length <= PROVIDER_AUTH_URL_MAX_CHARS &&
            !deliveredUrls.has(parsed.url)
          ) {
            deliveredUrls.add(parsed.url);
            options.onUrl(parsed.url);
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore transient read error
    }
  };

  const timer = setInterval(pollOnce, CAPTURE_POLL_MS);
  timer.unref();

  return {
    applyEnv(baseEnv, envOpts) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(baseEnv)) {
        if (v !== undefined) out[k] = v;
      }
      out.BROWSER = browserLauncherPath;
      out.FUSA_CAPTURE_NODE = execPath;
      out.FUSA_CAPTURE_SCRIPT = captureScriptFile;
      out.FUSA_CAPTURE_OUT = capturedFile;
      out.FUSA_CAPTURE_MAX_CHARS = String(PROVIDER_AUTH_URL_MAX_CHARS);

      if (envOpts?.interceptSystemOpeners !== false && platform !== "win32") {
        const sep = platform === "win32" ? win32.delimiter : posix.delimiter || delimiter;
        const currentPath = out.PATH ?? "";
        out.PATH = currentPath ? `${openersDir}${sep}${currentPath}` : openersDir;
      }
      if (envOpts?.fakeNodeTty) {
        const quotedShim = ttyShimFile.includes(" ") ? `"${ttyShimFile}"` : ttyShimFile;
        const existingOpts = out.NODE_OPTIONS?.trim() ?? "";
        out.NODE_OPTIONS = existingOpts ? `${existingOpts} --require ${quotedShim}` : `--require ${quotedShim}`;
      }
      return out;
    },
    pollOnce,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      pollOnce();
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    },
  };
}
