// ProScore — Firestore + realtime. Loaded as an ES module.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, onSnapshot, collection
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MATCH_REF = doc(db, 'config', 'match');
const PREDS = collection(db, 'predictions');

let uid = null;
let match = null;                 // config/match data
let revealed = localStorage.getItem('ps_submitted') === '1';
let predsUnsub = null;            // predictions listener (attached after submit)

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// flag/crest image: http URL (crest), ISO code (flagcdn), else raw text
function flagMarkup(flag) {
  if (/^https?:\/\//i.test(flag)) return `<img src="${esc(flag)}" alt="">`;
  if (/^[a-z]{2}(-[a-z]{2,3})?$/i.test(flag)) return `<img src="https://flagcdn.com/w80/${flag.toLowerCase()}.png" alt="">`;
  return flag || '🏳️';
}

// ── auth: anonymous sign-in gives each browser a stable uid ──
signInAnonymously(auth).catch(e => console.error('auth', e));
onAuthStateChanged(auth, async user => {
  if (!user) return;
  uid = user.uid;
  // live match banner (public read)
  onSnapshot(MATCH_REF, snap => { match = snap.data() || {}; renderMatch(); });
  // if this browser already submitted, unlock consensus
  try {
    const mine = await getDoc(doc(db, 'predictions', uid));
    if (mine.exists()) { revealed = true; localStorage.setItem('ps_submitted', '1'); }
  } catch {}
  if (revealed) subscribeConsensus();
  renderGate();
});

// ── lock state: manual lock OR kickoff time reached ──
function kickoffMs() {
  const k = match?.kickoff;
  if (!k) return null;
  if (typeof k.toMillis === 'function') return k.toMillis();     // Firestore Timestamp
  if (typeof k.seconds === 'number') return k.seconds * 1000;    // plain object
  return new Date(k).getTime();                                  // ISO fallback
}
function isLocked() {
  if (match?.locked === true) return true;
  const ms = kickoffMs();
  return ms != null && Date.now() >= ms;
}

// ── predictions view ──
function renderMatch() {
  if (!match) return;
  const home = { name: match.home_name || 'Home', flag: match.home_flag || '' };
  const away = { name: match.away_name || 'Away', flag: match.away_flag || '' };
  $('homeName').textContent = home.name;
  $('awayName').textContent = away.name;
  $('homeFlag').innerHTML = flagMarkup(home.flag);
  $('awayFlag').innerHTML = flagMarkup(away.flag);
  $('matchInfo').textContent = match.info || 'Match';
  $('matchStage').textContent = match.stage || '';
  $('homeCap').textContent = home.name.toUpperCase() + ' SCORE';
  $('awayCap').textContent = away.name.toUpperCase() + ' SCORE';
  $('winLbl').textContent = home.name + ' Win';
  $('lossLbl').textContent = away.name + ' Win';

  const locked = isLocked();
  const started = kickoffMs() != null && Date.now() >= kickoffMs();
  $('lockBadge').classList.toggle('hidden', !locked);
  $('lockBadge').textContent = started ? '🔒 LOCKED — MATCH STARTED' : '🔒 PREDICTIONS LOCKED';
  $('submitBtn').disabled = locked;
  $('submitBtn').textContent = locked ? 'Predictions Locked' : 'Submit Prediction';
  document.querySelectorAll('.stepper button').forEach(b => b.disabled = locked);
}

function bump(side, d) {
  const el = $(side + 'Score');
  el.value = Math.max(0, Math.min(30, (parseInt(el.value) || 0) + d));
}

async function submitPred() {
  const name = $('userName').value.trim();
  const msg = $('msg');
  if (!name) return flash(msg, 'Enter your name first.', true);
  if (isLocked()) return flash(msg, 'Predictions are locked.', true);
  const h = parseInt($('homeScore').value);
  const a = parseInt($('awayScore').value);
  try {
    await setDoc(doc(db, 'predictions', uid), { name, h, a, ts: Date.now() });
    revealed = true;
    localStorage.setItem('ps_submitted', '1');
    subscribeConsensus();
    renderGate();
    flash(msg, `Saved: ${match.home_name} ${h} - ${a} ${match.away_name}`, false);
  } catch (e) {
    flash(msg, 'Save failed: ' + e.message, true);
  }
}

function flash(el, txt, err) { el.textContent = txt; el.className = 'msg ' + (err ? 'err' : 'ok'); }

// ── consensus: realtime over predictions collection (rules allow read only after you submit) ──
function subscribeConsensus() {
  if (predsUnsub) return;
  predsUnsub = onSnapshot(PREDS, snap => {
    const preds = snap.docs.map(d => d.data());
    renderConsensus(preds);
  }, e => console.error('consensus', e));
}

function renderGate() {
  $('gateLocked').classList.toggle('hidden', revealed);
  $('gateOpen').classList.toggle('hidden', !revealed);
}

function renderConsensus(preds) {
  if (!revealed) return;
  const n = preds.length;
  let w = 0, l = 0, d = 0;
  for (const p of preds) { if (p.h > p.a) w++; else if (p.h < p.a) l++; else d++; }
  const pc = x => n ? Math.round(x / n * 100) : 0;
  set('win', pc(w)); set('loss', pc(l)); set('draw', pc(d));
  $('voteCount').textContent = n + ' prediction' + (n === 1 ? '' : 's');

  const home = match?.home_name || 'HOME', away = match?.away_name || 'AWAY';
  const list = $('lbList');
  if (!n) { list.innerHTML = '<div class="empty">No predictions yet. Be first!</div>'; return; }
  list.innerHTML = preds.slice().sort((a, b) => b.ts - a.ts).map(p => {
    const res = p.h > p.a ? home.slice(0,3).toUpperCase() + ' win'
              : p.h < p.a ? away.slice(0,3).toUpperCase() + ' win' : 'Draw';
    const ini = String(p.name).trim().slice(0, 2).toUpperCase();
    return `<div class="lb-item"><div class="av">${esc(ini)}</div>
      <div class="nm">${esc(p.name)}<small>${esc(res)}</small></div>
      <div class="pt">${p.h} - ${p.a}</div></div>`;
  }).join('');
}
function set(k, v) { $(k + 'Pct').textContent = v + '%'; $(k + 'Bar').style.width = v + '%'; }

// ── view switch ──
function show(v) {
  $('view-predict').classList.toggle('hidden', v !== 'predict');
  $('view-admin').classList.toggle('hidden', v !== 'admin');
  $('nav-predict').classList.toggle('active', v === 'predict');
  $('nav-admin').classList.toggle('active', v === 'admin');
  if (v === 'admin') fillAdmin();
}

// ── admin (writes go through /api/admin serverless + ADMIN_KEY) ──
const TEAMS = [
  { name: 'Argentina', flag: 'ar' }, { name: 'Belgium', flag: 'be' }, { name: 'Brazil', flag: 'br' },
  { name: 'England', flag: 'gb-eng' }, { name: 'France', flag: 'fr' }, { name: 'Morocco', flag: 'ma' },
  { name: 'Norway', flag: 'no' }, { name: 'Spain', flag: 'es' }, { name: 'Switzerland', flag: 'ch' }
];
function buildTeamOptions() {
  const opts = TEAMS.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  $('aHome').innerHTML = opts; $('aAway').innerHTML = opts;
}
function teamByName(n) { return TEAMS.find(t => t.name === n) || { name: n, flag: '' }; }

async function adminPost(action, payload) {
  const res = await fetch('/api/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, adminKey: $('adminKey').value, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fillAdmin() {
  if (!$('aHome').options.length) buildTeamOptions();
  if (!$('fdComp').options.length) loadFdCompetitions();
  if (match) {
    $('aHome').value = match.home_name;
    $('aAway').value = match.away_name;
    $('aInfo').value = match.info || '';
    $('aStage').value = match.stage || '';
    $('lockBtn').textContent = match.locked ? 'Unlock Predictions' : 'Lock Predictions';
  }
}
async function saveMatch() {
  const home = teamByName($('aHome').value), away = teamByName($('aAway').value);
  if (home.name === away.name) return flash($('adminMsg'), 'Home and away must differ.', true);
  try {
    await adminPost('setMatch', {
      home_name: home.name, home_flag: home.flag, away_name: away.name, away_flag: away.flag,
      info: $('aInfo').value, stage: $('aStage').value
    });
    flash($('adminMsg'), 'Match saved.', false);
  } catch (e) { flash($('adminMsg'), e.message, true); }
}
async function toggleLock() {
  try { await adminPost('lock', { locked: !match.locked }); flash($('adminMsg'), 'Lock toggled.', false); }
  catch (e) { flash($('adminMsg'), e.message, true); }
}
async function clearVotes() {
  if (!confirm('Delete all predictions?')) return;
  try { await adminPost('clear', {}); flash($('adminMsg'), 'Predictions cleared.', false); }
  catch (e) { flash($('adminMsg'), e.message, true); }
}
async function resetAll() {
  if (!confirm('Reset match AND all predictions to default?')) return;
  try { await adminPost('reset', {}); flash($('adminMsg'), 'Everything reset.', false); }
  catch (e) { flash($('adminMsg'), e.message, true); }
}

// ── football-data import (via /api/fd proxy) ──
let fdMatches = [];
async function fdGet(qs) {
  const res = await fetch('/api/fd?' + qs);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'football-data error');
  return data;
}
async function loadFdCompetitions() {
  try {
    const list = await fdGet('type=competitions');
    $('fdComp').innerHTML = list.map(c => `<option value="${c.code}">${esc(c.name)}</option>`).join('');
    if (list.find(c => c.code === 'WC')) $('fdComp').value = 'WC';
  } catch (e) { flash($('fdMsg'), 'Could not load competitions: ' + e.message, true); }
}
async function loadFdMatches() {
  flash($('fdMsg'), 'Loading…', false);
  try {
    const d = await fdGet('type=matches&comp=' + encodeURIComponent($('fdComp').value));
    fdMatches = d.matches;
    if (!fdMatches.length) { $('fdMatch').innerHTML = '<option value="">none</option>'; return flash($('fdMsg'), 'No matches available.', true); }
    $('fdMatch').innerHTML = fdMatches.map((m, i) => {
      const dt = new Date(m.utcDate).toLocaleString();
      return `<option value="${i}">${esc(m.home.name || 'TBD')} vs ${esc(m.away.name || 'TBD')} — ${esc(dt)}</option>`;
    }).join('');
    flash($('fdMsg'), fdMatches.length + ' match(es) loaded.', false);
  } catch (e) { flash($('fdMsg'), e.message, true); }
}
async function applyFdMatch() {
  const i = parseInt($('fdMatch').value);
  if (isNaN(i) || !fdMatches[i]) return flash($('fdMsg'), 'Pick a match first.', true);
  const m = fdMatches[i];
  if (!m.home.name || !m.away.name) return flash($('fdMsg'), 'Teams not decided yet (TBD).', true);
  const dt = new Date(m.utcDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const stage = (m.stage || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  try {
    await adminPost('setMatch', {
      home_name: m.home.name, home_flag: m.home.crest,
      away_name: m.away.name, away_flag: m.away.crest, info: dt, stage,
      kickoff: m.utcDate           // ISO → auto-lock at this time
    });
    flash($('fdMsg'), 'Applied: ' + m.home.name + ' vs ' + m.away.name, false);
  } catch (e) { flash($('fdMsg'), e.message, true); }
}

// tick every 20s so an open page auto-locks when kickoff passes (no refresh needed)
setInterval(() => { if (match) renderMatch(); }, 20000);

// expose handlers to inline onclick attributes
Object.assign(window, { show, bump, submitPred, saveMatch, toggleLock, clearVotes, resetAll,
  loadFdMatches, applyFdMatch });
