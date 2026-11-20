import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MAX_SETUP_COMMAND_BYTES, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { FakeApi, FakeWebSocket, changeOf, installFakeWebSocket, makeConvSnapshot, makeFolder, makePm, makeProject, makeSnapshot } from "./test-utils.ts";

const SAVED = "pnpm install --frozen-lockfile\npnpm build";

function snapshot({ setupCommand = SAVED as string | null, archivedAt = null as number | null } = {}): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林", archivedAt })],
    projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 1, setupCommand })],
    folders: [makeFolder({ id: 1, projectId: 1, path: "/work/foo", isMain: true })],
    conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })],
  });
}

async function boot(options: Parameters<typeof snapshot>[0] = {}) {
  window.history.replaceState(null, "", "/#/pm/1");
  const api = new FakeApi(snapshot(options));
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  const page = await screen.findByRole("region", { name: "小林's profile" });
  const group = await within(page).findByRole("region", { name: "Worktree setup" });
  const box = within(group).getByRole("textbox", { name: "Worktree setup" });
  return { api, user: userEvent.setup(), group, box, ws: FakeWebSocket.last };
}

const button = (group: HTMLElement, name: string) => within(group).queryByRole("button", { name });

describe("资料页 → Worktree setup：准备命令查看、编辑、清空", () => {
  it("挨着 Folders；已存的多行命令原样显示（等宽），旁边只有 Clear，没改时没有 Save", async () => {
    const { group, box } = await boot();
    const folders = screen.getByRole("region", { name: "Folders" });
    expect(folders.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box).toHaveValue(SAVED);
    expect(box).toHaveClass("font-mono");
    expect(button(group, "Clear")).toBeInTheDocument();
    expect(button(group, "Save")).not.toBeInTheDocument();
  });

  it("没有准备命令：占位 No setup command，也没有 Clear", async () => {
    const { group, box } = await boot({ setupCommand: null });
    expect(box).toHaveValue("");
    expect(box).toHaveAttribute("placeholder", "No setup command");
    expect(button(group, "Clear")).not.toBeInTheDocument();
  });

  it("改了出现 Cancel 和 Save；Save 原样发多行命令，回应到了就收起按钮，project.updated 回声到了也不变", async () => {
    const { api, user, group, box, ws } = await boot();
    await user.type(box, "{Enter}cp ../.env .env");
    const next = `${SAVED}\ncp ../.env .env`;
    expect(button(group, "Cancel")).toBeInTheDocument();
    await user.click(button(group, "Save")!);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/projects\/1\/setup-command$/).map((c) => c.body)).toEqual([{ command: next }]));
    await waitFor(() => expect(button(group, "Save")).not.toBeInTheDocument());
    expect(box).toHaveValue(next);
    act(() => ws.push(changeOf(20, "project.updated", { project: makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 1, setupCommand: next, updatedAt: 2_000 }) })));
    expect(box).toHaveValue(next);
    expect(button(group, "Clear")).toBeInTheDocument();
  });

  it("Clear 只清空草稿，按 Save 才发 command: null；全是空白也按清空发", async () => {
    const { api, user, group, box } = await boot();
    await user.click(button(group, "Clear")!);
    expect(box).toHaveValue("");
    expect(api.callsTo("PUT", /setup-command$/)).toHaveLength(0);
    await user.click(button(group, "Save")!);
    await waitFor(() => expect(api.callsTo("PUT", /setup-command$/).map((c) => c.body)).toEqual([{ command: null }]));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(button(group, "Clear")).not.toBeInTheDocument();
    await user.type(box, "   ");
    await user.click(button(group, "Save")!);
    await waitFor(() => expect(api.callsTo("PUT", /setup-command$/).map((c) => c.body)).toEqual([{ command: null }, { command: null }]));
  });

  it("Cancel 回到已存的内容", async () => {
    const { user, group, box } = await boot();
    await user.clear(box);
    await user.type(box, "make deps");
    await user.click(button(group, "Cancel")!);
    expect(box).toHaveValue(SAVED);
    expect(button(group, "Save")).not.toBeInTheDocument();
  });

  it("超过 16 KB 或带 NUL：写清原因，Save 不能点，不发请求", async () => {
    const { api, group, box } = await boot();
    fireEvent.change(box, { target: { value: "x".repeat(MAX_SETUP_COMMAND_BYTES + 1) } });
    expect(within(group).getByRole("alert")).toHaveTextContent("Setup command must be 16 KB or less");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(button(group, "Save")).toBeDisabled();
    fireEvent.change(box, { target: { value: "make\0deps" } });
    expect(within(group).getByRole("alert")).toHaveTextContent("Setup command can't contain NUL characters");
    expect(button(group, "Save")).toBeDisabled();
    fireEvent.change(box, { target: { value: "x".repeat(MAX_SETUP_COMMAND_BYTES) } });
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
    expect(button(group, "Save")).toBeEnabled();
    expect(api.callsTo("PUT", /setup-command$/)).toHaveLength(0);
  });

  it("服务端拒绝：原因显示在组里，草稿留着；再改一下错误消失", async () => {
    const { api, user, group, box } = await boot();
    api.putSetupCommand = () => ({ status: 400, body: { code: "invalid", error: "准备命令不能超过 16384 字节" } });
    await user.type(box, " && pnpm test");
    await user.click(button(group, "Save")!);
    expect(await within(group).findByRole("alert")).toHaveTextContent("准备命令不能超过 16384 字节");
    expect(box).toHaveValue(`${SAVED} && pnpm test`);
    await user.type(box, "!");
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("草稿保护：正在改时项目经理用 hub 改了准备命令，草稿不被冲掉；Cancel 后看到最新的", async () => {
    const { user, group, box, ws } = await boot();
    await user.type(box, " --verbose");
    act(() => ws.push(changeOf(20, "project.updated", { project: makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 1, setupCommand: "bun install", updatedAt: 3_000 }) })));
    expect(box).toHaveValue(`${SAVED} --verbose`);
    await user.click(button(group, "Cancel")!);
    expect(box).toHaveValue("bun install");
  });

  it("归档的项目经理：只读，没有 Clear 和 Save", async () => {
    const { group, box } = await boot({ archivedAt: 1_000 });
    expect(box).toHaveAttribute("readonly");
    expect(button(group, "Clear")).not.toBeInTheDocument();
    expect(button(group, "Save")).not.toBeInTheDocument();
  });
});
