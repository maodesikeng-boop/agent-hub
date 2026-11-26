export interface ServerInfo {
  platform: string;
  folderPicker: boolean;
  fileActions: boolean;
  repoDir?: string;
  currentQuota?: true;
}

export function serverInfoFor(platform: string, options?: { supervised?: boolean }): ServerInfo {
  if (platform === "darwin") return { platform, folderPicker: true, fileActions: true };
  if (platform === "win32") {
    return { platform, folderPicker: options?.supervised === true, fileActions: true };
  }
  return { platform, folderPicker: false, fileActions: false };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "::1" || /^(::ffff:)?127\./i.test(address);
}

export function serverInfoForClient(info: ServerInfo, remoteAddress: string | undefined): ServerInfo {
  const sameMachine = isLoopbackAddress(remoteAddress);
  const { repoDir, ...rest } = info;
  return {
    ...rest,
    fileActions: info.fileActions && sameMachine,
    ...(sameMachine && repoDir !== undefined ? { repoDir } : {}),
  };
}
