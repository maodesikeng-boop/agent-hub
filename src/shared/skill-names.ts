const SKILL_NAME_RE = /^(?!\.{1,2}$)[^\\/\0]+$/u;

const SKILL_FILE_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/iu;

export const isSkillName = (name: string): boolean => SKILL_NAME_RE.test(name);

const validName = (name: string | undefined): string | null => (name !== undefined && isSkillName(name) ? name : null);

export function skillNameOf(raw: string | undefined): string | null {
  return validName(raw?.trim().split(":").findLast((part) => part.trim() !== "")?.trim());
}

export function skillNameOfFile(path: string): string | null {
  return validName(SKILL_FILE_RE.exec(path)?.[1]);
}
