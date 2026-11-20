// Mesh connections run HTTP/1.1 inside TLS on an http.Agent, which fetch (undici) cannot use.
import { request as httpRequest, type Agent } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** Peers authenticate by TLS certificate and ignore Host. */
export const MESH_HTTP_HOST = "mesh.fusa";

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(headers ?? {}).entries());
}

export function agentFetch(agent: Agent, path: string, init: Omit<RequestInit, "body"> & { body?: RequestInit["body"] | Readable } = {}): Promise<Response> {
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
    } else if (body instanceof Readable) {
      body.on("error", (error) => req.destroy(error));
      body.pipe(req);
    } else if (body instanceof ReadableStream) {
      const stream = Readable.fromWeb(body as NodeReadableStream);
      stream.on("error", (error) => req.destroy(error));
      stream.pipe(req);
    } else {
      reject(new TypeError("agentFetch 只收字符串、字节或流作请求体"));
    }
  });
}
