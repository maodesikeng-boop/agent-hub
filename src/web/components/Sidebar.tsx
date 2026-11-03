import { formatTime } from "../format.ts";
import type { ConversationEntry } from "../selectors.ts";
import { Avatar } from "./Avatar.tsx";

export function Sidebar({
  entries,
  activeId,
  onSelect,
}: {
  entries: ConversationEntry[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <nav className="sidebar" aria-label="对话列表">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="contact"
          aria-current={entry.id === activeId ? "true" : undefined}
          onClick={() => onSelect(entry.id)}
        >
          <Avatar name={entry.name} colorKey={entry.avatarKey} />
          <span className="contact-body">
            <span className="contact-row">
              <span className="contact-name">{entry.name}</span>
              {entry.lastMessage && <span className="contact-time">{formatTime(entry.lastMessage.createdAt)}</span>}
            </span>
            <span className="contact-preview">{entry.lastMessage?.text ?? ""}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
