// 测试专用的假厂商 acme（docs/vendor-plugin-design.md 5.3 节、第 9 节拍板点 7 选 B）：不在生产名单里，
// 只在 src/vendors/acme-contract.test.ts 里加进名单，证明“新文件夹 + 名单一项”就够公共代码认它。只填必需字段，可选的都不写、走兜底。
import { PRODUCT_NAME } from "../../../../src/shared/names.ts";
import { defineVendor } from "../../../../src/vendors/types.ts";

export default defineVendor({
  id: "acme",
  label: "Acme Rocket",
  cli: {
    command: "acme",
    envVar: "AGENT_HUB_ACME",
    loginCommand: "acme login",
    fallbackPaths: ({ linuxInstallDirs, join }) => linuxInstallDirs.map((dir) => join(dir, "acme")),
  },
  home: {
    dirs: [".acme"],
    readonlySecrets: [".acme/token.json"],
    catalogWatchPaths: [".acme/token.json", ".acme/config.json"],
  },
  models: {
    bundled: [
      { id: "acme-ultra-9", label: "Acme Ultra 9" },
      { id: "acme-mini-2", label: "Acme Mini 2", efforts: ["low"] },
    ],
    customModel: true,
    customModelExample: "如 acme-ultra-9",
    efforts: ["low", "high", "turbo"],
    flags: { model: "--model", effort: "--reasoning" },
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: { clear: `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令` },
  },
  prompt: {
    subagentTools: ["acme_spawn"],
    backgroundCommandTool: "后台命令参数",
  },
  failure: {
    serviceName: "Acme",
    rawHint: /^acme_not_found\b|\bacme\b/i,
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
  },
});
