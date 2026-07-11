import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Claim, Table } from '../types';
import { claimColor } from '../util';

// The virtual room is CANVAS x the viewport in each dimension; the default
// view (scale = MIN_SCALE) shows all of it.
const CANVAS = 2;
const MIN_SCALE = 1 / CANVAS;
const MAX_SCALE = 3;
const FIT_VIEW = { scale: MIN_SCALE, tx: 0, ty: 0 };

// Tables snap to a 32x32 board of half-table cells (keep in sync with
// server/db.js): a table covers 2x1 cells, rotated 1x2, so snapped
// tables sit flush against each other.
const GRID_CELL = 1 / 32;
const CELLS = 32;

// The canvas shows a square *window* of that board: the smallest square
// keeping at least FRAME_CELLS empty grid squares between the outermost
// tables and every edge. A lone table or two-table column yields the
// classic 8-squares-across room; wider blocks get a slightly bigger one.
const FRAME_CELLS = 3;
const HOME_SIDE = 8;

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

interface Win {
  c0: number; // leftmost board cell shown (may be a half cell for centring)
  r0: number;
  side: number; // window size in cells; the canvas shows side x side squares
}

const HOME_WIN: Win = { c0: (CELLS - HOME_SIDE) / 2, r0: (CELLS - HOME_SIDE) / 2, side: HOME_SIDE };

// The smallest square window with FRAME_CELLS of air on every side of the
// block, centred on it. Only one axis can need fractional centring (the
// other has exactly FRAME_CELLS on both sides), so the split stays
// symmetric down to the half cell.
function windowFor(tables: Table[]): Win {
  if (tables.length === 0) return HOME_WIN;
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
  const side = Math.min(CELLS, Math.max(maxC - minC, maxR - minR) + FRAME_CELLS * 2);
  const c0 = Math.max(0, Math.min(CELLS - side, minC - (side - (maxC - minC)) / 2));
  const r0 = Math.max(0, Math.min(CELLS - side, minR - (side - (maxR - minR)) / 2));
  return { c0, r0, side };
}

const sameWin = (a: Win, b: Win) => a.c0 === b.c0 && a.r0 === b.r0 && a.side === b.side;

// The smallest square window containing both — used to grow the canvas
// without ever pulling it out from under someone's camera.
function unionWin(a: Win, b: Win): Win {
  const c0 = Math.min(a.c0, b.c0);
  const r0 = Math.min(a.r0, b.r0);
  const side = Math.min(
    CELLS,
    Math.max(Math.max(a.c0 + a.side, b.c0 + b.side) - c0, Math.max(a.r0 + a.side, b.r0 + b.side) - r0),
  );
  return {
    c0: Math.max(0, Math.min(CELLS - side, c0)),
    r0: Math.max(0, Math.min(CELLS - side, r0)),
    side,
  };
}

const idsOf = (ts: Table[]) => ts.map((t) => t.id).sort((a, b) => a - b).join(',');

// board fraction -> % of the canvas (which shows exactly the window)
function winLeft(win: Win, bx: number) {
  return ((bx * CELLS - win.c0) / win.side) * 100;
}

function winTop(win: Win, by: number) {
  return ((by * CELLS - win.r0) / win.side) * 100;
}

