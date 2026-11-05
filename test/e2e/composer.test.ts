// 输入框的“/”命令和“@”文件，端到端：真守护进程 + 假 claude，临时数据目录。
// 命令列表（会话没在跑时另起进程问、正在跑时问它）、手打 /clear 被拦、/compact 在对话里记一行、@ 文件搜索。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, type CommandsResponse, type FilesResponse } from "../../src/shared/index.ts";
import { Client, messagesOf, waitForStatus, waitUntil, type E2eEnv, makeEnv } from "./harness.ts";

const COMMANDS = [
  { name: "x", description: "probe command x (project)", argumentHint: "word" },
  { name: "compact", description: "Free up context", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
  { name: "model", description: "Set the AI model", argumentHint: "<model>", builtin: true },
  { name: "doctor", description: "Health-check", argumentHint: "", builtin: true },
];
const VISIBLE = [
  { name: "x", description: "probe command x (project)", argumentHint: "word" },
  { name: "compact", description: "Free up context", argumentHint: "<optional custom summarization instructions>", builtin: true },
];
const BOUNDARY = { type: "system", subtype: "compact_boundary", uuid: "cb-e2e", compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 10 } };

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe("输入框的“/”“@”（端到端）", () => {
  it("命令列表去掉隐藏的；手打 /clear 被拦（400 带原因、不存）；/compact 记一行“已压缩上下文”；@ 搜工作目录", async () => {
    env = makeEnv();
    env.setScript({ commands: COMMANDS, turns: [{ steps: [{ text: "好" }] }, { steps: [{ raw: JSON.stringify(BOUNDARY) }], result: { result: "" } }] });
    const daemon = await env.start();
    const client = await Client.login(daemon);
    const state = await client.state();
    const conversationId = state.conversations[0]!.conversation.id;

    // 会话还没起来：另起一个 claude 问（不写会话）
    const before = (await (await client.get(API_PATHS.commands(conversationId))).json()) as CommandsResponse;
    expect(before.commands).toEqual(VISIBLE);
    const query = env.argvs().find((a) => a.argv.includes("--no-session-persistence"))!;
    // 另起的进程不跑钩子、不连 MCP（docs/composer-commands.md 的 T10）
    expect(query.argv).toContain("--strict-mcp-config");
    expect(query.argv[query.argv.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');

    // 正在跑：问它本身（不再另起进程）
    const first = await client.post(conversationId, "你好");
    await waitForStatus(client, first, "replied");
    const spawned = env.argvs().length;
    const running = (await (await client.get(API_PATHS.commands(conversationId))).json()) as CommandsResponse;
    expect(running.commands).toEqual(VISIBLE);
    expect(env.argvs()).toHaveLength(spawned);

    // 手打 /clear：不存、不发，回原因
    const blocked = await client.postJson(API_PATHS.messages(conversationId), { clientId: "clear-1", text: "/clear" });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/开新会话/);
    expect(messagesOf(await client.state(), conversationId).some((m) => m.text === "/clear")).toBe(false);

    // /compact：这一轮正常结束，对话里多一行系统消息
    const compact = await client.post(conversationId, "/compact");
    await waitForStatus(client, compact, "replied");
    await waitUntil("compact notice", async () =>
      messagesOf(await client.state(), conversationId).find((m) => m.sender === "system" && m.text === "已压缩上下文"),
    );
    expect(env.stdinTexts().at(-1)).toBe("/compact");

    // @ 文件：项目经理还没项目，工作目录是 pm-home/<编号>/，插相对路径
    const cwd = env.argvs().find((a) => !a.argv.includes("--no-session-persistence"))!.cwd;
    writeFileSync(join(cwd, "plan notes.md"), "x");
    const files = (await (await client.get(API_PATHS.files(conversationId, "plan"))).json()) as FilesResponse;
    expect(files.entries.map(({ path, insert }) => ({ path, insert }))).toContainEqual({ path: "plan notes.md", insert: '@"plan notes.md"' });

    expect((await client.get(API_PATHS.commands(99_999))).status).toBe(404);
  });
});
