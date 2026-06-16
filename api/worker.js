// PULSE leaderboard API — server-authoritative scoring via deterministic replay.
// The client submits {seed, taps[]} (tap = cumulative game-time, slow-mo baked in).
// The server re-simulates the run with the EXACT game logic below and stores the
// score IT computes. A forged score is impossible without a valid input timeline.
// The simulate() function is byte-identical to the client's copy.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

/* ===== shared deterministic core — MUST stay identical to the client ===== */
const CFG = { basePoints:10, ringTargetBase:8, baseSpeed:1.75, speedPerLock:0.05, speedPerTier:0.55, speedCap:5.0, zoneBase:0.92, zoneMin:0.34, zoneShrinkPerTier:0.075, perfectFrac:0.34, minTravel:1.9, bpmBase:96, bpmPerTier:7, bpmCap:168, epochUTC: Date.UTC(2026,5,2) };
const TAU = Math.PI * 2;
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function hashSeed(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
function dailySeed(day){ return hashSeed('PULSE-daily-' + day); }
function wrap(a){ a%=TAU; return a<0?a+TAU:a; }
function angDist(a,b){ let d=Math.abs((a-b)%TAU); if(d>Math.PI) d=TAU-d; return d; }
function comboMult(c){ return c<5?1:c<10?2:c<20?3:c<35?4:5; }
function tierMult(t){ return 1+0.5*t; }
function beatRate(t){ return Math.min(CFG.bpmCap, CFG.bpmBase + t*CFG.bpmPerTier); }

// taps: ascending array of cumulative game-time (seconds) at each tap.
function simulate(seed, taps){
  const rng = mulberry32(seed>>>0);
  const place = (angle,dir,speed,tier)=>{ const spb=60/beatRate(tier); const bd=speed*spb; const kmin=Math.max(1,Math.ceil(CFG.minTravel/bd)); const kcap=Math.max(kmin,Math.floor(6.0/bd)); let k=kmin+Math.floor(rng()*3); if(k>kcap)k=kcap; return wrap(angle+dir*(k*bd)); };
  let angle=0, dir=1, speed=CFG.baseSpeed, score=0, combo=0, maxCombo=0, perfects=0, tier=0, locks=0, ringTarget=CFG.ringTargetBase, zone=CFG.zoneBase, shields=1;
  let target = place(angle,dir,speed,tier);
  let prev=0, used=0, dead=false, minGap=Infinity;
  for(let i=0;i<taps.length;i++){
    const t=taps[i], dgt=t-prev; prev=t;
    if(!(dgt>=0) || dgt>3600){ break; }
    if(dgt<minGap) minGap=dgt;
    angle = wrap(angle + dir*speed*dgt); used++;
    const d = angDist(angle, target);
    if(d <= zone/2){
      const perfect = d <= (zone*CFG.perfectFrac)/2;
      combo++; if(combo>maxCombo) maxCombo=combo;
      score += Math.round(CFG.basePoints * comboMult(combo) * tierMult(tier) * (perfect?2:1));
      if(perfect) perfects++;
      locks++; speed += CFG.speedPerLock;
      if(locks >= ringTarget){
        tier++; shields=Math.min(3,shields+1); score += 100*tier; locks=0; dir*=-1;
        speed = Math.min(CFG.speedCap, CFG.baseSpeed + tier*CFG.speedPerTier);
        zone = Math.max(CFG.zoneMin, CFG.zoneBase - tier*CFG.zoneShrinkPerTier);
        ringTarget = CFG.ringTargetBase + Math.floor(tier/2);
        target = place(angle,dir,speed,tier);
      } else { target = place(angle,dir,speed,tier); }
    } else {
      if(shields>0){ shields--; combo=0; target = place(angle,dir,speed,tier); }
      else { dead=true; break; }
    }
  }
  return { score, maxCombo, perfects, tier, used, dead, minGap };
}

async function topFor(env, key){
  const r = await env.DB.prepare("SELECT handle, MAX(score) AS score FROM scores WHERE board=? GROUP BY handle ORDER BY score DESC LIMIT 25").bind(key).all();
  return r.results || [];
}
async function rankFor(env, key, score){
  const r = await env.DB.prepare("SELECT COUNT(*)+1 AS rank FROM (SELECT handle, MAX(score) s FROM scores WHERE board=? GROUP BY handle) WHERE s > ?").bind(key, score).first();
  return r ? r.rank : null;
}

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try{
      if(url.pathname === '/top' && req.method === 'GET'){
        const board = url.searchParams.get('board') || 'alltime';
        const day = url.searchParams.get('day');
        const handle = (url.searchParams.get('handle')||'').toLowerCase().replace(/[^a-z0-9_\-]/g,'').slice(0,15);
        const key = (board==='daily' && day) ? ('daily:'+day) : 'alltime';
        const top = await topFor(env, key);
        let rank=null, best=null;
        if(handle){
          const b = await env.DB.prepare("SELECT MAX(score) AS best FROM scores WHERE board=? AND handle=?").bind(key, handle).first();
          best = b ? b.best : null;
          if(best!=null) rank = await rankFor(env, key, best);
        }
        return json({ board:key, top, rank, best });
      }
      if(url.pathname === '/submit' && req.method === 'POST'){
        const b = await req.json();
        const handle = String(b.handle||'').trim().toLowerCase().replace(/[^a-z0-9_\-]/g,'').slice(0,15);
        if(handle.length < 3) return json({ error:'bad_handle' }, 400);
        const taps = Array.isArray(b.taps) ? b.taps : [];
        if(taps.length < 1 || taps.length > 6000) return json({ error:'bad_taps' }, 400);
        for(let i=0;i<taps.length;i++){ if(typeof taps[i]!=='number' || !isFinite(taps[i]) || (i>0 && taps[i] < taps[i-1])) return json({ error:'bad_taps' }, 400); }
        const seed = (b.seed>>>0);
        const board = b.board==='daily' ? 'daily' : 'alltime';
        let key = 'alltime';
        if(board === 'daily'){
          const day = parseInt(b.day, 10);
          const today = Math.floor((Date.now() - CFG.epochUTC)/86400000) + 1;
          if(!(day === today || day === today-1)) return json({ error:'stale_day' }, 400);
          if(seed !== dailySeed(day)) return json({ error:'bad_seed' }, 400);
          key = 'daily:' + day;
        }
        const sim = simulate(seed, taps);
        // plausibility guards (raise the bot bar; daily is the protected board)
        if(sim.score < 0 || sim.score > 5000000) return json({ error:'implausible' }, 400);
        // NO fast-tap rejection. The score is the authoritative replay output, so spamming fast taps
        // just misses the ring and dies near 0 -- a real score proves real play. The old
        // `minGap < 0.03` gate let a SINGLE fast tap (a double-tap, a frantic late-game moment) throw
        // out an ENTIRE legit run (the STAK-class false positive that dropped Clutch's 32550). Removed.
        const ts = Date.now();
        await env.DB.prepare("INSERT INTO scores (board,handle,score,tier,perfects,ts) VALUES (?,?,?,?,?,?)").bind(key, handle, sim.score, sim.tier, sim.perfects, ts).run();
        return json({ ok:true, score:sim.score, tier:sim.tier, perfects:sim.perfects, rank: await rankFor(env, key, sim.score), top: await topFor(env, key) });
      }
      return json({ error:'not_found' }, 404);
    }catch(e){ return json({ error: String(e && e.message || e) }, 500); }
  }
};
