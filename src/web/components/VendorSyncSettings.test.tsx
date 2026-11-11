import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorSyncPreviewResponse } from "../../shared/index.ts";
import type { NotifySettings } from "../notify.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

const notify: NotifySettings = { permission: "granted", enabled: false, setEnabled: vi.fn(async () => {}) };

const samplePreview: VendorSyncPreviewResponse = {
  scannedAt: 1_700_000_000_000,
  truncated: false,
  mcpServers: [
    {
      key: "context7",
      name: "context7",
      transport: "stdio",
      maskedTarget: "npx -y @upstash/context7-mcp",
      maskedAuth: ["CONTEXT7_API_KEY=••••"],
      usesMcpRemoteBridge: false,
      vendors: [
        { vendor: "claude", label: "Claude Code", status: "present" },
        { vendor: "codex", label: "Codex", status: "will_add" },
      ],
    },
    {
      key: "linear_sse",
      name: "linear_sse",
      transport: "sse",
      maskedTarget: "https://mcp.linear.app/sse",
      maskedAuth: [],
      usesMcpRemoteBridge: true,
      vendors: [
        { vendor: "cursor", label: "Cursor", status: "present" },
        { vendor: "agy", label: "Antigravity", status: "mcp_remote" },
      ],
    },
  ],
  skills: [
    {
      key: "global:code-review",
      name: "code-review",
      scope: "global",
      sourcePath: "/Users/dev/.agents/skills/code-review",
      vendors: [
        { vendor: "codex", label: "Codex", status: "native" },
        { vendor: "claude", label: "Claude Code", status: "will_link" },
      ],
    },
  ],
  nonSyncable: [
    {
      key: "claude:slack",
      name: "slack",
      vendor: "claude",
      vendorLabel: "Claude Code",
      kind: "cloud_connector",
      reason: "Bound to provider cloud account; OAuth credentials cannot be synced across providers",
    },
  ],
};

describe("设置弹窗：Vendor sync 扫描预览、取消勾选移除与执行同步", () => {
  let api: FakeApi;

  beforeEach(() => {
    api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: samplePreview });
    api.install();
  });

  it("点 Scan… 弹出脱敏预览窗（不含 · 拼接符），默认全选并集，取消勾选某项将其放入 remove 列表并提交同步", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => {}} notify={notify} />);

    const scanBtn = screen.getByRole("button", { name: "Scan…" });
    await user.click(scanBtn);

    const dialog = await screen.findByRole("dialog", { name: "Sync preview" });
    expect(within(dialog).getByText("context7")).toBeVisible();
    expect(within(dialog).getByText("linear_sse")).toBeVisible();
    expect(within(dialog).getByText("code-review")).toBeVisible();
    expect(within(dialog).getByText("slack")).toBeVisible();
    expect(
      within(dialog).getByText("Bound to provider cloud account; OAuth credentials cannot be synced across providers"),
    ).toBeVisible();

    // 严守 ui-standard.md：预览弹窗文本中无任何 "·" 拼接符
    expect(dialog.textContent).not.toContain("·");

    // 取消勾选 linear_sse（主动全局删除）
    const linearSwitch = within(dialog).getByRole("switch", { name: "linear_sse" });
    expect(linearSwitch).toHaveAttribute("aria-checked", "true");
    await user.click(linearSwitch);
    expect(linearSwitch).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByText("Unchecked — will be removed")).toBeVisible();

    // 点击 Sync 提交
    await user.click(within(dialog).getByRole("button", { name: "Sync" }));

    const applyCalls = api.callsTo("POST", /\/api\/vendor-sync\/apply$/);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.body).toEqual({
      selectedMcpKeys: ["context7"],
      removeMcpKeys: ["linear_sse"],
      selectedSkillKeys: ["global:code-review"],
      removeSkillKeys: [],
    });
  });

  it("空扫描结果展示空状态说明且 Sync 主按钮禁用；后台提交失败时保留勾选状态并在底部提示错误", async () => {
    const user = userEvent.setup();
    api.vendorSyncPreview = () => ({
      status: 200,
      body: { scannedAt: 1_700_000_000_000, mcpServers: [], skills: [], nonSyncable: [], truncated: false },
    });
    const { unmount } = render(<SettingsDialog open onOpenChange={() => {}} notify={notify} />);

    await user.click(screen.getByRole("button", { name: "Scan…" }));
    const emptyDialog = await screen.findByRole("dialog", { name: "Sync preview" });
    expect(within(emptyDialog).getByText("No MCP servers, skills, or cloud connectors found")).toBeVisible();
    expect(within(emptyDialog).getByRole("button", { name: "Sync" })).toBeDisabled();
    unmount();

    api.vendorSyncPreview = () => ({ status: 200, body: samplePreview });
    api.vendorSyncApply = () => ({ status: 500, body: { error: "磁盘空间不足，回滚完成", code: "internal" } });
    render(<SettingsDialog open onOpenChange={() => {}} notify={notify} />);

    await user.click(screen.getByRole("button", { name: "Scan…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sync preview" });
    const skillSwitch = within(dialog).getByRole("switch", { name: "code-review" });
    await user.click(skillSwitch);
    expect(skillSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(within(dialog).getByRole("button", { name: "Sync" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("磁盘空间不足，回滚完成");
    expect(skillSwitch).toHaveAttribute("aria-checked", "false");
  });
});
