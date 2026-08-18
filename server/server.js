const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BD_TIMEZONE = 'Asia/Dhaka';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || process.env.LIVE_FOOTBALL_API_KEY || '';
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_API_KEY || '';
const ADMIN_UPLOAD_TOKEN = process.env.ADMIN_UPLOAD_TOKEN || '';
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || '';

const API_FOOTBALL_URL = 'https://v3.football.api-sports.io';
const FOOTBALL_DATA_URL = 'https://api.football-data.org/v4';

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const CACHE_TTL = {
  live: 30_000,
  date: 60_000,
  upcoming: 15 * 60_000,
  detail: 5 * 60_000,
  team: 10 * 60_000,
  standings: 15 * 60_000
};

const memoryCache = new Map();
const inflight = new Map();
const rate = new Map();

function bdDate(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BD_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}

function isLive(m) { return ['1H','HT','2H','ET','BT','P','LIVE'].includes(m?.fixture?.status?.short || m?.status?.short); }
function isFinished(m) { return ['FT','AET','PEN'].includes(m?.fixture?.status?.short || m?.status?.short); }
function isScheduled(m) { return ['NS','TBD'].includes(m?.fixture?.status?.short || m?.status?.short); }
function unique(matches = []) { const map = new Map(); for (const m of matches) if (m?.fixture?.id != null) map.set(String(m.fixture.id), m); return [...map.values()]; }
function sortByDate(matches = []) { return matches.sort((a,b) => new Date(a?.fixture?.date || 0) - new Date(b?.fixture?.date || 0)); }

