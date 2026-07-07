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
}

export interface Table {
  id: number;
  label: string;
  released: boolean;
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
  createdAt: number;
}

export interface SpaceState {
  space: SpaceInfo;
  tables: Table[];
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
}
