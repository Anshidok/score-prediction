// Vercel serverless function: admin actions via Firebase Admin SDK.
// Protected by ADMIN_KEY. Admin SDK bypasses Firestore security rules.
// POST /api/admin  body: { action, adminKey, ...payload }
//   action: setMatch | lock | clear | reset | list | deletePrediction | finalWinner
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DEFAULT_MATCH = {
  home_name: 'Brazil', home_flag: 'br',
  away_name: 'France', away_flag: 'fr',
  info: 'Dec 14, 2024 • 20:00 GMT', stage: 'Group Stage • Match 42',
  locked: false, requireLogin: false, fd_id: null, live: null,
  poster_url: '', show_poster: false, knockout: false, final_winner: null,
  awaiting_next: false
};

// the tied winners for a published result. Mirrors the client's isWinner()/pensDecided()
// (public/app.js): exact score, plus the advancing side when a KNOCKOUT ended level.
function winnersFor(preds, match) {
  const live = match.live;
  if (!live || live.status !== 'FINISHED' || live.home == null) return [];
  const pens = !!match.knockout && live.home === live.away && !!live.pens_winner;
  return preds.filter(p =>
    p.h === live.home && p.a === live.away && (!pens || p.pens === live.pens_winner));
}

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

// snapshot a finished round (teams, score, tied-winner pool, any drawn winner) into
// the `rounds` collection so its final winner can still be drawn after the match
// slot is reused. Doc ID = live.ts → re-archiving the same result is idempotent.
// Returns true when a round was archived.
async function archiveRound(db, matchRef) {
  const m = (await matchRef.get()).data() || {};
  const live = m.live;
  if (!live || live.status !== 'FINISHED' || live.home == null) return false;
  const snap = await db.collection('predictions').get();
  const winners = winnersFor(snap.docs.map(d => ({ id: d.id, ...d.data() })), m)
    .map(p => ({ id: p.id, name: p.name, h: p.h, a: p.a, pens: p.pens ?? null }));
  await db.collection('rounds').doc(String(live.ts)).set({
    home_name: m.home_name || 'Home', home_flag: m.home_flag || '',
    away_name: m.away_name || 'Away', away_flag: m.away_flag || '',
    stage: m.stage || '', info: m.info || '', knockout: !!m.knockout,
    score: { h: live.home, a: live.away, pens_winner: live.pens_winner ?? null },
    winners,
    final_winner: m.final_winner || null,
    ts: live.ts, archived_ts: Date.now()
  }, { merge: true });
  return true;
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
      // discard the published result, the lock and any previous draw when it's
      // genuinely a different match
      const prev = (await matchRef.get()).data() || {};
      const isNewMatch = prev.fd_id !== data.fd_id
        || prev.home_name !== data.home_name
        || prev.away_name !== data.away_name;
      if (isNewMatch) {
        // preserve the outgoing round's winners before its score slot is reused
        await archiveRound(db, matchRef);
        data.live = null; data.locked = false; data.final_winner = null;
      }
      data.awaiting_next = false;   // a saved match is the announcement — page goes live
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
        await matchRef.set({ live: null, final_winner: null }, { merge: true });
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
        live: { home, away, status: 'FINISHED', label: 'FULL TIME', ts: Date.now(), pens_winner },
        final_winner: null,   // re-publishing a score invalidates any previous draw
        awaiting_next: false  // results are something to show — leave the waiting screen
      }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'clear') {
      // clearing predictions starts a fresh round: archive the finished round first
      // (so its final winner can still be drawn later from `rounds`), then drop the
      // manual lock with the predictions — otherwise a lock from the previous round
      // silently blocks the new one. A kickoff in the past still auto-locks.
      const archived = await archiveRound(db, matchRef);
      await clearPredictions(db);
      // clearing predictions ends the round: park the page on "next match soon" (the
      // old match/result stays configured but hidden) until a new match is saved.
      const patch = { final_winner: null, locked: false, awaiting_next: true };
      if (archived) patch.live = null;   // score is preserved on the round doc now
      await matchRef.set(patch, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'reset') {
      await clearPredictions(db);
      await clearCollection(db, 'rounds');
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
      // don't leave a drawn winner pointing at a prediction that no longer exists
      const cur = (await matchRef.get()).data() || {};
      if (cur.final_winner?.id === id) await matchRef.set({ final_winner: null }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === 'finalWinner') {
      // randomly pick ONE of the tied winners. Done server-side so every client sees the
      // same person, and so the winner set can't be spoofed by the caller.
      const m = (await matchRef.get()).data() || {};
      if (!m.live || m.live.status !== 'FINISHED' || m.live.home == null) {
        return res.status(400).json({ error: 'Publish the final result first.' });
      }
      if (m.final_winner) {
        return res.status(400).json({ error: 'Final winner already drawn. Clear the result to redo.' });
      }
      const snap = await db.collection('predictions').get();
      const winners = winnersFor(snap.docs.map(d => ({ id: d.id, ...d.data() })), m);
      if (!winners.length) return res.status(400).json({ error: 'No winners to draw from.' });
      const pick = winners[Math.floor(Math.random() * winners.length)];
      const final_winner = {
        id: pick.id, name: pick.name, h: pick.h, a: pick.a,
        pens: pick.pens ?? null, pool: winners.length, ts: Date.now()
      };
      await matchRef.set({ final_winner }, { merge: true });
      return res.json({ ok: true, final_winner });
    }
    if (action === 'drawRoundWinner') {
      // like finalWinner, but for an ARCHIVED round — pool comes from the round doc
      const roundId = String(body.roundId || '').trim();
      if (!roundId) return res.status(400).json({ error: 'Missing round id' });
      const roundRef = db.collection('rounds').doc(roundId);
      const r = (await roundRef.get()).data();
      if (!r) return res.status(400).json({ error: 'Round not found.' });
      if (r.final_winner) return res.status(400).json({ error: 'Final winner already drawn for this round.' });
      const winners = r.winners || [];
      if (!winners.length) return res.status(400).json({ error: 'No winners to draw from.' });
      const pick = winners[Math.floor(Math.random() * winners.length)];
      const final_winner = {
        id: pick.id ?? null, name: pick.name, h: pick.h, a: pick.a,
        pens: pick.pens ?? null, pool: winners.length, ts: Date.now()
      };
      await roundRef.set({ final_winner }, { merge: true });
      return res.json({ ok: true, final_winner });
    }
    if (action === 'deleteRound') {
      const roundId = String(body.roundId || '').trim();
      if (!roundId) return res.status(400).json({ error: 'Missing round id' });
      await db.collection('rounds').doc(roundId).delete();
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
