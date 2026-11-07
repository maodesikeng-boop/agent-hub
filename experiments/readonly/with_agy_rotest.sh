#!/bin/sh
# 临时把测试 MCP 服务器 rotest 加进 agy 的全局 MCP 配置，跑完立刻恢复备份
CFG=$HOME/.gemini/config/mcp_config.json
cp "$CFG" /tmp/ro110/mcp_config.backup.json || exit 1
python3 -c "import json,sys;p=sys.argv[1];m=json.load(open(p));m['mcpServers']['rotest']={'command':'node','args':['/tmp/ro110/mcp/server.mjs']};json.dump(m,open(p,'w'),indent=2)" "$CFG"
"$@"
cp /tmp/ro110/mcp_config.backup.json "$CFG"; rm -rf "$HOME/.gemini/antigravity-cli/mcp/rotest"
cmp -s "$CFG" /tmp/ro110/mcp_config.backup.json && echo "config restored"
