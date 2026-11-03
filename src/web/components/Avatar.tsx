import { Avatar as AvatarRoot, AvatarFallback } from "../ui/avatar.tsx";

/** 团子的身体颜色，按 key 在这一组里轮着取。 */
const BLOB_COLORS = ["#ff3d8b", "#ff7a1a", "#2f8cff", "#18181b", "#1fb37d", "#f5b400"] as const;

/** 头像：一只有两只眼睛的小团子，颜色由 colorKey 决定。 */
export function Avatar({ colorKey, size = 44 }: { colorKey: number; size?: number }) {
  const color = BLOB_COLORS[Math.abs(colorKey) % BLOB_COLORS.length];
  return (
    <AvatarRoot style={{ width: size, height: size }} className="overflow-visible rounded-none" aria-hidden="true">
      <AvatarFallback>
        <svg viewBox="0 0 40 40" className="size-full">
          <path
            d="M20 3c9.5 0 17 6.6 17 16.4C37 29.8 29.6 37 19.6 37 9.9 37 3 30.4 3 20.6 3 10.2 10.6 3 20 3Z"
            fill={color}
          />
          <ellipse cx="16" cy="18" rx="2.2" ry="3.4" fill="#fff" />
          <ellipse cx="24.5" cy="17" rx="2.2" ry="3.4" fill="#fff" />
        </svg>
      </AvatarFallback>
    </AvatarRoot>
  );
}

/** 项目群的头像：项目名首字，底色和团子同一组。 */
export function GroupAvatar({ name, colorKey, size = 44 }: { name: string; colorKey: number; size?: number }) {
  const color = BLOB_COLORS[Math.abs(colorKey) % BLOB_COLORS.length];
  return (
    <span
      data-slot="group-avatar"
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-2xl font-semibold text-white uppercase"
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.42 }}
    >
      {[...name][0] ?? "?"}
    </span>
  );
}

/** 对话的头像：群用首字，私聊用团子。 */
export function EntryAvatar({ kind, name, colorKey, size }: { kind: string; name: string; colorKey: number; size?: number }) {
  return kind === "project_group" ? (
    <GroupAvatar name={name} colorKey={colorKey} size={size} />
  ) : (
    <Avatar colorKey={colorKey} size={size} />
  );
}
