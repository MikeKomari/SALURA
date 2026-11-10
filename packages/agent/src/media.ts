import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lt, notInArray } from '@salura/db/orm';
import { deliveryChecks, first, media, messages, type Db, type Q } from '@salura/db';

/** A stored voice note or photo. */
export interface MediaFile {
  id: string;
  mime: string;
  data: Buffer;
  /** Stored transcript (eval dataset, bundled samples), used when no speech or vision provider is set. */
  sidecarText: string | null;
}

const MEDIA_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Allowed media type → file extension; the client's file name is never trusted. */
export function mediaExt(mime: string): string | null {
  return MEDIA_EXT[normalMime(mime)] ?? null;
}

function normalMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** Stores a file and returns its id ("<uuid>.<ext>"), which is also its public name under /media/. */
export async function saveMedia(db: Q, input: { data: Buffer; mime: string; sidecarText?: string | null; id?: string }): Promise<string> {
  const ext = mediaExt(input.mime);
  if (!ext) throw new Error(`Unsupported media type ${input.mime}`);
  // A fixed id (bundled samples) is stored once and shared by every message that sends it.
  const id = input.id ? `${input.id}${ext}` : `${randomUUID()}${ext}`;
  await db.insert(media).values({ id, mime: normalMime(input.mime), data: input.data, sidecarText: input.sidecarText ?? null }).onConflictDoNothing();
  return id;
}

/** Deletes files older than `maxAgeMs` that no message or delivery check points to any more. */
export async function pruneMedia(db: Db, now: Date, maxAgeMs = 2 * 86_400_000) {
  const used = db.select({ id: messages.mediaId }).from(messages).where(isNotNull(messages.mediaId));
  const checked = db.select({ id: deliveryChecks.mediaId }).from(deliveryChecks);
  await db
    .delete(media)
    .where(and(lt(media.createdAt, new Date(now.getTime() - maxAgeMs).toISOString()), notInArray(media.id, used), notInArray(media.id, checked)));
}

export function loadMedia(db: Q, id: string): Promise<MediaFile | undefined> {
  return first(db.select().from(media).where(eq(media.id, id)));
}
