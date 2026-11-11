import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  PM_MEMORY_MAX_LINES,
  PM_MEMORY_MAX_SUBFILES,
  utf8Bytes,
  type PmMemoryFileDetail,
  type PmMemoryFileSummary,
  type StateSnapshot,
} from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makePersonaView,
  makePm,
  makeSession,
  makeSnapshot,
  openFirstConversation,
} from "./test-utils.ts";

function singlePmSnapshot(): StateSnapshot {
  const pm = makePm({ id: 1, name: "小林", mode: "manage_only" });
  return makeSnapshot({
    pms: [pm],
    conversations: [makeConvSnapshot([], { conversation: { id: 1, kind: "pm", pmId: 1, title: "小林" } })],
    sessions: [makeSession({ sessionId: 10, conversationId: 1, pmId: 1 })],
  });
}

async function openProfile(api: FakeApi, snapshot: StateSnapshot) {
  const user = userEvent.setup();
  // 电脑外壳空 hash 默认落地 #/router（docs/ui-standard.md 第 21 条），资料页按钮在对话顶栏，先打开第一个对话
  openFirstConversation(snapshot);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  await user.click(await screen.findByRole("button", { name: "View 小林's profile" }));
  const page = await screen.findByRole("region", { name: "小林's profile" });
  await within(page).findByRole("textbox", { name: "Persona" });
  return { user, page };
}

