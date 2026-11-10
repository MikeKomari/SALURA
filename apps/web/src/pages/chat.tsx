import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleQuestionMark, PanelRightOpen } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../components/admin-gate.tsx';
import { formatWa, randomUnregisteredWa } from '../components/chat/chat-format.ts';
import { Composer } from '../components/chat/composer.tsx';
import { ContextPanel, ContextSlideOver, type ContextTab } from '../components/chat/context-panel.tsx';
import { ConversationList } from '../components/chat/conversation-list.tsx';
import { MessageThread } from '../components/chat/message-thread.tsx';
import { useConversationTrace, useMessages, useSender } from '../components/chat/use-chat.ts';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Chip } from '../components/ui/chip.tsx';
import { Avatar, EmptyState, Skeleton } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { api } from '../lib/api.ts';
import { pageGroup } from '../lib/motion.ts';
import type { Conversation } from '../lib/types.ts';

const SUGGESTIONS = ['Pesan seperti biasa ya', 'Indomie goreng 2 dus sama gula 10 kg', 'Ada Aqua 600ml? Mau 5 dus'];

export function ChatPage() {
  const navigate = useNavigate();
  const { waId: param } = useParams();
  const [search, setSearch] = useSearchParams();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/api/conversations') });
  const list = conversations.data?.conversations ?? [];
  const waId = param ?? list[0]?.waId ?? null;
  const conversation = list.find((c) => c.waId === waId) ?? null;
  const unknownWaId = param && conversations.data && !conversation ? param : null;

  // ?draft=<text> prefills the composer (the help page links scenarios this way).
  const [draft, setDraft] = useState<string | null>(null);
  const draftParam = search.get('draft');
  useEffect(() => {
    if (draftParam === null) return;
    setDraft(draftParam);
    setSearch(
      (p) => {
        p.delete('draft');
        return p;
      },
      { replace: true },
    );
  }, [draftParam, setSearch]);
  const onDraftUsed = useCallback(() => setDraft(null), []);

  const [tab, setTab] = useState<ContextTab>('customer');
  const [slideOpen, setSlideOpen] = useState(false);
  const [focus, setFocus] = useState<{ runId: string | null; nonce: number } | null>(null);
  useEffect(() => {
    setFocus(null);
    setSlideOpen(false);
  }, [waId]);
  const showTrace = useCallback((runId: string | null) => {
    setTab('trace');
    setFocus((f) => ({ runId, nonce: (f?.nonce ?? 0) + 1 }));
    // The panel is already on screen in the three-column layout.
    if (!window.matchMedia('(min-width: 1440px)').matches) setSlideOpen(true);
  }, []);
  const closeSlide = useCallback(() => setSlideOpen(false), []);

  const sender = useSender();

  return (
    <Page>
      <PageHeader
        title="Percakapan"
        subtitle="Pilih warung, lalu kirim pesan sebagai pemiliknya. Balasan agen dan setiap langkahnya tampil langsung."
        actions={
          <Button variant="outline" icon={CircleQuestionMark} onClick={() => navigate('/bantuan')}>
            Skenario uji
          </Button>
        }
      />
      <motion.div variants={pageGroup} custom={1} className="flex h-[calc(100dvh-160px)] min-h-[560px] gap-4 md:h-[calc(100dvh-272px)]">
        <ConversationList
          className={`${param ? 'hidden lg:flex' : 'flex'} w-full lg:w-[320px] lg:shrink-0`}
          conversations={list}
          loading={conversations.isLoading}
          error={conversations.error}
          onRetry={() => void conversations.refetch()}
          selected={waId}
          unknownWaId={unknownWaId}
          onNewNumber={() => navigate(`/percakapan/${randomUnregisteredWa()}`)}
        />
        {waId ? (
          <ConversationView
            key={waId}
            waId={waId}
            conversation={conversation}
            listLoading={conversations.isLoading}
            className={param ? 'flex' : 'hidden lg:flex'}
            draft={draft}
            onDraftUsed={onDraftUsed}
            onSuggestion={setDraft}
            sender={sender}
            tab={tab}
            onTab={setTab}
            focus={focus}
            onShowTrace={showTrace}
            slideOpen={slideOpen}
            onOpenSlide={() => setSlideOpen(true)}
            onCloseSlide={closeSlide}
          />
        ) : (
          <section className="hidden min-w-0 flex-1 flex-col rounded-card bg-surface lg:flex">
            {conversations.isLoading ? (
              <div className="flex flex-col gap-4 p-6">
                <Skeleton className="h-12 w-1/2" />
                <Skeleton className="h-16 w-2/3" />
              </div>
            ) : (
              <EmptyState title="Belum ada pelanggan">Muat ulang data demo di Pengaturan untuk mengisi daftar warung.</EmptyState>
            )}
          </section>
        )}
      </motion.div>
    </Page>
  );
}

interface ConversationProps {
  waId: string;
  conversation: Conversation | null;
  listLoading: boolean;
  className: string;
  draft: string | null;
  onDraftUsed: () => void;
  onSuggestion: (text: string) => void;
  sender: ReturnType<typeof useSender>;
  tab: ContextTab;
  onTab: (t: ContextTab) => void;
  focus: { runId: string | null; nonce: number } | null;
  onShowTrace: (runId: string | null) => void;
  slideOpen: boolean;
  onOpenSlide: () => void;
  onCloseSlide: () => void;
}

