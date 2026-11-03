import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchState, postMessage } from "./client.ts";
import { errorText } from "./format.ts";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(res: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("请求体超过 1 MB：服务端回 413，响应里没有 code", () => {
  it("{ error } 没有 code：按通用错误处理，用户看到中文提示，不是 undefined", async () => {
    stubFetch(new Response(JSON.stringify({ error: "Request body is too large" }), { status: 413, headers: { "content-type": "application/json" } }));
    const err = await caught(postMessage(1, { clientId: "c", text: "x" }));
    expect(err.status).toBe(413);
    expect(errorText(err)).toBe("内容太大，发不出去（最多 1 MB）");
  });

  it("响应体是空的、状态文字也是空的：不显示空白或 undefined", async () => {
    stubFetch(new Response(null, { status: 413 }));
    expect(errorText(await caught(fetchState()))).toBe("内容太大，发不出去（最多 1 MB）");
  });

  it("别的状态码响应体里没有可用的 error：用“请求失败（状态码）”，不显示 undefined", async () => {
    for (const body of ["{}", '{"error":null}', '{"error":{"a":1}}', "<html>bad gateway</html>"]) {
      stubFetch(new Response(body, { status: 502 }));
      const text = errorText(await caught(fetchState()));
      expect(text).toBe("请求失败（502）");
    }
  });

  it("别的状态码有 error：原样显示服务端的原因", async () => {
    stubFetch(new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 }));
    expect(errorText(await caught(fetchState()))).toBe("conversation not found");
  });
});
