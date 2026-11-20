export const REDACTED = "***";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [
    /((?:[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_-]*)["']?\s*[=:]\s*["']?)(?!\$\(|\$\{|\$[A-Za-z_]|\*\*\*)[^\s"'&;|)]{4,}/gi,
    `$1${REDACTED}`,
  ],
  [/(--[A-Za-z0-9-]*(?:token|secret|passw(?:or)?d|api-?key|access-?key|credential)[A-Za-z0-9-]*\s+)(?!-|\$)[^\s"';|&]{4,}/gi, `$1${REDACTED}`],
  [/(\s(?:-u|--user)\s+[^\s:]+:)[^\s]+/g, `$1${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
];

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