describe("PmProfile 记忆子文件折叠管理（Memory files）", () => {
  it("默认收起且不提前请求接口；平时不挂配额数字，严禁用 · 中点拼接；展开后按需查看、编辑、新建、删除子文件", async () => {
    const snapshot = singlePmSnapshot();
    const api = new FakeApi(snapshot);
    const store = new Map<string, PmMemoryFileDetail>([
      [
        "architecture.md",
        {
          name: "architecture.md",
          content: "# Architecture\nLayered daemon + web",
          bytes: utf8Bytes("# Architecture\nLayered daemon + web"),
          updatedAt: 1_000,
        },
      ],
    ]);
    const listSummary = (): { files: PmMemoryFileSummary[]; totalBytes: number } => {
      const files = [...store.values()].map(({ name, bytes, updatedAt }) => ({ name, bytes, updatedAt }));
      return { files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
    };
    api.getPmMemoryFiles = () => ({ status: 200, body: listSummary() });
    api.getPmMemoryFile = (_pmId, name) => {
      const item = store.get(name);
      return item ? { status: 200, body: item } : { status: 404, body: { code: "not_found", error: "not found" } };
    };
    api.putPmMemoryFile = (_pmId, name, body) => {
      const detail: PmMemoryFileDetail = {
        name,
        content: body.content,
        bytes: utf8Bytes(body.content),
        updatedAt: 2_000,
      };
      store.set(name, detail);
      return { status: 200, body: { file: detail, totalBytes: listSummary().totalBytes } };
    };
    api.deletePmMemoryFile = (_pmId, name) => {
      store.delete(name);
      return { status: 204 };
    };

    const { user, page } = await openProfile(api, snapshot);

    // 1. 位于 Persona 下方、History 上方，默认收起，且未展开前绝不拉取 /memory-files
    const personaGroup = within(page).getByRole("region", { name: "Persona" });
    const memoryGroup = within(page).getByRole("region", { name: "Memory files" });
    const historyGroup = within(page).getByRole("region", { name: "History" });
    expect(personaGroup.compareDocumentPosition(memoryGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(memoryGroup.compareDocumentPosition(historyGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const trigger = within(memoryGroup).getByRole("button", { name: /Memory files/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(api.callsTo("GET", /\/api\/pms\/1\/memory-files$/)).toHaveLength(0);
    // 平时不挂配额数字，也不含中点 ·
    expect(personaGroup.textContent).not.toMatch(/200|25\s*KB/);
    expect(memoryGroup.textContent).not.toContain("·");

    // 2. 展开后通过 react-query 按需拉取列表，仍不显示 50 / 1 MB 配额分母且无 · 中点
    await user.click(trigger);
    expect(await within(memoryGroup).findByText("architecture.md")).toBeInTheDocument();
    expect(api.callsTo("GET", /\/api\/pms\/1\/memory-files$/)).toHaveLength(1);
    expect(memoryGroup.textContent).not.toContain("·");
    expect(memoryGroup.textContent).not.toMatch(/\/\s*50|1\s*MB/);

    // 3. 点击 Edit 按需拉取子文件内容并保存修改
    await user.click(within(memoryGroup).getByRole("button", { name: "Edit architecture.md" }));
    const editor = await within(memoryGroup).findByRole("textbox", { name: "architecture.md content" });
    expect(editor).toHaveValue("# Architecture\nLayered daemon + web");
    expect(api.callsTo("GET", /\/api\/pms\/1\/memory-files\/architecture\.md$/)).toHaveLength(1);

    await user.clear(editor);
    await user.type(editor, "# Updated architecture");
    await user.click(within(memoryGroup).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PUT", /\/api\/pms\/1\/memory-files\/architecture\.md$/)).toHaveLength(1));
    expect(store.get("architecture.md")?.content).toBe("# Updated architecture");

    // 4. 新建子文件：实时表单校验拦截非法名字（如 MEMORY.md、路径穿越），合法 <topic>.md 可正常保存
    await user.click(within(memoryGroup).getByRole("button", { name: "New" }));
    const nameInput = within(memoryGroup).getByLabelText("File name");
    await user.type(nameInput, "../escape.md");
    expect(within(memoryGroup).getByRole("alert")).toBeInTheDocument();
    expect(within(memoryGroup).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(nameInput);
    await user.type(nameInput, "MEMORY.md");
    expect(within(memoryGroup).getByRole("alert")).toHaveTextContent(/MEMORY\.md/i);
    expect(within(memoryGroup).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(nameInput);
    await user.type(nameInput, "conventions.md");
    const contentInput = within(memoryGroup).getByRole("textbox", { name: "Content" });
    await user.type(contentInput, "# Conventions\nUse strict TypeScript");
    await user.click(within(memoryGroup).getByRole("button", { name: "Save" }));
    expect(await within(memoryGroup).findByText("conventions.md")).toBeInTheDocument();
    expect(store.get("conventions.md")?.content).toBe("# Conventions\nUse strict TypeScript");

    // 5. 删除子文件（带二次确认 Cancel / Delete）
    await user.click(within(memoryGroup).getByRole("button", { name: "Delete architecture.md" }));
    expect(within(memoryGroup).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(within(memoryGroup).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(memoryGroup).queryByText("architecture.md")).not.toBeInTheDocument());
    expect(store.has("architecture.md")).toBe(false);
  });

  it("接近或达到上限时柔和提示：Persona 超过/接近 200 行提示拆分，子文件接近/满 50 个柔和提示并禁用 New", async () => {
    const snapshot = singlePmSnapshot();
    const api = new FakeApi(snapshot);
    const nearLimitPersona = Array.from({ length: PM_MEMORY_MAX_LINES + 5 }, (_, i) => `rule ${i + 1}`).join("\n");
    api.getPersona = (pmId) => ({ status: 200, body: makePersonaView({ pmId, text: nearLimitPersona }) });
    const fiftyFiles: PmMemoryFileSummary[] = Array.from({ length: PM_MEMORY_MAX_SUBFILES }, (_, i) => ({
      name: `topic-${i + 1}.md`,
      bytes: 128,
      updatedAt: 1_000,
    }));
    api.getPmMemoryFiles = () => ({ status: 200, body: { files: fiftyFiles, totalBytes: fiftyFiles.length * 128 } });

    const { user, page } = await openProfile(api, snapshot);
    const personaGroup = within(page).getByRole("region", { name: "Persona" });
    expect(personaGroup.textContent).toMatch(/200 lines/i);

    const memoryGroup = within(page).getByRole("region", { name: "Memory files" });
    await user.click(within(memoryGroup).getByRole("button", { name: /Memory files/ }));
    expect(await within(memoryGroup).findByText("topic-1.md")).toBeInTheDocument();
    const newBtn = within(memoryGroup).getByRole("button", { name: /New/ });
    expect(newBtn).toBeDisabled();
    expect(within(memoryGroup).getByText(`${PM_MEMORY_MAX_SUBFILES} max`)).toBeInTheDocument();
    expect(memoryGroup.textContent).not.toContain("·");
  });
});
