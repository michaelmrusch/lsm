import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Claim, Table } from '../types';
import { claimColor } from '../util';

// The virtual room is CANVAS x the viewport in each dimension; scale =
// MIN_SCALE shows the whole board. Normally, though, the view auto-frames
// just the occupied part (see framableView).
const CANVAS = 2;
const MIN_SCALE = 1 / CANVAS;
const MAX_SCALE = 3;
const FIT_VIEW = { scale: MIN_SCALE, tx: 0, ty: 0 };
// Breathing room around the tables when auto-framing: 1.5 cells beyond the
// block's long side, which for the usual two-row strip leaves about three
// visible grid squares of air above and below. Never tighter than the
// classic 8-squares-across view.
const FRAME_MARGIN = 1.5;
const MIN_FRAME_CELLS = 8;

function clampPos(v: number) {
  return Math.min(0.94, Math.max(0.06, v));
}

// The canvas is a 32x32 board of half-table cells (keep in sync with
// server/db.js): a table covers 2x1 cells, rotated 1x2, so snapped
// tables sit flush against each other.
const GRID_CELL = 1 / 32;
const CELLS = 32;
const CELL_PCT = GRID_CELL * 100; // one cell as a % of the canvas

interface Placement {
  leftCell: number;
  topCell: number;
  wc: number;
  hc: number;
}

function tablePlacement(x: number, y: number, rot: 0 | 90): Placement {
  const wc = rot === 0 ? 2 : 1;
  const hc = rot === 0 ? 1 : 2;
  return {
    leftCell: Math.min(CELLS - wc, Math.max(0, Math.round(x / GRID_CELL - wc / 2))),
    topCell: Math.min(CELLS - hc, Math.max(0, Math.round(y / GRID_CELL - hc / 2))),
    wc,
    hc,
  };
}

function placementsOverlap(a: Placement, b: Placement) {
  return a.leftCell < b.leftCell + b.wc && b.leftCell < a.leftCell + a.wc &&
    a.topCell < b.topCell + b.hc && b.topCell < a.topCell + a.hc;
}

function placementCenter(p: Placement) {
  return { x: (p.leftCell + p.wc / 2) * GRID_CELL, y: (p.topCell + p.hc / 2) * GRID_CELL };
}

function snapPos(x: number, y: number, rot: 0 | 90) {
  return placementCenter(tablePlacement(x, y, rot));
}

// Where a dropped table actually lands (mirrors server/db.js): the
// snapped cell if free, else the nearest free spot at most one cell
// away, else null — the drop is refused.
function findFreeSpot(x: number, y: number, rot: 0 | 90, others: Placement[]) {
  const desired = tablePlacement(x, y, rot);
  let best: { x: number; y: number; dist: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cand: Placement = {
        leftCell: Math.min(CELLS - desired.wc, Math.max(0, desired.leftCell + dx)),
        topCell: Math.min(CELLS - desired.hc, Math.max(0, desired.topCell + dy)),
        wc: desired.wc,
        hc: desired.hc,
      };
      if (others.some((o) => placementsOverlap(cand, o))) continue;
      const c = placementCenter(cand);
      const dist = Math.hypot(c.x - x, c.y - y);
      if (!best || dist < best.dist) best = { ...c, dist };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function otherPlacements(tables: Table[], excludeId: number): Placement[] {
  return tables.filter((t) => t.id !== excludeId).map((t) => tablePlacement(t.x, t.y, t.rot));
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

// The view that frames exactly the tables: a square window around their
// bounding box with FRAME_MARGIN empty cells on every side, centred. This
// is what keeps the board feeling "always the perfect size" — it recomputes
// whenever the tables change and the room quietly rescales to it.
function framableView(tables: Table[], w: number, h: number): View {
  if (tables.length === 0 || w === 0) return FIT_VIEW;
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const t of tables) {
    const p = tablePlacement(t.x, t.y, t.rot);
    minC = Math.min(minC, p.leftCell);
    minR = Math.min(minR, p.topCell);
    maxC = Math.max(maxC, p.leftCell + p.wc);
    maxR = Math.max(maxR, p.topCell + p.hc);
  }
  const side = Math.max(MIN_FRAME_CELLS, Math.max(maxC - minC, maxR - minR) + FRAME_MARGIN * 2);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, 1 / (side * GRID_CELL * CANVAS)));
  const cx = ((minC + maxC) / 2) * GRID_CELL; // cluster centre, board fraction
  const cy = ((minR + maxR) / 2) * GRID_CELL;
  return { scale, tx: w / 2 - cx * CANVAS * w * scale, ty: h / 2 - cy * CANVAS * h * scale };
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
  // In auto mode the view tracks the tables (framed with a margin). Any
  // manual pan/zoom drops out of it; the ⤢ button switches it back on.
  const [auto, setAuto] = useState(true);

  // Re-frame whenever the tables (or the room size) change, while auto. A
  // layout effect so the first paint is already framed (no zoom-in on load).
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el || !auto) return;
    const refit = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setView(framableView(tables, r.width, r.height));
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tables, auto]);

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
      setAuto(false);
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
    setAuto(false);
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
      setAuto(false);
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
      const spot = findFreeSpot(pos.x, pos.y, t.rot, otherPlacements(tables, t.id));
      if (spot) onMove(d.id, spot.x, spot.y);
      // no free spot: the table springs back to where it was
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
    setAuto(false);
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
        className={`room-canvas${auto ? ' animate' : ''}`}
        ref={canvasRef}
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {live &&
          (() => {
            // dashed ghost previews the cell the dragged table will land in;
            // red means there is no room and the drop will be refused
            const t = tables.find((tb) => tb.id === live.id);
            if (!t) return null;
            const spot = findFreeSpot(live.x, live.y, t.rot, otherPlacements(tables, t.id));
            const s = spot ?? snapPos(live.x, live.y, t.rot);
            const horizontal = t.rot === 0;
            return (
              <div
                className={`rtable-ghost${spot ? '' : ' invalid'}`}
                style={{
                  left: `${s.x * 100}%`,
                  top: `${s.y * 100}%`,
                  width: horizontal ? `${2 * CELL_PCT}%` : `${CELL_PCT}%`,
                  aspectRatio: horizontal ? '2 / 1' : '1 / 2',
                }}
              />
            );
          })()}
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
                (t.stolen ? ' stolen' : '') +
                (live?.id === t.id ? ' dragging' : '')
              }
              style={{
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
                width: horizontal ? `${2 * CELL_PCT}%` : `${CELL_PCT}%`,
                aspectRatio: horizontal ? '2 / 1' : '1 / 2',
              }}
              onPointerDown={(e) => onPointerDown(e, t)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(e, t)}
              onPointerCancel={onPointerCancel}
            >
              <span className="rtable-tag">{t.label}</span>
              {t.stolen ? (
                <span className="rtable-stolen">taken by others</span>
              ) : t.released ? (
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
        <button className="zoom-btn" onClick={() => setAuto(true)} aria-label="Fit the tables">
          ⤢
        </button>
      </div>
    </div>
  );
}
