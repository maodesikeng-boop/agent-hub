// 界面用户令牌：第一次启动生成，存在 state/ui-token（权限 0600），之后沿用（见 shared/limits.ts 的 UI_COOKIE_NAME）。
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UI_TOKEN_FILE_MODE } from "../../shared/index.ts";

/** 令牌只允许这些字符（也是 cookie 值），至少 16 个，免得空串或带分号的值混进 cookie。 */
export const UI_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

/** 一个新的界面令牌：32 字节随机。 */
export function newUiToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 读 uiTokenFile；没有或内容不合格就生成新的写进去。权限比 0600 宽就改回来。 */
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
  // writeFileSync 的 mode 受 umask 影响、对已有文件也不生效，所以每次都核对。
  if ((statSync(uiTokenFile).mode & 0o777) !== UI_TOKEN_FILE_MODE) chmodSync(uiTokenFile, UI_TOKEN_FILE_MODE);
  return token;
}

/** 换主钥匙（“全部退出”）：生成新的写进文件（权限 0600），返回它。 */
export function rotateUiToken(uiTokenFile: string): string {
  const token = newUiToken();
  writeUiToken(uiTokenFile, token);
  return token;
}

function writeUiToken(uiTokenFile: string, token: string): void {
  mkdirSync(dirname(uiTokenFile), { recursive: true });
  // writeFileSync 的 mode 对已有文件不生效，先写再核对权限
  writeFileSync(uiTokenFile, `${token}\n`, { mode: UI_TOKEN_FILE_MODE });
  if ((statSync(uiTokenFile).mode & 0o777) !== UI_TOKEN_FILE_MODE) chmodSync(uiTokenFile, UI_TOKEN_FILE_MODE);
}

/** 启动时打印给用户的登录链接。 */
export function loginUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/auth?token=${token}`;
}
