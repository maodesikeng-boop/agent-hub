import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { PROVIDER_AUTH_URL_MAX_CHARS } from "../../../shared/index.ts";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/gu;
const CAPTURE_POLL_MS = 80;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

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
  applyEnv(
    baseEnv: Record<string, string | undefined>,
    options?: { interceptSystemOpeners?: boolean; fakeNodeTty?: boolean },
  ): Record<string, string>;
  pollOnce(): void;
  dispose(): void;
}

const CAPTURE_SCRIPT_SOURCE = [
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

// Some Node CLIs require process.stdin.isTTY; the shim sets it on piped stdin.
const TTY_SHIM_SOURCE = [
  "if (!process.stdin.isTTY) {",
  "  process.stdin.isTTY = true;",
  '  if (typeof process.stdin.setRawMode !== "function") {',
  "    process.stdin.setRawMode = function setRawMode() { return process.stdin; };",
  "  }",
  "}",
  "if (!process.stdout.isTTY) { process.stdout.isTTY = true; }",
].join("\n");

interface CaptureFiles {
  openersDir: string;
  capturedFile: string;
  captureScriptFile: string;
  ttyShimFile: string;
  browserLauncherPath: string;
}

function writeCaptureFiles(rootDir: string, platform: string): CaptureFiles {
  const openersDir = join(rootDir, "openers");
  mkdirSync(openersDir, { recursive: true, mode: 0o700 });
  const capturedFile = join(rootDir, "captured-urls.jsonl");
  const captureScriptFile = join(rootDir, "capture.cjs");
  const ttyShimFile = join(rootDir, "tty-shim.cjs");
  writeFileSync(captureScriptFile, CAPTURE_SCRIPT_SOURCE, { mode: 0o600 });
  writeFileSync(ttyShimFile, TTY_SHIM_SOURCE, { mode: 0o600 });

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
  return { openersDir, capturedFile, captureScriptFile, ttyShimFile, browserLauncherPath };
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
    }
  }

  const { openersDir, capturedFile, captureScriptFile, ttyShimFile, browserLauncherPath } = writeCaptureFiles(rootDir, platform);

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
        }
      }
    } catch {
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
      }
    },
  };
}
