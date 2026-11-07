// 设备网址：只认 tailnet 里的 https://<机器>.<tailnet>.ts.net（serve 的地址），测试时另认本机回环地址。
// 转发只会发到存下来的设备网址（防 SSRF），存之前一律过这里。
import { isIP } from "node:net";

const TAILNET_SUFFIX = ".ts.net";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
/** DNS 标签：字母数字和连字符，不以连字符开头结尾。 */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * 规范化设备网址：只留 origin（小写、不带末尾斜杠）。不认的（别的域名、IP、带路径 / 参数 / 账号密码、http 的 ts.net）回 null。
 * allowLoopback：再认 http://127.0.0.1:<端口>、http://localhost:<端口>（ENV_ALLOW_LOOPBACK_PEERS）。
 */
export function normalizePeerUrl(raw: unknown, allowLoopback: boolean): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return null;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    if (!host.endsWith(TAILNET_SUFFIX) || isIP(host) !== 0) return null;
    const labels = host.split(".");
    // 至少 <机器>.<tailnet>.ts.net
    if (labels.length < 4 || !labels.every((l) => DNS_LABEL.test(l))) return null;
    return url.port === "" ? `https://${host}` : null;
  }
  if (url.protocol === "http:" && allowLoopback && LOOPBACK_HOSTS.has(host) && url.port !== "") return `http://${host}:${url.port}`;
  return null;
}
