// 找会话原始记录用的通用小函数和类型（各家的找法在 src/vendors/<厂商>/transcript.ts，按家分发在 transcript.ts）。
// 只读文件系统，不写、不删。
import { readdirSync, statSync } from "node:fs";

export interface TranscriptRef {
  vendor: string;
  vendorSessionId: string;
  cwd: string;
}

export interface TranscriptRoots {
  /** 用户目录，默认 os.homedir()；测试用。 */
  home?: string;
  /** 环境变量，默认 process.env（各家配置目录的环境变量）。 */
  env?: Readonly<Record<string, string | undefined>>;
}

/** 会话 ID 要能当文件名的一部分：不含路径分隔符，也不是 . / ..。 */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};
