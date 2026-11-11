// 资料页的“记忆子文件”折叠组（docs/ui-standard.md 第 9 条）：
// 默认收起且收起时不发请求、不常驻配额数字；展开后通过 react-query 按需拉取、查看、编辑、新建或删除 <topic>.md 子文件。
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  PM_MEMORY_MAX_SUBFILES,
  PM_MEMORY_MAX_SUBFILE_BYTES,
  PM_MEMORY_MAX_TOTAL_BYTES,
  PM_MEMORY_SOFT_WARN_RATIO,
  checkPmMemoryFileName,
  utf8Bytes,
  type PmMemoryFileDetail,
  type PmMemoryFileSummary,
  type PmMemoryFilesList,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { useClient } from "../device-scope.tsx";
import { errorText, formatTime, type ErrorLike } from "../format.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { CollapsibleGroup, RowError, SettingsRow } from "./SettingsList.tsx";

const SOFT_SUBFILE_COUNT = Math.ceil(PM_MEMORY_MAX_SUBFILES * PM_MEMORY_SOFT_WARN_RATIO);
const SOFT_SUBFILE_BYTES = Math.ceil(PM_MEMORY_MAX_SUBFILE_BYTES * PM_MEMORY_SOFT_WARN_RATIO);
const SOFT_TOTAL_BYTES = Math.ceil(PM_MEMORY_MAX_TOTAL_BYTES * PM_MEMORY_SOFT_WARN_RATIO);

function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb >= 10 ? `${Math.round(kb)} KB` : `${Number(kb.toFixed(1))} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number(mb.toFixed(2))} MB`;
}

function upsertMemoryFileInList(
  prev: PmMemoryFilesList | undefined,
  file: PmMemoryFileDetail,
  totalBytes: number,
): PmMemoryFilesList {
  const summary: PmMemoryFileSummary = {
    name: file.name,
    bytes: file.bytes,
    updatedAt: file.updatedAt,
  };
  const rest = (prev?.files ?? []).filter((item) => item.name !== file.name);
  const files = [...rest, summary].sort((a, b) => a.name.localeCompare(b.name));
  return { files, totalBytes };
}

