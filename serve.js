// Minimal zero-dependency static server for local frontend preview.
// Serves ./public. NOTE: does NOT run /api/* serverless functions —
// use `vercel dev` for those. Run with: npm run static
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    // prevent path traversal, keep everything under ROOT
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

// if the chosen port is taken, try the next few automatically
let port = Number(PORT);
const MAX_TRIES = 15;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && port < Number(PORT) + MAX_TRIES) {
    console.log(`  port ${port} in use, trying ${port + 1}…`);
    setTimeout(() => server.listen(++port), 150);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
server.on('listening', () => {
  console.log(`\n  ProScore frontend → http://localhost:${port}\n`);
  console.log('  (static preview only — Admin API routes need `vercel dev`)\n');
});
server.listen(port);
