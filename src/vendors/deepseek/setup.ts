// DeepSeek (dsh) 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 2.1、2.2.3 节）：
// - 全平台通过守护进程/随包 Node 24 受管 npm 安装 `@deepseek-ai/dsh@0.2.2-rc.1`（免 sudo / 免管理员）；
// - 严格遵守 `@deepseek-ai/dsh-credentials-local` v1 schema 与 POSIX `0600` 强校验读写 `$DSH_HOME/.credentials.yaml`；
// - 同时支持 API Key（写入 `refs.DEEPSEEK_API_KEY`，高于 `<cwd>/.env` 优先级）与原厂 PKCE 账号网页登录（本机回调 & 远端粘贴回环 URL）。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { arch, platform as osPlatform, release as osRelease } from "node:os";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ProviderAuthMethodDescriptor } from "../../shared/index.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { readBoundedTextFile, writePrivateFileAtomic } from "../_common/setup/file-helpers.ts";
import { hasDeepSeekLocalCredentials } from "./catalog.ts";
import { resolveDeepSeekHome } from "./paths.ts";

export const DEEPSEEK_PINNED_NPM_SPEC = "@deepseek-ai/dsh@0.2.2-rc.1";
const DEFAULT_DEEPSEEK_PLATFORM_ORIGIN = "https://platform.deepseek.com";
const ACCOUNT_RECORD_KEY = "deepseek-account-platform/default";
const DEVICE_RECORD_KEY = "deepseek-account-platform/device";

const DEEPSEEK_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  {
    id: "api_key",
    kind: "api_key",
    label: "API key",
    placeholder: "sk-...",
  },
  {
    id: "browser",
    kind: "browser_oauth",
    label: "DeepSeek Account",
    manualInput: "callback_url",
  },
];

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

export interface DeepSeekCredentialsDoc {
  refs: Record<string, string>;
  records: Record<string, Record<string, unknown>>;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  return trimmed;
}

function parseYamlScalarValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  return unquoteYamlScalar(trimmed);
}

/** 解析已有 `$DSH_HOME/.credentials.yaml`（兼容 v1 标准缩进 YAML、JSON 子集与 pre-release 平铺格式）。 */
export function parseDeepSeekCredentialsYaml(rawText: string | null): DeepSeekCredentialsDoc {
  const empty: DeepSeekCredentialsDoc = { refs: {}, records: {} };
  if (rawText === null || rawText.trim() === "") return empty;

  const trimmedWhole = rawText.trim();
  if (trimmedWhole.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmedWhole) as Record<string, unknown>;
      const refs: Record<string, string> = {};
      const records: Record<string, Record<string, unknown>> = {};
      if (typeof obj.refs === "object" && obj.refs !== null && !Array.isArray(obj.refs)) {
        for (const [k, v] of Object.entries(obj.refs as Record<string, unknown>)) {
          if (typeof v === "string" && v !== "") refs[k] = v;
        }
      }
      if (typeof obj.records === "object" && obj.records !== null && !Array.isArray(obj.records)) {
        for (const [k, v] of Object.entries(obj.records as Record<string, unknown>)) {
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            records[k] = v as Record<string, unknown>;
          }
        }
      }
      return { refs, records };
    } catch {
      // fall through to YAML line parser
    }
  }

  const refs: Record<string, string> = {};
  const records: Record<string, Record<string, unknown>> = {};
  let topSection: "refs" | "records" | "other" | null = null;
  let currentRecordKey: string | null = null;
  let currentRecordSubMap: string | null = null;

  for (const rawLine of rawText.split(/\r?\n/u)) {
    const withoutComment = rawLine.replace(/(^|\s)#.*$/u, "");
    if (withoutComment.trim() === "" || withoutComment.trim() === "---" || withoutComment.trim() === "...") {
      continue;
    }
    const indent = /^ */u.exec(withoutComment)![0].length;
    const line = withoutComment.trim();
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = unquoteYamlScalar(line.slice(0, colonIdx));
    const rest = line.slice(colonIdx + 1).trim();

    if (indent === 0) {
      currentRecordKey = null;
      currentRecordSubMap = null;
      if (key === "version") {
        topSection = "other";
      } else if (key === "refs" && rest === "") {
        topSection = "refs";
      } else if (key === "records" && rest === "") {
        topSection = "records";
      } else if (rest !== "" && /^[A-Z_][A-Z0-9_]*$/u.test(key)) {
        // 兼容 pre-release 平铺格式迁移进 v1 refs
        const val = unquoteYamlScalar(rest);
        if (val !== "") refs[key] = val;
        topSection = null;
      } else {
        topSection = "other";
      }
      continue;
    }

    if (topSection === "refs" && indent === 2 && rest !== "") {
      const val = unquoteYamlScalar(rest);
      if (val !== "") refs[key] = val;
      continue;
    }

    if (topSection === "records") {
      if (indent === 2 && rest === "") {
        currentRecordKey = key;
        currentRecordSubMap = null;
        records[currentRecordKey] ??= {};
      } else if (indent === 4 && currentRecordKey !== null) {
        if (rest === "") {
          currentRecordSubMap = key;
          records[currentRecordKey]![key] = {};
        } else {
          currentRecordSubMap = null;
          records[currentRecordKey]![key] = parseYamlScalarValue(rest);
        }
      } else if (indent === 6 && currentRecordKey !== null && currentRecordSubMap !== null) {
        const sub = records[currentRecordKey]![currentRecordSubMap];
        if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
          (sub as Record<string, unknown>)[key] = parseYamlScalarValue(rest);
        }
      }
    }
  }

  return { refs, records };
}

