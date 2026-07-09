import { LUNCH_PLACES } from './votes.js';

// Today's lunch menus, proxied from ETH's public gastronomy API ("Cookpit",
// the same source as the ethz.ch menu pages). Proxied server-side because
// the API sends no CORS headers, and cached because the menus only change
// once a day.
const API = 'https://idapps.ethz.ch/cookpit-pub-services/v1/weeklyrotas';
const CACHE_MS = 6 * 3600 * 1000;
const cache = new Map(); // facilityId -> { at, date, meals }

function zurichParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // Cookpit numbers days 1 (Monday) … 7 (Sunday).
  const dayCode = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { date, dayCode };
}

function studentPrice(meal) {
  const prices = meal['meal-price-array'] ?? [];
  return (prices.find((p) => p['customer-group-code'] === 10) ?? prices[0])?.price ?? null;
}

async function fetchFacilityMenu(facilityId, date, dayCode) {
  const url = `${API}?client-id=ethz-wcms&lang=de&rs-first=0&rs-size=5&facility=${facilityId}&valid-after=${date}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ETH menu API answered ${res.status}`);
  const data = await res.json();
  const rota = (data['weekly-rota-array'] ?? []).find((r) => r['valid-from'] <= date && (!r['valid-to'] || date <= r['valid-to']));
  const day = rota?.['day-of-week-array']?.find((d) => d['day-of-week-code'] === dayCode);
  const meals = [];
  for (const oh of day?.['opening-hour-array'] ?? []) {
    for (const mt of oh['meal-time-array'] ?? []) {
      for (const line of mt['line-array'] ?? []) {
        if (!line.meal) continue;
        meals.push({
          line: line.name,
          name: line.meal.name,
          description: line.meal.description ?? '',
          price: studentPrice(line.meal),
        });
      }
    }
  }
  return meals;
}

export async function menusHandler(req, res) {
  const { date, dayCode } = zurichParts();
  const menus = await Promise.all(
    LUNCH_PLACES.filter((p) => p.facilityId !== null).map(async (p) => {
      const hit = cache.get(p.facilityId);
      if (hit && hit.date === date && Date.now() - hit.at < CACHE_MS) {
        return { facilityId: p.facilityId, label: p.label, meals: hit.meals };
      }
      try {
        const meals = await fetchFacilityMenu(p.facilityId, date, dayCode);
        cache.set(p.facilityId, { at: Date.now(), date, meals });
        return { facilityId: p.facilityId, label: p.label, meals };
      } catch {
        // ETH API down or slow — show the vote without menus rather than fail.
        return { facilityId: p.facilityId, label: p.label, meals: [] };
      }
    }),
  );
  res.json({ date, menus });
}
