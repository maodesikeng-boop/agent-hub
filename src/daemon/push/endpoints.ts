// The daemon sends requests to subscription endpoints, so only known push services are accepted to prevent SSRF.

export const PUSH_ENDPOINT_HOSTS: readonly string[] = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];

const WILDCARD_PREFIX = "*.";

function hostAllowed(hostname: string): boolean {
  return PUSH_ENDPOINT_HOSTS.some((pattern) =>
    pattern.startsWith(WILDCARD_PREFIX) ? hostname.length > pattern.length - 1 && hostname.endsWith(pattern.slice(1)) : hostname === pattern,
  );
}

export function isAllowedPushEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && hostAllowed(parsed.hostname);
}
