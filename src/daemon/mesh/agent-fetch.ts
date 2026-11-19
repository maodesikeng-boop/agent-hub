// 经一个 http.Agent 发 HTTP 请求、回标准 Response：组网的 Agent（dialer.agentFor）上跑的是 TLS 里面的 HTTP/1.1，fetch（undici）用不了 http.Agent。
import { request as httpRequest, type Agent } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** 组网请求里的 Host：对方按 TLS 证书认人，不看 Host。 */
export const MESH_HTTP_HOST = "mesh.fusa";

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(headers ?? {}).entries());
}

/**
 * 后置：path 以 / 开头；回的 Response 体是流（大文件不落内存）；连不上、被 signal 叫停时 reject。
 * 101、204、205、304 和 HEAD 的响应体是 null。
 */
export function agentFetch(agent: Agent, path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      { agent, host: MESH_HTTP_HOST, path, method, headers: headerRecord(init.headers), ...(init.signal ? { signal: init.signal } : {}) },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        }
        if (status === 101 || status === 204 || status === 205 || status === 304 || method === "HEAD") {
          res.resume();
          resolve(new Response(null, { status, headers }));
        } else {
          resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
        }
      },
    );
    req.on("error", reject);
    const body = init.body;
    if (body === undefined || body === null) {
      req.end();
    } else if (typeof body === "string" || body instanceof Uint8Array) {
      req.end(body);
    } else if (body instanceof ReadableStream) {
      const stream = Readable.fromWeb(body as NodeReadableStream);
      stream.on("error", (error) => req.destroy(error));
      stream.pipe(req);
    } else {
      reject(new TypeError("agentFetch 只收字符串、字节或流作请求体"));
    }
  });
}
