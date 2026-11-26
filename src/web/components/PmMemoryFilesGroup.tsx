import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "../ui/icons.ts";
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
import { personaQueryKey } from "../pm-persona.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { INFO_ROW, InfoAction, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

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
        void qc.invalidateQueries({ queryKey: personaQueryKey(client.device, pmId) });
        onClose();
      },
      onError: (err) => setSaveError(errorText(err)),
    },
    qc,
  );

  return (
    <div data-slot="settings-row">
      <div className="flex h-7.5 items-center justify-between gap-3">
        <span className="truncate text-minor text-foreground">{file.name}</span>
        {nearFileLimit && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{`${formatFileBytes(bytes)} of 64 KB`}</span>
        )}
      </div>
      {detail === undefined ? (
        loadError && !isFetching ? (
          <div className="flex items-center justify-between gap-3 py-1.5">
            <RowError error={errorText(loadError)} />
            <span className="info-actions">
              <InfoAction onClick={onClose}>Cancel</InfoAction>
              <InfoAction onClick={() => void refetch()}>Retry</InfoAction>
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 py-1.5 text-minor text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="size-3.5" aria-hidden="true" />
              Loading…
            </span>
            <InfoAction onClick={onClose}>Cancel</InfoAction>
          </div>
        )
      ) : (
        <>
          <Textarea
            aria-label={`${file.name} content`}
            rows={4}
            readOnly={archived}
            variant="bare"
            className="max-h-[50vh] min-h-24 font-mono"
            value={text}
            aria-invalid={contentProblem !== null}
            onChange={(e) => setDraft(e.target.value)}
          />
          {contentProblem && <RowError>{contentProblem}</RowError>}
          <div className="py-2">
            {saveError && <RowError error={saveError} />}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={saveMutation.isPending} onClick={onClose}>
                Cancel
              </Button>
              {!archived && (
                <Button
                  size="sm"
                  disabled={contentProblem !== null || saveMutation.isPending}
                  onClick={() => saveMutation.mutate(text)}
                >
                  {saveMutation.isPending && <Loader2 aria-hidden="true" />}
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
        void qc.invalidateQueries({ queryKey: personaQueryKey(client.device, pmId) });
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
          <span className="info-actions">
            <InfoAction disabled={deleteMutation.isPending} onClick={onCancelConfirm}>
              Cancel
            </InfoAction>
            <InfoAction danger disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
              {deleteMutation.isPending && <Loader2 className="size-3.5" aria-hidden="true" />}
              Delete
            </InfoAction>
          </span>
        ) : (
          <span className="info-actions">
            <InfoAction aria-label={`Edit ${file.name}`} disabled={deleteMutation.isPending} onClick={onStartEdit}>
              Edit
            </InfoAction>
            {!archived && (
              <InfoAction danger aria-label={`Delete ${file.name}`} disabled={deleteMutation.isPending} onClick={onConfirmDelete}>
                Delete…
              </InfoAction>
            )}
          </span>
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
        void qc.invalidateQueries({ queryKey: personaQueryKey(client.device, pmId) });
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
            className="h-7.5 w-60 font-mono text-minor"
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
          variant="bare"
          className="max-h-[40vh] min-h-20 font-mono"
          value={content}
          aria-invalid={contentProblem !== null}
          onChange={(e) => setContent(e.target.value)}
        />
        {nearFileLimit && (
          <p className="pb-1 text-xs text-muted-foreground tabular-nums">{`${formatFileBytes(bytes)} of 64 KB`}</p>
        )}
        {contentProblem && <RowError>{contentProblem}</RowError>}
      </div>
      <div className="py-2">
        {error && <RowError error={error} />}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={createMutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => createMutation.mutate()}>
            {createMutation.isPending && <Loader2 aria-hidden="true" />}
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
        <div className="flex items-center justify-center gap-3 py-6">
          <RowError error={errorText(error)} />
          <InfoAction onClick={() => void refetch()}>Retry</InfoAction>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-minor text-muted-foreground">
        <Loader2 className="size-pixel" aria-hidden="true" />
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
        <p className="py-1.5 text-xs text-muted-foreground tabular-nums">
          {nearTotalBytes
            ? `Total size ${formatFileBytes(totalBytes)} is approaching the 1 MB limit`
            : `${files.length} files stored, approaching the ${PM_MEMORY_MAX_SUBFILES} file limit`}
        </p>
      )}
      {files.length === 0 && !adding && (
        <p className="py-6 text-center text-minor text-muted-foreground">No memory files yet</p>
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
            className={cn(INFO_ROW, "h-7.5 text-minor")}
            onClick={() => {
              setEditingName(null);
              setConfirmingName(null);
              setAdding(true);
            }}
          >
            <Plus className="info-chevron size-3.5" aria-hidden="true" />
            <span className="flex-1 text-foreground">New</span>
            {full && <span className="info-val text-minor tabular-nums">{`${PM_MEMORY_MAX_SUBFILES} max`}</span>}
          </button>
        ))}
    </>
  );
}

export function PmMemoryFilesGroup({ pmId, archived = false, titled = true }: { pmId: number; archived?: boolean; titled?: boolean }) {
  return (
    <SettingsGroup {...(titled ? { title: "Memory files" } : { label: "Memory files" })}>
      <PmMemoryFilesBody pmId={pmId} archived={archived} />
    </SettingsGroup>
  );
}