function cacheFile(key) { return path.join(CACHE_DIR, `${String(key).replace(/[^a-z0-9_-]/gi, '_')}.json`); }
function readPersistent(key) { try { return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')); } catch { return null; } }
function writePersistent(key, value) { try { fs.writeFileSync(cacheFile(key), JSON.stringify(value), 'utf8'); } catch {} }
function setCache(key, data, ttl) { const entry = { data, savedAt: Date.now(), expires: Date.now() + ttl }; memoryCache.set(key, entry); writePersistent(key, entry); return entry; }
function getCache(key) {
  const m = memoryCache.get(key);
  if (m) return m;
  const p = readPersistent(key);
  if (p) { memoryCache.set(key, p); return p; }
  return null;
}

async function requestJSON(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

async function apiFootballGet(endpoint, params = {}) {
  if (!API_FOOTBALL_KEY) throw new Error('API-Football key not configured');
  const url = new URL(`${API_FOOTBALL_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const r = await requestJSON(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY, accept: 'application/json' }
  });
  if (!r.ok || (r.data?.errors && Object.keys(r.data.errors).length)) {
    throw new Error(JSON.stringify(r.data?.errors || r.data?.message || `API-Football HTTP ${r.status}`));
  }
  return r.data;
}

async function footballDataGet(endpoint, params = {}) {
  if (!FOOTBALL_DATA_TOKEN) throw new Error('football-data.org token not configured');
  const url = new URL(`${FOOTBALL_DATA_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const r = await requestJSON(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN, accept: 'application/json' }
  });
  if (!r.ok) throw new Error(r.data?.message || r.data?.error || `football-data.org HTTP ${r.status}`);
  return r.data;
}

async function apiFootballDate(date) {
  return (await apiFootballGet('/fixtures', { date, timezone: BD_TIMEZONE }))?.response || [];
}

function fdStatus(s) {
  if (s === 'FINISHED') return 'FT';
  if (s === 'IN_PLAY') return 'LIVE';
  if (s === 'PAUSED') return 'HT';
  if (['POSTPONED','SUSPENDED','CANCELLED'].includes(s)) return 'PST';
  return 'NS';
}

function normalizeFD(matches = []) {
  return matches.map(m => ({
    fixture: { id: m.id, date: m.utcDate, status: { short: fdStatus(m.status), long: m.status, elapsed: Number.isFinite(m.minute) ? m.minute : null } },
    league: { id: m.competition?.id, name: m.competition?.name || 'Football', code: m.competition?.code || '', country: m.area?.name || '', logo: m.competition?.emblem || '' },
    teams: {
      home: { id: m.homeTeam?.id, name: m.homeTeam?.name || 'Home', logo: m.homeTeam?.crest || '' },
      away: { id: m.awayTeam?.id, name: m.awayTeam?.name || 'Away', logo: m.awayTeam?.crest || '' }
    },
    goals: { home: m.score?.fullTime?.home ?? null, away: m.score?.fullTime?.away ?? null },
    sourceProvider: 'football-data.org'
  }));
}

async function footballDataDate(date) {
  const data = await footballDataGet('/matches', { dateFrom: date, dateTo: date });
  return normalizeFD(data?.matches || []);
}

async function providerDate(date) {
  if (API_FOOTBALL_KEY) {
    try { return { provider: 'API-Football', matches: await apiFootballDate(date) }; }
    catch (e) { console.error('API-Football failed:', e.message); }
  }
  if (FOOTBALL_DATA_TOKEN) {
    try { return { provider: 'football-data.org', matches: await footballDataDate(date) }; }
    catch (e) { console.error('football-data.org failed:', e.message); }
  }
  throw new Error('No working football API provider is configured.');
}

async function getDateData(date, force = false) {
  const key = `date-${date}`;
  const c = getCache(key);
  if (!force && c?.data && c.expires > Date.now()) return { ...c.data, cached: true, stale: false };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const out = await providerDate(date);
      const payload = { success: true, source: out.provider, date, timezone: BD_TIMEZONE, response: out.matches, fetchedAt: new Date().toISOString() };
      setCache(key, payload, CACHE_TTL.date);
      return { ...payload, cached: false, stale: false };
    } catch (e) {
      if (c?.data) return { ...c.data, cached: true, stale: true };
      throw e;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

function clientRateLimit(req, res, next) {
  const now = Date.now();
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  const windowMs = 60_000, max = 90;
  const r = rate.get(ip) || { start: now, count: 0 };
  if (now - r.start >= windowMs) { r.start = now; r.count = 0; }
  r.count += 1; rate.set(ip, r);
  if (r.count > max) return res.status(429).json({ success: false, error: 'Too many requests. Please try again shortly.' });
  next();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', clientRateLimit);
app.use((req,res,next) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=()');
  next();
});

const wwwDir = path.join(__dirname, '..', 'www');
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(wwwDir));

app.get('/api/config', (_req,res) => res.json({ success:true, analytics: GA_MEASUREMENT_ID ? 'configured':'not_configured' }));
app.get('/api/status', (_req,res) => res.json({
  success:true,
  server:'DreamLive',
  timezone:BD_TIMEZONE,
  today:bdDate(),
  providers:{ apiFootball:Boolean(API_FOOTBALL_KEY), footballData:Boolean(FOOTBALL_DATA_TOKEN) },
  cacheFiles: fs.readdirSync(CACHE_DIR).length,
  time:new Date().toISOString()
}));

app.get('/api/live', async (req,res) => {
  try {
    const date = bdDate();
    const data = await getDateData(date, req.query.refresh === '1');
    const matches = data.response.filter(isLive);
    res.json({ success:true, source:data.source, date, timezone:BD_TIMEZONE, results:matches.length, response:matches, cached:data.cached, stale:data.stale, fetchedAt:data.fetchedAt });
  } catch (e) { res.status(503).json({ success:false, error:e.message }); }
});

app.get('/api/today', async (req,res) => {
  try {
    const date = bdDate();
    const data = await getDateData(date, req.query.refresh === '1');
    const matches = sortByDate(data.response.filter(m => !isLive(m) && !['CANC','PST','ABD'].includes(m.fixture?.status?.short) && (isFinished(m) || isScheduled(m))));
    res.json({ success:true, source:data.source, date, timezone:BD_TIMEZONE, results:matches.length, response:matches, cached:data.cached, stale:data.stale, fetchedAt:data.fetchedAt });
  } catch (e) { res.status(503).json({ success:false, error:e.message }); }
});

app.get('/api/upcoming', async (req,res) => {
  const key = bdDate();
  const c = getCache(`upcoming-${key}`);
  if (req.query.refresh !== '1' && c?.data && c.expires > Date.now()) return res.json({ ...c.data, cached:true, stale:false });
  if (inflight.has(`upcoming-${key}`)) return res.json(await inflight.get(`upcoming-${key}`));
  const promise = (async () => {
    try {
      const all = []; let source = null; let stale = false;
      for (let i=0;i<=2;i++) {
        const data = await getDateData(bdDate(i), false);
        source = source || data.source; stale = stale || data.stale;
        all.push(...data.response.filter(isScheduled));
      }
      const matches = sortByDate(unique(all)).slice(0,100);
      const payload = { success:true, source:source || 'fallback', from:key, to:bdDate(2), timezone:BD_TIMEZONE, results:matches.length, response:matches, fetchedAt:new Date().toISOString() };
      setCache(`upcoming-${key}`, payload, CACHE_TTL.upcoming);
      return { ...payload, cached:false, stale };
    } catch (e) {
      if (c?.data) return { ...c.data, cached:true, stale:true };
      throw e;
    } finally { inflight.delete(`upcoming-${key}`); }
  })();
  inflight.set(`upcoming-${key}`, promise);
  try { res.json(await promise); } catch (e) { res.status(503).json({ success:false, error:e.message }); }
});

async function cachedApiFootballDetail(key, loader) {
  const c = getCache(key);
  if (c?.data && c.expires > Date.now()) return { ...c.data, cached:true, stale:false };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { const data = await loader(); const payload = { success:true, response:data, fetchedAt:new Date().toISOString() }; setCache(key,payload,CACHE_TTL.detail); return {...payload,cached:false,stale:false}; }
    catch(e){ if(c?.data)return {...c.data,cached:true,stale:true}; throw e; }
    finally{inflight.delete(key);}
  })();
  inflight.set(key,p); return p;
}

app.get('/api/match/:id', async (req,res) => {
  const id = req.params.id;
  try {
    if (API_FOOTBALL_KEY) {
      const data = await cachedApiFootballDetail(`match-${id}`, async () => (await apiFootballGet('/fixtures', { id, timezone:BD_TIMEZONE }))?.response?.[0] || null);
      return res.json(data);
    }
    if (FOOTBALL_DATA_TOKEN) return res.json({ success:true, response: await footballDataGet(`/matches/${encodeURIComponent(id)}`) });
    throw new Error('No match detail provider available.');
  } catch (e) { res.status(503).json({ success:false,error:e.message }); }
});

app.get('/api/match/:id/events', async (req,res) => {
  try {
    if (!API_FOOTBALL_KEY) throw new Error('Events require API-Football.');
    const data = await cachedApiFootballDetail(`events-${req.params.id}`, async () => (await apiFootballGet('/fixtures/events',{ fixture:req.params.id }))?.response || []);
    res.json(data);
  } catch(e){ res.status(503).json({success:false,error:e.message}); }
});

app.get('/api/match/:id/lineups', async (req,res) => {
  try {
    if (!API_FOOTBALL_KEY) throw new Error('Lineups require API-Football.');
    const data = await cachedApiFootballDetail(`lineups-${req.params.id}`, async () => (await apiFootballGet('/fixtures/lineups',{ fixture:req.params.id }))?.response || []);
    res.json(data);
  } catch(e){ res.status(503).json({success:false,error:e.message}); }
});

app.get('/api/match/:id/statistics', async (req,res) => {
  try {
    if (!API_FOOTBALL_KEY) throw new Error('Statistics require API-Football.');
    const data = await cachedApiFootballDetail(`stats-${req.params.id}`, async () => (await apiFootballGet('/fixtures/statistics',{ fixture:req.params.id }))?.response || []);
    res.json(data);
  } catch(e){ res.status(503).json({success:false,error:e.message}); }
});

app.get('/api/match/:id/players', async (req,res) => {
  try {
    if (!API_FOOTBALL_KEY) throw new Error('Player match stats require API-Football.');
    const data = await cachedApiFootballDetail(`players-${req.params.id}`, async () => (await apiFootballGet('/fixtures/players',{ fixture:req.params.id }))?.response || []);
    res.json(data);
  } catch(e){ res.status(503).json({success:false,error:e.message}); }
});

app.get('/api/h2h', async (req,res) => {
  const { team1, team2 } = req.query;
  if (!team1 || !team2) return res.status(400).json({success:false,error:'team1 and team2 are required.'});
  try {
    if (!API_FOOTBALL_KEY) throw new Error('H2H requires API-Football.');
    const data = await cachedApiFootballDetail(`h2h-${team1}-${team2}`, async () => (await apiFootballGet('/fixtures/headtohead',{ h2h:`${team1}-${team2}`, last:10 }))?.response || []);
    res.json(data);
  } catch(e){ res.status(503).json({success:false,error:e.message}); }
});

app.get('/api/team/:id', async (req,res) => {
  const id = req.params.id;
  if (!API_FOOTBALL_KEY) return res.status(503).json({success:false,error:'Team profiles require API-Football.'});
  const key = `team-${id}`;
  const c = getCache(key);
  if (c?.data && c.expires > Date.now()) return res.json({...c.data,cached:true});
  if (inflight.has(key)) return res.json(await inflight.get(key));
  const promise=(async()=>{
    try {
      const [teamData,lastData,nextData] = await Promise.all([
        apiFootballGet('/teams',{id}),
        apiFootballGet('/fixtures',{team:id,last:5,timezone:BD_TIMEZONE}),
        apiFootballGet('/fixtures',{team:id,next:5,timezone:BD_TIMEZONE})
      ]);
      const payload={success:true,team:teamData?.response?.[0]||null,recent:lastData?.response||[],next:nextData?.response||[]};
      setCache(key,payload,CACHE_TTL.team); return {...payload,cached:false};
    }catch(e){if(c?.data)return {...c.data,cached:true,stale:true};throw e}
    finally{inflight.delete(key)}
  })();
  inflight.set(key,promise); try{res.json(await promise)}catch(e){res.status(503).json({success:false,error:e.message})}
});

app.get('/api/league/:id/standings', async (req,res) => {
  const id=req.params.id;
  const season = req.query.season || new Date().getFullYear();
  if (!API_FOOTBALL_KEY) return res.status(503).json({success:false,error:'Standings require API-Football.'});
  const key=`standings-${id}-${season}`;
  const c=getCache(key);
  if(c?.data&&c.expires>Date.now())return res.json({...c.data,cached:true});
  try{
    const data=await apiFootballGet('/standings',{league:id,season});
    const payload={success:true,response:data?.response||[],league:id,season};
    setCache(key,payload,CACHE_TTL.standings); res.json({...payload,cached:false});
  }catch(e){if(c?.data)return res.json({...c.data,cached:true,stale:true});res.status(503).json({success:false,error:e.message})}
});

app.get('/api/search/teams', async (req,res) => {
  const q=String(req.query.q||'').trim();
  if(q.length<2)return res.status(400).json({success:false,error:'Search must contain at least 2 characters.'});
  if(!API_FOOTBALL_KEY)return res.status(503).json({success:false,error:'Team search requires API-Football.'});
  const key=`team-search-${q.toLowerCase()}`; const c=getCache(key);
  if(c?.data&&c.expires>Date.now())return res.json({...c.data,cached:true});
  try{const data=await apiFootballGet('/teams',{search:q});const payload={success:true,response:data?.response||[]};setCache(key,payload,30*60_000);res.json({...payload,cached:false});}
  catch(e){if(c?.data)return res.json({...c.data,cached:true,stale:true});res.status(503).json({success:false,error:e.message})}
});

const storage = multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null,UPLOADS_DIR),
  filename: (_req,file,cb)=>{
    const ext=path.extname(file.originalname);
    const base=path.basename(file.originalname,ext).replace(/[^a-zA-Z0-9-_]/g,'_').slice(0,80);
    cb(null,`${Date.now()}-${base}${ext}`);
  }
});
const upload=multer({
  storage,
  limits:{fileSize:500*1024*1024},
  fileFilter:(_req,file,cb)=>cb(null,['video/mp4','video/webm','video/ogg','video/quicktime'].includes(file.mimetype))
});

