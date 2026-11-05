// 输入框的 commands、files 接口背后（方案第 5 节 17、27）：按对话找目录和厂商，插进输入框的写法由厂商实现生成。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationNotFoundError, type ComposerTarget } from "../shared/index.ts";
import { createComposerService } from "./composer.ts";
import { createWorkspaceFiles } from "./workspace-files.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "hub-composer-"));
  dirs.push(d);
  for (const f of files) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), "x");
  }
  return d;
}

function service(target: Partial<ComposerTarget>) {
  const full: ComposerTarget = { sessionId: 1, vendor: "claude", cwd: "/x", addDirs: [], fileRoots: [], ...target };
  const list = vi.fn(async () => [{ name: "x", description: "d" }]);
  return {
    list,
    svc: createComposerService({
      ledger: {
        composerTarget: (id) => {
          if (id !== 7) throw new ConversationNotFoundError(id);
          return full;
        },
      },
      commands: { list },
      files: createWorkspaceFiles(),
    }),
  };
}

describe("files", () => {
  it("17：挂了几个文件夹都搜；主文件夹（工作目录）里的插相对路径，别的插绝对路径；带空格的加引号", async () => {
    const main = folder(["notes.md", "docs/plan notes.md"]);
    const other = folder(["notes-other.md"]);
    const { svc } = service({ cwd: main, fileRoots: [main, other] });
    const { entries, truncated } = await svc.files(7, "notes");
    expect(truncated).toBe(false);
    expect(entries).toEqual([
      { path: "notes.md", root: main, insert: "@notes.md" },
      { path: "notes-other.md", root: other, insert: `@${join(other, "notes-other.md")}` },
      { path: "docs/plan notes.md", root: main, insert: '@"docs/plan notes.md"' },
    ]);
  });

  it("27：越界的搜索词搜不出工作文件夹外面的东西", async () => {
    const main = folder(["a.txt"]);
    const { svc } = service({ cwd: main, fileRoots: [main] });
    expect((await svc.files(7, "../../etc/passwd")).entries).toEqual([]);
    for (const e of (await svc.files(7, "..")).entries) expect(e.root).toBe(main);
  });

  it("不认识的厂商、没有文件夹：空的", async () => {
    const main = folder(["a.txt"]);
    expect(await service({ vendor: "codex", fileRoots: [main] }).svc.files(7, "a")).toEqual({ entries: [], truncated: false });
    expect(await service({ fileRoots: [] }).svc.files(7, "a")).toEqual({ entries: [], truncated: false });
  });

  it("对话不存在：ConversationNotFoundError（界面服务回 404）", async () => {
    await expect(service({}).svc.files(8, "a")).rejects.toThrow(ConversationNotFoundError);
  });
});

describe("commands", () => {
  it("按对话的会话、厂商、目录去要", async () => {
    const { svc, list } = service({ sessionId: 3, cwd: "/repo", addDirs: ["/other"] });
    expect(await svc.commands(7)).toEqual({ commands: [{ name: "x", description: "d" }] });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 3, vendor: "claude", cwd: "/repo", addDirs: ["/other"] }));
  });
});
