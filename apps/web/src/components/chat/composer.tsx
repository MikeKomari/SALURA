import { Image, ImagePlus, Info, LoaderCircle, Mic, SendHorizontal, UserRound, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toWavFile } from '../../lib/audio.ts';
import { press } from '../../lib/motion.ts';
import { ErrorCallout } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { useToast } from '../ui/toast.tsx';
import type { Outgoing } from './use-chat.ts';

import { MAX_UPLOAD_BYTES, shrinkPhoto } from '../../lib/image.ts';

/** Photos larger than this are not even tried; smaller ones are shrunk below the upload limit. */
const MAX_PICK_BYTES = 30 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 120;
const MAX_TEXTAREA_PX = 5 * 24 + 20; // five lines of body text plus padding
const QUICK_REPLIES = ['Ya, proses', 'Batal', 'Pesan seperti biasa'];

interface ComposerProps {
  identity: React.ReactNode;
  /** Shown under the identity line, e.g. what a guest account's messages can and cannot change. */
  notice?: React.ReactNode;
  busy: boolean;
  draft: string | null;
  onDraftUsed: () => void;
  onSend: (out: Outgoing) => void;
  error: { message: string; onRetry?: () => void } | null;
  /** Sample photos this customer can send (transfer receipt, surat jalan). */
  samples?: { id: string; label: string; caption: string; imageUrl: string }[];
}

const swap = { initial: { opacity: 0, scale: 0.25, filter: 'blur(4px)' }, animate: { opacity: 1, scale: 1, filter: 'blur(0px)' }, exit: { opacity: 0, scale: 0.25, filter: 'blur(4px)' } };

