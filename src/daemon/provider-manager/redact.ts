// 安装/更新任务输出脱敏与有界环形日志缓冲（docs/providers-install-login-design.md 第 8.1.2、8.2、8.3 节）：
// - 擦除 sk-* / key_* / AIza* / Bearer Token / OAuth code / access_token / state 等一切凭据痕迹；
// - 处理 `\r` 进度条原地覆盖，严格限制内存缓冲不超过 16 KiB / 80 行 / 单行未换行 4096 字符。
import {
  PROVIDER_JOB_LOG_MAX_BYTES,
  PROVIDER_JOB_LOG_MAX_LINES,
  PROVIDER_JOB_PARTIAL_LINE_MAX_CHARS,
  PROVIDER_PROGRESS_LINE_MAX_CHARS,
} from "../../shared/index.ts";

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/gu;

export function redactProviderLog(raw: string): string {
  let text = raw.replace(ANSI_ESCAPE_RE, "");
  // Bearer / Basic Authorization 头
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, "$1 [REDACTED]");
  // URL 查询参数中的敏感字段（code / token / state / key / secret）
  text = text.replace(
    /([?&](?:code|token|access_token|refresh_token|id_token|client_secret|api_key|apikey|key|state)=)[^&\s#"']+/giu,
    "$1[REDACTED]",
  );
  // 常见厂商密钥前缀（sk-..., key_..., AIza..., ghp_..., gho_..., github_pat_...）
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[REDACTED]");
  text = text.replace(/\bkey_[A-Za-z0-9_-]{8,}\b/gu, "key_[REDACTED]");
  text = text.replace(/\bAIza[A-Za-z0-9_-]{16,}\b/gu, "AIza[REDACTED]");
  text = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/gu, "[REDACTED]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/gu, "[REDACTED]");
  // 环境变量形式 KEY=xxx 或 KEY: xxx
  text = text.replace(
    /(\b[A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET_KEY)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu,
    "$1[REDACTED]",
  );
  return text;
}

function extractCleanProgressCandidate(redactedLine: string): string | null {
  const trimmed = redactedLine.trim();
  if (trimmed === "") return null;
  // 跳过纯符号进度条或纯分隔线
  if (/^[#=\-*_.%0-9\s[\]()|/\\]+$/u.test(trimmed)) return null;
  const collapsed = trimmed.replace(/\s+/gu, " ");
  if (collapsed.length <= PROVIDER_PROGRESS_LINE_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROVIDER_PROGRESS_LINE_MAX_CHARS - 1)}…`;
}

export class BoundedJobLogBuffer {
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #maxPartialChars: number;
  readonly #lines: string[] = [];
  readonly #lineBytes: number[] = [];
  #totalBytes = 0;
  #partial = "";
  #progressLine: string | null = null;

  constructor(options?: {
    maxBytes?: number;
    maxLines?: number;
    maxPartialChars?: number;
    initialProgress?: string | null;
  }) {
    this.#maxBytes = options?.maxBytes ?? PROVIDER_JOB_LOG_MAX_BYTES;
    this.#maxLines = options?.maxLines ?? PROVIDER_JOB_LOG_MAX_LINES;
    this.#maxPartialChars = options?.maxPartialChars ?? PROVIDER_JOB_PARTIAL_LINE_MAX_CHARS;
    this.#progressLine = options?.initialProgress ?? null;
  }

  setStageProgress(stageText: string): void {
    this.#progressLine = extractCleanProgressCandidate(redactProviderLog(stageText)) ?? this.#progressLine;
  }

  append(chunk: string): void {
    if (!chunk) return;
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      if (ch === "\r") {
        if (chunk[i + 1] === "\n") {
          i += 1;
          this.#commitPartialLine();
        } else {
          // 纯 `\r` 进度刷新：提取可读进度短语后重置当前行缓冲，不刷入多行日志
          const candidate = extractCleanProgressCandidate(redactProviderLog(this.#partial));
          if (candidate) this.#progressLine = candidate;
          this.#partial = "";
        }
        continue;
      }
      if (ch === "\n") {
        this.#commitPartialLine();
        continue;
      }
      if (this.#partial.length < this.#maxPartialChars) {
        this.#partial += ch;
      }
    }
  }

  flush(): void {
    if (this.#partial !== "") {
      this.#commitPartialLine();
    }
  }

  get progressLine(): string | null {
    if (this.#partial.trim() !== "") {
      const live = extractCleanProgressCandidate(redactProviderLog(this.#partial));
      if (live) return live;
    }
    return this.#progressLine;
  }

  toString(): string {
    const list =
      this.#partial.trim() !== ""
        ? [...this.#lines, this.#clampLineToBudget(redactProviderLog(this.#partial))]
        : this.#lines;
    if (list.length === 0) return "";
    const sliced = list.slice(-this.#maxLines);
    let out = sliced.join("\n");
    while (Buffer.byteLength(out, "utf8") > this.#maxBytes && sliced.length > 1) {
      sliced.shift();
      out = sliced.join("\n");
    }
    if (Buffer.byteLength(out, "utf8") > this.#maxBytes) {
      const buf = Buffer.from(out, "utf8");
      out = buf.subarray(buf.byteLength - this.#maxBytes).toString("utf8");
    }
    return out;
  }

  lastNonEmptyLine(): string | null {
    for (let i = this.#lines.length - 1; i >= 0; i -= 1) {
      const trimmed = this.#lines[i]!.trim();
      if (trimmed !== "") return trimmed;
    }
    if (this.#partial.trim() !== "") {
      return redactProviderLog(this.#partial).trim();
    }
    return null;
  }

  #clampLineToBudget(redacted: string): string {
    if (Buffer.byteLength(redacted, "utf8") <= this.#maxBytes) return redacted;
    return Buffer.from(redacted, "utf8").subarray(0, this.#maxBytes).toString("utf8");
  }

  #commitPartialLine(): void {
    const rawLine = this.#partial;
    this.#partial = "";
    const redacted = this.#clampLineToBudget(redactProviderLog(rawLine));
    const candidate = extractCleanProgressCandidate(redacted);
    if (candidate) this.#progressLine = candidate;

    const bytes = Buffer.byteLength(redacted, "utf8") + 1;
    this.#lines.push(redacted);
    this.#lineBytes.push(bytes);
    this.#totalBytes += bytes;

    while (this.#lines.length > this.#maxLines || (this.#totalBytes > this.#maxBytes && this.#lines.length > 1)) {
      this.#lines.shift();
      const removed = this.#lineBytes.shift() ?? 0;
      this.#totalBytes = Math.max(0, this.#totalBytes - removed);
    }
  }
}
