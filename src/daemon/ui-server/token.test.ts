import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_TOKEN_FILE_MODE } from "../../shared/index.ts";
import { UI_TOKEN_PATTERN, loadOrCreateUiToken, loginUrl, rotateUiToken } from "./token.ts";

describe("loadOrCreateUiToken", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-token-"));
    file = join(dir, "state", "ui-token");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("首次生成合格的令牌，写进文件，权限 0600（目录不存在也行）", () => {
    const token = loadOrCreateUiToken(file);
    expect(token).toMatch(UI_TOKEN_PATTERN);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(UI_TOKEN_FILE_MODE);
  });

  it("再次调用沿用同一个令牌（重启后旧 cookie 仍然有效）", () => {
    const first = loadOrCreateUiToken(file);
    expect(loadOrCreateUiToken(file)).toBe(first);
  });

  it("权限比 0600 宽就改回来，令牌不变", () => {
    const token = loadOrCreateUiToken(file);
    chmodSync(file, 0o644);
    expect(loadOrCreateUiToken(file)).toBe(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(UI_TOKEN_FILE_MODE);
  });

  it("文件内容为空或不合格时换新令牌", () => {
    loadOrCreateUiToken(file);
    writeFileSync(file, "short\n");
    const token = loadOrCreateUiToken(file);
    expect(token).toMatch(UI_TOKEN_PATTERN);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
  });

  it("每次新建的令牌不一样", () => {
    const other = join(dir, "other-token");
    expect(loadOrCreateUiToken(file)).not.toBe(loadOrCreateUiToken(other));
  });
});

describe("rotateUiToken（全部退出换主钥匙）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-token-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("换成新的合格令牌写进文件（权限 0600），重启后读到的是新的", () => {
    const file = join(dir, "state", "ui-token");
    const old = loadOrCreateUiToken(file);
    const next = rotateUiToken(file);
    expect(next).toMatch(UI_TOKEN_PATTERN);
    expect(next).not.toBe(old);
    expect(readFileSync(file, "utf8").trim()).toBe(next);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(UI_TOKEN_FILE_MODE);
    expect(loadOrCreateUiToken(file)).toBe(next);
  });

  it("文件权限被放宽过，换完也是 0600", () => {
    const file = join(dir, "ui-token");
    loadOrCreateUiToken(file);
    chmodSync(file, 0o644);
    rotateUiToken(file);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(UI_TOKEN_FILE_MODE);
  });
});

describe("loginUrl", () => {
  it("格式是 http://127.0.0.1:<端口>/auth?token=<令牌>", () => {
    expect(loginUrl(4321, "abc")).toBe("http://127.0.0.1:4321/auth?token=abc");
  });
});
