// ProScore — Firestore + realtime. Loaded as an ES module.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut, onAuthStateChanged }
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
const NAMES = collection(db, 'names');   // public registry of taken names (read by all)

let uid = null;
let match = null;                 // config/match data
let revealed = false;             // consensus unlocked once this account has predicted
let predsUnsub = null;            // predictions listener (attached after submit)
let takenNames = [];              // [{ name, uid }] — kept live for duplicate checks
let myPred = null;                // this user's own prediction (private to them)

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// flag/crest image: http URL (crest), ISO code (flagcdn), else raw text
function flagMarkup(flag) {
  if (/^https?:\/\//i.test(flag)) return `<img src="${esc(flag)}" alt="">`;
  if (/^[a-z]{2}(-[a-z]{2,3})?$/i.test(flag)) return `<img src="https://flagcdn.com/w80/${flag.toLowerCase()}.png" alt="">`;
  return flag || '🏳️';
}

// ── public data: match + name registry (no auth required, attached once) ──
onSnapshot(MATCH_REF, snap => {
  match = snap.data() || {};
  renderMatch();
  handleAuth();        // auth mode (requireLogin) lives on the match doc
  matchLoaded = true; maybeReveal();
});
onSnapshot(NAMES, snap => {
  takenNames = snap.docs.map(d => ({ name: d.data().name, uid: d.id }));
  validateName();
}, e => console.error('names', e));

// ── auth: real Google sign-in → identity is a stable account (one per person) ──
async function signInGoogle() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const el = $('authMsg');
    const txt = e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request'
      ? 'Sign-in cancelled.' : 'Sign-in failed: ' + e.message;
    if (el) flash(el, txt, true);
  }
}
async function signOutUser() {
  try { await signOut(auth); } catch (e) { console.error('signout', e); }
}

onAuthStateChanged(auth, () => handleAuth());

// admin flag on config/match: true → require Google login; false/absent → old
// open mode (anonymous sign-in, no gate).
function loginRequired() { return match?.requireLogin === true; }
// authorized to use the app: in Google mode you must be a real (non-anonymous)
// account; in open mode any auth (including anonymous) is fine.
function isAuthorized(user) {
  if (!user) return false;
  return loginRequired() ? !user.isAnonymous : true;
}

let anonSigningIn = false;   // guard against duplicate anonymous sign-in calls
let loadedForUid = null;     // which uid's prediction we've already loaded

// single source of truth for auth: reconciles the current user with the mode.
async function handleAuth() {
  const user = auth.currentUser;

  // OPEN mode with nobody signed in → the gate must never show; hide it right
  // away (don't wait on the anonymous sign-in, which may be slow or disabled),
  // then get an anonymous session in the background.
  if (!loginRequired() && !user) {
    renderAuth(); renderViews();
    if (!anonSigningIn) {
      anonSigningIn = true;
      try { await signInAnonymously(auth); }
      catch (e) { console.error('anon', e); authResolved = true; maybeReveal(); }
      finally { anonSigningIn = false; }
    }
    return;   // on success, onAuthStateChanged re-runs handleAuth with the user
  }

  const authed = isAuthorized(user);
  renderAuth(); renderViews();

  if (!authed) {
    // signed out / anonymous-in-Google-mode → reset prediction state.
    // (Admin stays reachable via its key — renderViews handles that.)
    uid = null; myPred = null; revealed = false; loadedForUid = null;
    if (predsUnsub) { predsUnsub(); predsUnsub = null; }
    resetForm();
    renderGate(); renderMine(); renderNameLock(); renderMatch();
    authResolved = true; maybeReveal();
    return;
  }

  uid = user.uid;
  if (loadedForUid !== uid) {          // load this account's prediction once
    loadedForUid = uid;
    try {
      const mine = await getDoc(doc(db, 'predictions', uid));
      myPred = mine.exists() ? mine.data() : null;
      revealed = !!myPred;
      if (myPred) prefillForm();        // seed the form so re-predicting edits it
    } catch { myPred = null; revealed = false; }
    if (revealed) subscribeConsensus();
  }
  renderGate(); renderMine(); renderNameLock(); renderMatch();
  authResolved = true; maybeReveal();
}

// clear the form back to defaults (used when switching accounts / signing out)
function resetForm() {
  $('userName').value = '';
  $('homeScore').value = '0';
  $('awayScore').value = '0';
  const nm = $('nameMsg'); if (nm) nm.classList.add('hidden');
}

let currentView = 'predict';   // which top-level view is selected

