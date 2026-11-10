import { afterEach, describe, expect, it, vi } from "vitest";
import { API_REQUEST_TIMEOUT_MS, SLOW_API_REQUEST_TIMEOUT_MS, WS_CHECK_SILENCE_MS } from "../shared/index.ts";
import { ApiError, createClient, fetchState, onUnauthorized, postMessage, postUpload } from "./client.ts";
import { openChangeStream } from "./connection.ts";
import { errorText } from "./format.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeSnapshot, stubRequestTimeouts } from "./test-utils.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("接口出错：四种应答分别显示成什么（docs/user-facing-errors-design.md 第 3 节）", () => {
  it("老服务端 { error: 英文码 }：按码查表，中文 + 怎么办，英文码只留在 raw", async () => {
    stubFetch(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const err = await caught(fetchState());
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(errorText(err)).toEqual({ text: "要找的东西不在了", hint: "刷新页面再试", raw: "not_found" });
  });

  it("新服务端 { code, error }：error 是中文就原样用，hint 按 code 查表", async () => {
    stubFetch(new Response(JSON.stringify({ code: "device_offline", error: "“书房的 Mac”连不上" }), { status: 502 }));
    const err = await caught(fetchState());
    expect(err.code).toBe("device_offline");
    expect(err.hint).toBe("看那台设备开没开机、联没联网");
    expect(errorText(err)).toEqual({ text: "“书房的 Mac”连不上", hint: "看那台设备开没开机、联没联网", raw: "“书房的 Mac”连不上" });
  });

  it("fetch 本身抛错（Failed to fetch）：一律当 network，英文原文只留在 raw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await caught(fetchState());
    expect(err.status).toBe(0);
    expect(err.code).toBe("network");
    expect(errorText(err)).toEqual({ text: "连不上守护进程", hint: "看守护进程有没有在跑", raw: "Failed to fetch" });
  });

  it("应答不是 JSON（网关页面、空体）：出错了（状态码），页面原文进 raw", async () => {
    stubFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(errorText(await caught(fetchState()))).toEqual({ text: "出错了（502）", raw: "<html>bad gateway</html>" });
    stubFetch(new Response(null, { status: 500 }));
    expect(errorText(await caught(fetchState()))).toEqual({ text: "出错了（500）", raw: "" });
  });

  it("老服务端的英文原文（没有码）：不显示英文，出错了（状态码）", async () => {
    stubFetch(new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 }));
    expect(errorText(await caught(fetchState()))).toEqual({ text: "出错了（404）", raw: "conversation not found" });
  });

  it("没登录（401）：通知登录界面，错误本身还是抛出去", async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    stubFetch(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    expect((await caught(postMessage(1, { clientId: "c", text: "x" }))).status).toBe(401);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    stubFetch(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await caught(fetchState());
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("设备没配对（401 peer_unauthorized）不是网页登录过期：照常显示，不切登录界面", async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    stubFetch(new Response(JSON.stringify({ code: "peer_unauthorized", error: "这台设备没有配对或已被移除" }), { status: 401 }));
    expect(errorText(await caught(fetchState())).hint).toBe("到设备页重新配对");
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

describe("请求体超过 1 MB：Fastify 回 413，响应里没有表里的 code", () => {
  it("Fastify 的英文原文：用户看到“内容太大”，原文进 raw", async () => {
    stubFetch(new Response(JSON.stringify({ error: "Request body is too large" }), { status: 413, headers: { "content-type": "application/json" } }));
    const err = await caught(postMessage(1, { clientId: "c", text: "x" }));
    expect(err.status).toBe(413);
    expect(errorText(err)).toEqual({ text: "内容太大，发不出去（最多 1 MB）", raw: "Request body is too large" });
  });

  it("响应体是空的：照样是“内容太大”，不显示空白或 undefined", async () => {
    stubFetch(new Response(null, { status: 413 }));
    expect(errorText(await caught(fetchState())).text).toBe("内容太大，发不出去（最多 1 MB）");
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
    expect(errorText(err).text).toBe("文件太大，单个文件最多 20 MB");
  });

  it("400 带中文原因：原样给用户；连不上：说连不上", async () => {
    stubFetch(new Response(JSON.stringify({ error: "文件是空的，没有内容可发", code: "invalid" }), { status: 400 }));
    expect(errorText(await caught(postUpload(new File(["x"], "a"), "a"))).text).toBe("文件是空的，没有内容可发");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await caught(postUpload(new File(["x"], "a"), "a"));
    expect(err.status).toBe(0);
    expect(errorText(err).text).toBe("连不上守护进程");
  });
});

describe("请求超时（连接静默断了，请求挂在死连接上）", () => {
  /** 资料页的性格设定一直不回。 */
  function hangingApi(): FakeApi {
    const api = new FakeApi(makeSnapshot());
    api.getPersona = () => new Promise(() => {});
    api.install();
    return api;
  }

  it("普通请求：API_REQUEST_TIMEOUT_MS 没回就报“请求超时”（status 0），不一直挂着", async () => {
    vi.useFakeTimers();
    stubRequestTimeouts();
    hangingApi();
    const pending = caught(createClient(null).fetchPersona(1));
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    const err = await pending;
    expect(err.status).toBe(0);
    expect(err.code).toBe("timeout");
    expect(errorText(err).text).toBe("请求超时");
  });

  it("超时顺便查一次实时连接：超过一次心跳加余量没消息就马上重连，不等判死", async () => {
    vi.useFakeTimers();
    stubRequestTimeouts();
    hangingApi();
    installFakeWebSocket();
    const close = openChangeStream({ url: (s) => `ws://x/api/ws?since=${s}`, getSince: () => 0, onMessage: () => {}, onStatus: () => {} });
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(WS_CHECK_SILENCE_MS - API_REQUEST_TIMEOUT_MS + 1);
    const pending = caught(createClient(null).fetchPersona(1));
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await pending;
    expect(FakeWebSocket.instances).toHaveLength(2);
    close();
  });

  it("快照、额度、模型名单用长一点的超时；上传、选文件夹、下载文件不设超时", async () => {
    const timeouts = stubRequestTimeouts();
    const api = new FakeApi(makeSnapshot());
    api.install();
    const client = createClient(null);
    await client.fetchPersona(1);
    expect(timeouts.delays).toEqual([API_REQUEST_TIMEOUT_MS]);
    await client.fetchState();
    await client.fetchQuota().catch(() => {});
    await client.fetchModels().catch(() => {});
    expect(timeouts.delays.slice(1)).toEqual([SLOW_API_REQUEST_TIMEOUT_MS, SLOW_API_REQUEST_TIMEOUT_MS, SLOW_API_REQUEST_TIMEOUT_MS]);
    await client.postUpload(new File(["x"], "a.txt"), "a.txt");
    await client.postPickFolder({});
    expect(timeouts.delays).toHaveLength(4);
    for (const [, init] of api.fetch.mock.calls.slice(-2)) expect(init?.signal).toBeUndefined();
  });
});
