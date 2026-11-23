import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CUSTOM_MODEL,
  MAX_PERSONA_BYTES,
  PM_MEMORY_MAX_BYTES,
  PM_MEMORY_MAX_LINES,
  PM_MEMORY_SOFT_WARN_RATIO,
  effortLabel,
  modelLabel,
  pmMemoryLineCount,
  splitModelEffort,
  utf8Bytes,
  vendorLabel,
  type AgentSetting,
  type EditPersonaRequest,
  type ModelCatalog,
  type PersonaChange,
  type PersonaView,
} from "../shared/index.ts";
import { ApiError } from "./client.ts";
import { useClient } from "./device-scope.tsx";
import { ACTOR_LABELS, DEFAULT_CHOICE, MODE_LABELS, errorText, formatTime, type ErrorInfo, type ErrorLike } from "./format.ts";
import { useModelCatalog } from "./models.tsx";
import { draftOf, settingOf, type AgentDraft, type AgentRowKey } from "./components/AgentRows.tsx";
import { guardedQueryFn, queryGenerationOf, useHubQueryClient } from "./query-client.ts";

export type PersonaLoad = { phase: "loading" } | { phase: "error"; info: ErrorInfo } | { phase: "ready"; persona: PersonaView };

export type AliveRef = React.RefObject<boolean>;

export function useAliveRef(): AliveRef {
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  return aliveRef;
}

