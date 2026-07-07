export function etaLabel(eta: string): string {
  return eta === 'now' ? 'now' : `~${eta}`;
}

export function plusMinutes(mins: number): string {
  const d = new Date(Date.now() + mins * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function shadeColor(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Guests wear a darker shade of their host's color so both are
// recognizably "together" yet distinguishable.
export function claimColor(claim: { color: string; guestName: string | null }): string {
  return claim.guestName ? shadeColor(claim.color, 0.6) : claim.color;
}
