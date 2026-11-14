import { useMemo, useRef, useState } from 'react';
import { parseOcclusions } from '../../db/collection';
import { useResolvedHtml } from './CardView';
import { Trash2 } from '../ui/icons';
import { Button, Input } from '../ui/primitives';

type Region = { x: number; y: number; w: number; h: number; label?: string };

/** Draw rectangles over an image; each rectangle becomes one card. Works with mouse, pen and touch. */
export function OcclusionEditor({ imageHtml, value, onChange }: { imageHtml: string; value: string; onChange: (json: string) => void }) {
  const html = useResolvedHtml(imageHtml);
  const src = useMemo(() => /<img[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? '', [html]);
  const regions = useMemo<Region[]>(() => parseOcclusions(value), [value]);
  const stage = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const set = (next: Region[]) => onChange(next.length ? JSON.stringify(next) : '');
  const pos = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  if (!src) {
    return <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-mute">Insert an image above, then draw boxes over the parts you want to hide.</p>;
  }

  const rect = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };

  return (
    <div className="space-y-3">
      <p className="text-xs text-mute">Drag over the image to hide a region. Each region becomes its own card ({regions.length} so far, up to 100).</p>
      <div
        ref={stage}
        className="relative inline-block max-w-full touch-none select-none align-top"
        onPointerDown={(e) => {
          if (regions.length >= 100) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = pos(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, ...(() => { const p = pos(e); return { x1: p.x, y1: p.y }; })() })}
        onPointerUp={() => {
          if (rect && rect.w > 0.015 && rect.h > 0.015) set([...regions, { x: rect.x, y: rect.y, w: rect.w, h: rect.h }]);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <img src={src} alt="Image to annotate" draggable={false} className="block max-h-[60dvh] max-w-full rounded-lg" />
        {regions.map((r, i) => (
          <div key={i} className="pointer-events-none absolute flex items-center justify-center rounded-sm border-2 border-brand bg-brand/45 text-xs font-bold text-white" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>
            {i + 1}
          </div>
        ))}
        {rect && <div className="pointer-events-none absolute border-2 border-dashed border-white bg-black/30" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
      </div>
      {regions.length > 0 && (
        <ul className="space-y-1.5">
          {regions.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="kbd w-6 shrink-0">{i + 1}</span>
              <Input aria-label={`Label for region ${i + 1}`} placeholder="Optional label" maxLength={100} value={r.label ?? ''} onChange={(e) => set(regions.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))} />
              <button type="button" aria-label={`Remove region ${i + 1}`} className="rounded-md p-2 text-mute hover:bg-again/10 hover:text-again" onClick={() => set(regions.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
          <li>
            <Button size="sm" variant="ghost" onClick={() => set([])}>Clear all regions</Button>
          </li>
        </ul>
      )}
    </div>
  );
}
