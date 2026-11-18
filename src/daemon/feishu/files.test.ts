import { describe, it } from "vitest";

describe("planFeishuFile", () => {
  it.todo("10 MB 以内的图片发图片；更大的图片按文件发");
  it.todo("30 MB 以内的其他文件发文件，fileType 按扩展名定（pdf、doc、xls、ppt、mp4、opus，其余 stream）");
  it.todo("超过 30 MB 的 too_large");
});

describe("createFeishuFileService", () => {
  it.todo("同一个账本文件只上传一次，第二次直接返回记下的消息编号");
  it.todo("下载超过 MAX_UPLOAD_BYTES 时返回 null，上传目录里不留文件");
  it.todo("下载成功存成附件，和网页上传一样的目录和命名");
});