function serializeYamlScalar(val: unknown): string {
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (val === null) return "null";
  return JSON.stringify(String(val));
}

function serializeYamlMapping(obj: Record<string, unknown>, indentSpaces: number): string[] {
  const pad = " ".repeat(indentSpaces);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const safeKey = /^[A-Za-z0-9_./-]+$/u.test(k) ? k : JSON.stringify(k);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${pad}${safeKey}: {}`);
      } else {
        lines.push(`${pad}${safeKey}:`);
        lines.push(...serializeYamlMapping(v as Record<string, unknown>, indentSpaces + 2));
      }
    } else {
      lines.push(`${pad}${safeKey}: ${serializeYamlScalar(v)}`);
    }
  }
  return lines;
}

/** 序列化为 `@deepseek-ai/dsh-credentials-local` 严格要求的 `version: 1` YAML 文档（非空标量，零空字符串）。 */
export function serializeDeepSeekCredentialsYaml(doc: DeepSeekCredentialsDoc): string {
  const validRefs: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.refs)) {
    if (typeof v === "string" && v.trim() !== "") {
      validRefs[k] = v.trim();
    }
  }
  const validRecords = Object.entries(doc.records).filter(([, v]) => Object.keys(v).length > 0);
  const lines = ["version: 1"];
  if (Object.keys(validRefs).length > 0) {
    lines.push("refs:");
    for (const [k, v] of Object.entries(validRefs)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (validRecords.length > 0) {
    lines.push("records:");
    for (const [recKey, recVal] of validRecords) {
      const safeRecKey = /^[A-Za-z0-9_./-]+$/u.test(recKey) ? recKey : JSON.stringify(recKey);
      lines.push(`  ${safeRecKey}:`);
      lines.push(...serializeYamlMapping(recVal, 4));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function resolveDeepSeekCredentialsPath(ctx: Pick<VendorSetupContext, "userHome" | "env">): string {
  const dshHome = resolveDeepSeekHome(ctx.userHome, ctx.env());
  return joinByStyle(dshHome, ".credentials.yaml");
}

function resolvePlatformOrigin(env: Record<string, string | undefined>): string {
  const raw = env.DSH_PLATFORM_ORIGIN?.trim() || DEFAULT_DEEPSEEK_PLATFORM_ORIGIN;
  const parsed = new URL(raw);
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("DeepSeek platform origin must use HTTPS");
  }
  return parsed.origin;
}

async function postDeepSeekPlatformJson(
  origin: string,
  endpoint: "auth_init" | "auth_exchange" | "auth_cancel",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin}/auth-api/v0/dsh/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  if (!res.ok) {
    throw new Error(`DeepSeek platform ${endpoint} failed (HTTP ${res.status})`);
  }
  const json = (await res.json()) as {
    code?: unknown;
    data?: { biz_code?: unknown; biz_data?: unknown };
  };
  if (json.code !== 0 || json.data?.biz_code !== 0 || typeof json.data.biz_data !== "object" || json.data.biz_data === null) {
    throw new Error(`DeepSeek platform ${endpoint} returned error response`);
  }
  return json.data.biz_data as Record<string, unknown>;
}

function cleanDotEnvApiKey(dotEnvPath: string, platform: string): void {
  if (!existsSync(dotEnvPath)) return;
  const raw = readBoundedTextFile(dotEnvPath);
  if (raw === null) return;
  const kept = raw
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/u.test(line));
  const next = kept.join("\n").trim();
  writePrivateFileAtomic(dotEnvPath, next === "" ? "" : `${next}\n`, platform);
}

export const deepseekSetupAdapter: VendorSetupAdapter = {
  installRecipe() {
    return { kind: "npm", packageSpec: DEEPSEEK_PINNED_NPM_SPEC };
  },

  updateRecipe() {
    return { kind: "reinstall" };
  },

  async inspectAuth(ctx) {
    const credPath = resolveDeepSeekCredentialsPath(ctx);
    const doc = parseDeepSeekCredentialsYaml(readBoundedTextFile(credPath));
    if (typeof doc.refs.DEEPSEEK_API_KEY === "string" && doc.refs.DEEPSEEK_API_KEY.trim() !== "") {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: DEEPSEEK_AUTH_METHODS,
      };
    }
    if (doc.records[ACCOUNT_RECORD_KEY]?.kind === "grant") {
      return {
        accountSummary: "Signed in",
        canSignOut: true,
        methods: DEEPSEEK_AUTH_METHODS,
      };
    }
    const mergedEnv = { ...ctx.env(), HOME: ctx.userHome };
    if (hasDeepSeekLocalCredentials(mergedEnv)) {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: DEEPSEEK_AUTH_METHODS,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods: DEEPSEEK_AUTH_METHODS,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId !== "browser") {
      throw new Error(`Unsupported DeepSeek sign-in method: ${input.methodId}`);
    }
    const origin = resolvePlatformOrigin(ctx.env());
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    let receivedCodeResolve: ((code: string) => void) | null = null;
    let receivedCodeReject: ((err: Error) => void) | null = null;
    const codePromise = new Promise<string>((resolve, reject) => {
      receivedCodeResolve = resolve;
      receivedCodeReject = reject;
    });

    let server: Server | null = null;
    let authorizeId: string | null = null;

    const closeServer = () =>
      new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        const s = server;
        server = null;
        s.close(() => resolve());
      });

    const onAbort = () => {
      receivedCodeReject?.(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      server = createServer((req, res) => {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        } catch {
          res.writeHead(400, { "cache-control": "no-store" }).end();
          return;
        }
        const code = parsedUrl.searchParams.get("code") ?? "";
        const givenState = parsedUrl.searchParams.get("state") ?? "";
        const validState =
          Buffer.byteLength(givenState) === Buffer.byteLength(state) &&
          timingSafeEqual(Buffer.from(givenState), Buffer.from(state));
        if (
          req.method !== "GET" ||
          parsedUrl.pathname !== "/oauth/callback" ||
          !validState ||
          !code ||
          parsedUrl.searchParams.getAll("code").length !== 1 ||
          parsedUrl.searchParams.getAll("state").length !== 1
        ) {
          res.writeHead(400, { "cache-control": "no-store" }).end();
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end("<!doctype html><meta charset='utf-8'><title>Signed in</title><p>Sign-in completed. You may return to Fusa.</p>");
        receivedCodeResolve?.(code);
      });

      const port = await new Promise<number>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          const addr = server!.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("Failed to bind local OAuth callback port"));
        });
      });

      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      const initData = await postDeepSeekPlatformJson(
        origin,
        "auth_init",
        {
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          redirect_uri: redirectUri,
          locale: "en_US",
          login_source: "cli",
        },
        signal,
      );
      const rawAuthorizeUrl = typeof initData.authorize_url === "string" ? initData.authorize_url : "";
      authorizeId = typeof initData.authorize_id === "string" ? initData.authorize_id : null;
      const parsedAuth = new URL(rawAuthorizeUrl);
      if (parsedAuth.origin !== origin || parsedAuth.username !== "" || parsedAuth.password !== "") {
        throw new Error("DeepSeek platform returned untrusted authorize_url");
      }
      // 确保 authorizeUrl 带上 redirect_uri 与 state 查询参数（若服务端仅按 authorize_id 关联），以便远端无头 6 重防 SSRF 校验契约完整可用
      if (!parsedAuth.searchParams.has("redirect_uri")) {
        parsedAuth.searchParams.set("redirect_uri", redirectUri);
      }
      if (!parsedAuth.searchParams.has("state")) {
        parsedAuth.searchParams.set("state", state);
      }
      hooks.onAuthorizeUrl(parsedAuth.href);

      const authCode = await codePromise;
      signal.throwIfAborted();

      const credPath = resolveDeepSeekCredentialsPath(ctx);
      const currentDoc = parseDeepSeekCredentialsYaml(readBoundedTextFile(credPath));
      const existingDevice = currentDoc.records[DEVICE_RECORD_KEY]?.payload as { id?: unknown } | undefined;
      const deviceId =
        typeof existingDevice?.id === "string" && existingDevice.id.trim() !== ""
          ? existingDevice.id
          : randomUUID();

      const exchangeData = await postDeepSeekPlatformJson(
        origin,
        "auth_exchange",
        {
          code: authCode,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          device_id: deviceId,
          device_model: `${osPlatform()}-${arch()}`,
          os_version: `${osPlatform()} ${osRelease()}`,
        },
        signal,
      );
      const token = typeof exchangeData.token === "string" ? exchangeData.token.trim() : "";
      if (!token) {
        throw new Error("DeepSeek auth_exchange returned empty token");
      }

      const nextDoc: DeepSeekCredentialsDoc = {
        refs: { ...currentDoc.refs },
        records: {
          ...currentDoc.records,
          [DEVICE_RECORD_KEY]: {
            kind: "grant",
            payload: { id: deviceId },
          },
          [ACCOUNT_RECORD_KEY]: {
            kind: "grant",
            payload: {
              version: 1,
              token,
              issuer: origin,
            },
          },
        },
      };
      writePrivateFileAtomic(credPath, serializeDeepSeekCredentialsYaml(nextDoc), ctx.platform);
    } catch (err) {
      if (signal.aborted && authorizeId) {
        void postDeepSeekPlatformJson(
          origin,
          "auth_cancel",
          { authorize_id: authorizeId, code_verifier: verifier },
          AbortSignal.timeout(3_000),
        ).catch(() => undefined);
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
      await closeServer();
    }
  },

  async saveApiKey(ctx, { apiKey }) {
    const credPath = resolveDeepSeekCredentialsPath(ctx);
    const doc = parseDeepSeekCredentialsYaml(readBoundedTextFile(credPath));
    doc.refs.DEEPSEEK_API_KEY = apiKey.trim();
    writePrivateFileAtomic(credPath, serializeDeepSeekCredentialsYaml(doc), ctx.platform);
  },

  async signOut(ctx) {
    const credPath = resolveDeepSeekCredentialsPath(ctx);
    if (existsSync(credPath)) {
      const doc = parseDeepSeekCredentialsYaml(readBoundedTextFile(credPath));
      delete doc.refs.DEEPSEEK_API_KEY;
      delete doc.records[ACCOUNT_RECORD_KEY];
      delete doc.records[DEVICE_RECORD_KEY];
      writePrivateFileAtomic(credPath, serializeDeepSeekCredentialsYaml(doc), ctx.platform);
    }
    const dshHome = resolveDeepSeekHome(ctx.userHome, ctx.env());
    cleanDotEnvApiKey(joinByStyle(dshHome, ".env"), ctx.platform);
  },
};
