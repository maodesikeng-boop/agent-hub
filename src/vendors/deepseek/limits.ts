// deepseek 专属可调常量（公共常量在 src/shared/limits.ts）。

/** 本地凭据文件（$DSH_HOME/.credentials.yaml、$DSH_HOME/.env）探测时允许安全读取的最大字节数（64 KiB）。 */
export const MAX_DEEPSEEK_CREDENTIAL_FILE_BYTES = 64 * 1024;