// header: the nav is ALWAYS available (Admin is protected by its key, not by
// login); the user chip + Sign out apply only to a real (named) account.
function renderAuth() {
  const user = auth.currentUser;
  $('mainNav').classList.remove('hidden');
  const showChip = !!user && !user.isAnonymous;
  $('userChip').classList.toggle('hidden', !showChip);
  if (showChip) $('userChipName').textContent = user.displayName || user.email || 'Signed in';
}

// SINGLE authority for what's on screen. The sign-in gate only covers the
// Predict view in Google mode when unauthorized — it never covers Admin, and in
// Open mode it is never shown at all.
function renderViews() {
  const gateNeeded = currentView === 'predict'
    && loginRequired() && !isAuthorized(auth.currentUser);
  $('authGate').classList.toggle('hidden', !gateNeeded);
  $('view-predict').classList.toggle('hidden', currentView !== 'predict' || gateNeeded);
  $('view-admin').classList.toggle('hidden', currentView !== 'admin');
  $('nav-predict').classList.toggle('active', currentView === 'predict');
  $('nav-admin').classList.toggle('active', currentView === 'admin');
}

// ── reveal the page once match details + flag images are ready AND auth resolved ──
let pageShown = false;
let matchLoaded = false, authResolved = false;
function maybeReveal() { if (matchLoaded && authResolved) revealPage(); }
function whenFlagsReady() {
  const imgs = ['homeFlag', 'awayFlag']
    .flatMap(id => Array.from($(id).querySelectorAll('img')));
  if (!imgs.length) return Promise.resolve();          // text/emoji flags, nothing to await
  return Promise.all(imgs.map(img => img.complete
    ? Promise.resolve()
    : new Promise(res => { img.onload = img.onerror = res; })));
}
async function revealPage() {
  if (pageShown) return;
  pageShown = true;
  await whenFlagsReady();
  $('loader').classList.add('hidden');
}
// safety net: never trap the user on the loader if Firestore/auth is unreachable
setTimeout(() => { renderAuth(); renderViews(); revealPage(); }, 8000);

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
  return matchStarted();
}
// true once kickoff time has been reached (manual locks don't count as "started")
function matchStarted() {
  const ms = kickoffMs();
  return ms != null && Date.now() >= ms;
}
function resultFinal() {
  return match?.live?.status === 'FINISHED' && match?.live?.home != null;
}
function finalScore() {
  return resultFinal() ? { h: match.live.home, a: match.live.away } : null;
}
// ms → 'YYYY-MM-DDTHH:mm' in LOCAL time, for a datetime-local input
function msToLocalInput(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
  const started = matchStarted();
  $('lockBadge').classList.toggle('hidden', !locked);
  $('lockBadge').textContent = started ? '🔒 LOCKED — MATCH STARTED' : '🔒 PREDICTIONS LOCKED';
  $('submitBtn').disabled = locked;
  $('submitBtn').textContent = locked ? 'Predictions Locked'
    : (myPred ? 'Update Prediction' : 'Submit Prediction');
  document.querySelectorAll('.stepper button').forEach(b => b.disabled = locked);
  validateName();   // keep duplicate-name disable in sync after the button reset
  renderMine();     // refresh the private "your prediction" line (team names may have loaded)
  renderNameLock(); // keep the name field vs "Playing as" label in sync

  // the predictions list shows once the result is final, or after kickoff to a predictor
  const predsCard = $('predsCard');
  if (predsCard) predsCard.classList.toggle('hidden', !(resultFinal() || (revealed && started)));

  if (resultFinal()) subscribeConsensus();

  renderLive();            // live in-play score stays hidden
  manageResultPolling();   // fetch the FINAL score only after the match should be over
}

// ── live in-play score: DISABLED ──
// Keep the "VS" label and never display a running score during the match.
function renderLive() {
  $('vsLabel').classList.remove('hidden');
  $('liveScore').classList.add('hidden');
  $('liveStatus').classList.add('hidden');
}

// ── final-result fetch: frugal, for the winners feature ──
// We do NOT poll during play. Only once the match should be over (kickoff +
// RESULT_POLL_AFTER_MS) do we ask /api/live for the final score, and only until it
// reports FINISHED — then we stop. The server throttles the actual football-data
// calls, and the result lands in config/match.live (delivered by snapshot).
const RESULT_POLL_AFTER_MS = 100 * 60 * 1000;   // ~100 min after kickoff
let resultTimer = null;
async function pingResult() { try { await fetch('/api/live'); } catch {} }
function manageResultPolling() {
  const ms = kickoffMs();
  const dueForResult = ms != null && Date.now() >= ms + RESULT_POLL_AFTER_MS;
  const needResult = dueForResult && match?.fd_id && !resultFinal();
  if (needResult && !resultTimer) {
    pingResult();                                  // fetch once immediately
    resultTimer = setInterval(pingResult, 60000);  // then every 60s until FINISHED
  } else if (!needResult && resultTimer) {
    clearInterval(resultTimer); resultTimer = null;
  }
}

