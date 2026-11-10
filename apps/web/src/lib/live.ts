import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, SIGNED_OUT_EVENT } from './api.ts';
import type { LiveEvent } from './types.ts';

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();
/** Called when the stream comes back after a drop: events sent meanwhile are lost, so refetch. */
const resyncListeners = new Set<() => void>();
let droppedSinceReady = false;
/** Resume token of the last event seen (the SSE id), sent when a new stream is opened. */
let lastEventId: string | null = null;
let lastEventAt = 0;
/** The stream was closed because the tab is hidden; it reopens when the tab is visible again. */
let paused = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Bumped by closeLive, so a retry decided before signing out never reopens the stream. */
let generation = 0;
/** A quick look at another tab keeps the stream; a tab left in the background stops costing a server function. */
const HIDDEN_GRACE_MS = 30_000;
/** After this long away, start fresh and refetch instead of replaying the outbox (pruned after 2 h). */
const MAX_RESUME_MS = 30 * 60_000;

function ensureSource() {
  if (source) return;
  if (document.visibilityState === 'hidden') {
    paused = true;
    droppedSinceReady = true;
    return;
  }
  paused = false;
  const resume = lastEventId && Date.now() - lastEventAt < MAX_RESUME_MS ? `?lastEventId=${encodeURIComponent(lastEventId)}` : '';
  source = new EventSource(`/api/events${resume}`);
  const remember = (msg: Event) => {
    const id = (msg as MessageEvent).lastEventId;
    if (id) {
      lastEventId = id;
      lastEventAt = Date.now();
    }
  };
  for (const type of ['ready', 'agent', 'ping']) source.addEventListener(type, remember);
  source.addEventListener('ready', (msg) => {
    setConnected(true);
    // The server streams from a durable outbox: a reconnect that resumed from the last event id
    // missed nothing. Only a fresh start after a drop needs a full refetch.
    let resumed = false;
    try {
      resumed = Boolean(JSON.parse((msg as MessageEvent).data)?.resumed);
    } catch {
      // older server: treat as not resumed
    }
    if (droppedSinceReady && !resumed) for (const l of resyncListeners) l();
    droppedSinceReady = false;
  });
  source.addEventListener('agent', (msg) => {
    let event: LiveEvent;
    try {
      event = JSON.parse((msg as MessageEvent).data) as LiveEvent;
    } catch {
      return;
    }
    // One failing listener must not stop the others from hearing the event.
    for (const l of listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('Live event listener failed', err);
      }
    }
  });
  source.onerror = () => {
    droppedSinceReady = true;
    setConnected(false);
    // The browser retries dropped connections itself, but gives up for good after a non-200
    // response (e.g. 429 when too many tabs are open). Then we start over, with backoff.
    if (source?.readyState === EventSource.CLOSED) {
      source.close();
      source = null;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 60_000);
      // An expired session (401) closes the stream for good too: sign out instead of retrying forever.
      const gen = generation;
      const retry = () => {
        if (gen === generation) retryTimer = setTimeout(ensureSource, delay);
      };
      api.get<{ user: unknown }>('/api/auth/me').then((me) => {
        if (gen !== generation) return;
        if (me.user) retry();
        else window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      }, retry);
    }
  };
  source.addEventListener('ready', () => (retryDelay = 5_000));
}

let retryDelay = 5_000;

/** Stops the live stream (after signing out). */
export function closeLive() {
  source?.close();
  source = null;
  paused = false;
  lastEventId = null;
  generation++;
  clearTimeout(hideTimer);
  clearTimeout(retryTimer);
  setConnected(false);
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.visibilityState === 'hidden') {
    hideTimer = setTimeout(() => {
      if (!source) return;
      source.close();
      source = null;
      paused = true;
      droppedSinceReady = true;
      setConnected(false);
    }, HIDDEN_GRACE_MS);
  } else if (paused) {
    ensureSource();
  }
});

function setConnected(c: boolean) {
  connected = c;
  for (const l of statusListeners) l(c);
}

export function useLiveEvent(fn: Listener) {
  useEffect(() => {
    ensureSource();
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, [fn]);
}

export function useLiveConnected(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    statusListeners.add(setC);
    return () => void statusListeners.delete(setC);
  }, []);
  return c;
}

/** Keeps cached server state fresh: every live event invalidates the queries it affects. */
export function useLiveInvalidation() {
  const qc = useQueryClient();
  useEffect(() => {
    ensureSource();
    const fn: Listener = (e) => {
      switch (e.type) {
        case 'message':
          qc.invalidateQueries({ queryKey: ['conversations'] });
          qc.invalidateQueries({ queryKey: ['messages', e.message.waId] });
          break;
        case 'run':
          if (e.run.status !== 'running') {
            qc.invalidateQueries({ queryKey: ['dashboard'] });
            qc.invalidateQueries({ queryKey: ['approvals'] });
            qc.invalidateQueries({ queryKey: ['orders'] });
            qc.invalidateQueries({ queryKey: ['overdue'] });
            qc.invalidateQueries({ queryKey: ['proactive'] });
            qc.invalidateQueries({ queryKey: ['warehouse'] });
            qc.invalidateQueries({ queryKey: ['payments'] });
            qc.invalidateQueries({ queryKey: ['deliveries'] });
            if (e.run.waId) qc.invalidateQueries({ queryKey: ['profile', e.run.waId] });
          }
          if (e.run.waId) qc.invalidateQueries({ queryKey: ['trace', e.run.waId] });
          break;
        case 'approval':
        case 'order':
          qc.invalidateQueries({ queryKey: ['approvals'] });
          qc.invalidateQueries({ queryKey: ['orders'] });
          qc.invalidateQueries({ queryKey: ['dashboard'] });
          qc.invalidateQueries({ queryKey: ['warehouse'] });
          qc.invalidateQueries({ queryKey: ['payments'] });
          qc.invalidateQueries({ queryKey: ['overdue'] });
          break;
        case 'reset':
          qc.invalidateQueries();
          break;
      }
    };
    listeners.add(fn);
    const resync = () => void qc.invalidateQueries();
    resyncListeners.add(resync);
    return () => {
      listeners.delete(fn);
      resyncListeners.delete(resync);
    };
  }, [qc]);
}
