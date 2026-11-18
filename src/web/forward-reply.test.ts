import { describe, it } from "vitest";

describe("forwardReplyOf", () => {
  it.todo("原消息在近窗且处理中：返回 waiting");
  it.todo("原消息 replied、回复也在近窗：返回 replied，带着那条回复");
  it.todo("原消息 replied、有 replyId 但回复不在近窗：返回 null（要补取）");
  it.todo("原消息不在近窗：返回 null");
  it.todo("原消息 stopped：返回 ended，不把它后面别的轮次的文字当回复");
  it.todo("同一个项目经理对话里相近的两问两答：每条转交只拿到自己那一轮的回复");
  it.todo("messages 数组没变时返回同一个对象；对话里来了无关的新消息，已定的回复对象不变");
});

describe("useForwardReply", () => {
  it.todo("近窗能定时不发补取请求");
  it.todo("近窗定不了时向目标设备补取一次，同一编号在多次渲染里不重复请求");
  it.todo("补取到 waiting 后，那台设备推来原消息变 replied 和回复：改用近窗结果");
  it.todo("那台设备重拉快照后，在途状态的补取结果作废、重新取");
  it.todo("配对设备离线：返回 unknown，不报错；重连后补齐");
  it.todo("补取 404（老版本设备、消息已清理）：返回 silent");
  it.todo("本机和配对设备上编号相同的两条消息互不串：按设备键分开");
});
