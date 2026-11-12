在 Pi 里跑 Gemini 分直接配官方密钥和走刚才聊的 Magpie 本地网关两种路子，配置好以后 Fusa 里的 Pi 厂商下拉菜单也会自动刷出对应的 Gemini 模型。

**推荐做法是用 Gemini API Key 直连，最稳妥也最简单。**
我刚核对了本机装好的 `pi 1.5.0` 文档与 [`pi.md`](~/agent-hub/docs/vendors/pi.md)，Pi 原生内置了 Google Gemini 模型商，不用装任何插件：
1. 在终端运行 `pi` 进入交互界面，输入 `/login`。
2. 在列表里选 **Google Gemini**，粘贴你在 Google AI Studio 申请的 `GEMINI_API_KEY`，密钥会自动存进 `~/.pi/agent/auth.json`。
3. 输入 `/model` 就能搜到并切换 `google/gemini-...` 系列模型，按 `Ctrl+S` 可设为默认；回到 Fusa 选 Pi 厂商时，模型列表也会自动读取 `~/.pi/agent/auth.json` 把这些 Gemini 模型和思考档位列出来。如果你用的是 Google Cloud Vertex AI，设好 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION` 并跑一次 `gcloud auth application-default login` 同样直接生效。

**如果你是想用 Magpie 把别的渠道转进 Pi。**
保持本机 Magpie 网关运行后，如果界面里没直接一键绑定 Pi，可以在 `~/.pi/agent/models.json` 里加一段自定义接口指向本机 `127.0.0.1:3425`：
```json
{
  "providers": {
    "magpie": {
      "baseUrl": "http://127.0.0.1:3425/v1",
      "api": "openai-completions",
      "apiKey": "你在magpie里设的key或任意非空字符串",
      "models": [
        { "id": "你在magpie里映射的gemini模型名" }
      ]
    }
  }
}
```
保存后在 `pi` 里敲 `/model` 就能直接选 `magpie/...` 运行。

**有一条账号安全红线得专门提醒你。**
如果你在 Magpie 上游填的是正规 Gemini API Key 或中转 API Key 完全没问题；但如果你打算让 Magpie 读取本机 **Antigravity 订阅的 OAuth 登录态**转给 Pi 用，千万别这么干。[`README.md`](~/agent-hub/README.md#L145-L148) 里摘录的 Google Antigravity 附加条款第 6 条专门点名禁止第三方工具借用 Antigravity OAuth 令牌调服务，触发风控会连带封停账号。要用 Antigravity 订阅里的 Gemini 4 Carbon，直接在 Fusa 里选原生 `Antigravity` 厂商最稳。


---

