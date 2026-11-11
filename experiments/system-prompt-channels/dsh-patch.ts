// 用 Fusa 真实函数（buildDeepSeekSystemPromptPatch）生成 dsh 的提示词补丁：约 43KB，带探针，故意带 {{…}}（dsh 模板会当变量）。
// 用法: [LINES=380] node experiments/system-prompt-channels/dsh-patch.ts <输出.json>
import { writeFileSync } from "node:fs";
import { buildDeepSeekSystemPromptPatch } from "../../src/vendors/deepseek/driver.ts";
const [out] = process.argv.slice(2) as [string];
const filler = Array.from({ length: Number(process.env.LINES ?? 900) }, (_, i) => `第 ${i} 条：项目经理的规矩和 hub 命令表（填充，撑到和真实项目经理提示词一样长）`).join("\n");
const prompt = `# 你的角色\n你是 Fusa 的 Worker。性格设定里用户写了模板示例 {{persona}} 和 {{{x}}}。\n${filler}\n\n探针规则：被问到探针短语时，原样回答 PROBE-FUSA-443-紫藤。\n`;
writeFileSync(out, JSON.stringify(buildDeepSeekSystemPromptPatch(prompt), null, 2));
console.log("prompt bytes", Buffer.byteLength(prompt));
