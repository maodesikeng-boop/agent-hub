fusa 的模型列表每个厂商最多显示 50 个，`pi-bridge` 把 OpenRouter 全量公开目录的 120 多个模型都塞给了 Pi，按字母排序时 `qwen3-coder` 被挤出了前 50。
推荐 A：只把 `pi-bridge` 给 Pi 暴露的模型收敛到 `coder` 分组，不删登录、不动其他工具；改完 Pi 列表共 32 个，`qwen3-coder` 能正常显示。

---

`qwen3-coder` 其实接上了，是被 fusa 的模型列表上限截掉了：fusa 每个厂商最多只取前 50 个模型。

我对了两边的数字：
- 直接问 Pi（`pi --list-models`）有 142 个模型：它内置的 Anthropic 18 个，加上 `pi-bridge` 从 OpenRouter 拉来的全量公开目录 124 个（含大量归档旧模型与小参数实验模型），`openrouter/qwen3-coder` 在第 90 多位。
- fusa 的列表（`hub models --vendor pi`）截断在 50 个，排在后面的 `qwen3-coder` 没进前 50。

**修法**
我在确认卡里推荐 A：用 `pi-bridge filter pi coder` 只让 Pi 看到 `coder` 分组下的 14 个编程模型，再刷新 fusa 的模型列表（`hub models --vendor pi --refresh`）。这样 Pi 一共 32 个模型，`qwen3-coder` 等常用编程模型都能直接选到。这个改动不删登录凭证，也不改默认模型。

---
