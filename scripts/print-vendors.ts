// 给 scripts/provision-linux.sh 用：按名单（src/vendors/registry.ts）每家打一行，制表符分隔：
//   编号  命令名  安装命令（paths.ts 的 installCommand，没写是空）  登录命令（没有浏览器的机器用的，paths.ts 的 headlessLoginCommand ?? spec 的 cli.loginCommand）
// 脚本据此装 CLI、打登录提示，加厂商不用改脚本。只读名单，不碰网络和文件。用法：node scripts/print-vendors.ts
import { VENDOR_PATHS } from "../src/vendors/paths-registry.ts";
import { VENDOR_LIST } from "../src/vendors/registry.ts";

for (const { id, cli } of VENDOR_LIST) {
  const { installCommand, headlessLoginCommand } = VENDOR_PATHS[id];
  console.log([id, cli.command, installCommand ?? "", headlessLoginCommand ?? cli.loginCommand].join("\t"));
}
