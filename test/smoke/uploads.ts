// 聊天框上传文件的冒烟：S15 项目经理（真 claude，项目文件夹在别处）读 ~/.agent-hub/uploads/ 下的文件会不会被权限拦。
// S16 整条路：走上传接口、带 attachmentIds 发消息，项目经理按消息里的绝对路径读到文字文件的内容、认出图片的颜色。
// S15 的文件放在真实的 ~/.agent-hub/uploads/_smoke-<随机>/ 下（权限规则按路径匹配，用临时目录测不出家目录下的情况），跑完删掉这个子目录，不碰别的。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { API_PATHS, type Attachment } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { waitForStatus } from "../e2e/harness.ts";
import { MODEL, Smoke, expect, scenario, type Outcome } from "./kit.ts";

/** 纯红色的 PNG（宽高各 16 像素），不依赖任何图片库。 */
export function redPng(size = 16): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function inFreshSmoke(outcomes: Outcome[], name: string, fn: (smoke: Smoke) => Promise<string>): Promise<void> {
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, name, () => fn(smoke));
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: `${name}（收尾）`, ok: false, detail: problems.join("；") });
}

export async function runUploads(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S16")) {
    await inFreshSmoke(outcomes, "S16 上传 → 带附件发消息 → 项目经理按路径读到内容", async (smoke) => {
      const secret = `MANGO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const project = smoke.folder("s16", { "readme.txt": "项目文件夹\n" });
      const { conversationId } = await smoke.client.createPm({ name: "阿周", mode: "hands_on", defaultModel: MODEL, persona: "阿周：简洁、直接。", folder: project });
      const up = async (name: string, body: Buffer): Promise<Attachment> => {
        const res = await fetch(smoke.client.base + `${API_PATHS.uploads}?name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: smoke.client.headers({ "content-type": "application/octet-stream" }),
          body,
        });
        if (res.status !== 200) throw new Error(`上传 ${name} 失败：${res.status} ${await res.text()}`);
        return (await res.json()) as Attachment;
      };
      const note = await up("../便签.txt", Buffer.from(`暗号是 ${secret}\n`));
      const picture = await up("红.png", redPng());
      const res = await fetch(smoke.client.base + API_PATHS.messages(conversationId), {
        method: "POST",
        headers: smoke.client.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId: crypto.randomUUID(), text: "读一下附带的两个文件：只回复文字文件里的暗号原文，再用一个词说图片是什么颜色，用逗号隔开。", attachmentIds: [note.id, picture.id] }),
      });
      expect(res.status === 200, `发消息失败：${res.status}`);
      const messageId = ((await res.json()) as { messageId: number }).messageId;
      await waitForStatus(smoke.client, messageId, "replied", 180_000);
      const reply = (await smoke.repliesAfter(conversationId, messageId)).join("\n");
      const session = await smoke.currentSession(conversationId);
      const denials = smoke.permissionDenials(session.sessionId);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      expect(reply.includes(secret), `回复里没有暗号 ${secret}：${reply}`);
      expect(/红|red/i.test(reply), `回复里没认出红色：${reply}`);
      expect(note.name === "便签.txt", `文件名没清理：${note.name}`);
      return `项目经理按路径 ${note.path} 读到暗号、认出图片是红色，permission_denials 为空；回复：${reply}`;
    });
  }
  if (!only("S15")) return;
  await inFreshSmoke(outcomes, "S15 项目经理读 ~/.agent-hub/uploads/ 下的文字文件和图片不被权限拦", async (smoke) => {
    const secret = `KIWI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const project = smoke.folder("s15", { "readme.txt": "项目文件夹，和上传的文件不在一起\n" });
    // 用真实家目录下的数据目录（resolveHubPaths 和守护进程默认的算法一样）
    const uploads = resolveHubPaths({}, homedir()).uploadsDir;
    const dir = join(uploads, `_smoke-${secret}`);
    mkdirSync(dir, { recursive: true });
    try {
      const textFile = join(dir, "便签.txt");
      const imageFile = join(dir, "红.png");
      writeFileSync(textFile, `暗号是 ${secret}\n`);
      writeFileSync(imageFile, redPng());
      const { conversationId } = await smoke.client.createPm({ name: "阿周", mode: "hands_on", defaultModel: MODEL, persona: "阿周：简洁、直接。", folder: project });
      const text = await smoke.ask(conversationId, `用读文件的工具读 ${textFile}，只回复里面的暗号原文。`);
      const image = await smoke.ask(conversationId, `用读文件的工具看 ${imageFile} 这张图，只回复它是什么颜色（一个词）。`);
      const session = await smoke.currentSession(conversationId);
      const denials = smoke.permissionDenials(session.sessionId);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      expect(text.replies.join("\n").includes(secret), `没读到文字文件里的暗号 ${secret}：${text.replies.join("|")}`);
      expect(/红|red/i.test(image.replies.join("\n")), `没认出图片是红色：${image.replies.join("|")}`);
      return `项目文件夹在 ${project}，读 ${dir} 下的文字文件拿到暗号、图片认出是红色，permission_denials 为空`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
