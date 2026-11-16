import { describe, it } from "vitest";

describe("界面清单", () => {
  it.todo("id 不重复，每个 id 以它所属的区域开头");
  it.todo("每个界面至少有一个视口，视口名都在 VIEWPORTS 里");
  it.todo("清单里每个界面在 SCREEN_STEPS 里都有到达步骤");
  it.todo("到达步骤里引的补丁名都在 PATCH_NAMES 里");
  it.todo("每个区域都有 normal 以外的状态（空、出错、超长、在忙至少一种）");
});

describe("expandShots", () => {
  it.todo("每个界面按它的每个视口各出一张，key 是 <id>@<视口> 且不重复");
  it.todo("only 给区域名时只留这个区域的界面");
  it.todo("only 里有清单里没有的 id 时抛 RangeError");
});

describe("batchShots", () => {
  it.todo("每张图恰好在一批里，每批不超过 batchSize 张");
  it.todo("batchSize 是 0 或小数时抛 RangeError");
  it.todo("哨兵图平均分到各批");
  it.todo("seed 相同分法相同，seed 不同批内顺序不同");
});

describe("judgeWaves", () => {
  it.todo("5 批、两家评委排成两个波次：前 3 批一波，后 2 批一波，每波不超过 JUDGE_MAX_CONCURRENT 个 Worker");
  it.todo("每批恰好在一个波次里，顺序不变");
});

describe("inventoryMarkdown", () => {
  it.todo("按区域分组，最后一行写界面数和图数，和清单数出来的一致");
});
