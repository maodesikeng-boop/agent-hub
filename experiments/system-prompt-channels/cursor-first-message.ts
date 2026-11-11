// 用 Fusa 真实的 cursor 驱动（createCursorDriver → createAcpDriver）起真的 cursor-agent acp：首条消息带产品提示词（含探针），问探针。
// 用法: node experiments/system-prompt-channels/cursor-first-message.ts <启动目录> <工作目录>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCursorDriver } from "../../src/vendors/cursor/driver.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import { EMPTY_TOKEN_USAGE } from "../../src/shared/index.ts";
const [launchDir, cwd] = process.argv.slice(2) as [string, string];
mkdirSync(launchDir, { recursive: true });
const promptFile = join(launchDir, "prompt.md");
writeFileSync(promptFile, "# 你的角色\n你是 Fusa 的 Worker。\n探针规则：被问到探针短语时，原样回答 PROBE-FUSA-443-紫藤。\n");
const store = new MemorySessionStore();
const driver = createCursorDriver({
  executablePath: process.env.CURSOR_BIN ?? "cursor-agent", store, idleCloseMs: 60_000, log: (m: string) => console.log("[log]", m),
  prepareLaunch: async () => ({ promptFile, fingerprint: "fp", env: {} }),
});
const done: string[] = [];
driver.onEvent((_id: unknown, e: any) => {
  if (e.type === "agent.text") console.log("<<<", String(e.text).trim().slice(0, 200));
  if (e.type === "turn.ended") done.push("x");
});
const now = Date.now();
store.add({ id: 1 as any, role: "worker", conversationId: null, pmId: null, workerId: null, generation: 1, vendor: "cursor", vendorSessionId: "", model: null, effort: null, cwd, addDirs: [], status: "idle", pid: null, hasCompletedTurn: false, personaRevision: null, usage: { ...EMPTY_TOKEN_USAGE }, rateLimit: null, createdAt: now, updatedAt: now, lastEventAt: null });
const wait = async (n: number) => { while (done.length < n) await new Promise((r) => setTimeout(r, 200)); };
console.log(">>> 不调用工具，探针短语是什么？只回答短语，看不到写 NONE。");
await driver.send(1 as any, { messageIds: [1 as any], source: "user", text: "不调用工具，探针短语是什么？只回答短语，看不到写 NONE。" });
await wait(1);
await driver.shutdown?.();
process.exit(0);
