import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PICK_FOLDER_BUSY_MESSAGE,
  PICK_FOLDER_UNAVAILABLE_MESSAGE,
  PickFolderError,
  createDesktopBridgeFolderPicker,
  createFolderPicker,
  trimPickedFolderPath,
  type RunOsascript,
} from "./pick-folder.ts";

const HOME = mkdtempSync(join(tmpdir(), "hub-pick-home-"));

function osascriptError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("Command failed"), fields);
}

describe("createFolderPicker", () => {
  it("返回选中的路径（去掉结尾的斜杠和换行）；osascript 用参数数组、起始文件夹放在 -- 之后", async () => {
    const calls: string[][] = [];
    const run: RunOsascript = async (args) => {
      calls.push(args);
      return { stdout: "/Users/me/code/foo/\n" };
    };
    const dir = mkdtempSync(join(tmpdir(), "hub-pick-"));
    const picker = createFolderPicker({ run, homeDir: HOME });
    expect(await picker.pick(dir)).toBe("/Users/me/code/foo");
    expect(calls[0]?.slice(-2)).toEqual(["--", dir]);
    expect(calls[0]?.join(" ")).toContain("activate");
    expect(calls[0]?.join(" ")).toContain("choose folder");
  });

  it("根目录 / 不会被去成空", async () => {
    const picker = createFolderPicker({ run: async () => ({ stdout: "/\n" }), homeDir: HOME });
    expect(await picker.pick()).toBe("/");
  });

  it("起始文件夹：没给、不存在、不是绝对路径 → 家目录；~/ 展开；是文件 → 它所在的文件夹", async () => {
    const starts: string[] = [];
    const run: RunOsascript = async (args) => {
      starts.push(args[args.length - 1] ?? "");
      return { stdout: "/x\n" };
    };
    const picker = createFolderPicker({ run, homeDir: HOME });
    const sub = join(HOME, "proj");
    const file = join(HOME, "a.txt");
    writeFileSync(file, "");
    await picker.pick();
    await picker.pick("   ");
    await picker.pick("/不存在/的/路径");
    await picker.pick("相对/路径");
    await picker.pick("~");
    await picker.pick(file);
    expect(starts).toEqual([HOME, HOME, HOME, HOME, HOME, HOME]);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub);
    await picker.pick("~/proj");
    await picker.pick(sub);
    expect(starts.slice(6)).toEqual([sub, sub]);
  });

  it("用户取消（退出码 1、stderr 带 -128）：null，不报错", async () => {
    const run: RunOsascript = async () => {
      throw osascriptError({ code: 1, stderr: "execution error: User canceled. (-128)\n" });
    };
    expect(await createFolderPicker({ run, homeDir: HOME }).pick()).toBeNull();
  });

  it("超时（osascript 被杀）：null；并把超时时间传给执行函数", async () => {
    const seen: number[] = [];
    const run: RunOsascript = async (_args, { timeoutMs }) => {
      seen.push(timeoutMs);
      throw osascriptError({ killed: true, signal: "SIGTERM", stderr: "" });
    };
    expect(await createFolderPicker({ run, homeDir: HOME, timeoutMs: 1234 }).pick()).toBeNull();
    expect(seen).toEqual([1234]);
  });

  it("同时只有一个：第二次直接 409；第一次结束后又可以开", async () => {
    let finish: (v: { stdout: string }) => void = () => {};
    const run: RunOsascript = () => new Promise((r) => (finish = r));
    const picker = createFolderPicker({ run, homeDir: HOME });
    const first = picker.pick();
    await expect(picker.pick()).rejects.toMatchObject({ statusCode: 409, message: PICK_FOLDER_BUSY_MESSAGE });
    finish({ stdout: "/a\n" });
    expect(await first).toBe("/a");
    const again = picker.pick();
    finish({ stdout: "/b\n" });
    expect(await again).toBe("/b");
  });

  it("出错后也释放“正在选”的状态", async () => {
    let fail = true;
    const run: RunOsascript = async () => {
      if (fail) throw osascriptError({ code: 1, stderr: "boom" });
      return { stdout: "/ok\n" };
    };
    const picker = createFolderPicker({ run, homeDir: HOME });
    await expect(picker.pick()).rejects.toBeInstanceOf(PickFolderError);
    fail = false;
    expect(await picker.pick()).toBe("/ok");
  });

  it("没有 osascript（ENOENT）：501 加中文原因", async () => {
    const run: RunOsascript = async () => {
      throw osascriptError({ code: "ENOENT" });
    };
    await expect(createFolderPicker({ run, homeDir: HOME }).pick()).rejects.toMatchObject({
      statusCode: 501,
      message: PICK_FOLDER_UNAVAILABLE_MESSAGE,
    });
  });

  it("这台机器不能弹原生对话框（不是 macOS、没传 run）：501，不去起 osascript", async () => {
    await expect(createFolderPicker({ available: false, homeDir: HOME }).pick()).rejects.toMatchObject({
      statusCode: 501,
      message: PICK_FOLDER_UNAVAILABLE_MESSAGE,
    });
  });

  it("别的错且 stderr 是空的（被信号结束）：原因里写信号，不带整条命令", async () => {
    const run: RunOsascript = async () => {
      throw osascriptError({ signal: "SIGKILL", stderr: "" });
    };
    await expect(createFolderPicker({ run, homeDir: HOME }).pick()).rejects.toMatchObject({
      statusCode: 500,
      message: "弹不出选择文件夹的窗口：osascript 被 SIGKILL 结束了",
    });
  });

  it("别的错：500，原因里带 stderr", async () => {
    const run: RunOsascript = async () => {
      throw osascriptError({ code: 1, stderr: "execution error: 没有权限 (-1743)\n" });
    };
    await expect(createFolderPicker({ run, homeDir: HOME }).pick()).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("没有权限 (-1743)"),
    });
  });

  it("trimPickedFolderPath 保留 / 与 Windows 盘符根 D:\\，去掉普通子目录末尾分隔符", () => {
    expect(trimPickedFolderPath("/")).toBe("/");
    expect(trimPickedFolderPath("D:\\")).toBe("D:\\");
    expect(trimPickedFolderPath("D:\\projects\\demo\\")).toBe("D:\\projects\\demo");
    expect(trimPickedFolderPath("   ")).toBeNull();
  });

  it("createDesktopBridgeFolderPicker：仅允许 127.0.0.1 回环桥接，携带 Bearer token 并解析返回的 Windows 路径", async () => {
    await expect(
      createDesktopBridgeFolderPicker({
        bridgeUrl: "https://example.com/pick",
        bridgeToken: "tok",
        homeDir: HOME,
      }).pick(),
    ).rejects.toMatchObject({ statusCode: 501 });

    let seenAuth = "";
    let seenStartDir = "";
    const server = createServer((req, res) => {
      seenAuth = req.headers.authorization ?? "";
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        seenStartDir = (JSON.parse(raw) as { startDir: string }).startDir;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: "D:\\work\\repo\\" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const picker = createDesktopBridgeFolderPicker({
        bridgeUrl: `http://127.0.0.1:${port}/pick-folder`,
        bridgeToken: "bridge-secret-123",
        homeDir: HOME,
      });
      expect(await picker.pick()).toBe("D:\\work\\repo");
      expect(seenAuth).toBe("Bearer bridge-secret-123");
      expect(seenStartDir).toBe(HOME);
    } finally {
      server.close();
    }
  });
});
