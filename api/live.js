// api/live.js — throttled live-score updater.
// Any client may call GET /api/live. It reads the configured match's football-data
// id from config/match, fetches that match's score from football-data at most once
// per THROTTLE_MS (tracked by config/match.live.ts), and writes the result back to
// config/match.live via the Admin SDK. Every client then receives the score in
// realtime through the existing onSnapshot(config/match) — so only a trickle of
// requests ever reach football-data, well under the free-tier rate limit.
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const FD_BASE = 'https://api.football-data.org/v4';
const THROTTLE_MS = 25000;   // don't hit football-data more than ~once per 25s

function db() {
  if (!getApps().length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(svc) });
  }
  return getFirestore();
}

// map football-data status → a short label for the UI
function label(status, minute) {
  switch (status) {
    case 'IN_PLAY': return minute ? `LIVE ${minute}'` : 'LIVE';
    case 'PAUSED': return 'HALF TIME';
    case 'FINISHED': return 'FULL TIME';
    case 'SUSPENDED': return 'SUSPENDED';
    case 'POSTPONED': return 'POSTPONED';
    default: return '';
  }
}

export default async function handler(req, res) {
  try {
    const store = db();
    const ref = store.doc('config/match');
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const id = data.fd_id;
    if (!id) return res.status(200).json({ live: null, reason: 'no fd_id' });

    const now = Date.now();
    const live = data.live || null;
    // serve the cached score if it's final, or still fresh (throttle window)
    if (live && (live.status === 'FINISHED' || now - (live.ts || 0) < THROTTLE_MS)) {
      return res.status(200).json({ live });
    }

    const key = process.env.FD_KEY;
    if (!key) return res.status(200).json({ live, reason: 'no FD_KEY' });

    const r = await fetch(`${FD_BASE}/matches/${id}`, { headers: { 'X-Auth-Token': key } });
    if (!r.ok) {
      // on API failure keep the last known score (don't bump ts so we retry soon)
      return res.status(200).json({ live, reason: `fd ${r.status}` });
    }
    const m = await r.json();
    const status = m.status || 'UNKNOWN';
    const next = {
      home: m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0,
      away: m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0,
      status,
      minute: m.minute ?? null,
      label: label(status, m.minute),
      ts: now
    };
    await ref.set({ live: next }, { merge: true });
    return res.status(200).json({ live: next });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
