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

`response` 里的字段：`commands`、`agents`、`output_style`、`available_output_styles`、`user_output_styles_dir`、**`models`**、`account`（账号信息，我们不读、不存、不转发）、
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
