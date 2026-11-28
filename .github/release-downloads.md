### 下载与校验 / Downloads and checksums

| 平台 / Platform | 安装包 / Installer | 校验文件 / Checksum |
| --- | --- | --- |
| Apple 芯片 Mac / Apple silicon Mac (macOS 13+) | `Bellwood-macos-arm64.dmg` | `Bellwood-macos-arm64.dmg.sha256` |
| Windows x64 | `Bellwood-windows-x64-setup.exe` | `Bellwood-windows-x64-setup.exe.sha256` |

安装包为未签名预览版。验证校验值后，macOS 如阻止启动，可在「系统设置 → 隐私与安全性」中选择「仍要打开」。Windows 如弹出 SmartScreen，可选「更多信息 → 仍要运行」。

These installers are unsigned previews. After checking the checksum, use **Open Anyway** in macOS **Privacy & Security** or **More info**, then **Run anyway** in Windows SmartScreen if the system blocks the app.

- macOS: `shasum -a 256 -c Bellwood-macos-arm64.dmg.sha256`
- Windows: `Get-FileHash Bellwood-windows-x64-setup.exe -Algorithm SHA256`. Compare `Hash` with the value in the `.sha256` file.

### 多端验收矩阵 / Verification matrix

查看绑定发布版本与提交号的逐厂商 × 逐平台实测与覆盖边界（区分真实服务、真 CLI 模拟模型与离线测试）：[`docs/verification-matrix.md`](https://github.com/{{RELEASE_REPO}}/blob/{{RELEASE_REF}}/docs/verification-matrix.md)。

See the release-pinned, commit-bound per-vendor x per-platform verification matrix (separating live vendor service runs, real-CLI mock-LLM CI, offline tests, and unverified gaps): [`docs/verification-matrix.md`](https://github.com/{{RELEASE_REPO}}/blob/{{RELEASE_REF}}/docs/verification-matrix.md).