function EditMemoryFileRow({
  pmId,
  file,
  archived,
  listQueryKey,
  onClose,
}: {
  pmId: number;
  file: PmMemoryFileSummary;
  archived: boolean;
  listQueryKey: readonly [string, string, number];
  onClose: () => void;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const detailQueryKey = useMemo(
    () => ["pm-memory-file", client.device ?? "", pmId, file.name] as const,
    [client.device, pmId, file.name],
  );
  const { data: detail, error: loadError, isFetching, refetch } = useQuery(
    {
      queryKey: detailQueryKey,
      queryFn: () => client.fetchPmMemoryFile(pmId, file.name),
      staleTime: 0,
    },
    qc,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<ErrorLike | null>(null);

  const text = draft ?? detail?.content ?? "";
  const bytes = utf8Bytes(text);
  const contentProblem = bytes > PM_MEMORY_MAX_SUBFILE_BYTES ? "File can be at most 64 KB" : null;
  const nearFileLimit = contentProblem === null && bytes >= SOFT_SUBFILE_BYTES;

  const saveMutation = useMutation(
    {
      mutationFn: (content: string) => client.putPmMemoryFile(pmId, file.name, { content }),
      onMutate: () => setSaveError(null),
      onSuccess: (res) => {
        qc.setQueryData<PmMemoryFileDetail>(detailQueryKey, res.file);
        qc.setQueryData<PmMemoryFilesList>(listQueryKey, (prev) =>
          upsertMemoryFileInList(prev, res.file, res.totalBytes),
        );
        onClose();
      },
      onError: (err) => setSaveError(errorText(err)),
    },
    qc,
  );

  return (
    <div data-slot="settings-row">
      <div className="flex min-h-9 items-center justify-between gap-3 px-4 pt-3 pb-1">
        <span className="truncate font-mono text-body">{file.name}</span>
        {nearFileLimit && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{`${formatFileBytes(bytes)} of 64 KB`}</span>
        )}
      </div>
      {detail === undefined ? (
        loadError && !isFetching ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <RowError error={errorText(loadError)} />
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-minor text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading…
            </span>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )
      ) : (
        <>
          <Textarea
            aria-label={`${file.name} content`}
            rows={4}
            readOnly={archived}
            className="block max-h-[50vh] min-h-28 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-minor field-sizing-content focus-visible:ring-0"
            value={text}
            aria-invalid={contentProblem !== null}
            onChange={(e) => setDraft(e.target.value)}
          />
          {contentProblem && (
            <div className="px-4 pb-2">
              <RowError>{contentProblem}</RowError>
            </div>
          )}
          <div className="px-4 py-3">
            {saveError && <RowError error={saveError} />}
            <div className={saveError ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
              <Button variant="ghost" disabled={saveMutation.isPending} onClick={onClose}>
                Cancel
              </Button>
              {!archived && (
                <Button
                  disabled={contentProblem !== null || saveMutation.isPending}
                  onClick={() => saveMutation.mutate(text)}
                >
                  {saveMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Save
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MemoryFileItem({
  pmId,
  file,
  archived,
  confirmingDelete,
  onStartEdit,
  onConfirmDelete,
  onCancelConfirm,
  listQueryKey,
}: {
  pmId: number;
  file: PmMemoryFileSummary;
  archived: boolean;
  confirmingDelete: boolean;
  onStartEdit: () => void;
  onConfirmDelete: () => void;
  onCancelConfirm: () => void;
  listQueryKey: readonly [string, string, number];
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [error, setError] = useState<ErrorLike | null>(null);

  const deleteMutation = useMutation(
    {
      mutationFn: async () => {
        try {
          await client.deletePmMemoryFile(pmId, file.name);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
      },
      onMutate: () => setError(null),
      onSuccess: () => {
        qc.removeQueries({ queryKey: ["pm-memory-file", client.device ?? "", pmId, file.name] });
        qc.setQueryData<PmMemoryFilesList>(listQueryKey, (prev) => {
          if (!prev) return prev;
          const files = prev.files.filter((item) => item.name !== file.name);
          return { files, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0) };
        });
        onCancelConfirm();
      },
      onError: (err) => setError(errorText(err)),
    },
    qc,
  );

  return (
    <SettingsRow
      label={file.name}
      error={error}
      detail={
        <span className="flex flex-wrap gap-x-3 tabular-nums">
          <span>{formatFileBytes(file.bytes)}</span>
          <span>{formatTime(file.updatedAt)}</span>
        </span>
      }
    >
      {() =>
        confirmingDelete ? (
          <>
            <Button variant="outline" size="sm" disabled={deleteMutation.isPending} onClick={onCancelConfirm}>
              Cancel
            </Button>
            <Button size="sm" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
              {deleteMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" aria-label={`Edit ${file.name}`} disabled={deleteMutation.isPending} onClick={onStartEdit}>
              Edit
            </Button>
            {!archived && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${file.name}`}
                disabled={deleteMutation.isPending}
                onClick={onConfirmDelete}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            )}
          </>
        )
      }
    </SettingsRow>
  );
}

function NewMemoryFileForm({
  pmId,
  listQueryKey,
  onClose,
}: {
  pmId: number;
  listQueryKey: readonly [string, string, number];
  onClose: () => void;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<ErrorLike | null>(null);

  const nameProblem = name === "" ? null : checkPmMemoryFileName(name);
  const bytes = utf8Bytes(content);
  const contentProblem = bytes > PM_MEMORY_MAX_SUBFILE_BYTES ? "File can be at most 64 KB" : null;
  const nearFileLimit = contentProblem === null && bytes >= SOFT_SUBFILE_BYTES;

  const createMutation = useMutation(
    {
      mutationFn: () => client.putPmMemoryFile(pmId, name, { content }),
      onMutate: () => setError(null),
      onSuccess: (res) => {
        qc.setQueryData<PmMemoryFileDetail>(
          ["pm-memory-file", client.device ?? "", pmId, res.file.name],
          res.file,
        );
        qc.setQueryData<PmMemoryFilesList>(listQueryKey, (prev) =>
          upsertMemoryFileInList(prev, res.file, res.totalBytes),
        );
        onClose();
      },
      onError: (err) => setError(errorText(err)),
    },
    qc,
  );

  const canSave =
    name !== "" &&
    nameProblem === null &&
    content.trim() !== "" &&
    contentProblem === null &&
    !createMutation.isPending;

  return (
    <>
      <SettingsRow label="File name" error={nameProblem}>
        {(id) => (
          <Input
            id={id}
            className="w-60 font-mono"
            placeholder="topic.md"
            autoComplete="off"
            value={name}
            aria-invalid={nameProblem !== null}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </SettingsRow>
      <div data-slot="settings-row">
        <Textarea
          aria-label="Content"
          placeholder="Content"
          rows={4}
          className="block max-h-[40vh] min-h-24 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-minor placeholder:font-sans placeholder:text-body field-sizing-content focus-visible:ring-0"
          value={content}
          aria-invalid={contentProblem !== null}
          onChange={(e) => setContent(e.target.value)}
        />
        {nearFileLimit && (
          <p className="px-4 pb-2 text-xs text-muted-foreground tabular-nums">{`${formatFileBytes(bytes)} of 64 KB`}</p>
        )}
        {contentProblem && (
          <div className="px-4 pb-3">
            <RowError>{contentProblem}</RowError>
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        {error && <RowError error={error} />}
        <div className={error ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
          <Button variant="ghost" disabled={createMutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => createMutation.mutate()}>
            {createMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

function PmMemoryFilesBody({ pmId, archived }: { pmId: number; archived: boolean }) {
  const client = useClient();
  const qc = useHubQueryClient();
  const listQueryKey = useMemo(() => ["pm-memory-files", client.device ?? "", pmId] as const, [client.device, pmId]);
  const { data, error, isFetching, refetch } = useQuery(
    {
      queryKey: listQueryKey,
      queryFn: () => client.fetchPmMemoryFiles(pmId),
      staleTime: 0,
    },
    qc,
  );
  const [editingName, setEditingName] = useState<string | null>(null);
  const [confirmingName, setConfirmingName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (data === undefined) {
    if (error && !isFetching) {
      return (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <RowError error={errorText(error)} />
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-minor text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  const { files, totalBytes } = data;
  const full = files.length >= PM_MEMORY_MAX_SUBFILES;
  const nearCount = !full && files.length >= SOFT_SUBFILE_COUNT;
  const nearTotalBytes = totalBytes >= SOFT_TOTAL_BYTES;

  return (
    <>
      {(nearCount || nearTotalBytes) && (
        <p className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
          {nearTotalBytes
            ? `Total size ${formatFileBytes(totalBytes)} is approaching the 1 MB limit`
            : `${files.length} files stored, approaching the ${PM_MEMORY_MAX_SUBFILES} file limit`}
        </p>
      )}
      {files.length === 0 && !adding && (
        <p className="px-4 py-3 text-body text-muted-foreground">No memory files yet</p>
      )}
      {files.map((file) =>
        editingName === file.name ? (
          <EditMemoryFileRow
            key={file.name}
            pmId={pmId}
            file={file}
            archived={archived}
            listQueryKey={listQueryKey}
            onClose={() => setEditingName(null)}
          />
        ) : (
          <MemoryFileItem
            key={file.name}
            pmId={pmId}
            file={file}
            archived={archived}
            confirmingDelete={confirmingName === file.name}
            onStartEdit={() => {
              setAdding(false);
              setConfirmingName(null);
              setEditingName(file.name);
            }}
            onConfirmDelete={() => {
              setAdding(false);
              setEditingName(null);
              setConfirmingName(file.name);
            }}
            onCancelConfirm={() => setConfirmingName(null)}
            listQueryKey={listQueryKey}
          />
        ),
      )}
      {!archived &&
        (adding ? (
          <NewMemoryFileForm
            pmId={pmId}
            listQueryKey={listQueryKey}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            disabled={full}
            className="flex min-h-13 w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-body transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-transparent"
            onClick={() => {
              setEditingName(null);
              setConfirmingName(null);
              setAdding(true);
            }}
          >
            <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className={full ? "text-muted-foreground" : undefined}>New</span>
            {full && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{`${PM_MEMORY_MAX_SUBFILES} max`}</span>}
          </button>
        ))}
    </>
  );
}

export function PmMemoryFilesGroup({ pmId, archived = false }: { pmId: number; archived?: boolean }) {
  return (
    <CollapsibleGroup title="Memory files">
      <PmMemoryFilesBody pmId={pmId} archived={archived} />
    </CollapsibleGroup>
  );
}
