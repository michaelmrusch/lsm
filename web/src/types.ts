export interface User {
  id: number;
  username: string;
  color: string;
  isAdmin: boolean;
}

export interface Claim {
  id: number;
  userId: number; // for guests: the member who reserved the seat
  username: string;
  color: string;
  guestName: string | null;
  seat: number; // compartment index on the table (0-based)
  eta: string; // 'now' or 'HH:MM'
  status: 'coming' | 'arrived';
  arrivedAt: number | null; // unix seconds, set when they actually sat down
}

export interface Table {
  id: number;
  label: string;
  released: boolean;
  stolen: boolean; // given back AND grabbed by someone outside the group
  capacity: number;
  x: number; // center, fraction of room width (0..1)
  y: number; // center, fraction of room height (0..1)
  rot: 0 | 90;
  claims: Claim[];
}

export interface SpaceInfo {
  code: string;
  name: string;
  ownerId: number;
  ownerName: string;
  status: 'idle' | 'open';
  openedBy: number | null;
  openedByName: string | null;
  openedAt: number | null;
  lastSetup: { tableCount: number; totalSeats: number } | null;
  createdAt: number;
}

export interface NotificationPreferences {
  setup: boolean;
  activity: boolean;
  votes: boolean;
  timers: boolean;
  chat: boolean;
}

export interface SpaceMembership {
  archived: boolean;
  notifications: NotificationPreferences;
}

// Everyone who ever opened the space (they had the code, so they're in the
// group) — the pool admins can book seats for.
export interface Member {
  userId: number;
  username: string;
  color: string;
}

// "I'll be back tomorrow" pledge — intent only, no arrival time.
export interface TomorrowPledge {
  userId: number;
  username: string;
  color: string;
}

export interface VoteVoter {
  userId: number;
  username: string;
  color: string;
}

export interface VoteOption {
  id: number;
  label: string;
  facilityId: number | null; // ETH gastronomy facility, for the live menu view
  addedBy: number | null; // null = built-in option
  voters: VoteVoter[];
}

export interface Vote {
  id: number;
  kind: 'lunch' | 'custom';
  title: string;
  createdBy: number | null;
  options: VoteOption[];
}

export interface TimerParticipant {
  userId: number;
  username: string;
  color: string;
}

// Shared focus round: the client renders the countdown from endsAt itself;
// joining is only open until joinUntil (first 10% of the round).
export interface FocusTimer {
  id: number;
  durationS: number;
  startedAt: number;
  endsAt: number;
  joinUntil: number;
  startedBy: number | null;
  startedByName: string | null;
  participants: TimerParticipant[];
}

export interface ChatMessage {
  id: number;
  userId: number;
  username: string;
  color: string;
  body: string;
  createdAt: number;
}

// Session-scoped room chat. badgeHidden lists users who turned off the unread
// badge — a chat-window-only switch that does not affect push notifications
// (those follow the space's chat notification preference). The log is wiped
// when the session ends.
export interface ChatState {
  messages: ChatMessage[];
  badgeHidden: number[];
}

export interface Meal {
  line: string;
  name: string;
  description: string;
  price: number | null;
  image: string | null; // food photo, when the mensa published one
}

export interface FacilityMenu {
  facilityId: number;
  label: string;
  meals: Meal[];
  // open = dishes online · closed = week published but no service today ·
  // unknown = menu not online (yet)
  status: 'open' | 'closed' | 'unknown';
}

export interface SpaceState {
  space: SpaceInfo;
  tables: Table[];
  members: Member[];
  tomorrow: TomorrowPledge[];
  votes: Vote[];
  timer: FocusTimer | null;
  chat: ChatState;
}

export interface GroupSummary {
  code: string;
  name: string;
  status: 'idle' | 'open';
  ownerName: string;
  openedByName: string | null;
  totalSeats: number;
  peopleCount: number;
  freeSeats: number;
  archived: boolean;
}
