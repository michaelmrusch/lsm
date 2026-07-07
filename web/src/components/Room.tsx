import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Claim, Table } from '../types';
import { claimColor } from '../util';

// The virtual room is CANVAS x the viewport in each dimension; the default
// view (scale = MIN_SCALE) shows all of it.
const CANVAS = 2;
const MIN_SCALE = 1 / CANVAS;
const MAX_SCALE = 3;
const FIT_VIEW = { scale: MIN_SCALE, tx: 0, ty: 0 };

function clampPos(v: number) {
  return Math.min(0.94, Math.max(0.06, v));
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

// Keep the canvas covering the viewport: translation may never expose
// space beyond the room's edges.
function clampView(view: View, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  return {
    scale,
    tx: Math.min(0, Math.max(w * (1 - CANVAS * scale), view.tx)),
    ty: Math.min(0, Math.max(h * (1 - CANVAS * scale), view.ty)),
  };
}

function Segment({ claim, mine }: { claim: Claim | undefined; mine: boolean }) {
  if (!claim) return <div className="segment empty" />;
  const color = claimColor(claim);
  const style =
    claim.status === 'arrived'
      ? { background: color }
      : { background: `${color}38`, boxShadow: `inset 0 0 0 2px ${color}` };
  return (
    <div className={`segment${mine ? ' mine-seat' : ''}`} style={style}>
      <span>{(claim.guestName ?? claim.username).slice(0, 2)}</span>
    </div>
  );
}

interface DragInfo {
  id: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  moved: boolean;
}

type Gesture =
  | { type: 'pan'; startX: number; startY: number; origTx: number; origTy: number }
  | { type: 'pinch'; startDist: number; startScale: number; midX: number; midY: number; origTx: number; origTy: number };

export function Room({
  tables,
  currentUserId,
  onTap,
  onMove,
}: {
  tables: Table[];
  currentUserId: number;
  onTap(id: number, seat: number): void;
  onMove(id: number, x: number, y: number): void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const [live, setLive] = useState<{ id: number; x: number; y: number } | null>(null);

  function cancelDrag() {
    dragRef.current = null;
    setLive(null);
  }

  function zoomAt(px: number, py: number, newScale: number) {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const v = viewRef.current;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const cx = (px - v.tx) / v.scale;
    const cy = (py - v.ty) / v.scale;
    setView(clampView({ scale, tx: px - cx * scale, ty: py - cy * scale }, rect.width, rect.height));
  }

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, viewRef.current.scale * (e.deltaY < 0 ? 1.07 : 1 / 1.07));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ----- view gestures: pan with one finger on the background, pinch-zoom
  // with two fingers anywhere (a second finger cancels a table drag) -----

  function startPinch() {
    cancelDrag();
    const v = viewRef.current;
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      type: 'pinch',
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      startScale: v.scale,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      origTx: v.tx,
      origTy: v.ty,
    };
  }

  function bgPointerDown(e: ReactPointerEvent) {
    // Let the zoom controls handle their own clicks. Capturing the pointer
    // here retargets the mouse's compatibility click to the room, so on
    // desktop the buttons would never fire (touch synthesizes the click
    // from the tap, which is why it only broke with a mouse).
    if ((e.target as HTMLElement).closest('.zoom-controls')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const onTable = (e.target as HTMLElement).closest('.rtable');
    if (!onTable) {
      try {
        outerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events may not carry a real pointer
      }
    }
    if (pointers.current.size === 2) {
      startPinch();
    } else if (pointers.current.size === 1 && !onTable) {
      const v = viewRef.current;
      gesture.current = { type: 'pan', startX: e.clientX, startY: e.clientY, origTx: v.tx, origTy: v.ty };
    } else if (pointers.current.size === 1) {
      gesture.current = null; // single finger on a table: the table drags itself
    }
  }

  function bgPointerMove(e: ReactPointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const rect = outerRef.current?.getBoundingClientRect();
    if (!g || !rect) return;
    if (g.type === 'pan') {
      setView(
        clampView(
          { scale: viewRef.current.scale, tx: g.origTx + e.clientX - g.startX, ty: g.origTy + e.clientY - g.startY },
          rect.width,
          rect.height,
        ),
      );
    } else if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.startScale * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist));
      const px = g.midX - rect.left;
      const py = g.midY - rect.top;
      const cx = (px - g.origTx) / g.startScale;
      const cy = (py - g.origTy) / g.startScale;
      setView(clampView({ scale, tx: px - cx * scale, ty: py - cy * scale }, rect.width, rect.height));
    }
  }

  function bgPointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
    } else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      const v = viewRef.current;
      gesture.current = { type: 'pan', startX: p.x, startY: p.y, origTx: v.tx, origTy: v.ty };
    }
  }

  // ----- tables: tap to open, drag to move -----

  function finalPos(d: DragInfo, e: ReactPointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect(); // scaled size
    return {
      x: clampPos(d.origX + (e.clientX - d.startX) / rect.width),
      y: clampPos(d.origY + (e.clientY - d.startY) / rect.height),
    };
  }

  function onPointerDown(e: ReactPointerEvent, t: Table) {
    // no stopPropagation: the room must see this pointer so a second
    // finger can turn the interaction into a pinch
    dragRef.current = { id: t.id, startX: e.clientX, startY: e.clientY, origX: t.x, origY: t.y, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events may not carry a real pointer
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (pointers.current.size >= 2) return; // pinch owns the pointers now
    const d = dragRef.current;
    if (!d || !canvasRef.current) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return;
      d.moved = true;
    }
    setLive({ id: d.id, ...finalPos(d, e) });
  }

  function onPointerUp(e: ReactPointerEvent, t: Table) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) {
      const pos = finalPos(d, e);
      onMove(d.id, pos.x, pos.y);
    } else {
      // a tap targets the compartment under the finger
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const frac = t.rot === 0 ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      const seat = Math.max(0, Math.min(t.capacity - 1, Math.floor(frac * t.capacity)));
      onTap(d.id, seat);
    }
    setLive(null);
  }

  function onPointerCancel() {
    cancelDrag();
  }

  function buttonZoom(factor: number) {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.width / 2, rect.height / 2, viewRef.current.scale * factor);
  }

  return (
    <div
      className="room"
      ref={outerRef}
      onPointerDown={bgPointerDown}
      onPointerMove={bgPointerMove}
      onPointerUp={bgPointerUp}
      onPointerCancel={bgPointerUp}
    >
      <div
        className="room-canvas"
        ref={canvasRef}
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {tables.map((t) => {
          const pos = live?.id === t.id ? live : { x: t.x, y: t.y };
          const horizontal = t.rot === 0;
          const mine = t.claims.some((c) => c.userId === currentUserId && !c.guestName);
          return (
            <div
              key={t.id}
              className={
                'rtable' +
                (mine ? ' mine' : '') +
                (t.released ? ' released' : '') +
                (live?.id === t.id ? ' dragging' : '')
              }
              style={{
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
                width: horizontal ? '24%' : '12%',
                aspectRatio: horizontal ? '2 / 1' : '1 / 2',
              }}
              onPointerDown={(e) => onPointerDown(e, t)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(e, t)}
              onPointerCancel={onPointerCancel}
            >
              <span className="rtable-tag">{t.label}</span>
              {t.released ? (
                <span className="rtable-released">given back</span>
              ) : (
                <div className={`segments ${horizontal ? 'srow' : 'scol'}`}>
                  {Array.from({ length: t.capacity }, (_, i) => {
                    const claim = t.claims.find((c) => c.seat === i);
                    return <Segment key={i} claim={claim} mine={claim?.userId === currentUserId && !claim?.guestName} />;
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => buttonZoom(1.3)} aria-label="Zoom in">
          ＋
        </button>
        <button className="zoom-btn" onClick={() => buttonZoom(1 / 1.3)} aria-label="Zoom out">
          −
        </button>
        <button className="zoom-btn" onClick={() => setView(FIT_VIEW)} aria-label="Show the whole room">
          ⤢
        </button>
      </div>
    </div>
  );
}
