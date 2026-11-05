// 输入框的“/”命令和“@”文件（docs/composer-commands.md、composer-plan 第 6 节 B、C、D）：真 claude 冒烟。
// 测“命令有没有展开”照实测文档的办法：命令带 disable-model-invocation: true（模型不能自己调 Skill 跑它），正文里放一个
// 每次随机、消息里从没出现过的标记；回复里有标记 = claude 展开了命令。
// S24 项目经理的长期会话：命令列表（没在跑时另起进程问、在跑时问它本身）去掉了隐藏的；连续两轮 /命令 都展开；
//     手打 /clear 被拦（400 带原因、不存不发）；@文件（含带空格的 @"a b.md"）被读进来；/compact 记一行“已压缩上下文”。
// S25 Worker 对话里用户发 /命令：“【用户直接对你说】”标签在前一块，命令照样展开，汇报回到项目经理。
import { randomInt } from "node:crypto";
import { API_PATHS, HUB_COMMAND, type CommandsResponse, type FilesResponse } from "../../src/shared/index.ts";
import { messagesOf, waitForStatus } from "../e2e/harness.ts";
import { MODEL, TURN_MS, expect, type Outcome, type Smoke } from "./kit.ts";
import { inFreshSmoke, pmWithFolder, repo, waitResults, waitSettled, workers } from "./m3.ts";

const marker = (prefix: string) => `${prefix}${randomInt(10_000, 99_999)}`;

/** 项目里的自定义命令：模型不能自己调（disable-model-invocation），正文让它原样回标记和参数。 */
const command = (description: string, mark: string) =>
  `---\ndescription: ${description}\nargument-hint: [word]\ndisable-model-invocation: true\n---\nReply with exactly: ${mark} $ARGUMENTS\n`;

async function commandNames(smoke: Smoke, conversationId: number): Promise<string[]> {
  const res = await smoke.client.get(API_PATHS.commands(conversationId));
  expect(res.status === 200, `GET commands ${res.status}`);
  return ((await res.json()) as CommandsResponse).commands.map((c) => c.name);
}

async function fileInsert(smoke: Smoke, conversationId: number, q: string, path: string): Promise<string> {
  const res = await smoke.client.get(API_PATHS.files(conversationId, q));
  const { entries } = (await res.json()) as FilesResponse;
  const entry = entries.find((e) => e.path === path);
  expect(entry, `@${q} 没搜到 ${path}：${JSON.stringify(entries)}`);
  return entry!.insert;
}

/** 这条消息之后到下一条用户消息之前的工具调用（看模型是不是自己读了文件）。 */
async function toolsAfter(smoke: Smoke, conversationId: number, messageId: number): Promise<string[]> {
  return messagesOf(await smoke.client.state(), conversationId)
    .filter((m) => m.id > messageId && m.sender === "agent" && m.kind === "tool")
    .map((m) => m.text);
}

