// codex 按会话关技能、MCP、云端连接器（codex-cli 0.169.0 实测）：每个会话一个 app-server 进程，
// 用 `-c` 覆盖只对这个进程生效，不写 ~/.codex/config.toml（skills/config/write 会写全局，不用）。
// `-c` 的键按 `.` 直接切段、不认引号（`plugins."a@b".enabled` 会变成一个叫 `"a@b"` 的键，没效果），
// 所以键只写顶层表名，值写 TOML 内联表，名字放在内联表的引号键里；codex 把它和 config.toml 逐层合并，没写到的照旧。
// - 技能（含插件里的，名字是 `<插件>:<frontmatter name>`）：skills.config=[{name,enabled=false}]；
// - config.toml 里的 MCP：mcp_servers={"<名字>"={enabled=false}}（mcpServerStatus/list 里该服务器工具数变 0）；
// - 插件带的 MCP：plugins={"<插件编号>"={mcp_servers={"<名字>"={enabled=false}}}}。
//   写成 mcp_servers.<名字> 会因为 config.toml 里没有这个服务器的定义，app-server 报 invalid transport 直接退出；
// - 云端连接器（ChatGPT apps）：apps={"<编号>"={enabled=false}}。
// 不整个关插件：逐项关已经够，整个关还会关掉库存里看不到的插件钩子和 apps。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DISABLED = "{enabled=false}";

function inlineTable(entries: ReadonlyArray<readonly [string, string]>): string {
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}=${value}`).join(",")}}`;
}

function disabledTable(names: Iterable<string>): string {
  return inlineTable([...new Set(names)].sort(cmpStr).map((name) => [name, DISABLED] as const));
}

/**
 * 后置：返回接在 `codex app-server` 后面的 `-c key=value` 参数，值是 TOML 字面量；deny 全空返回 []。
 * 每个顶层表最多一条，同样的输入返回逐字相同的数组。
 */
export function codexCapabilityArgs(caps: SessionCapabilities): string[] {
  const args: string[] = [];

  const skills = [...new Set(caps.deny.skills)].sort(cmpStr);
  if (skills.length > 0) {
    const entries = skills.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(",");
    args.push("-c", `skills.config=[${entries}]`);
  }

  const pluginMcp = caps.deny.pluginOf.mcp;
  const configMcp = caps.deny.mcp.filter((name) => !Object.hasOwn(pluginMcp, name));
  if (configMcp.length > 0) args.push("-c", `mcp_servers=${disabledTable(configMcp)}`);

  const byPlugin = new Map<string, string[]>();
  for (const [name, pluginId] of Object.entries(pluginMcp)) {
    const names = byPlugin.get(pluginId);
    if (names) names.push(name);
    else byPlugin.set(pluginId, [name]);
  }
  if (byPlugin.size > 0) {
    const plugins = [...byPlugin.keys()].sort(cmpStr).map((id) => [id, `{mcp_servers=${disabledTable(byPlugin.get(id)!)}}`] as const);
    args.push("-c", `plugins=${inlineTable(plugins)}`);
  }

  if (caps.deny.connectors.length > 0) args.push("-c", `apps=${disabledTable(caps.deny.connectors)}`);

  return args;
}
