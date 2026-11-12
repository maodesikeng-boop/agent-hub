Pi 已经通过 `pi-bridge` 本地服务跑通 OpenRouter 的 `qwen3-coder` 模型，简单问答和读写文件任务都成功；免费池模型 `deepseek-r1:free` 返回 429（公共免费池限流）。Pi 的默认模型已改回 `anthropic/claude-opus-5-5`，`pi-bridge` provider 保留着。

**本地服务**
- 地址 `http://127.0.0.1:18080`，用 `nohup pi-bridge serve` 在后台跑，pid 24180，日志在 `/tmp/pi-bridge-connect/serve.log`。`pi-bridge status` 显示正常（`serve · pid 24180`）。
- 没装开机自启服务。停止：`kill 24180`。

**对 `~/.pi/agent` 的改动**（执行的是 `pi-bridge connect pi openrouter/qwen3-coder`）
- 新增 `models.json`：`providers.pi-bridge` 指向 `http://127.0.0.1:18080/v1`，同步了公开模型目录。
- 新增 `settings.json.before-pi-bridge`，内容和原文件一致。
- `settings.json` 的默认模型曾切到 `pi-bridge` / `openrouter/qwen3-coder`，冒烟测试后已改回 `anthropic/claude-opus-5-5`。
- `auth.json` 没被动过。

**冒烟测试**（都在空目录 `/tmp/pi-bridge-connect/smoke` 里，命令为 `pi -p --no-session --provider pi-bridge --model <模型> "<提示>"`）

| 测试 | 模型 | 结果 |
|---|---|---|
| a) 用一句话回答 1+1 等于几 | `openrouter/qwen3-coder` | ✅ 回复原文：“1 + 1 等于 2。” |
| b) 创建 hello.txt 写入 hi 再读出 | `openrouter/qwen3-coder` | ✅ 回复：“已在当前目录创建 `hello.txt`，读取到的文件内容为：hi”；文件存在且内容为 `hi` |
| a) 同上问答 | `openrouter/deepseek-r1:free` | ❌ exit 1，返回 `429: Public free-tier rate limit exceeded, retry later` |

**收尾**
- 执行 `pi-bridge connect pi anthropic/claude-opus-5-5` 把默认模型切回 Pi 原有配置，保留 `models.json` 里的 `pi-bridge` provider。
- 对比备份：`settings.json` 与备份完全一致；用 `--provider pi-bridge --model openrouter/qwen3-coder` 再跑一次问答仍返回 “1 + 1 等于 2。”。

**用户以后怎么用**
- 确保本地服务在跑（`pi-bridge serve`），再执行 `pi --provider pi-bridge --model openrouter/qwen3-coder`，或在交互界面 Ctrl+P 切换模型。
- 彻底还原：执行 `pi-bridge connect pi default`。

=== 汇报 ===
状态: 做完了
摘要: pi-bridge 服务临时在后台运行（127.0.0.1:18080，pid 24180）；Pi 通过 pi-bridge 调用 openrouter/qwen3-coder 问答和文件读写测试均成功；免费池 deepseek-r1:free 返回 429 公共限流；Pi 默认模型已改回 anthropic/claude-opus-5-5，pi-bridge provider 保留。
提交: 无（仓库工作区干净）
测试: openrouter/qwen3-coder 的问答（“1 + 1 等于 2。”）和文件读写（hello.txt 内容 hi）均通过；恢复默认后 settings.json 与备份一致，显式带 --model 再测仍通过。
问题: 本地服务是 nohup 临时启动的，重启机器或 kill 后需重新运行 `pi-bridge serve`。
=== 汇报结束 ===