// Keep a dragged table fully inside the visible window.
function clampToWin(x: number, y: number, rot: 0 | 90, win: Win) {
  const hw = (rot === 0 ? 1 : 0.5) * GRID_CELL;
  const hh = (rot === 0 ? 0.5 : 1) * GRID_CELL;
  const left = win.c0 * GRID_CELL;
  const top = win.r0 * GRID_CELL;
  const span = win.side * GRID_CELL;
  return {
    x: Math.min(left + span - hw, Math.max(left + hw, x)),
    y: Math.min(top + span - hh, Math.max(top + hh, y)),
  };
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
  rot: 0 | 90;
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
  // In auto mode the window tracks the tables. Any manual pan/zoom freezes
  // it (and unlocks the camera); the ⤢ button snaps both back.
  const [auto, setAuto] = useState(true);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const [win, setWin] = useState<Win>(() => windowFor(tables));
  const winRef = useRef(win);
  winRef.current = win;
  const prevIds = useRef(idsOf(tables));
  // glide: transform transitions on for a programmatic reframe.
  // frozen: all transitions off for one commit, for invisible canvas growth.
  const [glide, setGlide] = useState(false);
  const glideTimer = useRef<number>();
  const [frozen, setFrozen] = useState(false);

  function pulseGlide() {
    setGlide(true);
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 500);
  }

  // Grow the canvas to cover `needed` without moving anything on screen:
  // the camera is rescaled/shifted to exactly cancel the window change, so
  // the new space simply exists off-screen until someone pans over to it.
  function growTo(needed: Win) {
    const cur = winRef.current;
    const next = unionWin(cur, needed);
    if (sameWin(cur, next)) return;
    const rect = outerRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const v = viewRef.current;
      setView({
        scale: (v.scale * next.side) / cur.side,
        tx: v.tx + CANVAS * rect.width * (v.scale / cur.side) * (next.c0 - cur.c0),
        ty: v.ty + CANVAS * rect.height * (v.scale / cur.side) * (next.r0 - cur.r0),
      });
    }
    setWin(next);
    setFrozen(true);
  }

  useEffect(() => {
    const ids = idsOf(tables);
    const changed = ids !== prevIds.current;
    prevIds.current = ids;
    const needed = windowFor(tables);
    if (changed && autoRef.current) {
      // adding/removing tables re-tightens to the smallest frame, gliding
      pulseGlide();
      setWin((w) => (sameWin(w, needed) ? w : needed));
      setView(FIT_VIEW);
    } else {
      // a plain move (or any change while manually zoomed) only ever
      // grows the canvas — nobody's view shifts or pans because of it
      growTo(needed);
    }
  }, [tables]);

  useLayoutEffect(() => {
    if (!frozen) return;
    // Force a style recalc while transitions are off: without it a busy
    // (or throttled) tab can skip straight from the old styles to the
    // unfrozen state and replay the invisible growth as a visible glide.
    void canvasRef.current?.offsetWidth;
    const t = window.setTimeout(() => setFrozen(false), 100);
    return () => window.clearTimeout(t);
  }, [frozen]);

  useEffect(() => () => window.clearTimeout(glideTimer.current), []);

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
    const w = winRef.current;
    const span = w.side * GRID_CELL; // board fraction shown across the canvas
    return clampToWin(
      d.origX + ((e.clientX - d.startX) / rect.width) * span,
      d.origY + ((e.clientY - d.startY) / rect.height) * span,
      d.rot,
      w,
    );
  }

  function onPointerDown(e: ReactPointerEvent, t: Table) {
    // no stopPropagation: the room must see this pointer so a second
    // finger can turn the interaction into a pinch
    dragRef.current = { id: t.id, rot: t.rot, startX: e.clientX, startY: e.clientY, origX: t.x, origY: t.y, moved: false };
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

  // The graph paper is its own layer, anchored to whole board cells so the
  // lines stay glued to the snap grid even when the window is centred on a
  // half cell. On big boards the grid thins out in clean steps — past 12
  // squares every second line goes at once (past 24, three of four) — so a
  // large room shows the same calm grid instead of a mess of hairlines.
  const step = win.side <= 12 ? 1 : win.side <= 24 ? 2 : 4;
  const lineW = step === 1 ? 1 : 2;
  const lineCol = 'rgba(44, 54, 68, 0.7)';
  const gc0 = Math.floor(win.c0 / step) * step - step;
  const gr0 = Math.floor(win.r0 / step) * step - step;
  const gridCells = win.side + 4 * step;
  const gridStyle = {
    left: `${((gc0 - win.c0) / win.side) * 100}%`,
    top: `${((gr0 - win.r0) / win.side) * 100}%`,
    width: `${(gridCells / win.side) * 100}%`,
    height: `${(gridCells / win.side) * 100}%`,
    backgroundImage: `linear-gradient(${lineCol} ${lineW}px, transparent ${lineW}px), linear-gradient(90deg, ${lineCol} ${lineW}px, transparent ${lineW}px)`,
    backgroundSize: `${(step / gridCells) * 100}% ${(step / gridCells) * 100}%`,
  };

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
        className={`room-canvas${glide ? ' animate' : ''}${frozen ? ' still' : ''}`}
        ref={canvasRef}
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        <div className="room-grid" style={gridStyle} />
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
                  left: `${winLeft(win, s.x)}%`,
                  top: `${winTop(win, s.y)}%`,
                  width: horizontal ? `${200 / win.side}%` : `${100 / win.side}%`,
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
                left: `${winLeft(win, pos.x)}%`,
                top: `${winTop(win, pos.y)}%`,
                width: horizontal ? `${200 / win.side}%` : `${100 / win.side}%`,
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
      {/* the fixed sides of the real room, so the layout reads like the space */}
      <span className="room-wall room-wall-left">Fenster</span>
      <span className="room-wall room-wall-right">Gang</span>
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => buttonZoom(1.3)} aria-label="Zoom in">
          ＋
        </button>
        <button className="zoom-btn" onClick={() => buttonZoom(1 / 1.3)} aria-label="Zoom out">
          −
        </button>
        <button
          className="zoom-btn"
          onClick={() => {
            setAuto(true);
            pulseGlide();
            setWin(windowFor(tables));
            setView(FIT_VIEW);
          }}
          aria-label="Fit the tables"
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
