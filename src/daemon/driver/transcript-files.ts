import { readdirSync, statSync } from "node:fs";

export interface TranscriptRef {
  vendor: string;
  vendorSessionId: string;
  cwd: string;
}

export interface TranscriptRoots {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

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
