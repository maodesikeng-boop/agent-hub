import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENTS_TOO_MANY_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES, UPLOAD_CLIENT_CONCURRENCY } from "../shared/index.ts";
import { formatBytes, stageFiles, uploadFiles } from "./upload.ts";

afterEach(() => vi.unstubAllGlobals());

const file = (name: string, content = "x") => new File([content], name);
const sized = (name: string, size: number) => Object.defineProperty(file(name), "size", { value: size }) as File;

describe("加文件时检查", () => {
  it("正常的文件都加进去，按顺序，各有各的 key（同名也一样）", () => {
    const { files, notice } = stageFiles([], [file("a.txt"), file("a.txt")]);
    expect(notice).toBeNull();
    expect(files.map((f) => f.file.name)).toEqual(["a.txt", "a.txt"]);
    expect(new Set(files.map((f) => f.key)).size).toBe(2);
  });

  it("接在已有的后面，不改传进来的数组", () => {
    const current = stageFiles([], [file("a.txt")]).files;
    const next = stageFiles(current, [file("b.txt")]).files;
    expect(current).toHaveLength(1);
    expect(next.map((f) => f.file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("空文件、超过 20 MB 的不加，提示带文件名；刚好 20 MB 加", () => {
    const { files, notice } = stageFiles([], [new File([], "空.txt"), sized("大.mov", MAX_UPLOAD_BYTES + 1), sized("刚好.bin", MAX_UPLOAD_BYTES), file("好.txt")]);
    expect(files.map((f) => f.file.name)).toEqual(["刚好.bin", "好.txt"]);
    expect(notice).toBe("「空.txt」是空文件，没有加入；「大.mov」超过 20 MB，没有加入");
  });

  it("超出一条消息的个数上限：多的不加", () => {
    const { files, notice } = stageFiles([], Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 3 }, (_, i) => file(`${i}.txt`)));
    expect(files).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(notice).toBe(`${ATTACHMENTS_TOO_MANY_MESSAGE}，多出来的没有加入`);
  });
});

describe("文件大小的写法", () => {
  it("B、KB、MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});

describe("发送时上传", () => {
  it("按原来的顺序返回上传结果；一个失败整个抛错，错误里带文件名和原因（中文）", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const name = new URL(url, "http://x").searchParams.get("name");
        if (name === "坏.txt") return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
        return new Response(JSON.stringify({ id: `id${++n}`, name, path: `/p/${name}`, size: 1, mime: "x" }), { status: 200 });
      }),
    );
    const ok = await uploadFiles([file("甲.txt"), file("乙.txt")]);
    expect(ok.map((a) => a.name)).toEqual(["甲.txt", "乙.txt"]);
    await expect(uploadFiles([file("甲.txt"), file("坏.txt")])).rejects.toThrow("「坏.txt」上传失败：服务出错了（500）");
  });
});

describe("上传并发", () => {
  it(`最多同时传 ${UPLOAD_CLIENT_CONCURRENCY} 个，结果顺序不变`, async () => {
    let running = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        const name = new URL(url, "http://x").searchParams.get("name");
        return new Response(JSON.stringify({ id: name, name, path: `/p/${name}`, size: 1, mime: "x" }), { status: 200 });
      }),
    );
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
    const result = await uploadFiles(names.map((n) => file(n)));
    expect(result.map((a) => a.name)).toEqual(names);
    expect(peak).toBe(UPLOAD_CLIENT_CONCURRENCY);
  });

  it("有一个失败后不再开始新的上传", async () => {
    const started: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const name = new URL(url, "http://x").searchParams.get("name")!;
        started.push(name);
        await new Promise((r) => setTimeout(r, 5));
        if (name === "f0.txt") return new Response(JSON.stringify({ error: "x" }), { status: 500 });
        return new Response(JSON.stringify({ id: name, name, path: name, size: 1, mime: "x" }), { status: 200 });
      }),
    );
    await expect(uploadFiles(Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`)))).rejects.toThrow("f0.txt");
    await new Promise((r) => setTimeout(r, 50));
    expect(started.length).toBeLessThan(10);
  });
});
