import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../store/app';
import { sanitizeHtml } from '../../lib/sanitize';
import { clozeNumbers } from '../../lib/cloze';
import { escapeHtml } from '../../lib/render';
import { MediaError } from '../../lib/media';
import { Bold, Code2, ImageIcon, Italic, Link2, List, ListOrdered, Mic, Square, Underline, Volume2 } from '../ui/icons';
import { cx } from '../ui/primitives';

/** HTML stored in the note → HTML shown in the editor (media: refs become blob URLs tagged with data-media). */
async function toEditorHtml(html: string, urlFor: (id: string) => Promise<string | null>): Promise<string> {
  const clean = sanitizeHtml(html);
  if (!/media:/.test(clean)) return clean;
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  const els = [...doc.body.querySelectorAll<HTMLElement>('[src^="media:"]')];
  await Promise.all(
    els.map(async (el) => {
      const id = el.getAttribute('src')!.slice(6);
      const url = await urlFor(id);
      el.setAttribute('data-media', id);
      if (url) el.setAttribute('src', url);
    }),
  );
  return doc.body.innerHTML;
}

/** Editor DOM → clean HTML to store (blob URLs go back to media: refs, everything sanitised). */
function fromEditor(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>('[data-media]').forEach((el) => {
    el.setAttribute('src', 'media:' + el.getAttribute('data-media'));
    el.removeAttribute('data-media');
  });
  let html = sanitizeHtml(clone.innerHTML);
  const text = clone.textContent?.replace(/​/g, '').trim() ?? '';
  if (!text && !/<(img|audio|hr)\b/i.test(html)) return '';
  html = html.replace(/^(<br\s*\/?>)+|(<br\s*\/?>)+$/gi, '');
  return html;
}

function Btn({ icon: Icon, label: l, run, active }: { icon: typeof Bold; label: string; run: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      title={l}
      aria-label={l}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cx('flex h-8 w-8 items-center justify-center rounded-md text-mute transition hover:bg-ink/10 hover:text-ink', active && 'bg-again/15 text-again')}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export interface RichEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** Changing this reloads the editor content (e.g. switching to another note). */
  resetKey?: string;
  placeholder?: string;
  label: string;
  cloze?: boolean;
  /** Hide audio/image buttons for plain-ish fields. */
  media?: boolean;
  minHeight?: string;
  onSubmit?: () => void;
}

