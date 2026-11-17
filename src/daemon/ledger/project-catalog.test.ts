import { describe, it } from "vitest";

describe("project_catalogs 迁移", () => {
  it.todo("迁移后有 project_catalogs 表，删项目时这一行跟着删");
  it.todo("迁移后没有 router_pm_notes 表");
});

describe("scanAtStartup", () => {
  it.todo("没有档案的活跃项目全部进队列，返回进队列的个数");
  it.todo("有档案且切点之后加权字数没到门槛的项目不进队列");
  it.todo("有档案、过了最短间隔且加权字数到门槛的项目进队列");
  it.todo("已归档项目、已归档项目经理的项目不进队列");
});

describe("afterDriverEvent", () => {
  it.todo("项目经理会话 turn.ended 且这个项目到期时进队列，提交后调 onCatalogClaimable");
  it.todo("项目经理会话 turn.ended 但没到期时不进队列，也不叫醒");
  it.todo("Worker、总助会话的事件和项目经理的其他事件什么都不做");
  it.todo("加权字数只算切点之后 kind = text 的用户和项目经理的话，不算工具、Worker 汇报、系统消息");
});

describe("markForcedIn", () => {
  it.todo("建项目的同一个事务里记 forced，新项目马上进队列");
  it.todo("hub graph finish 后记 forced，过了最短间隔就进队列，没过的等到间隔再进");
  it.todo("项目经理换代（handover switched）后记 forced");
  it.todo("事务回滚时 forced 不留下");
  it.todo("不是活跃项目时静默忽略");
});

describe("claimCatalog", () => {
  it.todo("队列空时返回 null，不查库");
  it.todo("切点记成领活那一刻这个项目对话里最大的消息编号");
  it.todo("首次建档的输入里 previous 是 null，带最新一份交接和最近原话");
  it.todo("增量输入只带切点之后的原话、任务图、Worker 汇报和切点之后写成的交接");
  it.todo("原话超过 PROJECT_CATALOG_DIALOG_MAX_CHARS 时从新往旧取并标 dialogTruncated");
  it.todo("同一个项目在跑的时候不会被再领一次");
});

describe("catalogWritten", () => {
  it.todo("存档案和用量，切点前移到 job.cutMessageId，forced、失败次数清零，移出队列");
  it.todo("写成后名片缓存失效：getRouterDigest 的 project.catalog 换成新档案");
  it.todo("档案超过 PROJECT_CATALOG_ROW_MAX_BYTES 时按 invalid_reply 失败记，旧档案不动");
  it.todo("项目在写档期间被删或归档时静默忽略");
});

describe("catalogFailed", () => {
  it.todo("切点不动，旧档案照旧在名片里");
  it.todo("退避从 PROJECT_CATALOG_RETRY_BACKOFF_MS 起每次翻倍");
  it.todo("同一切点失败满 PROJECT_CATALOG_MAX_ATTEMPTS 次后隔 PROJECT_CATALOG_GIVE_UP_MS 再试");
  it.todo("shutdown 不算失败次数、不退避");
});

describe("cardOf / detailOf", () => {
  it.todo("还没写成过档案时都返回 null");
  it.todo("detailOf 带上用户写的 projects.description 和写成时刻");
  it.todo("getRouterDigest 的每个项目带 description 和 catalog，不再带 personaSummary、pmNote");
});
