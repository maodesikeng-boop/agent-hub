fusa 的模型列表每个厂商最多显示 50 个，magpie 给 Pi 塞了 67 个模型（它自动读到了本机 Claude Code、Codex、Cursor 的登录），排序时 Gemini 被挤出了前 50。
推荐 A：只改 magpie 给 Pi 看的模型范围，不删任何登录、不动 Claude Code/Codex/Cursor 本身；改完 Pi 列表约 31 个，Gemini 能出现。

---

Gemini 其实接上了，是被 fusa 的模型列表挤掉了：fusa 每个厂商最多只显示 50 个模型。

我对了两边的数字：
- 直接问 Pi（`pi --list-models`）有 85 个模型：它自己的 Anthropic 18 个，加 magpie 的 67 个，13 个 `antigravity/gemini-*` 都在里面。
- fusa 的列表（`hub models --vendor pi`）正好 50 个，没有一个 Gemini。

**为什么多出很多别的模型**
magpie 默认会自动读取本机其他工具的登录，把它们的模型也开放出来。它在你这台机器上找到了四个账号：

| 来源 | 账号 | 模型数 |
|---|---|---|
| Claude Code | （账号已隐去）（公司账号） | 18 |
| Codex | （账号已隐去） | 8 |
| Cursor | （账号已隐去） | 24 |
| Antigravity | 你刚登录的 Gmail | 13 |

再加几个 `auto/` 模型，一共 67 个，全部塞给了 Pi。

**修法**
我在确认卡里推荐 A：用 `magpie visible pi antigravity` 只让 Pi 看到 Antigravity 的模型，再刷新 fusa 的模型列表。这样 Pi 一共约 31 个模型，Gemini 就能显示出来。这个改动不删任何登录，也不碰 Claude Code、Codex、Cursor 本身。

另外，`claude/`、`codex/`、`cursor/` 这些模型用的就是你那几个账号的额度，尤其 Claude 那个是公司账号。只要不选它们，就不会消耗。

---