/** Thread and context panel for one number; keyed by waId so all local state resets on switch. */
function ConversationView({ waId, conversation, listLoading, className, draft, onDraftUsed, onSuggestion, sender, tab, onTab, focus, onShowTrace, slideOpen, onOpenSlide, onCloseSlide }: ConversationProps) {
  const chatSamples = useQuery({
    queryKey: ['chat-samples'],
    queryFn: () => api.get<{ samples: { id: string; label: string; waId: string; caption: string; imageUrl: string }[] }>('/api/chat-samples'),
    staleTime: Infinity,
  });
  const messages = useMessages(waId);
  const trace = useConversationTrace(waId);
  const busy = sender.isSending(waId);
  const sendError = sender.errorFor(waId);
  const registered = Boolean(conversation);
  const failed = sender.optimistic.find((o) => o.waId === waId && o.failed);
  const { isAdmin } = useAuth();

  const panel = (onClose?: () => void) => (
    <ContextPanel
      waId={waId}
      tab={tab}
      onTab={onTab}
      runs={trace.runs}
      running={trace.running}
      traceLoading={trace.isLoading}
      traceError={trace.error}
      onRetryTrace={() => void trace.refetch()}
      focus={focus}
      onClose={onClose}
      className={onClose ? 'flex w-full' : 'hidden w-[340px] shrink-0 min-[1440px]:flex'}
    />
  );

  return (
    <>
      <section aria-label="Percakapan" className={`min-w-0 flex-1 flex-col rounded-card bg-surface ${className}`}>
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
          <Link to="/percakapan" aria-label="Kembali ke daftar pelanggan" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-muted lg:hidden">
            <Icon icon={ArrowLeft} size={20} />
          </Link>
          {listLoading ? (
            <Skeleton className="h-11 w-56" />
          ) : (
            <>
              <Avatar name={conversation?.name ?? 'Nomor Baru'} size={44} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="truncate text-h3 font-semibold text-ink">{conversation?.name ?? 'Nomor belum terdaftar'}</h2>
                  {conversation ? <Chip tone="success">Kelas {conversation.tier}</Chip> : <Chip tone="info">Bukan pelanggan</Chip>}
                </div>
                <p className="tabular truncate text-small text-ink-3">
                  {conversation ? `${conversation.honorific} ${conversation.ownerName} · ${conversation.area}` : formatWa(waId)}
                </p>
              </div>
            </>
          )}
          <Button variant="ghost" size="sm" icon={PanelRightOpen} onClick={onOpenSlide} className="min-[1440px]:hidden" aria-label="Buka info pelanggan dan jejak agen">
            <span className="hidden sm:inline">Info & jejak</span>
            {trace.running && <span className="ml-1 inline-block size-2 rounded-full bg-info-fg" aria-hidden="true" />}
          </Button>
        </header>

        <MessageThread
          messages={messages.data?.messages}
          optimistic={sender.optimistic.filter((o) => o.waId === waId)}
          runs={trace.runs}
          loading={messages.isLoading}
          error={messages.error}
          onRetry={() => void messages.refetch()}
          typing={busy || trace.running}
          customerName={conversation ? `${conversation.honorific} ${conversation.ownerName.split(' ')[0]}` : formatWa(waId)}
          avatarName={conversation?.name ?? 'Nomor Baru'}
          suggestions={listLoading ? [] : registered ? SUGGESTIONS : ['Halo, mau pesan Indomie goreng 1 dus']}
          onSuggestion={onSuggestion}
          onShowTrace={onShowTrace}
        />

        <Composer
          identity={
            listLoading ? (
              'Memuat data pelanggan…'
            ) : conversation ? (
              <>
                Anda mengetik sebagai{' '}
                <strong className="font-semibold text-ink">
                  {conversation.honorific} {conversation.ownerName}
                </strong>{' '}
                ({conversation.name})
              </>
            ) : (
              <>
                Anda mengetik sebagai pemilik nomor <strong className="tabular font-semibold text-ink">{formatWa(waId)}</strong> yang belum terdaftar
              </>
            )
          }
          notice={
            isAdmin
              ? null
              : 'Akun tamu: chat ini terpisah dari pesanan warung yang asli dan tidak mengubah stok atau tagihan. Pesanan dan bukti bayar masuk ke Persetujuan (paling banyak 10 permintaan per jam); kalau admin menyetujui, itu hanya simulasi. Janji bayar tidak disimpan.'
          }
          busy={busy}
          draft={draft}
          onDraftUsed={onDraftUsed}
          onSend={(out) => sender.send(waId, out)}
          samples={chatSamples.data?.samples.filter((s) => s.waId === waId)}
          error={
            sendError
              ? {
                  message: sendError.message,
                  onRetry: sendError.retry && failed ? () => sender.retry(failed) : undefined,
                }
              : null
          }
        />
      </section>

      {panel()}
      <ContextSlideOver open={slideOpen} onClose={onCloseSlide}>
        {panel(onCloseSlide)}
      </ContextSlideOver>
    </>
  );
}
