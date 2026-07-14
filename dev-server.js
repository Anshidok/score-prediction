// Local dev server: serves ./public AND runs the api/ serverless functions,
// so /api/admin and /api/fd work without `vercel dev`. Loads .env.local.
// Run with: npm run dev:local     (or: node dev-server.js)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, 'public');
const PORT = Number(process.env.PORT || 3000);

// ── tiny .env.local loader (supports single/double-quoted values) ──
async function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = await readFile(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}

// give the Vercel-style handler the req/res shape it expects
async function runApi(name, req, res, query) {
  const modPath = join(HERE, 'api', `${name}.js`);
  if (!existsSync(modPath)) { res.writeHead(404).end('No such function'); return; }
  const mod = await import(`file://${modPath}?t=${Date.now()}`); // fresh on each call
  const raw = await readBody(req);
  req.query = query;
  try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }

  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  res.send = (body) => { res.end(body); return res; };

  try {
    await mod.default(req, res);
  } catch (e) {
    if (!res.writableEnded) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
  }
}

const server = http.createServer(async (req, res) => {
  const [pathname, qs = ''] = req.url.split('?');
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/$/, '');
    const query = Object.fromEntries(new URLSearchParams(qs));
    return runApi(name, req, res, query);
  }
  try {
    let path = decodeURIComponent(pathname);
    if (path === '/') path = '/index.html';
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    // local-only: serve a gitignored firebase-config.local.js (test project) in place
    // of the committed prod config, so local dev can point at a separate Firebase DB
    // without touching the file that ships to production.
    if (path === '/firebase-config.js') {
      const override = normalize(join(ROOT, 'firebase-config.local.js'));
      if (existsSync(override)) file = override;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

await loadEnv(join(HERE, '.env.local'));

let port = PORT;
const MAX_TRIES = 15;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && port < PORT + MAX_TRIES) {
    console.log(`  port ${port} in use, trying ${port + 1}…`);
    setTimeout(() => server.listen(++port), 150);
  } else { console.error(err.message); process.exit(1); }
});
server.on('listening', () => {
  console.log(`\n  ProScore (full local: static + /api) → http://localhost:${port}`);
  console.log(`  ADMIN_KEY ${process.env.ADMIN_KEY ? 'loaded' : 'MISSING'} · DELETE_KEY ${process.env.DELETE_KEY ? 'loaded' : 'MISSING'} · FIREBASE_SERVICE_ACCOUNT ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'loaded' : 'MISSING'} · FD_KEY ${process.env.FD_KEY ? 'loaded' : 'missing'}\n`);
});
server.listen(port);
