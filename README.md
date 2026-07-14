# ProScore — World Cup Score Prediction

Single-match score prediction for company employees. Admin sets the match, employees predict a scoreline, and **OFFICE CONSENSUS** (Win / Draw / Loss %) is revealed **only after you submit** — updating **live** as colleagues vote.

## Stack
- **Frontend:** static HTML/CSS/JS in `public/` (Firebase Web SDK, ES modules via CDN)
- **Database:** Firebase **Firestore** — realtime, no polling
- **Auth:** Firebase Anonymous (gives each browser a stable id for the reveal-gate)
- **Serverless:** Vercel functions in `api/`
  - `api/fd.js` — football-data.org proxy (keeps API key server-side)
  - `api/admin.js` — admin actions via Firebase Admin SDK (bypasses rules, gated by `ADMIN_KEY`)
- **Security:** `firestore.rules` enforces the reveal-gate + lock server-side

## Data model (Firestore)
```
config/match            → { home_name, home_flag, away_name, away_flag, info, stage, locked }
predictions/{uid}       → { name, h, a, ts }      (doc id = anonymous auth uid)
```
`*_flag` is either an ISO code (e.g. `br` → flagcdn image) or a full crest URL (from football-data).

---

## Setup

### 1. Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Firestore Database → Create** (Production mode).
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**.
4. Project settings (⚙️) → **General → Your apps → Web app (`</>`)** → register → copy the `firebaseConfig` values.
5. Paste them into [`public/firebase-config.js`](public/firebase-config.js). *(These are public by design — safe in frontend.)*

### 2. Firestore rules
Copy [`firestore.rules`](firestore.rules) into **Firestore → Rules → Publish**. This enforces:
- match config: public read, no client writes (server-only)
- a prediction is readable **only after you've submitted yours** (reveal-gate)
- you can only write your own prediction, and only while the match is **unlocked**

### 3. Service account (for admin function)
Project settings → **Service accounts → Generate new private key** → downloads a JSON file.
You'll paste its **entire contents** into the Vercel env var `FIREBASE_SERVICE_ACCOUNT` (step 5). Never commit it.

### 4. Seed the first match
In **Firestore → Start collection**: collection id `config`, document id `match`, add fields:
`home_name=Brazil, home_flag=br, away_name=France, away_flag=fr, info=..., stage=..., locked=false (boolean)`.
Or just deploy and hit the Admin tab to set it.

### 5. Deploy to Vercel
```bash
npm i -g vercel
vercel            # link project
vercel --prod     # deploy
```
Set **Environment Variables** (Vercel dashboard → Settings → Environment Variables):

| Var | Value |
|-----|-------|
| `FD_KEY` | your football-data.org token |
| `ADMIN_KEY` | a secret you choose (typed in the Admin tab) |
| `DELETE_KEY` | a separate secret required to delete a single prediction (second factor, prompted at delete time) |
| `FIREBASE_SERVICE_ACCOUNT` | full JSON contents of the service-account key (one line) |

Redeploy after adding envs.

---

## Local dev
```bash
npm install
vercel dev        # runs static + api functions locally, loads .env.local
```
Put the same vars in `.env.local` (gitignored). Firestore/Auth work against your real Firebase project.

## Usage
- **Employees** — enter name, pick score, Submit. Consensus + prediction list reveal after submit and update live.
- **Admin** — enter `ADMIN_KEY`, set teams (dropdown **or** import a real fixture from football-data), **Lock** at kickoff, **Clear** or **Reset**. Delete a single prediction from the live list via the ✕ button (requires the `DELETE_KEY`).

## Security notes
- Reveal-gate + lock are enforced by Firestore rules, not just UI — can't be bypassed via devtools.
- `FD_KEY`, `ADMIN_KEY`, and the service account live only in Vercel env / serverless — never shipped to the browser.
- You pasted your football-data key in chat earlier; rotate it if this repo goes public.
