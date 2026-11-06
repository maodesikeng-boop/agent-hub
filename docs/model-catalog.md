# 模型名单：直接问 claude（实测记录）

2026-11-04，本机 `claude` 2.1.314。

## 怎么问

起 `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence`，往标准输入写一行：

```json
{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}
```

不用发用户消息，约 0.9～1 秒回一行 `{"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{...}}}`。
关掉标准输入它就自己退出。之前会先出几行 `system/hook_started`、`hook_response`（用户的 SessionStart 钩子照常跑），之后还有 `system/commands_changed`，都不用管。
不认识的 subtype 回 `{"subtype":"error","request_id":"…","error":"Unsupported control request subtype: …"}`。

`response` 里的字段（账号相关的那一项这里不列，我们不读、不存、不转发）：`commands`、`agents`、`output_style`、`available_output_styles`、`user_output_styles_dir`、**`models`**、
`pid`、`claude_code_version`、`current_permission_mode`、`feedback_mode`、`analytics_disabled`、`remote_control_*`、`ide_rc_auto_enable_gate`、
`fast_mode_state`、`fast_mode_disabled_reason`、`session_state`、`capabilities`。

## models 原样（没有账号信息）

- `value`：传给 `--model` 的值；`default` 那项是“默认”（不传参数），我们不列进名单，只取它的 `supportedEffortLevels` 给“默认”用。
- `displayName`：下拉里显示的名字。`description`：一句说明（放进下拉项的悬停提示）。
- `supportedEffortLevels`：这个模型支持的思考程度；Haiku 4.5 那项没有这个字段（也没有 `supportsEffort`），按 vendors.ts 的通用档位。

```json
[
  {
    "value": "default",
    "resolvedModel": "claude-opus-5-5",
    "displayName": "Default (recommended)",
    "description": "Opus 5.5 · Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsFastMode": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "opus",
    "resolvedModel": "claude-opus-5-5",
    "displayName": "Opus 5.5",
    "description": "For complex work and everyday tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsFastMode": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "fable",
    "resolvedModel": "claude-fable-5-1",
    "displayName": "Fable 5.1",
    "description": "For your toughest challenges",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "sonnet",
    "resolvedModel": "claude-sonnet-5-5",
    "displayName": "Sonnet 5.5",
    "description": "Most efficient for simpler tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "haiku",
    "resolvedModel": "claude-haiku-5-5",
    "displayName": "Haiku 5.5",
    "description": "Fastest for quick answers",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "claude-haiku-4-5-20251001",
    "resolvedModel": "claude-haiku-4-5-20251001",
    "displayName": "Haiku 4.5",
    "description": "Fastest for quick answers",
    "supportsThinkingOff": true
  },
  {
    "value": "claude-sonnet-5",
    "resolvedModel": "claude-sonnet-5",
    "displayName": "Sonnet 5",
    "description": "Efficient for routine tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  },
  {
    "value": "claude-opus-5",
    "resolvedModel": "claude-opus-5",
    "displayName": "Opus 5",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsFastMode": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  },
  {
    "value": "claude-fable-5",
    "resolvedModel": "claude-fable-5",
    "displayName": "Fable 5",
    "description": "Most capable for your hardest and longest-running tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": false
  },
  {
    "value": "claude-opus-4-8",
    "resolvedModel": "claude-opus-4-8",
    "displayName": "Opus 4.8",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsFastMode": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  },
  {
    "value": "claude-opus-4-7",
    "resolvedModel": "claude-opus-4-7",
    "displayName": "Opus 4.7",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  },
  {
    "value": "claude-opus-4-6",
    "resolvedModel": "claude-opus-4-6",
    "displayName": "Opus 4.6",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  },
  {
    "value": "claude-sonnet-4-6",
    "resolvedModel": "claude-sonnet-4-6",
    "displayName": "Sonnet 4.6",
    "description": "Efficient for routine tasks",
    "supportsEffort": true,
    "supportedEffortLevels": [
      "low",
      "medium",
      "high",
      "max"
    ],
    "supportsAdaptiveThinking": true,
    "supportsAutoMode": true,
    "supportsThinkingOff": true
  }
]
```

## 我们怎么用

`src/daemon/driver/model-catalog.ts`：第一次有人要（`GET /api/models`，网页打开资料页、新建弹窗时）问一次并缓存；6 小时后再有人要时在后台重问（先给旧的）；
没问到（claude 不存在、15 秒超时、回错误、名单是空的或认不出）用 `src/shared/vendors.ts` 打包的名单，5 分钟后才再问，界面不报错。`GET /api/models?refresh=1` 强制重问。
可调的数在 `src/shared/limits.ts`（`MODEL_CATALOG_*`、`MAX_CATALOG_*`）。

和 T3 Code 的区别：T3 不问 claude，自己维护一份模型清单（打包 + 后台从 GitHub 拉新版）；我们问的是本机这个 claude 自己报的名单，
跟着用户装的版本和账号走，不用我们维护；打包的名单只在问不到时兜底。

