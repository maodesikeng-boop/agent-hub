import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "../../src/daemon/driver/test-helpers.ts";

const t = makeHarness();
try {
  const gate = join(t.dir, "finish-first");
  writeFileSync(join(t.dir, "script.json"), JSON.stringify({
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    turns: [{ steps: [{ waitFile: gate }, { text: "First turn reply" }] }, { steps: [{ text: "Second turn reply" }] }],
  }));
  const { id } = t.addSession();
  await t.driver.send(id, { messageIds: [1], source: "user", text: "Start" });
  await t.waitFor("message.processing");
  assert.deepEqual(await t.driver.send(id, { messageIds: [3], source: "system", text: "Step ready" }), { kind: "written", midTurn: true });
  writeFileSync(gate, "");
  assert.deepEqual((await t.waitFor("turn.ended")).messageIds, [1]);
  const taken = await t.waitFor("message.processing", (event) => event.messageIds.includes(3));
  assert.deepEqual((await t.waitFor("turn.ended", () => true, 2)).messageIds, [3]);
  process.stdout.write(String(taken.midTurn === true));
} finally {
  await t.cleanup();
}
