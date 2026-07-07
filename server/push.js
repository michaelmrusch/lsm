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