export async function runComposer(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S24")) {
    await inFreshSmoke(outcomes, "S24 项目经理会话里的 / 命令、拦 /clear、@文件、/compact", async (smoke) => {
      const [ma, mb] = [marker("TKA"), marker("TKB")];
      const secret = marker("SECRET-");
      const spaced = marker("SPACE-");
      const dir = repo(smoke, "s24", {
        ".claude/commands/za.md": command("smoke command za", ma),
        ".claude/commands/zb.md": command("smoke command zb", mb),
        "README.md": `${secret}\n第二行\n`,
        "a b.md": `${spaced}\n`,
      });
      const chat = await pmWithFolder(smoke, "小周", dir);

      // 会话还没起来：另起一个 claude 在项目目录里问
      const cold = await commandNames(smoke, chat);
      expect(cold.includes("za") && cold.includes("zb") && cold.includes("compact"), `命令列表里没有 za、zb、compact：${cold.join(",")}`);
      for (const hidden of ["clear", "model", "effort", "doctor", "config", "login"]) expect(!cold.includes(hidden), `隐藏的 /${hidden} 在列表里`);

      // 长期会话里连续两轮
      const a = await smoke.ask(chat, "/za alpha");
      expect(a.replies.some((r) => r.includes(ma) && r.includes("alpha")), `/za 没展开：${a.replies.join("|")}`);
      const warm = await commandNames(smoke, chat);
      expect(warm.includes("za") && !warm.includes("clear"), `会话在跑时问到的列表不对：${warm.join(",")}`);
      const b = await smoke.ask(chat, "/zb beta");
      expect(b.replies.some((r) => r.includes(mb) && r.includes("beta")), `第二轮 /zb 没展开：${b.replies.join("|")}`);

      // 手打 /clear：400、带原因、不存
      const blocked = await smoke.client.postJson(API_PATHS.messages(chat), { clientId: "smoke-clear", text: "/clear" });
      const blockedBody = (await blocked.json()) as { error?: string };
      expect(blocked.status === 400 && /开新会话/.test(blockedBody.error ?? ""), `/clear 没被拦：${blocked.status} ${JSON.stringify(blockedBody)}`);
      expect(!messagesOf(await smoke.client.state(), chat).some((m) => m.text === "/clear"), "/clear 被存进了对话");

      // @文件：用 files 接口给的写法
      const readme = await fileInsert(smoke, chat, "readme", "README.md");
      expect(readme === "@README.md", `README 的写法不对：${readme}`);
      const q1 = await smoke.ask(chat, `Quote the first line of ${readme} verbatim and nothing else. Do not call any tools.`);
      expect(q1.replies.some((r) => r.includes(secret)), `@README.md 没读进来：${q1.replies.join("|")}`);
      const tools1 = await toolsAfter(smoke, chat, q1.messageId);
      const space = await fileInsert(smoke, chat, "a b", "a b.md");
      expect(space === '@"a b.md"', `带空格的写法不对：${space}`);
      const q2 = await smoke.ask(chat, `Quote the first line of ${space} verbatim and nothing else. Do not call any tools.`);
      expect(q2.replies.some((r) => r.includes(spaced)), `@"a b.md" 没读进来：${q2.replies.join("|")}`);
      const tools2 = await toolsAfter(smoke, chat, q2.messageId);

      // /compact：这一轮正常结束，对话里多一行
      const compact = await smoke.client.post(chat, "/compact");
      await waitForStatus(smoke.client, compact, "replied", TURN_MS);
      const notice = messagesOf(await smoke.client.state(), chat).find((m) => m.id > compact && m.sender === "system");
      expect(notice?.text === "已压缩上下文", `/compact 之后没有“已压缩上下文”：${JSON.stringify(notice)}`);

      const toolNote = tools1.length + tools2.length === 0 ? "没调工具" : `模型还调了工具：${[...tools1, ...tools2].join("；")}`;
      return `列表 ${cold.length} 项（无隐藏的）；/za、/zb 都展开（${ma}、${mb}）；/clear 400：${blockedBody.error}；@README.md、@"a b.md" 读进来（${toolNote}）；/compact 记了一行`;
    });
  }

  if (only("S25")) {
    await inFreshSmoke(outcomes, "S25 Worker 对话里用户发 / 命令：标签在前一块，命令照样展开", async (smoke) => {
      const mc = marker("TKC");
      const dir = repo(smoke, "s25", { ".claude/commands/zc.md": command("smoke command zc", mc), "README.md": "# s25\n" });
      const tasks = smoke.folder("tasks", { "t.txt": "只回复“收到”，然后按汇报格式汇报（状态 做完了，摘要 收到）。不要改任何文件。" });
      const chat = await pmWithFolder(smoke, "小吴", dir);
      await smoke.ask(chat, `用 Bash 原样运行这一条命令，运行完只回复“派了”。它汇报回来以后先别让它收工，我还要直接跟它说话：\n\n${HUB_COMMAND} worker start --title 命令测试 --model ${MODEL} --stdin < ${tasks}/t.txt`);
      const [worker] = workers(smoke);
      expect(worker, "没派出 Worker");
      await waitResults(smoke, chat, 1);
      await waitSettled(smoke, chat);

      const names = await commandNames(smoke, worker!.worker_conversation_id);
      expect(names.includes("zc") && !names.includes("clear"), `Worker 的命令列表不对：${names.join(",")}`);
      const sent = await smoke.client.post(worker!.worker_conversation_id, "/zc gamma");
      await waitForStatus(smoke.client, sent, "replied", TURN_MS);
      const replies = messagesOf(await smoke.client.state(), worker!.worker_conversation_id)
        .filter((m) => m.id > sent && m.sender === "agent" && m.kind === "text")
        .map((m) => m.text);
      expect(replies.some((r) => r.includes(mc) && r.includes("gamma")), `Worker 对话里 /zc 没展开：${replies.join("|")}`);
      const blocked = await smoke.client.postJson(API_PATHS.messages(worker!.worker_conversation_id), { clientId: "w-clear", text: "/model opus" });
      expect(blocked.status === 400, `Worker 对话里 /model 没被拦：${blocked.status}`);
      await waitSettled(smoke, chat);
      return `Worker 列表 ${names.length} 项；/zc gamma 展开（${replies.find((r) => r.includes(mc))?.slice(0, 40)}）；/model 被拦`;
    });
  }
}
