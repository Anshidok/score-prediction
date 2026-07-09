// Vercel serverless function: football-data.org proxy (keeps API key server-side)
// GET /api/fd?type=competitions
// GET /api/fd?type=matches&comp=WC
const FD_BASE = 'https://api.football-data.org/v4';

async function fd(pathname) {
  const key = process.env.FD_KEY;
  if (!key) throw new Error('FD_KEY env not set');
  const r = await fetch(FD_BASE + pathname, { headers: { 'X-Auth-Token': key } });
  if (!r.ok) throw new Error(`football-data ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  const { type = 'matches', comp = 'WC' } = req.query;
  try {
    if (type === 'competitions') {
      const d = await fd('/competitions');
      return res.json(d.competitions.map(c => ({ code: c.code, name: c.name })));
    }
    const code = String(comp).replace(/[^A-Z0-9]/gi, '');
    const d = await fd(`/competitions/${code}/matches`);
    const matches = (d.matches || []).map(m => ({
      id: m.id, utcDate: m.utcDate, status: m.status, stage: m.stage,
      home: { name: m.homeTeam.name, crest: m.homeTeam.crest, tla: m.homeTeam.tla },
      away: { name: m.awayTeam.name, crest: m.awayTeam.crest, tla: m.awayTeam.tla },
      score: { home: m.score?.fullTime?.home, away: m.score?.fullTime?.away }
    }));
    return res.json({ competition: d.competition?.name || code, matches });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
