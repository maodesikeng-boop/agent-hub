// 错误码表（docs/user-facing-errors-design.md 第 1、3 节）：表的内容约束、humanize 的四步、errorBody 的类型限制。
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  API_ERRORS,
  GENERIC_ERROR_TEXT,
  LOCAL_ERRORS,
  errorBody,
  humanize,
  type ApiErrorBody,
  type ApiErrorCode,
  type ErrorCode,
  type LocalErrorCode,
} from "./errors.ts";
import { HUB_ERROR_HTTP_STATUS } from "./hub.ts";
import { LEDGER_ERROR_HTTP_STATUS } from "./ledger.ts";

const HAS_CJK = /[\u4e00-\u9fff]/;
/** hint 只写跟连法无关的话（方案第 2 节）。 */
const CONNECTION_WORDS = /tailscale|127\.0\.0\.1|localhost|ssh|隧道|扫码|一次性链接/i;
/** 用户自己能动手解决的，必须带“怎么办”（方案第 2 节）。 */
const MUST_HAVE_HINT: readonly ErrorCode[] = [
  "forbidden_host",
  "peer_unauthorized",
  "device_offline",
  "network",
  "port_in_use",
  "bad_port",
  "git_failed",
  "internal",
];

const ALL_ENTRIES: [string, { text: string; hint?: string }][] = [...Object.entries(API_ERRORS), ...Object.entries(LOCAL_ERRORS)];

describe("错误码表", () => {
  it("接口错误码和本地错误码不重名", () => {
    for (const code of Object.keys(LOCAL_ERRORS)) expect(Object.keys(API_ERRORS)).not.toContain(code);
  });

  it("接口错误都有 HTTP 状态，本地错误没有", () => {
    for (const [code, entry] of Object.entries(API_ERRORS)) {
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.status, code).toBeLessThan(600);
    }
    for (const [code, entry] of Object.entries(LOCAL_ERRORS)) expect("status" in entry, code).toBe(false);
  });

  it.each(ALL_ENTRIES)("%s：text 含中文，hint（若有）含中文且不写连法", (code, entry) => {
    expect(entry.text, code).toMatch(HAS_CJK);
    if (entry.hint !== undefined) {
      expect(entry.hint, code).toMatch(HAS_CJK);
      expect(entry.hint, code).not.toMatch(CONNECTION_WORDS);
    }
    expect(entry.text, code).not.toMatch(CONNECTION_WORDS);
  });

  it("该带“怎么办”的码都有 hint", () => {
    const table: Record<string, { text: string; hint?: string }> = { ...API_ERRORS, ...LOCAL_ERRORS };
    for (const code of MUST_HAVE_HINT) expect(table[code]?.hint, code).toBeTruthy();
  });

  it("GENERIC_ERROR_TEXT 是中文", () => {
    expect(GENERIC_ERROR_TEXT).toMatch(HAS_CJK);
  });

  it("两张状态表从 API_ERRORS 派生，对外状态码不变", () => {
    expect(LEDGER_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409 });
    expect(HUB_ERROR_HTTP_STATUS).toEqual({ invalid: 400, not_found: 404, forbidden: 403, conflict: 409, unauthorized: 401, internal: 500 });
    for (const [code, status] of Object.entries({ ...LEDGER_ERROR_HTTP_STATUS, ...HUB_ERROR_HTTP_STATUS })) {
      expect(API_ERRORS[code as ApiErrorCode].status, code).toBe(status);
    }
  });

  it("码的类型", () => {
    expectTypeOf<"device_offline">().toExtend<ApiErrorCode>();
    expectTypeOf<"network">().toExtend<LocalErrorCode>();
    expectTypeOf<ApiErrorCode | LocalErrorCode>().toEqualTypeOf<ErrorCode>();
    expectTypeOf<ApiErrorBody>().toEqualTypeOf<{ code: ErrorCode; error: string }>();
  });
});

describe("errorBody", () => {
  it("没给原因就用表里的话", () => {
    expect(errorBody("forbidden_host")).toEqual({ code: "forbidden_host", error: API_ERRORS.forbidden_host.text });
  });

  it("给了原因就用原因（业务原因本来就是中文）", () => {
    expect(errorBody("conflict", "项目名 foo 已经有了")).toEqual({ code: "conflict", error: "项目名 foo 已经有了" });
  });

  it("只收接口错误码，不收本地错误码", () => {
    // 只做类型检查，不调用：这些写法编译不过。
    const _typeOnly = () => {
      // @ts-expect-error network 是本地错误，不可能被当成 HTTP 应答发出去
      errorBody("network");
      // @ts-expect-error 不在表里的码
      errorBody("internal_error");
      // @ts-expect-error 状态码不是错误码
      errorBody(404);
    };
    expect(_typeOnly).toBeTypeOf("function");
  });
});

