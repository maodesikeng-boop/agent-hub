import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UI_TOKEN_FILE_MODE } from "../../shared/index.ts";

/** Restrict characters because the token is also a cookie value; empty or semicolon values would break the cookie. */
export const UI_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export function newUiToken(): string {
  return randomBytes(32).toString("base64url");
}

export function loadOrCreateUiToken(uiTokenFile: string): string {
  let token: string | null = null;
  try {
    const existing = readFileSync(uiTokenFile, "utf8").trim();
    if (UI_TOKEN_PATTERN.test(existing)) token = existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (token === null) {
    token = newUiToken();
    writeUiToken(uiTokenFile, token);
  }
  // writeFileSync's mode is masked by umask and ignored for existing files, so permissions are checked every time.
  if ((statSync(uiTokenFile).mode & 0o777) !== UI_TOKEN_FILE_MODE) chmodSync(uiTokenFile, UI_TOKEN_FILE_MODE);
  return token;
}

export function rotateUiToken(uiTokenFile: string): string {
  const token = newUiToken();
  writeUiToken(uiTokenFile, token);
  return token;
}

function writeUiToken(uiTokenFile: string, token: string): void {
  mkdirSync(dirname(uiTokenFile), { recursive: true });
  writeFileSync(uiTokenFile, `${token}\n`, { mode: UI_TOKEN_FILE_MODE });
  if ((statSync(uiTokenFile).mode & 0o777) !== UI_TOKEN_FILE_MODE) chmodSync(uiTokenFile, UI_TOKEN_FILE_MODE);
}

export function loginUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/auth?token=${token}`;
}
