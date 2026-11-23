import {
  attachmentsOf,
  isRewoundMessage,
  systemNoticeText,
  type ConversationId,
  type Message,
  type Pm,
  type Project,
  type ProjectFolder,
} from "../shared/index.ts";
import { isQuietMessage } from "../shared/reminders.ts";
import { defaultLookOf, resolvePmLook, type SlimeLook } from "../shared/slimes.ts";
import { stripMarkdown } from "./plainText.ts";
import type { ConversationView, HubState } from "./state.ts";

export interface ConversationEntry {
  id: ConversationId;
  name: string;
  look: SlimeLook;
  lastMessage: Message | null;
  lastAt: number;
  pm: Pm | null;
  project: Project | null;
  folders: ProjectFolder[];
}

const EMPTY_FOLDERS: ProjectFolder[] = [];
const conversationListCache = new WeakMap<
  HubState["conversations"],
  { pms: HubState["pms"]; projects: HubState["projects"]; folders: HubState["folders"]; entries: ConversationEntry[] }
>();
const conversationEntryCache = new WeakMap<
  ConversationView,
  { pm: Pm | null; project: Project | null; folders: ProjectFolder[]; entry: ConversationEntry }
>();
const previewTextCache = new WeakMap<Message, string>();

function previewMessage(messages: Message[]): Message | null {
  let fallback: Message | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isQuietMessage(m)) continue;
    fallback ??= m;
    if (m.kind === "text") return m;
  }
  return fallback;
}

export function listConversations(state: HubState): ConversationEntry[] {
  const hit = conversationListCache.get(state.conversations);
  if (hit !== undefined && hit.pms === state.pms && hit.projects === state.projects && hit.folders === state.folders) return hit.entries;
  const entries = computeConversationList(state);
  conversationListCache.set(state.conversations, { pms: state.pms, projects: state.projects, folders: state.folders, entries });
  return entries;
}

function computeConversationList(state: HubState): ConversationEntry[] {
  const pmById = new Map(state.pms.map((p) => [p.id, p]));
  const projectByConvId = new Map(state.projects.map((p) => [p.conversationId, p]));
  const foldersByProjectId = new Map<number, ProjectFolder[]>();
  for (const f of state.folders) {
    let list = foldersByProjectId.get(f.projectId);
    if (list === undefined) {
      list = [];
      foldersByProjectId.set(f.projectId, list);
    }
    list.push(f);
  }
  return Object.values(state.conversations)
    .filter((view) => view.conversation.kind !== "worker")
    .map((view): ConversationEntry => {
      const { conversation } = view;
      const pm = conversation.pmId === null ? null : (pmById.get(conversation.pmId) ?? null);
      const project = projectByConvId.get(conversation.id) ?? null;
      const folders = project
        ? (foldersByProjectId.get(project.id)?.toSorted((a, b) => Number(b.isMain) - Number(a.isMain) || a.id - b.id) ?? EMPTY_FOLDERS)
        : EMPTY_FOLDERS;
      const cached = conversationEntryCache.get(view);
      if (
        cached !== undefined &&
        cached.pm === pm &&
        cached.project === project &&
        cached.folders.length === folders.length &&
        cached.folders.every((f, i) => f === folders[i])
      ) {
        return cached.entry;
      }
      const last = view.messages.findLast((m) => !isQuietMessage(m));
      const entry: ConversationEntry = {
        id: conversation.id,
        name: pm?.name ?? conversation.title,
        look: pm !== null ? resolvePmLook(pm) : defaultLookOf(conversation.id),
        lastMessage: previewMessage(view.messages),
        lastAt: last?.createdAt ?? conversation.createdAt,
        pm,
        project,
        folders,
      };
      conversationEntryCache.set(view, { pm, project, folders, entry });
      return entry;
    })
    .toSorted((a, b) => b.lastAt - a.lastAt || a.id - b.id);
}

export function previewText(entry: ConversationEntry): string {
  const last = entry.lastMessage;
  if (!last) return "";
  const cached = previewTextCache.get(last);
  if (cached !== undefined) return cached;
  const files = attachmentsOf(last);
  let result: string;
  if ((last.text.trim() === "" || isRewoundMessage(last)) && files.length > 0) result = `[File] ${files.map((f) => f.name).join(", ")}`;
  else if (last.sender === "system") result = systemNoticeText(last);
  else result = last.sender === "agent" ? stripMarkdown(last.text) : last.text;
  previewTextCache.set(last, result);
  return result;
}
