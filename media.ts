/**
 * Media (images / audio) attached to notes.
 *   • Files are validated (type allow-list, 10 MB, no SVG), stored in IndexedDB and referenced from card HTML as
 *     `media:<id>`; blob: URLs are created only when rendering.
 *   • When a cloud account is active, uploads go to the private `media` bucket under `<user_id>/<id>` (RLS limits each
 *     user to their own folder) and missing files are downloaded on demand.
 */
import type { Persistence } from '../db/persistence';
import { uuid } from './ids';

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
};

export class MediaError extends Error {}

export interface CloudMedia {
  upload(path: string, blob: Blob): Promise<void>;
  download(path: string): Promise<Blob | null>;
}

export const isImage = (mime: string) => mime.startsWith('image/');
export const isAudio = (mime: string) => mime.startsWith('audio/');

/** Check the file's declared type against the allow-list and sniff the first bytes so a renamed file is caught. */
export async function validateMediaFile(file: Blob & { name?: string }): Promise<string> {
  const mime = file.type.split(';')[0].trim().toLowerCase(); // recorders report e.g. "audio/webm;codecs=opus"
  if (!TYPES[mime]) throw new MediaError('Unsupported file type. Use PNG, JPEG, GIF, WebP, MP3, M4A, OGG, WAV or WebM.');
  if (file.size === 0) throw new MediaError('The file is empty.');
  if (file.size > MAX_MEDIA_BYTES) throw new MediaError('The file is larger than 10 MB.');
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (a: number, b: number) => String.fromCharCode(...head.slice(a, b));
  const ok =
    (mime === 'image/png' && head[0] === 0x89 && ascii(1, 4) === 'PNG') ||
    (mime === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8) ||
    (mime === 'image/gif' && ascii(0, 3) === 'GIF') ||
    (mime === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') ||
    (mime === 'audio/mpeg' && (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) ||
    (mime === 'audio/mp4' && ascii(4, 8) === 'ftyp') ||
    (mime === 'audio/ogg' && ascii(0, 4) === 'OggS') ||
    (mime === 'audio/wav' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') ||
    (mime === 'audio/webm' && head[0] === 0x1a && head[1] === 0x45);
  if (!ok) throw new MediaError('The file contents do not match its type.');
  return TYPES[mime];
}

export class MediaStore {
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string | null>>();

  constructor(
    private store: Persistence,
    private userId: string,
    private cloud: CloudMedia | null = null,
  ) {}

  /** Validate, store, queue for upload. Returns the id to embed as `media:<id>`. */
  async add(file: Blob & { name?: string }): Promise<{ id: string; mime: string }> {
    const ext = await validateMediaFile(file);
    const id = `${uuid()}.${ext}`;
    const mime = file.type.split(';')[0].trim().toLowerCase();
    const clean = file.type === mime ? file : file.slice(0, file.size, mime);
    await this.store.putMedia(id, clean);
    if (this.cloud) {
      const pending = (await this.store.getMeta<string[]>('media:pending')) ?? [];
      await this.store.setMeta('media:pending', [...pending, id]);
    }
    return { id, mime };
  }

  /** Upload queued files. Failures stay queued for the next sync. */
  async flushUploads(): Promise<number> {
    if (!this.cloud) return 0;
    const pending = (await this.store.getMeta<string[]>('media:pending')) ?? [];
    const left: string[] = [];
    let done = 0;
    for (const id of pending) {
      const blob = await this.store.getMedia(id);
      if (!blob) continue;
      try {
        await this.cloud.upload(`${this.userId}/${id}`, blob);
        done++;
      } catch {
        left.push(id);
      }
    }
    await this.store.setMeta('media:pending', left);
    return done;
  }

  async urlFor(id: string): Promise<string | null> {
    const hit = this.urls.get(id);
    if (hit) return hit;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = (async () => {
      let blob = await this.store.getMedia(id);
      if (!blob && this.cloud) {
        try {
          blob = (await this.cloud.download(`${this.userId}/${id}`)) ?? undefined;
          if (blob) await this.store.putMedia(id, blob);
        } catch {
          /* offline: leave unresolved */
        }
      }
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      this.urls.set(id, url);
      return url;
    })().finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Replace every `media:<id>` in already-sanitised HTML by a blob: URL. Unknown ids are left as inert text. */
  async resolveHtml(html: string): Promise<string> {
    const ids = [...new Set([...html.matchAll(/media:([A-Za-z0-9._-]+)/g)].map((m) => m[1]))];
    if (ids.length === 0) return html;
    const map = new Map<string, string | null>();
    await Promise.all(ids.map(async (id) => map.set(id, await this.urlFor(id))));
    return html.replace(/media:([A-Za-z0-9._-]+)/g, (m, id: string) => map.get(id) ?? m);
  }

  dispose(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}
