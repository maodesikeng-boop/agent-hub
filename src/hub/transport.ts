import { request, type ClientRequest } from "node:http";
import type { Readable } from "node:stream";
import { HUB_MAX_BODY_BYTES } from "../shared/limits.ts";
import { UsageError } from "./args.ts";

export const TIMEOUT_REASON = "超时";

export function readAllStdin(stream: Readable, idleMs: number): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: { text: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData).off("end", onEnd).off("error", onError);
      if (result instanceof Error) {
        stream.destroy();
        fail(result);
      } else {
        done(result.text);
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new UsageError("标准输入一直没有结束，记得把正文从标准输入喂给 --stdin：bash、zsh 用 heredoc（<<'EOF' … EOF），PowerShell 用单引号 here-string（@'…'@）管道传入")), idleMs);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buf.length;
      if (size > HUB_MAX_BODY_BYTES) return finish(new UsageError(`标准输入太长，不能超过 ${HUB_MAX_BODY_BYTES} 字节`));
      chunks.push(buf);
      arm();
    };
    const onEnd = () => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return finish(new UsageError("标准输入不是合法的 UTF-8"));
      }
      if (text.endsWith("\r\n")) text = text.slice(0, -2);
      else if (text.endsWith("\n")) text = text.slice(0, -1);
      finish({ text });
    };
    const onError = (err: Error) => finish(new UsageError(`读标准输入出错：${err.message}`));
    stream.on("data", onData).on("end", onEnd).on("error", onError);
    arm();
  });
}

type Outcome =
  | { kind: "response"; status: number; body: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "no-answer"; reason: string }
  | { kind: "not-sent"; reason: string };

export function parseLoopbackTcpEndpoint(endpoint: string): { host: "127.0.0.1"; port: number } | null {
  const m = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host: "127.0.0.1", port } : null;
}

export type HubEndpointTarget =
  | { kind: "tcp"; host: "127.0.0.1"; port: number }
  | { kind: "socket"; socketPath: string };

// Only loopback TCP, local named pipes and local Unix sockets: a remote host or SMB pipe would leak the bearer token (and NTLM credentials).
export function parseHubEndpoint(raw: string): HubEndpointTarget | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.includes("\0")) return null;
  const tcp = parseLoopbackTcpEndpoint(trimmed);
  if (tcp) return { kind: "tcp", host: tcp.host, port: tcp.port };
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isWindowsDrivePath && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    return /^\\\\\.\\pipe\\[^\\/\0]+$/.test(trimmed) ? { kind: "socket", socketPath: trimmed } : null;
  }
  return { kind: "socket", socketPath: trimmed };
}

export function post(target: HubEndpointTarget, path: string, token: string, payload: string, timeoutMs: number): Promise<Outcome> {
  return new Promise((done) => {
    let settled = false;
    let sent = false;
    const finish = (outcome: Outcome) => {
      if (!settled) {
        settled = true;
        done(outcome);
      }
    };
    const lost = (reason: string): Outcome => (sent ? { kind: "no-answer", reason } : { kind: "unreachable", reason });
    const options = {
      ...(target.kind === "tcp" ? { host: target.host, port: target.port } : { socketPath: target.socketPath }),
      method: "POST",
      path,
      timeout: timeoutMs,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload, "utf8"),
      },
    };
    let req: ClientRequest;
    try {
      req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => finish({ kind: "response", status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => finish({ kind: "no-answer", reason: err.message }));
      });
    } catch (err) {
      finish({ kind: "not-sent", reason: (err as Error).message });
      return;
    }
    // Once the request is fully flushed the daemon may already have executed it.
    req.on("finish", () => (sent = true));
    req.on("timeout", () => {
      finish(lost(TIMEOUT_REASON));
      req.destroy();
    });
    req.on("error", (err: NodeJS.ErrnoException) => finish(lost(err.code ?? err.message)));
    req.end(payload);
  });
}
