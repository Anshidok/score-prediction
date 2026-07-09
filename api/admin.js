// Vercel serverless function: admin actions via Firebase Admin SDK.
// Protected by ADMIN_KEY. Admin SDK bypasses Firestore security rules.
// POST /api/admin  body: { action, adminKey, ...payload }
//   action: setMatch | lock | clear | reset | list
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DEFAULT_MATCH = {
  home_name: 'Brazil', home_flag: 'br',
  away_name: 'France', away_flag: 'fr',
  info: 'Dec 14, 2024 • 20:00 GMT', stage: 'Group Stage • Match 42',
  locked: false
};

function admin() {
  if (!getApps().length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(svc) });
  }
  return getFirestore();
}

async function clearCollection(db, name) {
  const snap = await db.collection(name).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// wipe predictions AND the name registry so freed names become available again
async function clearPredictions(db) {
  await clearCollection(db, 'predictions');
  await clearCollection(db, 'names');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { action, adminKey, ...body } = req.body || {};
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Bad admin key' });

  try {
    const db = admin();
    const matchRef = db.doc('config/match');

    if (action === 'setMatch') {
      const data = {
        home_name: (body.home_name || 'Home').trim(),
        home_flag: (body.home_flag || '').trim(),
        away_name: (body.away_name || 'Away').trim(),
        away_flag: (body.away_flag || '').trim(),
        info: (body.info || '').trim(),
        stage: (body.stage || '').trim(),
        locked: false
      };
      // kickoff (ISO string) → Firestore Timestamp for auto-lock; null clears it
      if (body.kickoff) data.kickoff = Timestamp.fromDate(new Date(body.kickoff));
      else data.kickoff = null;
      await matchRef.set(data, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'list') {
      const snap = await db.collection('predictions').get();
      const preds = snap.docs.map(d => d.data());
      return res.json({ preds });
    }
    if (action === 'lock') {
      await matchRef.set({ locked: !!body.locked }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'clear') {
      await clearPredictions(db);
      return res.json({ ok: true });
    }
    if (action === 'reset') {
      await clearPredictions(db);
      await matchRef.set(DEFAULT_MATCH);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