export function RichEditor({ value, onChange, resetKey, placeholder, label, cloze, media = true, minHeight = '5.5rem', onSubmit }: RichEditorProps) {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [htmlMode, setHtmlMode] = useState(false);
  const [source, setSource] = useState('');
  const [recording, setRecording] = useState<{ stop: () => void } | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const audInput = useRef<HTMLInputElement>(null);

  // Load content on mount, on resetKey change, and when the value is changed from outside.
  const prevKey = useRef(resetKey);
  useEffect(() => {
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      lastEmitted.current = null; // a different note: always reload
    }
    const el = ref.current;
    if (!el || htmlMode) return;
    if (value === lastEmitted.current) return;
    let off = false;
    void toEditorHtml(value, (id) => app.media.urlFor(id)).then((h) => {
      if (!off && ref.current) {
        ref.current.innerHTML = h;
        lastEmitted.current = value;
      }
    });
    return () => {
      off = true;
    };
  }, [value, resetKey, htmlMode, app.media]);

  const emit = useCallback(() => {
    if (!ref.current) return;
    const html = fromEditor(ref.current);
    lastEmitted.current = html;
    onChange(html);
  }, [onChange]);

  const rememberSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };
  const exec = (cmd: string, arg?: string) => {
    restoreSelection();
    document.execCommand(cmd, false, arg);
    emit();
  };
  const insertHtml = (html: string) => {
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const attach = async (file: File) => {
    try {
      const { id, mime } = await app.media.add(file);
      const url = (await app.media.urlFor(id)) ?? '';
      insertHtml(
        mime.startsWith('image/')
          ? `<img src="${url}" data-media="${id}" alt="">`
          : `<audio controls src="${url}" data-media="${id}"></audio>&nbsp;`,
      );
    } catch (e) {
      app.toast('error', e instanceof MediaError ? e.message : 'Could not add the file');
    }
  };

  const addLink = () => {
    rememberSelection();
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) {
      app.toast('error', 'Links must start with https://, http:// or mailto:');
      return;
    }
    exec('createLink', url.trim());
  };

  const addCloze = (sameNumber: boolean) => {
    restoreSelection();
    const sel = window.getSelection();
    const text = sel?.toString() ?? '';
    if (!text) {
      app.toast('info', 'Select the text you want to hide first');
      return;
    }
    const nums = clozeNumbers(ref.current?.textContent ?? '');
    const n = sameNumber ? Math.max(1, ...nums) : Math.max(0, ...nums) + 1;
    document.execCommand('insertText', false, `{{c${n}::${text}}}`);
    emit();
  };

  const record = async () => {
    if (recording) {
      recording.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(null);
        const type = rec.mimeType || 'audio/webm';
        void attach(new File([new Blob(chunks, { type })], 'recording', { type }));
      };
      rec.start();
      setRecording({ stop: () => rec.stop() });
      setTimeout(() => rec.state === 'recording' && rec.stop(), 120_000);
    } catch {
      app.toast('error', 'Microphone access was denied or is not available on this device.');
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length && media) {
      e.preventDefault();
      rememberSelection();
      files.forEach((f) => void attach(f));
      return;
    }
    const html = e.clipboardData.getData('text/html');
    e.preventDefault();
    document.execCommand('insertHTML', false, html ? sanitizeHtml(html) : escapeHtml(e.clipboardData.getData('text/plain')).replace(/\r?\n/g, '<br>'));
    emit();
  };

  const onDrop = (e: React.DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length && media) {
      e.preventDefault();
      rememberSelection();
      files.forEach((f) => void attach(f));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      emit();
      onSubmit?.();
    } else if (cloze && mod && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      addCloze(e.altKey);
    }
  };

  const toolbar = useMemo(
    () => [
      { icon: Bold, label: 'Bold (Ctrl+B)', run: () => exec('bold') },
      { icon: Italic, label: 'Italic (Ctrl+I)', run: () => exec('italic') },
      { icon: Underline, label: 'Underline (Ctrl+U)', run: () => exec('underline') },
      { icon: List, label: 'Bulleted list', run: () => exec('insertUnorderedList') },
      { icon: ListOrdered, label: 'Numbered list', run: () => exec('insertOrderedList') },
      { icon: Link2, label: 'Link', run: addLink },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emit],
  );

  const toggleHtml = () => {
    if (!htmlMode) {
      setSource(ref.current ? fromEditor(ref.current) : value);
      setHtmlMode(true);
    } else {
      const clean = sanitizeHtml(source);
      lastEmitted.current = null;
      onChange(clean);
      setHtmlMode(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1" role="toolbar" aria-label={`${label} formatting`}>
        {!htmlMode && toolbar.map((t) => <Btn key={t.label} icon={t.icon} label={t.label} run={t.run} />)}
        {!htmlMode && media && (
          <>
            <span className="mx-1 h-5 w-px bg-line" />
            <Btn icon={ImageIcon} label="Insert image" run={() => { rememberSelection(); imgInput.current?.click(); }} />
            <Btn icon={Volume2} label="Insert audio file" run={() => { rememberSelection(); audInput.current?.click(); }} />
            {typeof MediaRecorder !== 'undefined' && <Btn icon={recording ? Square : Mic} label={recording ? 'Stop recording' : 'Record audio'} run={() => { rememberSelection(); void record(); }} active={!!recording} />}
          </>
        )}
        {!htmlMode && cloze && (
          <button
            type="button"
            title="Make cloze (Ctrl+Shift+C)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addCloze(false)}
            className="ml-1 rounded-md bg-brand/10 px-2 py-1 text-xs font-semibold text-brand hover:bg-brand/20"
          >
            [...] Cloze
          </button>
        )}
        <span className="ml-auto" />
        <Btn icon={Code2} label={htmlMode ? 'Back to visual editor' : 'Edit HTML'} run={toggleHtml} active={htmlMode} />
      </div>
      {htmlMode ? (
        <textarea
          aria-label={`${label} (HTML)`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          className="block w-full resize-y bg-transparent p-3 font-mono text-xs outline-none"
          style={{ minHeight }}
        />
      ) : (
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder}
          className="editor-area p-3 text-[15px] outline-none"
          style={{ minHeight }}
          onInput={emit}
          onBlur={() => {
            rememberSelection();
            emit();
          }}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onPaste={onPaste}
          onDrop={onDrop}
          onKeyDown={onKeyDown}
        />
      )}
      <input ref={imgInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void attach(f); }} />
      <input ref={audInput} type="file" accept="audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void attach(f); }} />
    </div>
  );
}
