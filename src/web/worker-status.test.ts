import { describe, expect, it } from "vitest";
import type { WorkerMessageMeta } from "../shared/index.ts";
import { workerStatusOf } from "./worker-status.ts";

const line = (over: Partial<WorkerMessageMeta>): WorkerMessageMeta => ({
  workerId: 3,
  workerConversationId: 30,
  title: "修 X",
  readonly: false,
  event: "report",
  status: null,
  summary: null,
  ...over,
});

describe("workerStatusOf", () => {
  it("done 偏绿、problem 偏黄、gave_up 偏红，使用英文 UI 标签", () => {
    expect(workerStatusOf(line({ status: "done" }))).toEqual({ tone: "success", label: "Done" });
    expect(workerStatusOf(line({ status: "problem" }))).toEqual({ tone: "warn", label: "Problem" });
    expect(workerStatusOf(line({ status: "gave_up" }))).toEqual({ tone: "danger", label: "Gave up" });
  });

  it("这一轮出错、建 worktree 失败偏红，不看 status", () => {
    expect(workerStatusOf(line({ event: "turn_failed" }))).toEqual({ tone: "danger", label: "Error" });
    expect(workerStatusOf(line({ event: "worktree_failed", status: "done" }))).toEqual({ tone: "danger", label: "Error" });
  });

  it("没按格式、没有状态（老数据）是中性灰，没有说法", () => {
    expect(workerStatusOf(line({ status: "unformatted" }))).toEqual({ tone: "neutral", label: null });
    expect(workerStatusOf(line({ status: undefined }))).toEqual({ tone: "neutral", label: null });
  });
});
