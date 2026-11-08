// 凭据清单：家目录下谁都不能读（只读 Worker 禁读）、也不能当文件分享到网页的路径。这是“凭据”的唯一一份，以后加一条只改这里：
// - 分享禁用（daemon/sent-files.ts 的 SENSITIVE_HOME_PATHS）= 这份 + 各家厂商的整个目录（vendors.ts 的 VENDOR_HOME_PATHS.dirs，会话记录也不给网页看）；
// - 只读禁读（readonly-policy.ts 的 READONLY_SECRET_HOME_PATHS）= 这份 + 各家厂商的令牌文件（VENDOR_HOME_PATHS.readonlySecrets）+ state/ 下的令牌，
//   厂商目录里的会话记录、日志留给只读 Worker 排查时读。
// 相对用户主目录。目录按子树算。

export const CREDENTIAL_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".netrc",
  ".git-credentials",
  ".config/gh",
  ".config/gcloud",
  ".config/hub",
  ".kube",
  ".docker",
  ".npmrc",
  ".pypirc",
  ".password-store",
  "Library/Keychains",
  "Library/Cookies",
  // Linux：登录钥匙环（Secret Service，agy 的登录令牌也在里面）、浏览器的 cookie 和密码库
  ".local/share/keyrings",
  ".config/google-chrome",
  ".config/chromium",
  ".mozilla",
  ".zsh_history",
  ".bash_history",
];
