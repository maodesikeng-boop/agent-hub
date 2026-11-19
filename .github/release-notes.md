## Bellwood 未签名预览版 / Unsigned preview

这是**未签名的预览版**：安装包还没有做代码签名与公证，系统首次打开时会拦一下，按下面的步骤放行即可。
This is an **unsigned preview**: the installers are not code-signed or notarized, so the OS will warn on first launch — follow the steps below.

### 下载 / Download

| 平台 / Platform | 文件 / File | 校验 / Checksum |
| --- | --- | --- |
| Mac（Apple 芯片 / Apple silicon, macOS 13+） | `Bellwood-macos-arm64.dmg` | `Bellwood-macos-arm64.dmg.sha256` |
| Windows x64 | `Bellwood-windows-x64-setup.exe` | `Bellwood-windows-x64-setup.exe.sha256` |

### Mac 首次打开 / First launch on Mac

1. 打开 DMG，把 **Bellwood** 拖进「应用程序」。 Open the DMG and drag **Bellwood** into Applications.
2. 双击打开，系统会提示无法验证开发者，点「完成」。 Double-click it; macOS says it cannot verify the developer — click Done.
3. 打开「系统设置 → 隐私与安全性」，滚动到「安全性」，在 Bellwood 那一行点「仍要打开」，输入密码确认。 Open System Settings → Privacy & Security, scroll to Security, click **Open Anyway** next to Bellwood and confirm with your password.
4. 之后可以正常双击打开。 After that it opens normally.

### Windows 首次运行 / First launch on Windows

SmartScreen 拦截时点「更多信息 → 仍要运行」。安装不需要管理员权限。
If SmartScreen blocks it, click **More info → Run anyway**. No administrator rights are needed.

### 校验 / Verify

```sh
shasum -a 256 -c Bellwood-macos-arm64.dmg.sha256          # macOS
```
```powershell
(Get-FileHash Bellwood-windows-x64-setup.exe -Algorithm SHA256).Hash.ToLower()   # 与 .sha256 文件里的值比对
```

---

