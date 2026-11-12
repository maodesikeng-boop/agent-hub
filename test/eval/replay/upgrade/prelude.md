在 Pi 里配模型分直接填官方 API Key 和接本地 OpenAI 兼容网关两种路子，配置好以后 Fusa 里的 Pi 厂商下拉菜单也会自动刷出对应的模型。

**推荐做法是用官方 API Key 直连，最稳妥也最简单。**
我刚核对了本机装好的 `pi 1.5.0` 文档与 [`pi.md`](~/agent-hub/docs/vendors/pi.md)，Pi 原生内置了 Google Gemini 模型商，不用装任何插件：
1. 在终端运行 `pi` 进入交互界面，输入 `/login`。
2. 在列表里选 **Google Gemini**，粘贴你在 Google AI Studio 申请的 `GEMINI_API_KEY`，密钥会自动存进 `~/.pi/agent/auth.json`。
3. 输入 `/model` 就能搜到并切换 `google/gemini-...` 系列模型，按 `Ctrl+S` 可设为默认；回到 Fusa 选 Pi 厂商时，模型列表也会自动读取 `~/.pi/agent/auth.json` 把这些 Gemini 模型和思考档位列出来。如果你用的是 Google Cloud Vertex AI，设好 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION` 并跑一次 `gcloud auth application-default login` 同样直接生效。

**如果你是想把本地 Ollama 或 OpenRouter 等兼容接口接进 Pi。**
可以在 `~/.pi/agent/models.json` 里加一段自定义 `openai-completions` 端点（例如指向本机 `http://127.0.0.1:11434/v1` 或 `pi-bridge` 本地端口 `http://127.0.0.1:18080/v1`）：
```json
{
  "providers": {
    "local-openai": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen3-coder:30b" }
      ]
    }
  }
}
```
保存后在 `pi` 里敲 `/model` 就能直接切换运行。

---
