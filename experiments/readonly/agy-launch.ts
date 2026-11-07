// 冒烟脚本（smoke.py 的 S4）用：打印 agy 只读 Worker 真正会用的外层沙箱 profile 和 --settings 内容，
// 就是 daemon 起只读 agy 时生成的那两份（src/daemon/driver/readonly-agy.ts、write-scope.ts），不是脚本里另写的参考写法。
// 用法：node experiments/readonly/agy-launch.ts <主目录> <私有临时目录> '<连接器清单 JSON：{"servers":{"服务器":{"工具":annotations|null}},"unlistable":[]}>'
// 输出一行 JSON：{ profile, settings }。
import { agyConnectorRules, agyReadonlySandboxInput, agyReadonlySettings, type AgyConnectorCatalog } from "../../src/daemon/driver/readonly-agy.ts";
import { readonlySeatbeltProfile } from "../../src/daemon/driver/write-scope.ts";
import { buildReadonlyPolicy } from "../../src/shared/readonly-policy.ts";

const [homeDir, tmpDir, catalogJson] = process.argv.slice(2);
if (homeDir === undefined || tmpDir === undefined) {
  console.error("用法：node experiments/readonly/agy-launch.ts <主目录> <私有临时目录> [连接器清单 JSON]");
  process.exit(2);
}
const catalog: AgyConnectorCatalog = catalogJson === undefined ? { servers: {}, unlistable: [] } : (JSON.parse(catalogJson) as AgyConnectorCatalog);
const policy = buildReadonlyPolicy({ homeDir, stateDir: `${homeDir}/.agent-hub/state` });
const profile = readonlySeatbeltProfile(agyReadonlySandboxInput({ homeDir, tmpDir, policy }));
const settings = agyReadonlySettings(policy, agyConnectorRules(policy, catalog));
console.log(JSON.stringify({ profile, settings }));