app.post('/api/upload',(req,res,next)=>{
  if(!ADMIN_UPLOAD_TOKEN)return res.status(503).json({success:false,error:'Video uploads are disabled until ADMIN_UPLOAD_TOKEN is configured.'});
  if((req.get('x-admin-token')||'')!==ADMIN_UPLOAD_TOKEN)return res.status(401).json({success:false,error:'Unauthorized'});
  next();
},upload.single('video'),(req,res)=>{
  if(!req.file)return res.status(400).json({success:false,error:'Please select a valid video.'});
  res.json({success:true,video:`/uploads/${encodeURIComponent(req.file.filename)}`,filename:req.file.originalname});
});

app.get('/admin',(req,res)=>res.sendFile(path.join(wwwDir,'admin.html')));
app.get('/robots.txt',(_req,res)=>res.sendFile(path.join(wwwDir,'robots.txt')));
app.get('/sitemap.xml',(_req,res)=>res.sendFile(path.join(wwwDir,'sitemap.xml')));
app.get('/manifest.webmanifest',(_req,res)=>res.sendFile(path.join(wwwDir,'manifest.webmanifest')));

app.use('/api',(_req,res)=>res.status(404).json({success:false,error:'API endpoint not found.'}));
app.use((err,_req,res,_next)=>{console.error('SERVER ERROR:',err);res.status(400).json({success:false,error:err.message||'Something went wrong.'})});

app.get('/',(_req,res)=>res.sendFile(path.join(wwwDir,'index.html')));

app.listen(PORT,'0.0.0.0',()=>{
  console.log('================================');
  console.log('       DREAMLIVE SERVER');
  console.log('================================');
  console.log('Port:',PORT);
  console.log('API-Football:',API_FOOTBALL_KEY?'FOUND':'NOT SET');
  console.log('football-data.org:',FOOTBALL_DATA_TOKEN?'FOUND':'NOT SET');
  console.log('Timezone:',BD_TIMEZONE);
  console.log('================================');
  console.log(`DreamLive running on port ${PORT}`);
});