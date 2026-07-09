import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FacilityMenu, SpaceState, Vote, VoteOption } from '../types';

interface VoteActions {
  castBallot(voteId: number, optionId: number | null): void;
  addOption(voteId: number, label: string): void;
  createVote(title: string): void;
  removeVote(voteId: number): void;
}

function leaderOf(vote: Vote): VoteOption | null {
  let best: VoteOption | null = null;
  for (const o of vote.options) {
    if (o.voters.length > 0 && (!best || o.voters.length > best.voters.length)) best = o;
  }
  return best;
}

// The quiet part: one slim chip per running vote showing just the current
// leader. Everything else lives in the overlay.
export function VotesBar({ votes, onOpen }: { votes: Vote[]; onOpen(): void }) {
  return (
    <div className="vote-bar">
      {votes.map((v) => {
        const lead = leaderOf(v);
        return (
          <button key={v.id} className="chip vote-chip" onClick={onOpen}>
            🗳️ {v.title}:{' '}
            {lead ? (
              <>
                <strong>{lead.label}</strong> · {lead.voters.length}
              </>
            ) : (
              'no votes yet'
            )}
          </button>
        );
      })}
      <button className="chip vote-chip vote-chip-new" onClick={onOpen}>
        {votes.length === 0 ? '🗳️ Start a vote' : '+'}
      </button>
    </div>
  );
}

function MenuDetail({ menus, facilityId }: { menus: FacilityMenu[] | null; facilityId: number }) {
  if (!menus) return <p className="hint menu-detail">Loading today's menu…</p>;
  const menu = menus.find((m) => m.facilityId === facilityId);
  if (!menu || menu.meals.length === 0) {
    return <p className="hint menu-detail">No menu published for today.</p>;
  }
  return (
    <ul className="menu-detail">
      {menu.meals.map((meal, i) => (
        <li key={i}>
          <span className="menu-line">{meal.line}</span>
          <span className="menu-meal">
            {meal.name}
            {meal.description && <span className="menu-desc"> — {meal.description}</span>}
          </span>
          {meal.price !== null && <span className="menu-price">{meal.price.toFixed(2)}</span>}
        </li>
      ))}
    </ul>
  );
}

function VoteCard({
  vote,
  userId,
  canManage,
  menus,
  actions,
}: {
  vote: Vote;
  userId: number;
  canManage: boolean;
  menus: FacilityMenu[] | null;
  actions: VoteActions;
}) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [newOption, setNewOption] = useState('');
  const myOptionId = vote.options.find((o) => o.voters.some((v) => v.userId === userId))?.id ?? null;
  const alreadyAdded = vote.options.some((o) => o.addedBy === userId);
  const canRemove = canManage || vote.createdBy === userId;

  return (
    <div className="sheet-section vote-card">
      <div className="vote-head">
        <p className="sheet-label">{vote.title}</p>
        {canRemove && vote.kind === 'custom' && (
          <button className="occupant-btn danger" title="Remove this vote" onClick={() => actions.removeVote(vote.id)}>
            ✕
          </button>
        )}
      </div>
      {vote.options.map((o) => (
        <div key={o.id}>
          <div className={`vote-opt${o.id === myOptionId ? ' mine' : ''}`}>
            <button
              className="vote-opt-main"
              onClick={() => actions.castBallot(vote.id, o.id === myOptionId ? null : o.id)}
            >
              <span className="vote-check">{o.id === myOptionId ? '✅' : '⬜'}</span>
              <span className="vote-label">{o.label}</span>
              <span className="voter-dots">
                {o.voters.map((v) => (
                  <span key={v.userId} className="person-dot" style={{ background: v.color }} title={v.username} />
                ))}
              </span>
              <span className="vote-count">{o.voters.length > 0 ? o.voters.length : ''}</span>
            </button>
            {o.facilityId !== null && (
              <button
                className="occupant-btn"
                title="Today's menu"
                onClick={() => setOpenMenu(openMenu === o.id ? null : o.id)}
              >
                {openMenu === o.id ? '▴' : 'ℹ️'}
              </button>
            )}
          </div>
          {openMenu === o.id && o.facilityId !== null && <MenuDetail menus={menus} facilityId={o.facilityId} />}
        </div>
      ))}
      {!alreadyAdded && (
        <div className="vote-add-row">
          <input
            className="input"
            value={newOption}
            onChange={(e) => setNewOption(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newOption.trim()) {
                e.preventDefault();
                actions.addOption(vote.id, newOption.trim());
                setNewOption('');
              }
            }}
            placeholder="Add your own option (1 per person)"
            maxLength={40}
          />
          <button
            className="btn btn-secondary btn-compact"
            disabled={!newOption.trim()}
            onClick={() => {
              actions.addOption(vote.id, newOption.trim());
              setNewOption('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export function VoteSheet({
  state,
  userId,
  canManage,
  onClose,
  actions,
}: {
  state: SpaceState;
  userId: number;
  canManage: boolean;
  onClose(): void;
  actions: VoteActions;
}) {
  const [menus, setMenus] = useState<FacilityMenu[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const needMenus = state.votes.some((v) => v.options.some((o) => o.facilityId !== null));

  useEffect(() => {
    if (!needMenus) return;
    api<{ menus: FacilityMenu[] }>('/api/menus')
      .then((r) => setMenus(r.menus))
      .catch(() => setMenus([]));
  }, [needMenus]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet vote-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>Votes</h2>
        </div>
        <div className="stack">
          {state.votes.length === 0 && <p className="hint">No votes running — start one below.</p>}
          {state.votes.map((v) => (
            <VoteCard key={v.id} vote={v} userId={userId} canManage={canManage} menus={menus} actions={actions} />
          ))}
          <div className="sheet-section">
            <p className="sheet-label">Start a new vote</p>
            <div className="vote-add-row">
              <input
                className="input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTitle.trim()) {
                    e.preventDefault();
                    actions.createVote(newTitle.trim());
                    setNewTitle('');
                  }
                }}
                placeholder="What are you deciding?"
                maxLength={40}
              />
              <button
                className="btn btn-secondary btn-compact"
                disabled={!newTitle.trim()}
                onClick={() => {
                  actions.createVote(newTitle.trim());
                  setNewTitle('');
                }}
              >
                Start
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