describe("humanize：新服务端带 code", () => {
  it("code 在表里、error 是中文 → 用 error，hint 按 code 查", () => {
    const h = humanize({ code: "forbidden_host", error: "这个网址不能打开" }, 403);
    expect(h).toEqual({ code: "forbidden_host", text: "这个网址不能打开", hint: API_ERRORS.forbidden_host.hint, raw: "这个网址不能打开" });
  });

  it("code 在表里、error 不是中文 → 用表里的 text", () => {
    const h = humanize({ code: "not_found", error: "not_found" }, 404);
    expect(h).toMatchObject({ code: "not_found", text: API_ERRORS.not_found.text, hint: API_ERRORS.not_found.hint, raw: "not_found" });
  });

  it("本地错误码也认", () => {
    expect(humanize({ code: "network", error: "x" }, 0)).toMatchObject({ code: "network", text: LOCAL_ERRORS.network.text, hint: LOCAL_ERRORS.network.hint });
  });

  it("没有 hint 的码，结果里不带 hint", () => {
    const h = humanize({ code: "forbidden", error: "不是这个项目的项目经理" }, 403);
    expect(h.hint).toBeUndefined();
    expect("hint" in h).toBe(false);
  });

  it("code 不在表里 → 当没有 code，按下面几步走", () => {
    expect(humanize({ code: "weird", error: "这个事做不了" }, 400)).toMatchObject({ code: null, text: "这个事做不了" });
    expect(humanize({ code: "weird", error: "boom" }, 500)).toMatchObject({ code: null, text: "出错了（500）" });
  });

  it("code 是 Object 原型上的名字（toString、constructor）也不当成表里的码", () => {
    expect(humanize({ code: "toString", error: "boom" }, 500)).toMatchObject({ code: null, text: "出错了（500）" });
    expect(humanize({ error: "constructor" }, 500)).toMatchObject({ code: null, text: "出错了（500）" });
  });
});

describe("humanize：老服务端只有 error，是英文码", () => {
  it("not_found → 当 code 查表", () => {
    expect(humanize({ error: "not_found" }, 404)).toEqual({
      code: "not_found",
      text: API_ERRORS.not_found.text,
      hint: API_ERRORS.not_found.hint,
      raw: "not_found",
    });
  });

  it("internal_error → 当 internal", () => {
    expect(humanize({ error: "internal_error" }, 500)).toMatchObject({
      code: "internal",
      text: API_ERRORS.internal.text,
      hint: API_ERRORS.internal.hint,
      raw: "internal_error",
    });
  });

  it("forbidden_host、unauthorized 都认", () => {
    expect(humanize({ error: "forbidden_host" }, 403)).toMatchObject({ code: "forbidden_host", text: API_ERRORS.forbidden_host.text });
    expect(humanize({ error: "unauthorized" }, 401)).toMatchObject({ code: "unauthorized", text: API_ERRORS.unauthorized.text });
  });

  it("形如英文码但表里没有 → 出错了（状态码）", () => {
    expect(humanize({ error: "some_new_code" }, 418)).toEqual({ code: null, text: "出错了（418）", raw: "some_new_code" });
  });
});

describe("humanize：老服务端只有 error，是中文原因", () => {
  it("原样用，没有 code 也没有 hint", () => {
    expect(humanize({ error: "项目名 foo 已经有了" }, 409)).toEqual({ code: null, text: "项目名 foo 已经有了", raw: "项目名 foo 已经有了" });
  });

  it("中英混合（含中文）也原样用", () => {
    expect(humanize({ error: "git 没跑成：fatal: not a git repository" }, 409)).toMatchObject({ code: null, text: "git 没跑成：fatal: not a git repository" });
  });
});

describe("humanize：其余输入", () => {
  it("英文原文 → 出错了（状态码），原文放 raw", () => {
    expect(humanize({ error: "body must be a JSON object" }, 400)).toEqual({ code: null, text: "出错了（400）", raw: "body must be a JSON object" });
    expect(humanize({ message: "Unexpected token" }, 400)).toMatchObject({ code: null, text: "出错了（400）" });
  });

  it("非 JSON（字符串）→ 出错了（状态码），字符串放 raw", () => {
    expect(humanize("<html>Bad Gateway</html>", 502)).toEqual({ code: null, text: "出错了（502）", raw: "<html>Bad Gateway</html>" });
  });

  it("空体、null、undefined、数组、数字 → 出错了（状态码）", () => {
    for (const body of ["", null, undefined, [], {}, 42, true]) {
      expect(humanize(body, 500), String(body)).toMatchObject({ code: null, text: "出错了（500）" });
    }
    expect(humanize(undefined, 500).raw).toBe("");
    expect(humanize({}, 500).raw).toBe("");
  });

  it("error 不是字符串 → 当没有", () => {
    expect(humanize({ error: { a: 1 } }, 500)).toMatchObject({ code: null, text: "出错了（500）", raw: "" });
    expect(humanize({ code: "not_found", error: 7 }, 404)).toMatchObject({ code: "not_found", text: API_ERRORS.not_found.text, raw: "" });
  });
});
