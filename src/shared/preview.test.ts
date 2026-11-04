import { describe, expect, it } from "vitest";
import { canOpenWithDefault, codeLanguageOf, previewKindOf } from "./preview.ts";
import { sentFileMime } from "./sent-files.ts";

const kind = (name: string) => previewKindOf(name, sentFileMime(name));

describe("previewKindOf：按文件选预览方式", () => {
  it("各类型对上各自的渲染方式", () => {
    expect(kind("说明.md")).toBe("markdown");
    expect(kind("README.markdown")).toBe("markdown");
    expect(kind("a.ts")).toBe("code");
    expect(kind("a.PY")).toBe("code");
    expect(kind("a.json")).toBe("code");
    expect(kind("a.txt")).toBe("code");
    expect(kind("run.log")).toBe("code");
    expect(kind("a.sh")).toBe("code");
    expect(kind("数据.csv")).toBe("csv");
    expect(kind("数据.tsv")).toBe("csv");
    expect(kind("报告.pdf")).toBe("pdf");
    expect(kind("页面.html")).toBe("html");
    expect(kind("页面.htm")).toBe("html");
    expect(kind("a.mp4")).toBe("video");
    expect(kind("a.mov")).toBe("video");
    expect(kind("a.webm")).toBe("video");
    expect(kind("a.mp3")).toBe("audio");
    expect(kind("a.wav")).toBe("audio");
    expect(kind("a.png")).toBe("image");
    expect(kind("a.svg")).toBe("image");
  });

  it("不认识的类型：other", () => {
    expect(kind("a.zip")).toBe("other");
    expect(kind("a.xlsx")).toBe("other");
    expect(kind("noext")).toBe("other");
  });

  it("按 mime 优先：mime 是 text/* 的当文本", () => {
    expect(previewKindOf("weird.xyz", "text/plain")).toBe("code");
    expect(previewKindOf("a.md", "application/octet-stream")).toBe("code");
  });
});

describe("codeLanguageOf", () => {
  it("扩展名对上语言；纯文本是 text；不认识是 null", () => {
    expect(codeLanguageOf("a.ts")).toBe("typescript");
    expect(codeLanguageOf("A.TSX")).toBe("tsx");
    expect(codeLanguageOf("a.json")).toBe("json");
    expect(codeLanguageOf("a.txt")).toBe("text");
    expect(codeLanguageOf("a.md")).toBe("markdown");
    expect(codeLanguageOf("a.zip")).toBeNull();
    expect(codeLanguageOf("noext")).toBeNull();
  });
});

describe("canOpenWithDefault：能不能用默认程序打开", () => {
  it(".app、.command、.sh、.pkg、.scpt、.jar（大小写不论）不能", () => {
    for (const name of ["a.app", "a.command", "a.sh", "a.pkg", "a.scpt", "a.jar", "A.APP", "x.y.Command"]) {
      expect(canOpenWithDefault(name), name).toBe(false);
    }
  });

  it("别的能", () => {
    for (const name of ["a.pdf", "a.png", "a.md", "noext", "app", "sh"]) expect(canOpenWithDefault(name), name).toBe(true);
  });
});