export function Composer({ identity, notice, busy, draft, onDraftUsed, onSend, error, samples = [] }: ComposerProps) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [multiline, setMultiline] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const sendOnStop = useRef(false);

  useEffect(() => {
    if (draft === null) return;
    setText(draft);
    onDraftUsed();
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft, onDraftUsed]);

  // Auto-grow up to five lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
    setMultiline(el.scrollHeight > 52);
  }, [text, recording]);

  useEffect(() => () => void (photo && URL.revokeObjectURL(photo.url)), [photo]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - recording.startedAt) / 1000);
      setElapsed(s);
      if (s >= MAX_RECORDING_SECONDS) stopRecording(true);
    }, 250);
    return () => clearInterval(id);
  }, [recording]);

  // Leaving the conversation mid-recording discards it and releases the microphone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sendOnStop.current = false;
      if (recorder.current?.state === 'recording') recorder.current.stop();
    };
  }, []);

  const hasContent = Boolean(text.trim() || photo);
  const canSend = !busy && (recording ? true : hasContent);

  function submit() {
    if (busy) return;
    if (recording) return stopRecording(true);
    const caption = text.trim();
    if (photo) {
      onSend({ kind: 'image', file: photo.file, text: caption || undefined });
      setPhoto(null);
    } else if (caption) {
      onSend({ kind: 'text', text: caption });
    } else return;
    setText('');
    area.current?.focus();
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast({ tone: 'error', text: 'Browser ini tidak bisa merekam suara. Coba Chrome atau Edge terbaru.' });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast({ tone: 'error', text: 'Mikrofon tidak bisa dipakai. Izinkan akses mikrofon di browser, lalu coba lagi.' });
      return;
    }
    // The user may have left while the permission prompt was open: release the microphone at once.
    if (!mounted.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      if (!sendOnStop.current) return;
      if (Date.now() - startedAt < 1000) {
        toast({ tone: 'error', text: 'Rekaman terlalu pendek. Tahan sedikit lebih lama, lalu kirim.' });
        return;
      }
      const type = (r.mimeType || 'audio/webm').split(';')[0]!;
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      // Converted to wav here: a multimodal speech model takes only wav or mp3, and the browser
      // already has the opus decoder. Falls back to the recording itself if it cannot be decoded.
      void toWavFile(new File(chunks, `pesan-suara.${ext}`, { type })).then((file) => onSend({ kind: 'voice', file }));
    };
    recorder.current = r;
    sendOnStop.current = false;
    r.start();
    setElapsed(0);
    setRecording({ startedAt });
  }

  function stopRecording(send: boolean) {
    sendOnStop.current = send;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    setRecording(null);
  }

  async function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (!picked.type.startsWith('image/')) return toast({ tone: 'error', text: 'Pilih file foto (JPG atau PNG).' });
    if (picked.size > MAX_PICK_BYTES) return toast({ tone: 'error', text: 'Foto terlalu besar. Pilih foto yang lebih kecil.' });
    const file = await shrinkPhoto(picked);
    if (file.size > MAX_UPLOAD_BYTES) return toast({ tone: 'error', text: 'Foto masih lebih dari 2 MB setelah diperkecil. Pilih foto lain.' });
    setPhoto({ file, url: URL.createObjectURL(file) });
    area.current?.focus();
  }

  return (
    <div className="border-t border-border px-4 pt-3 pb-4 md:px-6">
      <p className="mb-2 flex items-center gap-2 text-small text-ink-2">
        <span className="text-primary">
          <Icon icon={UserRound} size={16} weight="semibold" />
        </span>
        <span className="min-w-0">{identity}</span>
      </p>
      {notice && (
        <p className="mb-2 flex items-start gap-2 rounded-inner bg-info-bg px-3 py-2 text-small text-info-fg">
          <Icon icon={Info} size={16} weight="semibold" className="mt-0.5 shrink-0" />
          <span className="min-w-0">{notice}</span>
        </p>
      )}

      <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Balasan cepat">
        {QUICK_REPLIES.map((q) => (
          <motion.button
            key={q}
            type="button"
            whileTap={busy ? undefined : { scale: 0.97 }}
            transition={press}
            disabled={busy || Boolean(recording)}
            onClick={() => onSend({ kind: 'text', text: q })}
            className="h-9 cursor-pointer rounded-pill border border-border bg-surface px-3.5 text-small font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-ink-3"
          >
            {q}
          </motion.button>
        ))}
        {samples.map((s) => (
          <motion.button
            key={s.id}
            type="button"
            whileTap={busy ? undefined : { scale: 0.97 }}
            transition={press}
            disabled={busy || Boolean(recording)}
            title={`Mengirim foto contoh dengan pesan: "${s.caption}"`}
            onClick={() => onSend({ kind: 'image', text: s.caption, sample: { id: s.id, imageUrl: s.imageUrl } })}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-pill border border-primary bg-surface px-3.5 text-small font-medium text-primary transition-colors duration-150 hover:bg-primary-soft disabled:cursor-not-allowed disabled:border-border disabled:text-ink-3"
          >
            <Icon icon={Image} size={16} weight="semibold" />
            {s.label}
          </motion.button>
        ))}
      </div>

      {error && (
        <div className="mb-2">
          <ErrorCallout message={error.message} onRetry={error.onRetry} />
        </div>
      )}

      {photo && (
        <div className="mb-2 flex items-center gap-3 rounded-inner bg-surface-muted p-2 pr-3">
          <img src={photo.url} alt="" className="size-14 rounded-[8px] object-cover" />
          <p className="min-w-0 flex-1 truncate text-small text-ink-2">
            Foto siap dikirim · <span className="text-ink">{photo.file.name}</span>
            <span className="block text-meta text-ink-3">Tambahkan keterangan di bawah bila perlu.</span>
          </p>
          <PillButton icon={X} label="Hapus foto" onClick={() => setPhoto(null)} />
        </div>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          className={`flex min-h-12 min-w-0 flex-1 items-end gap-1 bg-surface-muted py-1 pr-1 pl-5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${multiline ? 'rounded-card' : 'rounded-pill'}`}
        >
          {recording ? (
            <div className="flex min-h-10 flex-1 items-center gap-2 text-body text-ink" role="status">
              <span className="size-2.5 rounded-full bg-danger-fg" aria-hidden="true" />
              Merekam pesan suara
              <span className="tabular text-ink-2">
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
              <span className="ml-auto hidden text-small text-ink-3 sm:inline">Tekan kirim bila selesai</span>
            </div>
          ) : (
            <textarea
              ref={area}
              rows={1}
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              aria-label="Tulis pesan sebagai pelanggan"
              placeholder={photo ? 'Keterangan foto (boleh kosong)' : 'Tulis pesan sebagai pelanggan…'}
              className="min-w-0 flex-1 resize-none bg-transparent py-2.5 text-body text-ink placeholder:text-ink-3 focus-visible:outline-none"
            />
          )}
          {recording ? (
            <PillButton icon={X} label="Batalkan rekaman" onClick={() => stopRecording(false)} />
          ) : (
            <>
              <PillButton icon={Mic} label="Rekam pesan suara" onClick={() => void startRecording()} disabled={busy || Boolean(photo)} />
              <PillButton icon={ImagePlus} label="Kirim foto" onClick={() => picker.current?.click()} disabled={busy} />
            </>
          )}
          <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pickPhoto} tabIndex={-1} aria-hidden="true" />
        </div>
        <motion.button
          type="submit"
          aria-label={recording ? 'Kirim pesan suara' : busy ? 'Menunggu balasan agen' : 'Kirim pesan'}
          title={recording ? 'Kirim pesan suara' : busy ? 'Menunggu balasan agen' : 'Kirim pesan'}
          disabled={!canSend}
          whileTap={canSend ? { scale: 0.95 } : undefined}
          transition={press}
          className="mb-0.5 grid size-11 shrink-0 cursor-pointer place-items-center rounded-inner bg-primary text-white transition-colors duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-3"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={busy ? 'busy' : 'send'} {...swap} transition={{ type: 'spring', duration: 0.3, bounce: 0 }} className="grid">
              {busy ? (
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }} className="grid">
                  <Icon icon={LoaderCircle} size={20} weight="semibold" />
                </motion.span>
              ) : (
                <Icon icon={SendHorizontal} size={20} weight="semibold" />
              )}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      </form>
      <p className="mt-2 hidden text-meta text-ink-3 md:block">Enter untuk kirim, Shift+Enter untuk baris baru.</p>
    </div>
  );
}

function PillButton({ icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.95 }}
      transition={press}
      className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 transition-colors duration-150 hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent"
    >
      <Icon icon={icon} size={20} />
    </motion.button>
  );
}
