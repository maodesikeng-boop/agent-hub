// 守护进程所在的机器能做什么：网页按它显示控件（不是按浏览器的系统判断——浏览器可能在另一台电脑上，通过 SSH 隧道连着服务器）。
// 前后端都能引：只用字符串，不碰 node:process。

export interface ServerInfo {
  /** process.platform：darwin、linux…… */
  platform: string;
  /** 能弹系统原生的“选择文件夹”（daemon/pick-folder.ts，macOS 的 osascript）。false：网页隐藏“选择…”，只留手填路径的输入框。 */
  folderPicker: boolean;
  /**
   * 能在这台机器的桌面上“在 Finder 中显示 / 用默认程序打开”文件（daemon/open-file.ts，macOS 的 open），并且浏览器就在这台机器上（请求来自回环地址）。
   * false：网页隐藏这两个按钮。手机或别的电脑看这台 Mac 上的项目时是 false。
   */
  fileActions: boolean;
  /** 本机仓库根目录（仅请求来自回环地址时返回，供“连到中心”向导拼 join 命令；远程访问不暴露本机路径）。 */
  repoDir?: string;
}

/**
 * 按平台与是否经桌面外壳监管给出服务端桌面能力：
 * - darwin：osascript 选文件夹 + open 在 Finder 中显示/默认程序打开；
 * - win32：explorer.exe 在资源管理器中显示/默认程序打开（仅回环访问生效）；纯浏览器下隐藏“选择…”，经桌面外壳（supervised）时开启；
 * - linux 等服务器系统：两项均关闭。
 */
export function serverInfoFor(platform: string, options?: { supervised?: boolean }): ServerInfo {
  if (platform === "darwin") return { platform, folderPicker: true, fileActions: true };
  if (platform === "win32") {
    return { platform, folderPicker: options?.supervised === true, fileActions: true };
  }
  return { platform, folderPicker: false, fileActions: false };
}

/** 回环地址：请求来自守护进程所在的这台机器（127.0.0.0/8、::1、::ffff:127.x）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "::1" || /^(::ffff:)?127\./i.test(address);
}

/** 给这个请求的浏览器看的 ServerInfo：fileActions 和 repoDir 还要浏览器和守护进程在同一台机器（“同一台机器才显示”的唯一判断）。 */
export function serverInfoForClient(info: ServerInfo, remoteAddress: string | undefined): ServerInfo {
  const sameMachine = isLoopbackAddress(remoteAddress);
  const { repoDir, ...rest } = info;
  return {
    ...rest,
    fileActions: info.fileActions && sameMachine,
    ...(sameMachine && repoDir !== undefined ? { repoDir } : {}),
  };
}
