// 隧道（docs/hub-tunnel-design.md 第 7 节）：连接码的格式、公钥和名字的校验。
import { describe, expect, it } from "vitest";
import {
  CONNECTION_CODE_PREFIX,
  decodeConnectionCode,
  encodeConnectionCode,
  isTunnelName,
  parseEd25519PublicKey,
  type ConnectionCode,
} from "./tunnel.ts";

const KEY_BODY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const CODE: ConnectionCode = {
  host: "203.0.113.10",
  sshPort: 22,
  user: "agenthub-tunnel",
  hostKey: `ssh-ed25519 ${KEY_BODY}`,
  listenPort: 4401,
  entryPort: 4319,
  invite: "Xy9_abcdefghijklmnopqr",
};

describe("连接码", () => {
  it("一行、只有 shell 里不用加引号的字符，前缀带版本号；能原样解回来", () => {
    const text = encodeConnectionCode(CODE);
    expect(text.startsWith(CONNECTION_CODE_PREFIX)).toBe(true);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConnectionCode(text)).toEqual(CODE);
    // 贴的时候带了空白、换行也认
    expect(decodeConnectionCode(`  ${text}\n`)).toEqual(CODE);
  });

  it("域名、IPv6 都能当地址", () => {
    for (const host of ["hub.example.com", "2001:db8::1"]) {
      expect(decodeConnectionCode(encodeConnectionCode({ ...CODE, host }))?.host).toBe(host);
    }
  });

  it("不认：别的前缀、坏的 base64 / JSON、少字段、字段不合格", () => {
    const body = (value: unknown) => CONNECTION_CODE_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
    const bad: string[] = [
      "",
      "hello",
      encodeConnectionCode(CODE).replace(CONNECTION_CODE_PREFIX, "ahtun9_"),
      CONNECTION_CODE_PREFIX + "!!!",
      CONNECTION_CODE_PREFIX + Buffer.from("not json").toString("base64url"),
      body({ ...CODE, host: undefined }),
      // 地址以 - 开头会被 ssh 当成选项
      body({ ...CODE, host: "-oProxyCommand=evil" }),
      body({ ...CODE, host: "a b" }),
      body({ ...CODE, user: "root;rm" }),
      body({ ...CODE, sshPort: 0 }),
      body({ ...CODE, sshPort: 70000 }),
      body({ ...CODE, listenPort: "4401" }),
      body({ ...CODE, entryPort: 1.5 }),
      body({ ...CODE, hostKey: "ssh-rsa AAAAB3NzaC1yc2E" }),
      body({ ...CODE, hostKey: `ssh-ed25519 ${KEY_BODY} extra` }),
      body({ ...CODE, invite: "short" }),
      body([CODE]),
    ];
    for (const text of bad) expect(decodeConnectionCode(text), text).toBeNull();
  });

  it("编码时也校验：不合格的字段直接抛", () => {
    expect(() => encodeConnectionCode({ ...CODE, host: "-x" })).toThrow();
  });
});

describe("公钥、名字", () => {
  it("只认 ssh-ed25519，注释丢掉", () => {
    expect(parseEd25519PublicKey(`ssh-ed25519 ${KEY_BODY} agent-hub:mac`)).toEqual({ type: "ssh-ed25519", body: KEY_BODY });
    expect(parseEd25519PublicKey(`ssh-ed25519 ${KEY_BODY}`)).toEqual({ type: "ssh-ed25519", body: KEY_BODY });
    expect(parseEd25519PublicKey(`  ssh-ed25519 ${KEY_BODY}\n`)).toEqual({ type: "ssh-ed25519", body: KEY_BODY });
    for (const bad of ["", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ", "ssh-ed25519", "ssh-ed25519 not*base64", `ssh-ed25519 ${KEY_BODY}\nssh-ed25519 ${KEY_BODY}`]) {
      expect(parseEd25519PublicKey(bad), bad).toBeNull();
    }
    // 选项前缀（restrict,… ssh-ed25519 …）不认：钥匙行由东京那边自己拼
    expect(parseEd25519PublicKey(`restrict ssh-ed25519 ${KEY_BODY}`)).toBeNull();
  });

  it("设备名：小写字母数字和 -，1–32 个，不以 - 开头", () => {
    for (const ok of ["mac", "tokyo-2", "a", "x".repeat(32)]) expect(isTunnelName(ok), ok).toBe(true);
    for (const bad of ["", "-mac", "Mac", "mac book", "x".repeat(33), "mac;id", "../x"]) expect(isTunnelName(bad), bad).toBe(false);
  });
});
