import { describe, expect, it } from "vitest";
import { FETCHED_QUOTA_FRESH_MS, VENDOR_SPECS, type QuotaResponse } from "../../shared/index.ts";
import { createFetchedQuota, parseFetchedQuota, queryFetchedQuota } from "./fetched-quota.ts";

const spec = VENDOR_SPECS.agy.quota!.fetched!;

/** 本机 `agy -p "/usage"` 的实际输出（2026-11-07）。 */
const REAL = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-14T09:11:26Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-07T14:11:26Z",
  "Claude and GPT models\tWeekly Limit Remaining\t40%\t2026-11-13T03:14:53Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-11-07T18:23:21Z",
  "",
].join("\n");

describe("parseFetchedQuota", () => {
  it("两组各两个窗口：剩余 → 已用（0 到 1），重置时间 → Unix 秒", () => {
    expect(parseFetchedQuota(REAL, spec)).toEqual({
      groups: [
        {
          id: "gemini",
          name: "Gemini",
          windows: {
            seven_day: { utilization: 0, resetsAt: Date.parse("2026-11-14T09:11:26Z") / 1000, status: "allowed" },
            five_hour: { utilization: 0, resetsAt: Date.parse("2026-11-07T14:11:26Z") / 1000, status: "allowed" },
          },
        },
        {
          id: "claude_gpt",
          name: "Claude 和 GPT",
          windows: {
            seven_day: { utilization: 0.6, resetsAt: Date.parse("2026-11-13T03:14:53Z") / 1000, status: "allowed" },
            five_hour: { utilization: 0.25, resetsAt: Date.parse("2026-11-07T18:23:21Z") / 1000, status: "allowed" },
          },
        },
      ],
    });
  });

  it("不认识的组、窗口、坏行跳过；一个窗口都没有的组不返回；整段不认识是空", () => {
    const text = ["Other\tWeekly Limit Remaining\t10%\t2026-11-14T09:11:26Z", "Gemini Models\tMonthly\t10%\tx", "Gemini Models\tFive Hour Limit Remaining\tabc\tx", "垃圾"].join("\n");
    expect(parseFetchedQuota(text, spec)).toEqual({ groups: [] });
    expect(parseFetchedQuota("", spec)).toEqual({ groups: [] });
  });

  it("重置时间读不出来也留着窗口（resetsAt 0）；百分比夹在 0 到 100", () => {
    const text = "Gemini Models\tFive Hour Limit Remaining\t120%\tsoon";
    expect(parseFetchedQuota(text, spec).groups[0]!.windows.five_hour).toEqual({ utilization: 0, resetsAt: 0, status: "allowed" });
  });
});

describe("createFetchedQuota（缓存）", () => {
  const sample: QuotaResponse = { groups: [{ id: "gemini", name: "Gemini", windows: {} }] };

  function setup(results: Array<QuotaResponse | Error>) {
    let time = 1_000;
    let calls = 0;
    const quota = createFetchedQuota({
      query: async () => {
        const r = results[Math.min(calls++, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
      now: () => time,
    });
    return { quota, calls: () => calls, advance: (ms: number) => (time += ms) };
  }

  it("5 分钟内再要用缓存，不再问；过了再问一次", async () => {
    const t = setup([sample]);
    expect(await t.quota.get()).toEqual(sample);
    t.advance(FETCHED_QUOTA_FRESH_MS - 1);
    await t.quota.get();
    expect(t.calls()).toBe(1);
    t.advance(1);
    await t.quota.get();
    expect(t.calls()).toBe(2);
  });

  it("同时来的几次只问一次", async () => {
    const t = setup([sample]);
    await Promise.all([t.quota.get(), t.quota.get(), t.quota.get()]);
    expect(t.calls()).toBe(1);
  });

  it("查失败：回空（不显示那一块），不抛；同样缓存 5 分钟", async () => {
    const t = setup([new Error("没装")]);
    expect(await t.quota.get()).toEqual({ groups: [] });
    await t.quota.get();
    expect(t.calls()).toBe(1);
  });

  it("没配查询（没装 agy）：回空", async () => {
    expect(await createFetchedQuota({ query: undefined }).get()).toEqual({ groups: [] });
  });
});

describe("queryFetchedQuota", () => {
  it("程序不存在：报错（上面当失败处理）", async () => {
    await expect(queryFetchedQuota({ path: "/nonexistent/agy", spec, cwd: "/tmp" })).rejects.toThrow();
  });
});
