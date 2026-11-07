// 守护进程所在的机器能做什么：网页按它显示控件（不是按浏览器的系统判断——浏览器可能在另一台电脑上，通过 SSH 隧道连着服务器）。
// 前后端都能引：只用字符串，不碰 node:process。

export interface ServerInfo {
  /** process.platform：darwin、linux…… */
  platform: string;
  /** 能弹系统原生的“选择文件夹”（daemon/pick-folder.ts，macOS 的 osascript）。false：网页隐藏“选择…”，只留手填路径的输入框。 */
  folderPicker: boolean;
  /** 能在这台机器的桌面上“在 Finder 中显示 / 用默认程序打开”文件（daemon/open-file.ts，macOS 的 open）。false：网页隐藏这两个按钮。 */
  fileActions: boolean;
}

/**
 * 这两项只在 macOS 上有：别的系统（Linux 服务器一般没有桌面，有的话 xdg-open 也开在服务器的屏幕上，不是用户的浏览器那台电脑）一律没有。
 * platform 是 process.platform 的值。
 */
export function serverInfoFor(platform: string): ServerInfo {
  const desktop = platform === "darwin";
  return { platform, folderPicker: desktop, fileActions: desktop };
}
