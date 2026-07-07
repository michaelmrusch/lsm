import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { PALETTE } from '../colors';
import type { GroupSummary } from '../types';

function GithubLink() {
  return (
    <a className="gh-link" href="https://github.com/michaelmrusch/lsm" target="_blank" rel="noreferrer">
      <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
      Open source on GitHub
    </a>
  );
}

export function Home() {
  const { user, loading, signIn, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next');

  const [username, setUsername] = useState(() => localStorage.getItem('lsm.lastName') ?? '');
  const [pin, setPin] = useState('');
  const [color, setColor] = useState(
    () => localStorage.getItem('lsm.lastColor') ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ spaces: GroupSummary[] }>('/api/me/spaces')
      .then((r) => setGroups(r.spaces))
      .catch(() => setGroups([]));
  }, [user]);

  async function submitSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), pin, color);
      localStorage.setItem('lsm.lastName', username.trim());
      localStorage.setItem('lsm.lastColor', color);
      if (next) navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  function submitJoin(e: FormEvent) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code) navigate(`/s/${code}`);
  }

  if (loading) {
    return <div className="screen-center">Loading…</div>;
  }

  if (!user) {
    return (
      <div className="app">
        <div className="hero">
          <div className="hero-icon">🪑</div>
          <h1>Learning Space Manager</h1>
          <p className="tagline">Reserve tables together — see who's coming and when.</p>
        </div>
        <form className="card stack" onSubmit={submitSignIn}>
          <label className="field">
            <span>Your name</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. Anna"
              autoComplete="username"
              maxLength={20}
              required
            />
          </label>
          <label className="field">
            <span>PIN (4–8 digits)</span>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              pattern="\d{4,8}"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••"
              autoComplete="current-password"
              maxLength={8}
              required
            />
          </label>
          <div className="field">
            <span>Your color</span>
            <div className="swatches">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch${c === color ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? '…' : "Let's go"}
          </button>
          <p className="hint">New name? An account is created automatically. Same name + PIN signs you back in.</p>
        </form>
        <GithubLink />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="page-head">
        <h1>Learning Space Manager</h1>
        <p className="tagline">
          Hi <span className="person-dot inline-dot" style={{ background: user.color }} />
          {user.username}!{' '}
          <button className="link-btn" onClick={() => void signOut()}>
            Sign out
          </button>
          {user.isAdmin && (
            <>
              {' · '}
              <Link to="/admin" className="link-btn">
                Admin
              </Link>
            </>
          )}
        </p>
      </header>

      <div className="stack">
        {groups && groups.length > 0 && (
          <div className="card stack">
            <h2 className="section-title">Your spaces</h2>
            {groups.map((g) => (
              <Link key={g.code} to={`/s/${g.code}`} className="recent-row group-row">
                <span className={`group-status ${g.status}`} />
                <span className="group-main">
                  <span className="recent-name">{g.name}</span>
                  <span className="group-sub">
                    {g.status === 'open'
                      ? `${g.openedByName} set it up · ${g.peopleCount} ${g.peopleCount === 1 ? 'person' : 'people'} · ${g.freeSeats} ${g.freeSeats === 1 ? 'seat' : 'seats'} free`
                      : 'Nothing set up today'}
                  </span>
                </span>
                <span className="recent-code">{g.code}</span>
              </Link>
            ))}
          </div>
        )}

        <Link to="/new" className="btn btn-primary btn-link">
          ➕ Create a space
        </Link>

        <form className="card stack" onSubmit={submitJoin}>
          <label className="field">
            <span>Join with a code</span>
            <input
              className="input input-code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="e.g. K3XF7Q"
              maxLength={6}
              autoCapitalize="characters"
              autoCorrect="off"
            />
          </label>
          <button className="btn btn-secondary" disabled={!joinCode.trim()}>
            Open space
          </button>
        </form>
      </div>
      <GithubLink />
    </div>
  );
}
