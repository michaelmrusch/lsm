import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { disablePush, enablePush, getPushEnabled, iosNeedsInstall, pushSupported } from '../push';
import type { SpaceState } from '../types';
import { SummaryBar } from '../components/SummaryBar';
import { Room } from '../components/Room';
import { PeopleList } from '../components/PeopleList';
import { ClaimSheet } from '../components/ClaimSheet';
import { Stepper } from '../components/Stepper';

export function Space() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [state, setState] = useState<SpaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<{ id: number; seat: number } | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [setupTables, setSetupTables] = useState(4);
  const [setupSeats, setSetupSeats] = useState(1);
  const toastTimer = useRef<number>();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    if (!loading && !user) navigate(`/?next=/s/${code}`, { replace: true });
  }, [loading, user, code, navigate]);

  useEffect(() => {
    getPushEnabled().then(setPushOn).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<SpaceState>(`/api/spaces/${code}`)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError && e.status === 404 ? 'This space does not exist.' : e.message);
      });
    const es = new EventSource(`/api/spaces/${code}/events`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.deleted) {
        navigate('/', { replace: true });
        return;
      }
      setState(data);
      setConnected(true);
    };
    es.onerror = () => setConnected(false);
    return () => {
      cancelled = true;
      es.close();
    };
  }, [user, code]);

  const mutate = useCallback(
    async (path: string, options: { method: string; body?: unknown }, { close = true } = {}) => {
      try {
        const s = await api<SpaceState>(path, options);
        setState(s);
        if (close) setSelected(null);
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Something went wrong.');
      }
    },
    [showToast],
  );

  async function share() {
    const url = window.location.origin + `/s/${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: state?.space.name ?? 'Learning Space', url });
      } else {
        await navigator.clipboard.writeText(url);
        showToast('Link copied — send it to your group!');
      }
    } catch {
      // user dismissed the share sheet
    }
  }

  async function toggleNotifications() {
    if (!pushSupported()) {
      showToast('Notifications are not supported in this browser.');
      return;
    }
    if (iosNeedsInstall()) {
      showToast('On iPhone: first add this app to your Home Screen (Share → Add to Home Screen), then enable notifications from the installed app.');
      return;
    }
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        showToast('Notifications are off.');
      } else {
        await enablePush();
        setPushOn(true);
        showToast("You'll be notified when the space gets set up and when people join.");
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not change notifications.');
    }
  }

  if (error) {
    return (
      <div className="app screen-center stack">
        <p className="error">{error}</p>
        <Link to="/" className="btn btn-secondary btn-link">
          Back to start
        </Link>
      </div>
    );
  }

  if (!user || !state) {
    return <div className="screen-center">Loading…</div>;
  }

  const { space, tables } = state;
  const canManageSession =
    space.status === 'open' && (space.openedBy === user.id || space.ownerId === user.id || user.isAdmin);
  const canDeleteSpace = space.ownerId === user.id || user.isAdmin;
  const selectedTable = selected ? tables.find((t) => t.id === selected.id) ?? null : null;

  async function deleteSpace() {
    if (!window.confirm(`Delete “${space.name}” forever? The code stops working for everyone.`)) return;
    try {
      await api(`/api/spaces/${code}`, { method: 'DELETE' });
      navigate('/', { replace: true });
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete the space.');
    }
  }

  const header = (
    <header className="top-bar">
      <Link to="/" className="icon-btn" aria-label="Back">
        ←
      </Link>
      <div className="top-title-group">
        <h1 className="top-title">{space.name}</h1>
        <span className="top-sub">
          Code {space.code}
          {space.status === 'open' && space.openedByName ? ` · set up by ${space.openedByName}` : ''}
          <span className={`live-dot ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
        </span>
      </div>
      <button
        className={`icon-btn${pushOn ? ' icon-btn-active' : ''}`}
        onClick={() => void toggleNotifications()}
        aria-label="Notifications"
      >
        {pushOn ? '🔔' : '🔕'}
      </button>
      <button className="icon-btn" onClick={() => void share()} aria-label="Share">
        📤
      </button>
    </header>
  );

  if (space.status === 'idle') {
    return (
      <div className="app">
        {header}
        <div className="stack idle-screen">
          <div className="card stack idle-card">
            <div className="hero-icon">🌅</div>
            <h2 className="idle-title">Nothing set up today</h2>
            <p className="hint idle-hint">
              First one there? Reserve the tables in the room, then set them up here — everyone in the group
              {pushOn ? ' gets notified.' : ' gets notified (turn on the 🔔 above to get yours).'}
            </p>
          </div>
          <div className="card stack">
            <Stepper label="Tables reserved" value={setupTables} min={1} max={20} onChange={setSetupTables} />
            <Stepper label="Seats per table" value={setupSeats} min={1} max={8} onChange={setSetupSeats} />
            <button
              className="btn btn-primary"
              onClick={() =>
                void mutate(`/api/spaces/${code}/sessions`, {
                  method: 'POST',
                  body: { tableCount: setupTables, defaultCapacity: setupSeats },
                })
              }
            >
              🌅 Set up the space
            </button>
          </div>
          {canDeleteSpace && (
            <button className="btn btn-danger" onClick={() => void deleteSpace()}>
              Delete this space forever
            </button>
          )}
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  const actions = {
    join: (tableId: number, eta: string, seat?: number) =>
      mutate(`/api/spaces/${code}/tables/${tableId}/claims`, { method: 'POST', body: { eta, seat } }),
    addGuest: (tableId: number, name: string, eta: string, seat?: number) =>
      mutate(`/api/spaces/${code}/tables/${tableId}/guests`, { method: 'POST', body: { name, eta, seat } }),
    updateClaim: (claimId: number, body: { eta?: string; status?: string }, close = true) =>
      mutate(`/api/spaces/${code}/claims/${claimId}`, { method: 'PATCH', body }, { close }),
    removeClaim: (claimId: number) => mutate(`/api/spaces/${code}/claims/${claimId}`, { method: 'DELETE' }),
    setReleased: (tableId: number, released: boolean) =>
      mutate(`/api/spaces/${code}/tables/${tableId}`, { method: 'PATCH', body: { released } }, { close: false }),
    setCapacity: (tableId: number, capacity: number) =>
      mutate(`/api/spaces/${code}/tables/${tableId}`, { method: 'PATCH', body: { capacity } }, { close: false }),
    rotate: (tableId: number) => {
      const t = tables.find((table) => table.id === tableId);
      if (!t) return;
      void mutate(
        `/api/spaces/${code}/tables/${tableId}`,
        { method: 'PATCH', body: { rot: t.rot === 0 ? 90 : 0 } },
        { close: false },
      );
    },
    move: (tableId: number, x: number, y: number) =>
      mutate(`/api/spaces/${code}/tables/${tableId}`, { method: 'PATCH', body: { x, y } }, { close: false }),
    removeTable: (tableId: number) => mutate(`/api/spaces/${code}/tables/${tableId}`, { method: 'DELETE' }),
  };

  return (
    <div className="app space-layout">
      <div className="space-main">
        {header}

        <SummaryBar state={state} />

        <div className="room-wrap">
          <Room tables={tables} currentUserId={user.id} onTap={(id, seat) => setSelected({ id, seat })} onMove={actions.move} />
        </div>
        <div className="room-toolbar">
          <p className="hint room-hint">Tap a table to set it up — drag to move it, pinch or scroll to zoom.</p>
          <button
            className="btn btn-secondary btn-compact"
            onClick={() => void mutate(`/api/spaces/${code}/tables`, { method: 'POST' }, { close: false })}
          >
            ➕ Add table
          </button>
        </div>
      </div>

      <aside className="space-side">
        <PeopleList tables={tables} />

        {canManageSession && (
          <button
            className="btn btn-danger end-space"
            onClick={() => {
              if (window.confirm('End today\'s session? Tables and seats are cleared — the space and its code stay.')) {
                void mutate(`/api/spaces/${code}`, { method: 'PATCH', body: { status: 'idle' } });
              }
            }}
          >
            End today's session
          </button>
        )}
      </aside>

      {selectedTable && selected && (
        <ClaimSheet
          state={state}
          table={selectedTable}
          seat={Math.min(selected.seat, selectedTable.capacity - 1)}
          userId={user.id}
          canManageClaims={canManageSession}
          onClose={() => setSelected(null)}
          actions={actions}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
