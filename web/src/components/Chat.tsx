import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../types';

export interface ChatActions {
  sendMessage(text: string): void;
  setChatNotify(enabled: boolean): void;
  setBadgeHidden(hidden: boolean): void;
}

// A tiny support-widget-style chat pinned to the bottom-right corner:
// collapsed it is just a square button (with an unread count unless the badge
// is switched off), expanded it is a minimal message panel for the people in
// the room today.
export function RoomChat({
  chat,
  userId,
  code,
  canChat,
  notifyChat,
  actions,
}: {
  chat: ChatState;
  userId: number;
  code: string;
  canChat: boolean;
  notifyChat: boolean;
  actions: ChatActions;
}) {
  const { messages } = chat;
  const badgeHidden = chat.badgeHidden.includes(userId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // Unread tracking is local: the id of the newest message this browser saw.
  const [lastRead, setLastRead] = useState(() => Number(localStorage.getItem(`lsm-chat-read-${code}`) || 0));
  const listRef = useRef<HTMLDivElement>(null);

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : 0;

  useEffect(() => {
    if (!open) return;
    if (lastId > lastRead) {
      setLastRead(lastId);
      localStorage.setItem(`lsm-chat-read-${code}`, String(lastId));
    }
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, lastId, lastRead, code]);

  const unread = badgeHidden ? 0 : messages.filter((m) => m.id > lastRead && m.userId !== userId).length;

  function send() {
    const t = text.trim();
    if (!t) return;
    actions.sendMessage(t);
    setText('');
  }

  if (!open) {
    return (
      <button className="chat-fab" aria-label="Room chat" onClick={() => setOpen(true)}>
        💬
        {unread > 0 && <span className="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">Room chat</span>
        <button
          className="icon-btn chat-icon"
          title={notifyChat ? 'Notifications on — tap to mute (same as in Settings)' : 'Notifications off — tap to unmute (same as in Settings)'}
          onClick={() => actions.setChatNotify(!notifyChat)}
        >
          {notifyChat ? '🔔' : '🔕'}
        </button>
        <button
          className="icon-btn chat-icon"
          title={badgeHidden ? 'Unread badge off — tap to show the count' : 'Unread badge on — tap to hide the count'}
          onClick={() => actions.setBadgeHidden(!badgeHidden)}
        >
          {badgeHidden ? '⚪' : '🔴'}
        </button>
        <button className="icon-btn chat-icon" aria-label="Close" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div className="chat-msgs" ref={listRef}>
        {messages.length === 0 && <p className="hint chat-empty">Just the people in the room today — say hi 👋</p>}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat-msg${m.userId === userId ? ' mine' : ''}`}
            title={new Date(m.createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          >
            {m.userId !== userId && (
              <span className="chat-msg-name" style={{ color: m.color }}>
                {m.username}
              </span>
            )}
            {m.body}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          className="input"
          value={text}
          maxLength={500}
          placeholder={canChat ? 'Message the room…' : 'Grab a seat to chat'}
          disabled={!canChat}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary btn-compact chat-send" disabled={!canChat || !text.trim()} onClick={send}>
          ➤
        </button>
      </div>
    </div>
  );
}