// prefill the form with the user's saved pick — called once, never on the tick,
// so it can't clobber edits the user is making
function prefillForm() {
  if (!myPred) return;
  if (!$('userName').value.trim()) $('userName').value = myPred.name || '';
  $('homeScore').value = myPred.h;
  $('awayScore').value = myPred.a;
}

// once a pick exists, the name is fixed: hide the input, show "Playing as: <name>"
function renderNameLock() {
  const field = $('nameField'), pa = $('playingAs');
  if (!field || !pa) return;
  if (myPred) {
    field.classList.add('hidden');
    $('playingAsName').textContent = myPred.name;
    pa.classList.remove('hidden');
  } else {
    field.classList.remove('hidden');
    pa.classList.add('hidden');
  }
}

// private display of the user's own current pick (derived from their own uid doc)
function renderMine() {
  const box = $('myPredBox');
  if (!box) return;
  if (myPred) {
    const home = match?.home_name || 'Home', away = match?.away_name || 'Away';
    $('myPredScore').textContent = `${home} ${myPred.h} - ${myPred.a} ${away}`;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function bump(side, d) {
  const el = $(side + 'Score');
  el.value = Math.max(0, Math.min(30, (parseInt(el.value) || 0) + d));
}

// name is taken if another user (different uid) already registered the exact
// same name — comparison is case-sensitive ("John" ≠ "john").
function nameTaken(name) {
  return takenNames.some(t => t.uid !== uid && t.name === name);
}

// live validation as the user types / on submit; toggles the inline hint + button
function validateName() {
  const el = $('nameMsg');
  if (!el) return true;
  const name = $('userName').value.trim();
  const btn = $('submitBtn');
  if (name && nameTaken(name)) {
    flash(el, `“${name}” is already taken — pick a different name.`, true);
    el.classList.remove('hidden');
    if (btn && !isLocked()) btn.disabled = true;
    return false;
  }
  el.classList.add('hidden');
  if (btn && !isLocked()) btn.disabled = false;
  return true;
}

async function submitPred() {
  const name = $('userName').value.trim();
  const msg = $('msg');
  if (!uid) return flash(msg, 'Please sign in first.', true);
  if (!name) return flash(msg, 'Enter your name first.', true);
  if (isLocked()) return flash(msg, 'Predictions are locked.', true);
  if (nameTaken(name)) {
    validateName();
    return flash(msg, `“${name}” is already taken — pick a different name.`, true);
  }
  const h = parseInt($('homeScore').value);
  const a = parseInt($('awayScore').value);
  try {
    // reserve the name first so the registry stays in sync with the prediction
    await setDoc(doc(db, 'names', uid), { name, ts: Date.now() });
    const ts = Date.now();
    await setDoc(doc(db, 'predictions', uid), { name, h, a, ts });
    const isUpdate = !!myPred;
    myPred = { name, h, a, ts };   // same uid → this overwrites, never duplicates
    revealed = true;
    subscribeConsensus();
    renderGate();
    renderMine();
    renderNameLock();              // lock the name into "Playing as: <name>"
    $('submitBtn').textContent = 'Update Prediction';
    flash(msg, `${isUpdate ? 'Updated' : 'Saved'}: ${match.home_name} ${h} - ${a} ${match.away_name}`, false);
    celebrate();
  } catch (e) {
    flash(msg, 'Save failed: ' + e.message, true);
  }
}

function flash(el, txt, err) { el.textContent = txt; el.className = 'msg ' + (err ? 'err' : 'ok'); }

// ── fireworks celebration on submit ──
function celebrate() {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  const colors = ['#7c5cff', '#a78bfa', '#f0abfc', '#22c55e', '#fbbf24', '#ef4444', '#38bdf8'];
  const particles = [];
  const G = 0.045;

  function burst(x, y) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const count = 46 + Math.floor(Math.random() * 24);
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.2;
      const speed = 2 + Math.random() * 4;
      particles.push({
        x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: 1, color, size: 1.6 + Math.random() * 1.6
      });
    }
  }

  // launch a few staggered bursts across the top-ish area
  let launched = 0;
  const total = 6;
  const launcher = setInterval(() => {
    burst(innerWidth * (0.2 + Math.random() * 0.6), innerHeight * (0.2 + Math.random() * 0.35));
    if (++launched >= total) clearInterval(launcher);
  }, 220);

  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of particles) {
      p.vy += G; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.life -= 0.012;
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (now - start < 4500 || particles.length) {
      requestAnimationFrame(frame);
    } else {
      removeEventListener('resize', resize);
      canvas.remove();
    }
  })(start);
}

