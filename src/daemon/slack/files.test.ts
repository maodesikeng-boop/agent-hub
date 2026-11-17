import { describe, it } from "vitest";

describe("uploadSlackFiles", () => {
  it.todo("每个文件调一次上传，发在频道主聊天流里，返回 Slack 文件编号");
  it.todo("文件不在了、超过 MAX_SENT_FILE_BYTES 的进 failed，不影响别的");
});

describe("downloadSlackFiles", () => {
  it.todo("下载后用 saveUpload 存进上传目录，返回的附件能被 resolveUpload 找到");
  it.todo("超过 MAX_UPLOAD_BYTES 的、超过 MAX_ATTACHMENTS_PER_MESSAGE 个以后的进 skipped，写明原因");
  it.todo("下载失败的进 skipped，不留半截文件");
});
