import { afterEach, beforeEach, expect, it } from "vitest";
import { PM_AGENDA_BUSY_LINE } from "../../shared/pm-agenda.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const post = (text: string) => f.ledger.postUserMessage({ conversationId: f.pm.conversation.id, clientId: text, text }).messageId;
const receipt = (...ids: number[]) => f.ledger.deliverySuffix!(f.pm.sessionId, ids);
const write = (...ids: number[]) => {
  const result = receipt(...ids);
  const messageId = ids.at(-1)!;
  f.ledger.applyDriverEvent(f.pm.sessionId, {
    type: "message.delivered", messageIds: ids, at: f.now(),
    ...(result.agenda === undefined ? {} : { agenda: { messageId, footer: result.agenda } }),
  });
  return result;
};

function createGraph() {
  return f.hub("graph.create", {
    specJson: JSON.stringify({ title: "交付回执", steps: [{ key: "review", title: "确认" }] }),
  }).data.graph;
}

it("renders one current footer for a batch, and retries a failed write at the same version", () => {
  const graph = createGraph();
  const a = post("第一个问题");
  const b = post("第二个问题");
  f.hub("graph.done", { graphId: graph.id, nodeKey: "review" });
  const firstAttempt = receipt(a, b);
  expect(firstAttempt.text).toContain("全部做完，等你验收交付");
  expect(firstAttempt.text.match(/【清单/gu)).toHaveLength(1);
  expect(firstAttempt.text).toContain("【清单 v1");
  expect(receipt(a, b)).toEqual(firstAttempt);
  expect(write(a, b)).toEqual(firstAttempt);
  expect(receipt(post("第三个问题")).text).toContain("【清单 v1 没变");
});

it("repeats the snapshot when the driver reclaims a written input before it is taken", () => {
  createGraph();
  const first = post("先看这张图");
  expect(write(first).text).toContain("【清单 v1");
  f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.requeued", messageIds: [first], at: f.now() });
  expect(f.ledger.getMessage(first)?.status).toBe("queued");
  const repeated = write(first);
  expect(repeated.text).toContain("【清单 v2");
  expect(repeated.text).toContain("交付回执");
  expect(receipt(post("再次看图")).text).toContain("【清单 v2 没变");
});

it("writes a new snapshot once after compaction, even when the next message was already queued", () => {
  createGraph();
  write(post("第一次读清单"));
  const next = post("压缩后读清单");
  f.ledger.applyDriverEvent(f.pm.sessionId, {
    type: "context.compacted", uuid: "compact-once", at: f.now(), trigger: "manual", preTokens: 40_000, postTokens: 2_000,
  });
  expect(write(next).text).toMatch(/【清单 v2[^】]*】\n任务图/u);
  expect(receipt(post("再读清单")).text).toContain("【清单 v2 没变");
});

it("marks a user message at insertion, even if the driver writes it after the PM is idle", () => {
  const first = post("正在处理");
  f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.processing", at: f.now(), messageIds: [first] });
  const second = post("插入的问题");
  expect(f.ledger.getMessage(second)?.meta?.sentWhileBusy).toBe(true);
  expect(receipt(second).text).toContain(PM_AGENDA_BUSY_LINE);
});
