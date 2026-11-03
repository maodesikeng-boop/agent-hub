const AVATAR_COLORS = 6;

/** 头像：名字的首字，颜色按 key 在一小组里轮着取。 */
export function Avatar({ name, colorKey, size = "md" }: { name: string; colorKey: number; size?: "sm" | "md" }) {
  const letter = [...name.trim()][0] ?? "?";
  return (
    <span className={`avatar avatar-${size}`} data-color={Math.abs(colorKey) % AVATAR_COLORS} aria-hidden="true">
      {letter}
    </span>
  );
}
