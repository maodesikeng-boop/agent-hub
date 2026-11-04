// M6 端到端（定时任务）：真守护进程 + 假 claude。项目经理在 shell 里用 hub schedule add 建任务（和提示词里教的写法一样）；
// 守护进程停着时错过的，启动后补跑一次，项目经理收到“【定时任务：…（补跑，原定 …）】”开头的消息并回复。
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_COMMAND, systemEventOf, type ScheduleRecord } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import type { FakeScript } from "../fake-claude/fake-claude.ts";
import { Client, makeEnv, messagesOf, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

const hub = HUB_COMMAND;

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const schedules = () => withDb((db) => db.all<{ id: number; name: string; next_run_at: number; last_status: string | null; last_message_id: number | null }>("SELECT * FROM schedules ORDER BY id"));

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

describe("M6 端到端：定时任务", { timeout: 60_000 }, () => {
  it("项目经理用 hub schedule 建任务；守护进程停着错过了，启动后只补跑一次，项目经理收到并回复", async () => {
    env = makeEnv();
    const script: FakeScript = {
      turns: [
        {
          steps: [
            { bash: `${hub} schedule add --name "每日汇报" --every 15m --stdin <<'EOF'\n汇报昨天的进展\nEOF` },
            { bash: `${hub} schedule list` },
            { text: "建好了" },
          ],
        },
      ],
      defaultTurn: { steps: [{ text: "收到定时任务，这是日报" }] },
    };
    env.setScript(script);
    const first = await env.start();
    const client = await Client.login(first);
    const { conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
    await waitForStatus(client, await client.post(conversationId, "每 15 分钟汇报一次"), "replied");

    // 建好了：表里一行、对话里一条给人看的系统消息、快照里有、hub list 能看到
    expect(schedules()).toMatchObject([{ id: 1, name: "每日汇报", last_status: null }]);
    const state = await client.state();
    expect(state.schedules).toMatchObject([{ id: 1, name: "每日汇报", kind: "interval", everyMinutes: 15, enabled: true }]);
    expect(messagesOf(state, conversationId).map((m) => systemEventOf(m)?.event).filter(Boolean)).toEqual(["schedule.created"]);
    const runs = env.bashRuns();
    expect(runs[0]).toMatchObject({ exitCode: 0 });
    expect(runs[0]!.output).toContain("已建定时任务 #1“每日汇报”：每隔 15 分钟");
    expect(runs[1]!.output).toContain("#1 每日汇报 · 每隔 15 分钟");
    expect(env.stdinTexts()).not.toContainEqual(expect.stringContaining("定时任务"));

    // 守护进程停着，过了好几个周期
    await terminate(first);
    const missed = Date.now() - 3 * 60 * 60_000;
    withDb((db) => db.run("UPDATE schedules SET next_run_at = ? WHERE id = 1", missed));

    const second = await env.start();
    const client2 = client.withPort(second.port);
    const scheduled = await waitUntil("补跑的那条消息", async () => {
      const m = messagesOf(await client2.state(), conversationId).find((x) => systemEventOf(x)?.event === "schedule.run");
      return m?.status === "replied" ? m : undefined;
    });
    expect(scheduled.text).toMatch(/^【定时任务：每日汇报（补跑，原定 .+）】\n\n汇报昨天的进展$/);
    expect(scheduled.meta).toMatchObject({ event: "schedule.run", scheduleId: 1, catchUp: true });
    // 项目经理收到的就是这条，回复进了对话
    expect(env.stdinTexts()).toContain(scheduled.text);
    const final = await client2.state();
    expect(messagesOf(final, conversationId).filter((m) => systemEventOf(m)?.event === "schedule.run")).toHaveLength(1);
    expect(messagesOf(final, conversationId).some((m) => m.sender === "agent" && m.text === "收到定时任务，这是日报")).toBe(true);
    const [row] = final.schedules as ScheduleRecord[];
    expect(row).toMatchObject({ lastStatus: "sent", lastMessageId: scheduled.id });
    expect(row!.nextRunAt).toBeGreaterThan(Date.now());
  });
});