// ── consensus: realtime over predictions collection (rules allow read only after you submit) ──
function subscribeConsensus() {
  if (predsUnsub) return;
  predsUnsub = onSnapshot(PREDS, snap => {
    const preds = snap.docs.map(d => d.data());
    renderConsensus(preds);
  }, e => console.error('consensus', e));
}

function renderGate() {
  const open = revealed || resultFinal();
  $('gateLocked').classList.toggle('hidden', open);
  $('gateOpen').classList.toggle('hidden', !open);
}

function renderConsensus(preds) {
  if (!revealed && !resultFinal()) return;
  const n = preds.length;
  let w = 0, l = 0, d = 0;
  for (const p of preds) { if (p.h > p.a) w++; else if (p.h < p.a) l++; else d++; }
  const pc = x => n ? Math.round(x / n * 100) : 0;
  set('win', pc(w)); set('loss', pc(l)); set('draw', pc(d));
  $('voteCount').textContent = n + ' prediction' + (n === 1 ? '' : 's');

  const result = finalScore();
  const card = $('winnersCard');
  if (card) {
    if (result) {
      $('winnersScore').textContent = `${result.h} - ${result.a}`;
      $('winnersFt').textContent = match?.live?.label || 'FULL TIME';
      const winners = preds.filter(p => p.h === result.h && p.a === result.a);
      if (winners.length) {
        $('winnersList').innerHTML = winners.map(p => {
          const ini = String(p.name).trim().slice(0, 2).toUpperCase();
          return `<div class="lb-item winner"><div class="av">${esc(ini)}</div>
            <div class="nm">${esc(p.name)}<small>Correct score 🏆</small></div>
            <div class="pt">${p.h} - ${p.a}</div></div>`;
        }).join('');
      } else {
        $('winnersList').innerHTML = `<div class="empty">No one nailed the exact score.</div>`;
      }
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  }

  $('lbList').innerHTML = predListHTML(preds, 'No predictions yet. Be first!', result);
}

// build the individual-predictions markup, shared by the public + admin lists
function predListHTML(preds, emptyMsg, result) {
  if (!preds.length) return `<div class="empty">${esc(emptyMsg || 'No predictions yet.')}</div>`;
  const home = match?.home_name || 'HOME', away = match?.away_name || 'AWAY';
  
  const sortedPreds = preds.slice();
  if (result) {
    sortedPreds.sort((a, b) => {
      const aWon = a.h === result.h && a.a === result.a;
      const bWon = b.h === result.h && b.a === result.a;
      if (aWon && !bWon) return -1;
      if (!aWon && bWon) return 1;
      return b.ts - a.ts;
    });
  } else {
    sortedPreds.sort((a, b) => b.ts - a.ts);
  }

  return sortedPreds.map(p => {
    const res = p.h > p.a ? home.slice(0,3).toUpperCase() + ' win'
              : p.h < p.a ? away.slice(0,3).toUpperCase() + ' win' : 'Draw';
    const ini = String(p.name).trim().slice(0, 2).toUpperCase();
    const won = result && p.h === result.h && p.a === result.a;
    const winnerClass = won ? ' winner' : '';
    const trophy = won ? ' 🏆' : '';
    return `<div class="lb-item${winnerClass}"><div class="av">${esc(ini)}</div>
      <div class="nm">${esc(p.name)}${trophy}<small>${esc(res)}</small></div>
      <div class="pt">${p.h} - ${p.a}</div></div>`;
  }).join('');
}
function set(k, v) { $(k + 'Pct').textContent = v + '%'; $(k + 'Bar').style.width = v + '%'; }

// ── view switch ──
let adminUnlocked = false;
function show(v) {
  currentView = v;
  renderViews();
  if (v === 'admin') renderAdminGate(); else stopAdminPreds();
}

// show either the key gate or the full admin body, depending on unlock state
function renderAdminGate() {
  $('adminGate').classList.toggle('hidden', adminUnlocked);
  $('adminBody').classList.toggle('hidden', !adminUnlocked);
  if (adminUnlocked) { fillAdmin(); startAdminPreds(); } else stopAdminPreds();
}

// verify the entered key server-side (a successful 'list' call means it's valid)
async function unlockAdmin() {
  const key = $('adminKey').value.trim();
  if (!key) return flash($('gateMsg'), 'Enter the admin key.', true);
  flash($('gateMsg'), 'Checking…', false);
  try {
    await adminPost('list', {});
    adminUnlocked = true;
    $('gateMsg').classList.add('hidden');
    renderAdminGate();
  } catch (e) {
    flash($('gateMsg'), e.message, true);
  }
}

// ── admin predictions list: fetched server-side (bypasses the reveal gate via
// the Admin SDK) so the admin can watch entries before kickoff ──
let adminPredsTimer = null;
async function loadAdminPreds() {
  try {
    const { preds } = await adminPost('list', {});
    $('adminLbList').innerHTML = predListHTML(preds || [], 'No predictions yet.', finalScore());
  } catch (e) {
    $('adminLbList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function startAdminPreds() {
  loadAdminPreds();
  if (!adminPredsTimer) adminPredsTimer = setInterval(loadAdminPreds, 10000);
}
function stopAdminPreds() {
  if (adminPredsTimer) { clearInterval(adminPredsTimer); adminPredsTimer = null; }
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
    $('aKick').value = match.kickoff ? msToLocalInput(kickoffMs()) : '';
    $('lockBtn').textContent = match.locked ? 'Unlock Predictions' : 'Lock Predictions';
    syncAuthToggle();
    // final-result box: label the score inputs with the team names, seed with any
    // already-published result
    $('resHomeLbl').textContent = match.home_name || 'Home';
    $('resAwayLbl').textContent = match.away_name || 'Away';
    if (match.live && match.live.home != null) {
      $('resHome').value = match.live.home;
      $('resAway').value = match.live.away;
    }
  }
}
async function publishResult() {
  const home = parseInt($('resHome').value), away = parseInt($('resAway').value);
  if (isNaN(home) || isNaN(away)) return flash($('adminMsg'), 'Enter both scores.', true);
  try {
    await adminPost('result', { home, away });
    flash($('adminMsg'), `Result published: ${home} - ${away} — winners are now live.`, false);
  } catch (e) { flash($('adminMsg'), e.message, true); }
}
async function clearResult() {
  if (!confirm('Clear the published result? (winners will be hidden again)')) return;
  try {
    await adminPost('result', { clear: true });
    flash($('adminMsg'), 'Result cleared.', false);
  } catch (e) { flash($('adminMsg'), e.message, true); }
}
// reflect the server's current requireLogin flag on the switch
function syncAuthToggle() {
  const t = $('authModeToggle');
  if (t) t.checked = match?.requireLogin === true;
}
async function toggleAuthMode() {
  const next = $('authModeToggle').checked;   // desired state after the click
  try {
    await adminPost('authmode', { requireLogin: next });
    flash($('adminMsg'),
      next ? 'Google sign-in is now required.' : 'Open mode — anyone can predict.', false);
  } catch (e) {
    $('authModeToggle').checked = !next;       // revert the switch on failure
    flash($('adminMsg'), e.message, true);
  }
}
async function saveMatch() {
  const home = teamByName($('aHome').value), away = teamByName($('aAway').value);
  if (home.name === away.name) return flash($('adminMsg'), 'Home and away must differ.', true);
  const kick = $('aKick').value;   // '' or local 'YYYY-MM-DDTHH:mm'
  try {
    await adminPost('setMatch', {
      home_name: home.name, home_flag: home.flag, away_name: away.name, away_flag: away.flag,
      info: $('aInfo').value, stage: $('aStage').value,
      // local time → ISO (UTC) so the server stores a real kickoff; '' clears it
      kickoff: kick ? new Date(kick).toISOString() : null
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
      kickoff: m.utcDate,          // ISO → auto-lock at this time
      fd_id: m.id                  // football-data id → enables live score once it starts
    });
    flash($('fdMsg'), 'Applied: ' + m.home.name + ' vs ' + m.away.name, false);
  } catch (e) { flash($('fdMsg'), e.message, true); }
}

// validate the name field live as the user types
$('userName').addEventListener('input', validateName);

// tick every 20s so an open page auto-locks when kickoff passes (no refresh needed)
setInterval(() => { if (match) renderMatch(); }, 20000);

// expose handlers to inline onclick attributes
Object.assign(window, { show, bump, submitPred, unlockAdmin, saveMatch, toggleLock, clearVotes, resetAll,
  loadFdMatches, applyFdMatch, signInGoogle, signOutUser, toggleAuthMode, publishResult, clearResult });
