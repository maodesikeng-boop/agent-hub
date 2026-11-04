import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchState, postMessage, postUpload } from "./client.ts";
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

describe("上传文件", () => {
  it("请求体是文件本身，文件名在 ?name=（编码过），声明 octet-stream，不是 JSON", async () => {
    const attachment = { id: "0123456789abcdef", name: "笔记 1.txt", path: "/d/u/0123456789abcdef/笔记 1.txt", size: 3, mime: "application/octet-stream" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(attachment), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["abc"], "笔记 1.txt", { type: "application/json" });
    expect(await postUpload(file, file.name)).toEqual(attachment);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/uploads?name=${encodeURIComponent("笔记 1.txt")}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream");
  });

  it("413：说的是上传的上限（20 MB），不是普通请求的 1 MB", async () => {
    stubFetch(new Response(JSON.stringify({ error: "文件太大，单个文件最多 20 MB" }), { status: 413 }));
    const err = await caught(postUpload(new File(["x"], "a.bin"), "a.bin"));
    expect(err.status).toBe(413);
    expect(errorText(err)).toBe("文件太大，单个文件最多 20 MB");
  });

  it("400 带中文原因：原样给用户；连不上：说连不上", async () => {
    stubFetch(new Response(JSON.stringify({ error: "文件是空的，没有内容可发", code: "invalid" }), { status: 400 }));
    expect(errorText(await caught(postUpload(new File(["x"], "a"), "a")))).toBe("文件是空的，没有内容可发");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await caught(postUpload(new File(["x"], "a"), "a"));
    expect(err.status).toBe(0);
    expect(errorText(err)).toBe("连不上守护进程");
  });
});