export function usePersona(pmId: number, rev: number) {
  const client = useClient();
  const qc = useHubQueryClient();
  const genId = `persona:${client.device ?? ""}:${pmId}`;
  const queryKey = useMemo(() => ["persona", client.device ?? "", pmId] as const, [client.device, pmId]);
  const { data: persona, error, isFetching, refetch } = useQuery(
    {
      queryKey,
      queryFn: guardedQueryFn(qc, genId, queryKey, () => client.fetchPersona(pmId)),
      staleTime: 0,
    },
    qc,
  );
  const prevRev = useRef(rev);
  useEffect(() => {
    if (prevRev.current !== rev) {
      prevRev.current = rev;
      void refetch();
    }
  }, [rev, refetch]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const set = useCallback(
    (next: PersonaView) => {
      queryGenerationOf(qc, genId).gen++;
      qc.setQueryData(queryKey, next);
    },
    [qc, genId, queryKey],
  );
  const load: PersonaLoad =
    persona !== undefined
      ? { phase: "ready", persona }
      : error && !isFetching
        ? { phase: "error", info: errorText(error) }
        : { phase: "loading" };
  return { load, retry, set };
}

export function describePersonaChange(change: PersonaChange, catalog: ModelCatalog): string {
  if (change.revertOf !== null) return "undid a change";
  const parts: string[] = [];
  if (change.textBefore !== change.textAfter) parts.push("edited the persona");
  if (change.modeBefore !== change.modeAfter) parts.push(`set mode to ${MODE_LABELS[change.modeAfter]}`);
  if (change.vendorBefore !== change.vendorAfter) parts.push(`set provider to ${vendorLabel(change.vendorAfter)}`);
  const beforeCatalog = change.vendorBefore === change.vendorAfter ? catalog : null;
  const before = splitModelEffort(change.vendorBefore, change.modelBefore, change.effortBefore, beforeCatalog);
  const after = splitModelEffort(change.vendorAfter, change.modelAfter, change.effortAfter, catalog);
  if (before.model !== after.model) parts.push(`set model to ${after.model === null ? DEFAULT_CHOICE : modelLabel(change.vendorAfter, after.model, catalog)}`);
  if (before.effort !== after.effort) parts.push(`set effort to ${after.effort === null ? DEFAULT_CHOICE : effortLabel(after.effort, change.vendorAfter, catalog)}`);
  return parts.join(", ") || "changed settings";
}

export function formatChangeSummary(change: PersonaChange, catalog: ModelCatalog): { actor: string; summary: string; timestamp: string } {
  return {
    actor: ACTOR_LABELS[change.actor] ?? "You",
    summary: describePersonaChange(change, catalog),
    timestamp: formatTime(change.createdAt),
  };
}

function sameSetting(a: AgentSetting, b: AgentSetting): boolean {
  return a.vendor === b.vendor && a.model === b.model && a.effort === b.effort;
}

export function useInstantSave<T>(pmId: number, onUpdate: (p: PersonaView) => void, aliveRef: AliveRef) {
  const client = useClient();
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const seq = useRef(0);
  const save = (next: T, body: EditPersonaRequest) => {
    setDraft(next);
    setError(null);
    const mine = ++seq.current;
    if (Object.keys(body).length === 0) {
      setDraft(null);
      return;
    }
    client.putPersona(pmId, body).then(
      (res) => {
        if (!aliveRef.current) return;
        onUpdate(res.persona);
        if (mine === seq.current) setDraft(null);
      },
      (err: unknown) => {
        if (!aliveRef.current || mine !== seq.current) return;
        setDraft(null);
        setError(errorText(err));
      },
    );
  };
  const reset = () => {
    seq.current++;
    setDraft(null);
    setError(null);
  };
  return { draft, error, save, reset };
}

export function useAgentEditor(pmId: number, persona: PersonaView, onUpdate: (p: PersonaView) => void, aliveRef: AliveRef) {
  const client = useClient();
  const savedCatalog = useModelCatalog(persona.vendor);
  const saved: AgentSetting = { vendor: persona.vendor, ...splitModelEffort(persona.vendor, persona.model, persona.effort, savedCatalog) };
  const [trackedPmId, setTrackedPmId] = useState(persona.pmId);
  const [editedAgent, setEditedAgent] = useState<AgentDraft | null>(null);
  const draftCatalog = useModelCatalog(editedAgent?.vendor ?? persona.vendor);
  const [agentError, setAgentError] = useState<ErrorInfo | null>(null);
  const [agentSaving, setAgentSaving] = useState(false);
  const agentSavingRef = useRef(false);
  const agentSeq = useRef(0);

  if (trackedPmId !== persona.pmId) {
    setTrackedPmId(persona.pmId);
    setEditedAgent(null);
    setAgentError(null);
    setAgentSaving(false);
  }

  const draft: AgentDraft = editedAgent ?? draftOf(saved, savedCatalog);
  const agentResult = settingOf(draft, draftCatalog);
  const agentChanged = !agentResult.ok || !sameSetting(agentResult.setting, saved);
  if (!agentSaving && editedAgent !== null && editedAgent.modelChoice !== CUSTOM_MODEL && !agentChanged) {
    setEditedAgent(null);
    setAgentError(null);
  }
  const canSave = agentChanged && agentResult.ok && !agentSaving;

  const change = (next: AgentDraft, row: AgentRowKey) => {
    const updated = row === "vendor" ? draftOf({ vendor: next.vendor, model: null, effort: null }) : next;
    const result = settingOf(updated, row === "vendor" ? null : draftCatalog);
    setAgentError(null);
    setEditedAgent(updated.modelChoice !== CUSTOM_MODEL && result.ok && sameSetting(result.setting, saved) ? null : updated);
  };

  const cancel = () => {
    setEditedAgent(null);
    setAgentError(null);
  };

  const reset = () => {
    agentSeq.current++;
    agentSavingRef.current = false;
    setAgentSaving(false);
    setEditedAgent(null);
    setAgentError(null);
  };

  const save = async (): Promise<boolean> => {
    if (agentSavingRef.current || !canSave || !agentResult.ok) return false;
    agentSavingRef.current = true;
    setAgentSaving(true);
    setAgentError(null);
    const mine = ++agentSeq.current;
    const { vendor, model, effort } = agentResult.setting;
    try {
      const res = await client.putPersona(pmId, { vendor, model, effort });
      if (!aliveRef.current || mine !== agentSeq.current) return false;
      onUpdate(res.persona);
      setEditedAgent(null);
      setAgentError(null);
      return true;
    } catch (err) {
      if (!aliveRef.current || mine !== agentSeq.current) return false;
      setAgentError(errorText(err));
      return false;
    } finally {
      if (aliveRef.current && mine === agentSeq.current) {
        agentSavingRef.current = false;
        setAgentSaving(false);
      }
    }
  };

  return { draft, edited: editedAgent !== null, error: agentError, saving: agentSaving, canSave, change, cancel, reset, save };
}

export function usePersonaText({
  pmId,
  persona,
  onUpdate,
  onReverted,
  aliveRef,
}: {
  pmId: number;
  persona: PersonaView;
  onUpdate: (p: PersonaView) => void;
  onReverted: () => void;
  aliveRef: AliveRef;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [trackedPmId, setTrackedPmId] = useState(persona.pmId);
  const [draftText, setDraftText] = useState<string | null>(null);
  if (trackedPmId !== persona.pmId) {
    setTrackedPmId(persona.pmId);
    setDraftText(null);
  }
  const text = draftText ?? persona.text;

  const textMutation = useMutation(
    {
      mutationFn: async () => (await client.putPersona(pmId, { text })).persona,
      onSuccess: (next) => {
        if (!aliveRef.current) return;
        setDraftText(null);
        onUpdate(next);
      },
    },
    qc,
  );
  const revertMutation = useMutation(
    {
      mutationFn: async (changeId: number) => (await client.postRevertPersonaChange(changeId)).persona,
      onSuccess: (next) => {
        if (!aliveRef.current) return;
        onReverted();
        setDraftText(null);
        onUpdate(next);
      },
    },
    qc,
  );
  const busy = textMutation.isPending ? ("text" as const) : revertMutation.isPending ? ("revert" as const) : null;
  const textError: ErrorLike | undefined = textMutation.error ? errorText(textMutation.error) : undefined;
  const revertError: ErrorLike | undefined = revertMutation.error
    ? revertMutation.error instanceof ApiError && revertMutation.error.status === 409
      ? "Only the latest change can be undone"
      : errorText(revertMutation.error)
    : undefined;
  return {
    text,
    setText: setDraftText,
    dirty: text !== persona.text,
    tooLong: utf8Bytes(text) > MAX_PERSONA_BYTES,
    busy,
    textError,
    revertError,
    save: () => textMutation.mutate(),
    revert: (changeId: number) => revertMutation.mutate(changeId),
  };
}

export function personaLoadHint(text: string): string | null {
  const lines = pmMemoryLineCount(text);
  const bytes = utf8Bytes(text);
  const limit = `${PM_MEMORY_MAX_LINES} lines (${PM_MEMORY_MAX_BYTES / 1024} KB)`;
  if (lines > PM_MEMORY_MAX_LINES || bytes > PM_MEMORY_MAX_BYTES) {
    return `Only the first ${limit} load automatically. Move detailed notes into Memory files below`;
  }
  const near =
    lines >= Math.ceil(PM_MEMORY_MAX_LINES * PM_MEMORY_SOFT_WARN_RATIO) ||
    bytes >= Math.ceil(PM_MEMORY_MAX_BYTES * PM_MEMORY_SOFT_WARN_RATIO);
  return near ? `Approaching the ${limit} auto-load limit. Move detailed notes into Memory files below` : null;
}
