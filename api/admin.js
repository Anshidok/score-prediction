// Vercel serverless function: admin actions via Firebase Admin SDK.
// Protected by ADMIN_KEY. Admin SDK bypasses Firestore security rules.
// POST /api/admin  body: { action, adminKey, ...payload }
//   action: setMatch | lock | clear | reset | list | deletePrediction
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DEFAULT_MATCH = {
  home_name: 'Brazil', home_flag: 'br',
  away_name: 'France', away_flag: 'fr',
  info: 'Dec 14, 2024 • 20:00 GMT', stage: 'Group Stage • Match 42',
  locked: false, requireLogin: false, fd_id: null, live: null,
  poster_url: '', show_poster: false, knockout: false
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
        poster_url: (body.poster_url || '').trim(),
        show_poster: !!body.show_poster,
        knockout: !!body.knockout
      };
      // kickoff (ISO string) → Firestore Timestamp for auto-lock; null clears it
      if (body.kickoff) data.kickoff = Timestamp.fromDate(new Date(body.kickoff));
      else data.kickoff = null;
      // football-data id enables live scores
      data.fd_id = body.fd_id != null ? body.fd_id : null;
      // setMatch is also how the admin edits details of the *current* match, so only
      // discard the published result and the lock when it's genuinely a different match
      const prev = (await matchRef.get()).data() || {};
      const isNewMatch = prev.fd_id !== data.fd_id
        || prev.home_name !== data.home_name
        || prev.away_name !== data.away_name;
      if (isNewMatch) { data.live = null; data.locked = false; }
      await matchRef.set(data, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'list') {
      const snap = await db.collection('predictions').get();
      const preds = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ preds });
    }
    if (action === 'lock') {
      await matchRef.set({ locked: !!body.locked }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'authmode') {
      // true → require Google login; false → open (anonymous) predictions
      await matchRef.set({ requireLogin: !!body.requireLogin }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'result') {
      // manually publish (or clear) the FINAL score → drives the winners feature.
      // Works for ANY match, incl. manual ones with no football-data id.
      if (body.clear) {
        await matchRef.set({ live: null }, { merge: true });
        return res.json({ ok: true });
      }
      const home = Number(body.home), away = Number(body.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 99 || away > 99) {
        return res.status(400).json({ error: 'Enter valid home/away scores.' });
      }
      // penalty shootout: only meaningful on a draw; must name the advancing side
      let pens_winner = null;
      if (home === away && (body.pens_winner === 'home' || body.pens_winner === 'away')) {
        pens_winner = body.pens_winner;
      }
      await matchRef.set({
        live: { home, away, status: 'FINISHED', label: 'FULL TIME', ts: Date.now(), pens_winner }
      }, { merge: true });
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
    if (action === 'deletePrediction') {
      // second factor beyond ADMIN_KEY: a separate DELETE_KEY, checked here only
      if (!process.env.DELETE_KEY) return res.status(500).json({ error: 'Delete key not configured' });
      if (body.deleteKey !== process.env.DELETE_KEY) return res.status(401).json({ error: 'Bad delete key' });
      const id = (body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing prediction id' });
      // delete the prediction and free up the reserved name (mirrors clearPredictions)
      await db.collection('predictions').doc(id).delete();
      await db.collection('names').doc(id).delete();
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
