import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from './db.js';

// VAPID keys identify this server to the browsers' push services.
// Generated once and kept next to the database so subscriptions survive restarts.
const vapidPath = path.join(dataDir, 'vapid.json');
let vapid;
try {
  vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} catch {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapid));
}
webpush.setVapidDetails('mailto:michael.m.rusch@bluewin.ch', vapid.publicKey, vapid.privateKey);

export const vapidPublicKey = vapid.publicKey;

// The server POSTs to whatever endpoint a subscription names, so an
// unchecked endpoint is a server-side request forgery hole: anyone signed in
// could point it at http://192.168.x.x/… or another service on the home
// network and have this server fire requests at it on every notification.
// Real subscriptions only ever point at the browsers' push services.
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera, Samsung Internet
  'android.googleapis.com', // older Chrome subscriptions
  'updates.push.services.mozilla.com', // Firefox
]);
const PUSH_HOST_SUFFIXES = [
  '.push.apple.com', // Safari / iOS home-screen apps
  '.notify.windows.com', // legacy Edge / Windows (WNS)
];

export function isPushEndpointAllowed(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function isValidSubscription(sub) {
  return (
    !!sub &&
    typeof sub.endpoint === 'string' &&
    sub.endpoint.length <= 2048 &&
    isPushEndpointAllowed(sub.endpoint) &&
    typeof sub.keys?.p256dh === 'string' &&
    typeof sub.keys?.auth === 'string' &&
    sub.keys.p256dh.length <= 256 &&
    sub.keys.auth.length <= 64
  );
}

export function saveSubscription(userId, subscription) {
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, subscription) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription
  `).run(subscription.endpoint, userId, JSON.stringify(subscription));
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

export function notifyUsers(userIds, payload) {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => '?').join(',');
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...userIds);
  const data = JSON.stringify(payload);
  for (const row of subs) {
    // Re-checked at send time too: rows stored before the endpoint
    // allowlist existed must never be contacted.
    if (!isPushEndpointAllowed(row.endpoint)) continue;
    // High urgency so Android/Chrome (which delivers web push via FCM) wakes
    // the device and shows it now. Without this the Web Push default urgency is
    // "normal", which Android holds in Doze until the phone next wakes on its
    // own — so notifications arrive late or not at all.
    // TTL: these messages coordinate a single study day — if a phone is
    // unreachable for hours, delivering them later would only confuse
    // (the push-service default keeps trying for ~4 weeks).
    webpush.sendNotification(JSON.parse(row.subscription), data, { urgency: 'high', TTL: 3 * 3600 }).catch((err) => {
      // 404/410 = the browser dropped this subscription; forget it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      }
    });
  }
}

const NOTIFICATION_CATEGORIES = new Set(['setup', 'activity', 'votes', 'timers', 'chat']);

export function notifySpaceUsers(spaceId, userIds, category, payload) {
  notifyUsers(notificationRecipients(spaceId, userIds, category), payload);
}

export function notificationRecipients(spaceId, userIds, category) {
  if (!NOTIFICATION_CATEGORIES.has(category)) throw new Error(`Unknown notification category: ${category}`);
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT user_id FROM space_members
    WHERE space_id = ? AND notify_${category} = 1 AND user_id IN (${placeholders})
  `).all(spaceId, ...uniqueIds).map((row) => row.user_id);
}
