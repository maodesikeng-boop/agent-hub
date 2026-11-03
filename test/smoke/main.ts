// pnpm smoke：用真 claude 跑冒烟场景（m1-plan 第 4 节的 S1～S4、m2-plan 第 4 节的 S5、S6、S8、S9（S7 交接 11-03 拿掉了），外加强制结束 S10、
// m3-plan 第 3 节的 S11～S13（Worker））。
// 不进 pnpm check 和 CI；验收时和每次升级 claude 后手动跑。真 claude 用的是订阅额度，每个场景跑通一次就够，失败了先看日志。
// 只跑一部分：pnpm smoke S5 S6，或 pnpm smoke S10（匹配 S10a、S10b）。S1～S4 是一串（S2 靠 S1 记下的暗号），选其中一个就整串都跑。
// 场景失败时数据目录留着（路径会打印），日志在 <目录>/home/state/logs/sessions/。
// 文件分工：kit.ts 是共用的零件（起守护进程、发消息等回复、读库读日志、查进程）；m1.ts、m2.ts、force-kill.ts、m3.ts 是各组场景。
import { Smoke, CLAUDE, MODEL, type Outcome } from "./kit.ts";
import { runForceKill } from "./force-kill.ts";
import { runM1 } from "./m1.ts";
import { runM2 } from "./m2.ts";
import { runM3 } from "./m3.ts";
import { PRODUCT_NAME } from "../../src/shared/index.ts";

const filters = process.argv.slice(2);
/** 没写过滤就全跑；写了 S10 也匹配 S10a、S10b，但 S1 不匹配 S10a。 */
const only = (name: string) => filters.length === 0 || filters.some((f) => name === f || (name.startsWith(f) && /^[a-z]$/.test(name.slice(f.length))));

const outcomes: Outcome[] = [];
console.log(`${PRODUCT_NAME} smoke：claude=${CLAUDE}，模型 ${MODEL}`);

let exitCode = 0;
try {
  if (["S1", "S2", "S3", "S4"].some(only)) {
    const smoke = await Smoke.boot();
    await runM1(outcomes, smoke);
    const problems = await smoke.finish(outcomes.some((o) => !o.ok));
    if (problems.length > 0) {
      outcomes.push({ name: "S1～S4（收尾）", ok: false, detail: problems.join("；") });
      console.log(`收尾发现问题：${problems.join("；")}`);
    } else {
      console.log("关机后没有残留的 claude 进程");
    }
  }
  await runM2(outcomes, only);
  await runForceKill(outcomes, only);
  await runM3(outcomes, only);
} catch (error) {
  console.error("smoke 没跑完：", error);
  exitCode = 1;
}

const failed = outcomes.filter((o) => !o.ok);
console.log(`\n结果：${outcomes.length - failed.length}/${outcomes.length} 通过`);
for (const o of failed) console.log(`  不过：${o.name}：${o.detail}`);
if (failed.length > 0 || outcomes.length === 0) exitCode = 1;
process.exitCode = exitCode;
