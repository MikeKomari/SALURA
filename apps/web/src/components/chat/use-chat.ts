import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { useLiveEvent } from '../../lib/live.ts';
import type { AgentRun, AuditEntry, LiveEvent, Message } from '../../lib/types.ts';

export interface TraceRun {
  run: AgentRun;
  steps: AuditEntry[];
}

interface LiveState {
  waId: string;
  runs: Record<string, AgentRun>;
  entries: Record<string, AuditEntry[]>;
  /** Runs known to belong to this conversation from live events (message or run). */
  mine: string[];
}

const emptyLive = (waId: string): LiveState => ({ waId, runs: {}, entries: {}, mine: [] });

function mergeEntries(server: AuditEntry[], live: AuditEntry[] | undefined): AuditEntry[] {
  if (!live?.length) return server;
  const byId = new Map(server.map((e) => [e.id, e]));
  for (const e of live) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Runs of one conversation: the trace endpoint plus audit entries streamed live, so a run that
 * is still working shows its steps as they happen, before the trace refetch catches up.
 */
export function useConversationTrace(waId: string) {
  const query = useQuery({
    queryKey: ['trace', waId],
    queryFn: () => api.get<{ runs: TraceRun[] }>(`/api/conversations/${encodeURIComponent(waId)}/trace`),
  });
  const [live, setLive] = useState<LiveState>(() => emptyLive(waId));
  const serverIds = useRef(new Set<string>());
  serverIds.current = new Set(query.data?.runs.map((r) => r.run.id) ?? []);

  const onEvent = useCallback(
    (e: LiveEvent) => {
      setLive((prev) => {
        const s = prev.waId === waId ? prev : emptyLive(waId);
        switch (e.type) {
          case 'run':
            if (e.run.waId !== waId) return prev;
            return { ...s, runs: { ...s.runs, [e.run.id]: e.run }, mine: s.mine.includes(e.run.id) ? s.mine : [...s.mine, e.run.id] };
          case 'message':
            // The inbound message (with its run id) is stored before the run's first audit entry.
            if (e.message.waId !== waId || !e.message.runId || s.mine.includes(e.message.runId)) return prev;
            return { ...s, mine: [...s.mine, e.message.runId] };
          case 'audit': {
            const runId = e.entry.runId;
            if (!runId || !(s.mine.includes(runId) || serverIds.current.has(runId))) return prev;
            const list = s.entries[runId] ?? [];
            if (list.some((x) => x.id === e.entry.id)) return prev;
            return { ...s, entries: { ...s.entries, [runId]: [...list, e.entry] } };
          }
          case 'reset':
            return emptyLive(waId);
          default:
            return prev;
        }
      });
    },
    [waId],
  );
  useLiveEvent(onEvent);

  const current = live.waId === waId ? live : emptyLive(waId);
  const runs = useMemo<TraceRun[]>(() => {
    const server = query.data?.runs ?? [];
    const merged = server.map(({ run, steps }) => {
      const liveRun = current.runs[run.id];
      // The trace may have been fetched mid-run; a later live event knows the final status.
      const latest = run.status === 'running' && liveRun && liveRun.status !== 'running' ? liveRun : run;
      return { run: latest, steps: mergeEntries(steps, current.entries[run.id]) };
    });
    const known = new Set(server.map((r) => r.run.id));
    for (const id of current.mine) {
      const run = current.runs[id];
      if (run && !known.has(id)) merged.push({ run, steps: mergeEntries([], current.entries[id]) });
    }
    return merged;
  }, [query.data, current]);

  return { runs, running: runs.some((r) => r.run.status === 'running'), isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}

export function useMessages(waId: string) {
  return useQuery({
    queryKey: ['messages', waId],
    queryFn: () => api.get<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(waId)}/messages`),
  });
}

export interface Outgoing {
  kind: Message['kind'];
  text?: string;
  file?: File;
  /** A bundled sample photo (see /api/chat-samples), sent instead of an upload. */
  sample?: { id: string; imageUrl: string };
}

export interface Optimistic extends Outgoing {
  key: string;
  waId: string;
  previewUrl: string | null;
  createdAt: string;
  /** Highest server message id when this was sent; the server copy will have a larger id. */
  baselineId: number;
  failed: boolean;
}

export interface SendError {
  message: string;
  retry?: Optimistic;
}

function sendErrorMessage(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 429) return { message: err.message, retryable: false };
    if (err.code === 'busy') return { message: err.message, retryable: true };
    if (err.status === 0) return { message: err.message, retryable: true };
    if (err.code === 'too_large') return { message: 'File lebih besar dari 4 MB. Kirim file yang lebih kecil.', retryable: false };
    if (err.code === 'unsupported_media') return { message: 'Hanya pesan suara dan foto yang bisa dikirim.', retryable: false };
    if (err.code === 'invalid_request') return { message: 'Pesan kosong atau terlalu panjang (maksimal 2.000 karakter).', retryable: false };
  }
  return { message: 'Pesan belum terkirim karena server sedang bermasalah. Coba lagi sebentar lagi.', retryable: true };
}

/** Sends as the customer, shows the message immediately and reconciles with the server copy. */
export function useSender() {
  const qc = useQueryClient();
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
  const [sending, setSending] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, SendError>>({});

  const deliver = useCallback(
    async (item: Optimistic) => {
      const { waId } = item;
      const path = `/api/conversations/${encodeURIComponent(waId)}/messages`;
      setSending((s) => [...s, waId]);
      setErrors(({ [waId]: _, ...rest }) => rest);
      let failed: SendError | null = null;
      try {
        if (item.sample) {
          await api.post(`/api/conversations/${encodeURIComponent(waId)}/sample`, { sample: item.sample.id, text: item.text });
        } else if (item.file) {
          const form = new FormData();
          form.append('file', item.file, item.file.name);
          if (item.text) form.append('text', item.text);
          await api.post(path, form);
        } else {
          await api.post(path, { text: item.text });
        }
      } catch (err) {
        const e = sendErrorMessage(err);
        failed = { message: e.message, retry: e.retryable ? item : undefined };
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['messages', waId] }),
        qc.invalidateQueries({ queryKey: ['trace', waId] }),
        qc.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
      // A gateway timeout or dropped connection can happen after the server stored the message and
      // while the agent is still working. If the message is there, don't offer a retry (it would send twice).
      if (failed && failed.retry) {
        const stored = qc
          .getQueryData<{ messages: Message[] }>(['messages', waId])
          ?.messages.some((m) => m.direction === 'in' && m.id > item.baselineId && (item.text && !item.file && !item.sample ? m.text === item.text : m.kind !== 'text'));
        if (stored) failed = null;
      }
      setSending((s) => {
        const i = s.indexOf(waId);
        return i < 0 ? s : [...s.slice(0, i), ...s.slice(i + 1)];
      });
      if (failed) {
        const err = failed;
        setOptimistic((o) => o.map((x) => (x.key === item.key ? { ...x, failed: true } : x)));
        setErrors((e) => ({ ...e, [waId]: err }));
      } else {
        setOptimistic((o) => o.filter((x) => x.key !== item.key));
        if (item.previewUrl && item.file) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [qc],
  );

  const send = useCallback(
    (waId: string, out: Outgoing) => {
      const cached = qc.getQueryData<{ messages: Message[] }>(['messages', waId]);
      const item: Optimistic = {
        ...out,
        key: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        waId,
        previewUrl: out.file ? URL.createObjectURL(out.file) : (out.sample?.imageUrl ?? null),
        createdAt: new Date().toISOString(),
        baselineId: Math.max(0, ...(cached?.messages.map((m) => m.id) ?? [])),
        failed: false,
      };
      // A new message replaces any earlier one that did not go through.
      setOptimistic((o) => [...o.filter((x) => !(x.waId === waId && x.failed)), item]);
      void deliver(item);
    },
    [qc, deliver],
  );

  const retry = useCallback(
    (item: Optimistic) => {
      setOptimistic((o) => o.map((x) => (x.key === item.key ? { ...x, failed: false } : x)));
      void deliver({ ...item, failed: false });
    },
    [deliver],
  );

  const dismissError = useCallback((waId: string) => setErrors(({ [waId]: _, ...rest }) => rest), []);

  return { optimistic, send, retry, isSending: (waId: string) => sending.includes(waId), errorFor: (waId: string) => errors[waId] ?? null, dismissError };
}