# agy（Antigravity）的模型和思考程度

2026-11-06，本机 `agy` 1.5.1。每条都是真 agy 在临时目录（`/tmp/agy-exp72`）里问一句 `reply with just: ok`（`--mode plan --output-format stream-json`）跑出来的，结果看 init 事件的 `model` 和最后 `usage.thinking_tokens`。

## `agy --output-format json models` 的名单

思考程度写在模型 ID 里，名字末尾括号里是同一个词：

```
gemini-4-argon-low / -medium / -high        Gemini 4 Argon (Low/Medium/High)
gemini-3.8-flash-low / -medium / -high      Gemini 3.8 Flash (…)
claude-opus-5-5-low / -medium / -high       Claude Opus 5.5 (…)
claude-sonnet-5-5-low / -medium / -high     Claude Sonnet 5.5 (…)
gpt-oss-120b-medium                         GPT-OSS 120B (Medium)     ← 只有一档
```

输出里没有 `currently_selected` 之类的“默认”标记。Antigravity 软件里也是这样：模型一个下拉，思考程度（Low/Medium/High）另一个，GPT-OSS 只有一档。

## 实测

| 命令 | 结果 | init 事件的 model | thinking_tokens |
|---|---|---|---|
| `--model gemini-4-argon`（不带档位） | 能用 | `gemini-4-argon` | 137（agy 自己挑档位，看不出是哪一档） |
| `--model gemini-4-argon-low` | 能用 | `gemini-4-argon-low` | 0 |
| `--model gemini-4-argon --effort high` | 能用 | `gemini-4-argon` | 161 |
| `--model gemini-4-argon-high --effort high` | 能用（同一档） | `gemini-4-argon-high` | 450 |
| `--model gemini-4-argon-low --effort low` | 能用（同一档） | `gemini-4-argon-low` | 0 |
| `--model gemini-4-argon-low --effort high` | **报错，不跑**：`--model gemini-4-argon-low conflicts with --effort=high` | — | — |
| `--model gemini-4-argon --effort xhigh` / `max` | **报错，不跑**：`gemini-4-argon has no "xhigh" effort (available: low, medium, high)` | — | — |
| `--model gpt-oss-120b` | 能用 | `gpt-oss-120b` | 0 |
| `--model gpt-oss-120b --effort medium` | 能用 | — | — |
| `--model gpt-oss-120b --effort high` | **报错**：`gpt-oss-120b has no "high" effort (available: medium)` | — | — |
| `--model claude-sonnet-5-5 --effort medium` | 能用 | `claude-sonnet-5-5` | 0 |
| 只传 `--effort high`（不传模型） | 能用 | 没有 model 字段（默认模型） | 622 |

结论：

- **不带档位的模型名能用**，agy 自己按“模型 + `--effort`”处理；`--effort` 只认这个模型自己有的档位（报错信息里直接列出），xhigh、max 对 Gemini（和 Claude、GPT-OSS）都**没用，直接报错**。
- **完整 ID 和 `--effort` 同时传，对不上就报错，不是“哪个算”**；一致才行。所以我们只传一个。
- 实际用的档位看不出来：init 事件的 model 就是传进去的字符串（不带档位的只回不带档位的名字）；thinking_tokens 一次采样一个数，档位之间差别大（low 是 0、high 几百），但同一档也会波动，只能当参考，不能当证明。
- agy 有三档（low/medium/high），和软件一致；没有 xhigh、max。

## 我们怎么做

- 拆（`src/daemon/driver/model-catalog.ts` 的 `parseAgyModels`）：ID 末尾是清单里的档位词（`VENDOR_SPECS.agy.efforts`，现在是 low、medium、high），并且名字末尾括号里是同一个词，才拆成“不带档位的模型 + 它有的档位”。不看模型名，agy 加了新模型照样拆；拆不开的（不带档位、对不上）原样留着，没有思考程度下拉。
- 拼（`src/shared/vendors.ts` 的 `agentLaunchArgs`）：不带档位的模型 + 思考程度拼回完整 ID，只传一个 `--model gemini-4-argon-high`，**不传 `--effort`**；只有思考程度、模型是默认时才传 `--effort high`（实测能用）；思考程度默认时传不带档位的模型名，档位 agy 自己定。
- 老数据：存着的完整 ID（`gemini-4-argon-high`）资料页、右栏显示成“模型 + 档位”（`splitModelEffort`）；`hub worker start --model gemini-4-argon-high` 和 `--model gemini-4-argon --effort high` 存成一样的；完整 ID 的档位和 `--effort` 对不上，直接 invalid（和 agy 一样不让过），说清楚怎么改。
- 打包的名单（拿不到 `agy models` 时）：上面五个模型，不带档位，GPT-OSS 只有 medium。
- agy 的 `efforts` 现在是 low、medium、high：xhigh、max 会被后台直接拒绝（agy 本来也拒绝）。agy 以后真加了新档位，改 `vendors.ts` 的 `AGY_EFFORTS`。
