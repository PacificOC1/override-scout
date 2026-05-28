/* ── Mobile bottom nav ── */
function mbnNav(tab, el) {
  let target = tab;
  if (tab === 'search') target = 'leaderboard';
  if (tab === 'alliance') target = 'calendar';

  const tabBtn = document.querySelector('[data-tab="'+target+'"]');
  if (!tabBtn || !switchTab(target, tabBtn)) return;

  document.querySelectorAll('.mbn-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  if (tab === 'search') setTimeout(() => document.getElementById('pubSearch')?.focus(), 80);
  if (tab === 'alliance') setTimeout(() => {
    document.querySelector('#tab-calendar [onclick^="openAllianceForEvent"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}
// Keep bottom nav in sync when tabs are switched via other means
document.addEventListener('tabchange', function(e) {
  const tab = e.detail && e.detail.tab;
  if (!tab) return;
  document.querySelectorAll('.mbn-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mbn === tab);
  });
});

/* ── Service Worker registration (offline mode) ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    // Inline SW as a blob so we don't need a separate sw.js file
    const swCode = `
const CACHE = 'override-scout-v1';
const ASSETS = [self.location.href.replace(/\\/[^\\/]*$/, '/') || '/'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't intercept Supabase API calls — always go to network
  if (e.request.url.includes('supabase.co')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
`;
    const blob = new Blob([swCode], { type: 'application/javascript' });
    const swUrl = URL.createObjectURL(blob);
    navigator.serviceWorker.register(swUrl).then(function(reg) {
      console.log('SW registered:', reg.scope);
      // Show offline-ready toast once
      if (!localStorage.getItem('os_sw_shown')) {
        reg.installing && reg.installing.addEventListener('statechange', function(e) {
          if (e.target.state === 'activated') {
            showToast('✅ Offline mode ready — app cached for venue use', 'ok', 4000);
            try { localStorage.setItem('os_sw_shown', '1'); } catch(err) {}
          }
        });
      }
    }).catch(function(err) {
      console.log('SW registration failed (blob SW not supported in this context):', err.message);
    });
  });
}

/* ── Share via URL (encode team/tab in hash) ── */
(function() {
  // On load: if hash has ?team=X, open that team in search
  window.addEventListener('DOMContentLoaded', function() {
    const hash = location.hash.replace('#','');
    if (!hash) return;
    // Support #search?team=97230F
    const m = hash.match(/^([a-z-]+)(?:\?(.*))?$/);
    if (!m) return;
    const tab = m[1], params = new URLSearchParams(m[2] || '');
    const teamParam = params.get('team');
    // Restore tab
    const tabEl = document.querySelector('[data-tab="'+tab+'"]');
    if (tabEl) switchTab(tab, tabEl);
    // If team in params, auto-search after data loads
    if (teamParam) {
      const trySearch = function() {
        const inp = document.getElementById('pubSearch');
        if (inp) {
          inp.value = teamParam.toUpperCase();
          // Always show leaderboard tab with search bubble
          switchTab('leaderboard', document.querySelector('[data-tab="leaderboard"]'));
          if (typeof lbDoSearch === 'function') lbDoSearch();
          else pubDoSearch();
        }
      };
      // Try immediately, then again after data loads
      setTimeout(trySearch, 800);
      setTimeout(trySearch, 2500);
    }
  });

  // Expose a share helper: shareTeam('97230F') copies a URL
  window.shareTeam = function(team) {
    const url = location.origin + location.pathname + '#search?team=' + encodeURIComponent(team);
    navigator.clipboard.writeText(url).then(function() {
      showToast('🔗 Link copied: ' + url, 'ok', 3500);
    }).catch(function() {
      prompt('Copy this link:', url);
    });
  };
})();

/* ══════════════════════════════════════════════════════════
   SKILLS RUNS — localStorage-backed, exportable
══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════
   SKILLS TABLE — run once in Supabase SQL editor:

   create table if not exists skills_runs (
     id         text primary key,
     team       text not null,
     event      text not null default '',
     type       text not null check (type in ('auton','driver')),
     score      integer not null default 0,
     attempt    integer not null default 1,
     notes      text not null default '',
     ts         bigint not null,
     created_at timestamptz not null default now()
   );
   alter table skills_runs enable row level security;
   create policy "public read"   on skills_runs for select using (true);
   create policy "admin insert"  on skills_runs for insert with check (auth.role() = 'authenticated');
   create policy "admin delete"  on skills_runs for delete using  (auth.role() = 'authenticated');
════════════════════════════════════════════════════════ */

const SK_LS_KEY = 'os_skills_v1';
let _skEntries = [];
let _skSyncing = false;

// Boot: load from localStorage immediately so leaderboard is instant
(function() {
  try { _skEntries = JSON.parse(localStorage.getItem(SK_LS_KEY) || '[]'); } catch(e) { _skEntries = []; }
})();

let _skFilter = 'both'; // 'both' | 'auton' | 'driver'

// Persist to localStorage (always) + sync status indicator
function skSave() {
  try { localStorage.setItem(SK_LS_KEY, JSON.stringify(_skEntries)); } catch(e) {}
}

// ── Pull all runs from Supabase, merge with any local-only entries ──
async function skLoadFromSupabase() {
  if (_skSyncing) return;
  _skSyncing = true;
  skSetSyncStatus('syncing');
  try {
    let rows = [], off = 0, batch;
    do {
      const r = await fetch(
        SB_URL + '/rest/v1/skills_runs?select=*&order=ts.desc&limit=1000&offset=' + off,
        { headers: HDRS }
      );
      if (!r.ok) throw new Error('HTTP ' + r.status);
      batch = await r.json();
      rows = rows.concat(batch);
      off += 1000;
    } while (batch.length === 1000);

    // Merge: keep any local entries not yet in Supabase (pending push)
    const sbIds = new Set(rows.map(e => e.id));
    const localOnly = _skEntries.filter(e => !sbIds.has(e.id));
    _skEntries = [...localOnly, ...rows];
    skSave();
    skRender();
    skSetSyncStatus('ok', rows.length + ' runs');
  } catch (err) {
    console.error('Skills load error:', err);
    skSetSyncStatus('err', 'Sync failed');
  } finally {
    _skSyncing = false;
  }
}

// ── Push a single new run to Supabase (admin only) ──
async function skPushToSupabase(entry) {
  if (!isAdmin) return; // viewers can't write
  const r = await fetch(SB_URL + '/rest/v1/skills_runs', {
    method: 'POST',
    headers: { ...adminHdrs(), 'Prefer': 'return=minimal', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id:      entry.id,
      team:    entry.team,
      event:   entry.event   || '',
      type:    entry.type,
      score:   entry.score,
      attempt: entry.attempt || 1,
      notes:   entry.notes   || '',
      ts:      entry.ts
    })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Supabase error ' + r.status + ': ' + txt.slice(0, 120));
  }
}

// ── Delete a run from Supabase (admin only) ──
async function skDeleteFromSupabase(id) {
  if (!isAdmin) return;
  const r = await fetch(SB_URL + '/rest/v1/skills_runs?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: adminHdrs()
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Delete error ' + r.status + ': ' + txt.slice(0, 120));
  }
}

// ── Sync status badge inside Skills tab ──
function skSetSyncStatus(state, label) {
  const el = document.getElementById('sk-sync-status');
  if (!el) return;
  const map = {
    syncing: { text: '⟳ Syncing…',      color: 'var(--blue)'  },
    ok:      { text: '✓ ' + (label||'Synced'), color: 'var(--green)' },
    err:     { text: '✕ ' + (label||'Error'),  color: 'var(--red)'   }
  };
  const s = map[state] || map.ok;
  el.textContent = s.text;
  el.style.color = s.color;
}

async function saveSkillsRun() {
  const team    = (document.getElementById('sk-team')?.value || '').trim().toUpperCase();
  const event_  = (document.getElementById('sk-event')?.value || '').trim();
  const type    = document.getElementById('sk-type')?.value || 'auton';
  const score   = parseInt(document.getElementById('sk-score')?.value || '0', 10);
  const attempt = parseInt(document.getElementById('sk-attempt')?.value || '1', 10);
  const notes   = (document.getElementById('sk-notes')?.value || '').trim();
  const msg     = document.getElementById('sk-msg');
  const btn     = document.querySelector('[onclick="saveSkillsRun()"]');

  if (!team)           { if (msg) { msg.style.color='var(--red)'; msg.textContent='Team # required.'; } return; }
  if (isNaN(score) || score < 0) { if (msg) { msg.style.color='var(--red)'; msg.textContent='Valid score required.'; } return; }

  const entry = {
    id:      'sk_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    team,
    event:   event_,
    type,
    score,
    attempt,
    notes,
    ts:      Date.now()
  };

  // Optimistic: add locally first so UI feels instant
  _skEntries.push(entry);
  skSave();
  skRender();

  // Clear form
  ['sk-team','sk-event','sk-score','sk-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const attemptEl = document.getElementById('sk-attempt');
  if (attemptEl) attemptEl.value = '1';

  if (msg) { msg.style.color = 'var(--green)'; msg.textContent = '⟳ Saving…'; }
  if (btn) btn.disabled = true;

  try {
    await skPushToSupabase(entry);
    if (msg) {
      msg.style.color = 'var(--green)';
      msg.textContent = '✓ Saved — ' + team + ' ' + score + ' pts';
      setTimeout(() => { msg.textContent = ''; }, 3000);
    }
    showToast('🎯 Skills run saved — ' + team + ' ' + score + ' pts (' + type + ')', 'ok');
  } catch (err) {
    // Push failed — entry stays in localStorage as pending, show warning
    if (msg) {
      msg.style.color = 'var(--amber)';
      msg.textContent = '⚠ Saved locally (sync failed: ' + err.message.slice(0,60) + ')';
      setTimeout(() => { msg.textContent = ''; }, 6000);
    }
    showToast('Skills run saved locally — sync failed', 'err');
    console.error('skPushToSupabase error:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function skDeleteRun(id) {
  _skEntries = _skEntries.filter(e => e.id !== id);
  skSave();
  skRender();
  try {
    await skDeleteFromSupabase(id);
    showToast('Skills run deleted', 'ok');
  } catch (err) {
    showToast('Deleted locally — Supabase sync failed', 'err');
    console.error('skDeleteFromSupabase error:', err);
  }
}

function skSetFilter(f, el) {
  _skFilter = f;
  // Style the segmented control buttons
  ['both','auton','driver'].forEach(k => {
    const b = document.getElementById('sk-filter-'+k);
    if (!b) return;
    if (k === f) {
      b.style.background = 'var(--red)';
      b.style.color = '#fff';
      b.style.borderColor = 'var(--red)';
    } else {
      b.style.background = 'var(--paper3)';
      b.style.color = 'var(--ink2)';
      b.style.borderColor = 'var(--border2)';
    }
  });
  skRender();
}

/* Build per-team summary from raw entries */
function skBuildLeaderboard() {
  const byTeam = {};
  _skEntries.forEach(e => {
    if (!byTeam[e.team]) byTeam[e.team] = { team: e.team, auton: [], driver: [] };
    byTeam[e.team][e.type === 'driver' ? 'driver' : 'auton'].push(e);
  });

  return Object.values(byTeam).map(t => {
    const bestAutonEntry  = t.auton.length  ? t.auton.reduce((a,b)=>b.score>a.score?b:a)  : null;
    const bestDriverEntry = t.driver.length ? t.driver.reduce((a,b)=>b.score>a.score?b:a) : null;
    const bestAuton  = bestAutonEntry  ? bestAutonEntry.score  : null;
    const bestDriver = bestDriverEntry ? bestDriverEntry.score : null;
    const combined   = (bestAuton || 0) + (bestDriver || 0);
    return { team: t.team, bestAuton, bestDriver, combined,
             autonRuns: t.auton.length, driverRuns: t.driver.length,
             bestAutonEntry, bestDriverEntry };
  });
}

function skRender() {
  const lb  = skBuildLeaderboard();
  const wrap = document.getElementById('sk-lb-wrap');
  if (!wrap) return;

  // Update spotlight cards
  const allAuton  = _skEntries.filter(e => e.type === 'auton');
  const allDriver = _skEntries.filter(e => e.type === 'driver');
  const topAuton  = allAuton.length  ? allAuton.reduce((a,b)=>b.score>a.score?b:a)  : null;
  const topDriver = allDriver.length ? allDriver.reduce((a,b)=>b.score>a.score?b:a) : null;

  const spotA = document.getElementById('sk-spot-auton-score');
  const spotAS = document.getElementById('sk-spot-auton-sub');
  const spotAT = document.getElementById('sk-spot-auton-team');
  if (spotA)  spotA.textContent  = topAuton  ? topAuton.score  : '—';
  if (spotAS) spotAS.textContent = topAuton  ? (topAuton.event || 'Skills run') : 'No runs yet';
  if (spotAT) spotAT.textContent = topAuton  ? topAuton.team   : '';

  const spotD = document.getElementById('sk-spot-driver-score');
  const spotDS = document.getElementById('sk-spot-driver-sub');
  const spotDT = document.getElementById('sk-spot-driver-team');
  if (spotD)  spotD.textContent  = topDriver  ? topDriver.score  : '—';
  if (spotDS) spotDS.textContent = topDriver  ? (topDriver.event || 'Skills run') : 'No runs yet';
  if (spotDT) spotDT.textContent = topDriver  ? topDriver.team   : '';

  // Search filter
  const q = (document.getElementById('sk-search')?.value || '').trim().toUpperCase();

  // Sort by selected filter
  let sorted;
  if (_skFilter === 'auton') {
    sorted = lb.filter(t => t.bestAuton !== null).sort((a,b) => b.bestAuton - a.bestAuton);
  } else if (_skFilter === 'driver') {
    sorted = lb.filter(t => t.bestDriver !== null).sort((a,b) => b.bestDriver - a.bestDriver);
  } else {
    sorted = lb.slice().sort((a,b) => b.combined - a.combined);
  }

  if (q) sorted = sorted.filter(t => t.team.includes(q));

  const countEl = document.getElementById('sk-count-label');
  if (countEl) countEl.textContent = sorted.length + ' team' + (sorted.length!==1?'s':'');

  if (!sorted.length) {
    wrap.innerHTML = '<div class="empty" style="padding:48px 0">' + (q ? 'No teams match "'+esc(q)+'".' : 'No skills runs logged yet.') + '</div>';
    return;
  }

  const maxScore = _skFilter === 'auton'  ? Math.max(...sorted.map(t => t.bestAuton  || 0))
                 : _skFilter === 'driver' ? Math.max(...sorted.map(t => t.bestDriver || 0))
                 : Math.max(...sorted.map(t => t.combined));

  const myTeam_ = typeof myTeam !== 'undefined' ? myTeam : (localStorage.getItem('os_my_team')||'');
  const isAdmin_ = typeof isAdmin !== 'undefined' && isAdmin;
  const medals = ['🥇','🥈','🥉'];

  // Table header columns depend on filter
  const colsBoth   = `<div style="color:var(--green)">Auton</div><div style="color:var(--blue)">Driver</div><div>Combined</div>`;
  const colsSingle = `<div>Best Score</div><div>Runs</div>`;
  const gridBoth   = `40px 1fr 80px 80px 100px${isAdmin_?' 36px':''}`;
  const gridSingle = `40px 1fr 100px 60px${isAdmin_?' 36px':''}`;
  const grid = _skFilter === 'both' ? gridBoth : gridSingle;
  const hdrCols = _skFilter === 'both' ? colsBoth : colsSingle;

  wrap.innerHTML = `
  <div style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
    <!-- Header row -->
    <div style="display:grid;grid-template-columns:${grid};gap:0;
                padding:8px 14px;background:var(--paper3);
                font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);
                border-bottom:1px solid var(--border2)">
      <div>Rank</div><div>Team</div>${hdrCols}${isAdmin_?'<div></div>':''}
    </div>

    ${sorted.map((t, i) => {
      const mainScore = _skFilter==='auton'  ? (t.bestAuton  ?? 0)
                      : _skFilter==='driver' ? (t.bestDriver ?? 0)
                      : t.combined;
      const pct   = maxScore ? Math.round(mainScore / maxScore * 100) : 0;
      const isMe  = t.team === myTeam_;
      const isTop = i < 3;

      // Accent colour for rank badge
      const rankColor = i===0 ? '#f0c030' : i===1 ? '#a8a49c' : i===2 ? '#cd7f32' : 'var(--ink3)';

      // How long ago best run was
      const refEntry = _skFilter==='driver' ? t.bestDriverEntry : t.bestAutonEntry;
      const daysAgo  = refEntry ? Math.floor((Date.now()-refEntry.ts)/86400000) : null;
      const agoLabel = daysAgo===0 ? 'Today' : daysAgo===1 ? '1 day ago' : daysAgo!==null ? daysAgo+' days ago' : '';

      return `
      <div style="display:grid;grid-template-columns:${grid};gap:0;
                  padding:10px 14px;border-top:1px solid var(--border);align-items:center;
                  background:${isMe?'rgba(240,192,48,.06)':isTop?'rgba(204,61,20,.03)':'transparent'};
                  transition:background .12s;cursor:default"
           onmouseenter="this.style.background='var(--paper3)'"
           onmouseleave="this.style.background='${isMe?'rgba(240,192,48,.06)':isTop?'rgba(204,61,20,.03)':'transparent'}'">

        <!-- Rank -->
        <div style="font-family:var(--mono);font-size:${isTop?'16px':'13px'};font-weight:800;color:${rankColor};text-align:center">
          ${i<3 ? medals[i] : i+1}
        </div>

        <!-- Team + score bar -->
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <span style="font-family:var(--mono);font-weight:800;font-size:${isTop?'15px':'13px'};color:${isMe?'var(--amber)':'var(--ink)'}">${esc(t.team)}</span>
            ${isMe ? '<span style="font-size:8px;background:var(--amber-bg);color:var(--amber);border:1px solid rgba(240,192,48,.3);padding:1px 6px;border-radius:3px;font-family:var(--mono);font-weight:700">YOU</span>' : ''}
            ${getGradeBadgeHTML(t.team)}
          </div>
          <!-- Score fill bar -->
          <div style="margin-top:4px;height:3px;border-radius:2px;background:var(--border2);width:min(100%,120px);overflow:hidden">
            <div style="height:100%;border-radius:2px;width:${pct}%;
                        background:${i===0?'linear-gradient(90deg,var(--amber),var(--red))':i===1?'var(--ink2)':'var(--red)'};
                        transition:width .4s cubic-bezier(.22,.68,0,1.2)"></div>
          </div>
          ${agoLabel ? `<div style="font-size:9px;color:var(--ink3);font-family:var(--mono);margin-top:2px">${agoLabel}</div>` : ''}
        </div>

        ${_skFilter==='both' ? `
          <!-- Auton score -->
          <div>
            <div style="font-family:var(--mono);font-size:${isTop?'16px':'14px'};font-weight:${isTop?'800':'600'};
                        color:${t.bestAuton!==null?'var(--ink)':'var(--ink3)'}">${t.bestAuton??'—'}</div>
            ${t.bestAuton!==null ? '<div style="font-size:8px;font-family:var(--mono);color:var(--green);letter-spacing:.5px;text-transform:uppercase;font-weight:700">best</div>' : ''}
          </div>
          <!-- Driver score -->
          <div>
            <div style="font-family:var(--mono);font-size:${isTop?'16px':'14px'};font-weight:${isTop?'800':'600'};
                        color:${t.bestDriver!==null?'var(--ink)':'var(--ink3)'}">${t.bestDriver??'—'}</div>
            ${t.bestDriver!==null ? '<div style="font-size:8px;font-family:var(--mono);color:var(--blue);letter-spacing:.5px;text-transform:uppercase;font-weight:700">best</div>' : ''}
          </div>
          <!-- Combined -->
          <div style="font-family:var(--mono);font-size:${isTop?'20px':'16px'};font-weight:800;
                      color:${i===0?'var(--amber)':i===1?'var(--ink)':'var(--ink2)'}">${t.combined}</div>
        ` : `
          <!-- Single score -->
          <div>
            <div style="font-family:var(--mono);font-size:${isTop?'20px':'16px'};font-weight:800;
                        color:${i===0?'var(--amber)':i===1?'var(--ink)':'var(--ink2)'}">${mainScore}</div>
            <div style="font-size:8px;font-family:var(--mono);color:${_skFilter==='auton'?'var(--green)':'var(--blue)'};letter-spacing:.5px;text-transform:uppercase;font-weight:700">best</div>
          </div>
          <!-- Run count -->
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink3)">
            ${_skFilter==='auton'?t.autonRuns:t.driverRuns} run${(_skFilter==='auton'?t.autonRuns:t.driverRuns)!==1?'s':''}
          </div>
        `}

        ${isAdmin_ ? `
        <div style="text-align:right">
          <button class="btn btn-sm" style="padding:2px 8px;font-size:9px;color:var(--ink3)" onclick="skShowRunsForTeam('${esc(t.team)}')" title="Show all runs">▾</button>
        </div>` : ''}
      </div>
      <div id="sk-runs-${esc(t.team)}" style="display:none;padding:10px 14px 12px;border-top:1px solid var(--border);background:var(--paper2)"></div>
      `;
    }).join('')}
  </div>`;
}

function skShowRunsForTeam(team) {
  const el = document.getElementById('sk-runs-' + team);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  const runs = _skEntries.filter(e => e.team === team).sort((a,b) => b.ts - a.ts);
  el.innerHTML = runs.map(r => `
    <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;flex-wrap:wrap">
      <span style="background:${r.type==='auton'?'var(--green-bg)':'var(--blue-bg)'};color:${r.type==='auton'?'var(--green)':'var(--blue)'};padding:1px 7px;border-radius:3px;font-size:9px;font-weight:700;text-transform:uppercase">${esc(r.type)}</span>
      <span style="font-weight:700;font-size:14px">${r.score} pts</span>
      <span style="color:var(--ink3)">Attempt ${r.attempt}</span>
      ${r.event ? `<span style="color:var(--ink3)">${esc(r.event)}</span>` : ''}
      ${r.notes ? `<span style="color:var(--ink2)">${esc(r.notes)}</span>` : ''}
      <button class="btn btn-sm" style="margin-left:auto;color:var(--red);border-color:rgba(204,61,20,.3);font-size:9px;padding:1px 8px" onclick="skDeleteRun('${esc(r.id)}')">✕ Delete</button>
    </div>`).join('') || '<div style="color:var(--ink3);font-size:11px;padding:4px 0">No runs yet.</div>';
  el.style.display = 'block';
}

function exportSkillsCSV() {
  if (!_skEntries.length) { showToast('No skills runs to export', 'err'); return; }
  const hdr = 'Team,Type,Score,Attempt,Event,Notes,Timestamp';
  const rows = _skEntries.map(e =>
    [e.team, e.type, e.score, e.attempt, e.event, e.notes, new Date(e.ts).toISOString()].map(v => '"'+(v??'').toString().replace(/"/g,'""')+'"').join(',')
  );
  const blob = new Blob([hdr + '\n' + rows.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'override_skills_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  showToast('Skills CSV exported — ' + _skEntries.length + ' runs', 'ok');
}

/* ══════════════════════════════════════════════════════════
   PIT SCOUT — localStorage-backed, exportable
══════════════════════════════════════════════════════════ */
const PIT_LS_KEY = 'os_pit_scout_v1';
let _pitEntries = [];
(function() {
  try { _pitEntries = JSON.parse(localStorage.getItem(PIT_LS_KEY) || '[]'); } catch(e) { _pitEntries = []; }
})();

function savePitEntry() {
  const team = (document.getElementById('pit-team').value || '').trim().toUpperCase();
  if (!team) { document.getElementById('pit-msg').innerHTML = '<span style="color:var(--red-text);font-size:12px;margin-top:8px;display:block">Team # is required.</span>'; return; }
  const entry = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    team,
    name:       document.getElementById('pit-name').value.trim(),
    event:      document.getElementById('pit-event').value.trim(),
    drive:      document.getElementById('pit-drive').value,
    motors:     document.getElementById('pit-motors').value,
    ratio:      document.getElementById('pit-ratio').value.trim(),
    type:       document.getElementById('pit-type').value,
    lift:       document.getElementById('pit-lift').value.trim(),
    weight:     document.getElementById('pit-weight').value,
    routes:     document.getElementById('pit-routes').value.trim(),
    best_auton: document.getElementById('pit-best-auton').value.trim(),
    sawp:       document.getElementById('pit-sawp').value,
    lang:       document.getElementById('pit-lang').value,
    notes:      document.getElementById('pit-notes').value.trim(),
  };
  // Overwrite existing entry for same team+event if exists
  const existIdx = _pitEntries.findIndex(e => e.team === team && e.event === entry.event);
  if (existIdx >= 0) _pitEntries[existIdx] = entry;
  else _pitEntries.unshift(entry);
  try { localStorage.setItem(PIT_LS_KEY, JSON.stringify(_pitEntries)); } catch(e) {}
  document.getElementById('pit-msg').innerHTML = '<span style="color:var(--green);font-size:12px;margin-top:8px;display:block">✅ Pit entry saved for ' + esc(team) + '.</span>';
  renderPitLog();
  setTimeout(() => { const m = document.getElementById('pit-msg'); if (m) m.innerHTML = ''; }, 3000);
}

function clearPitForm() {
  ['pit-team','pit-name','pit-event','pit-ratio','pit-lift','pit-weight','pit-routes','pit-best-auton','pit-notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['pit-drive','pit-motors','pit-type','pit-sawp','pit-lang']
    .forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  const m = document.getElementById('pit-msg'); if (m) m.innerHTML = '';
}

function renderPitLog() {
  const q = (document.getElementById('pit-log-q')?.value || '').trim().toUpperCase();
  const rows = q ? _pitEntries.filter(e => (e.team||'').includes(q) || (e.name||'').toUpperCase().includes(q)) : _pitEntries;
  const body = document.getElementById('pit-log-body');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<div class="empty" style="padding:24px 0">' + (_pitEntries.length ? 'No matching entries.' : 'No pit entries yet. Fill out the form above.') + '</div>';
    return;
  }
  body.innerHTML = rows.map(e => `
    <div class="pit-row">
      <div style="font-family:var(--mono);font-weight:700;font-size:13px">${esc(e.team)}</div>
      <div>
        <div style="font-size:12px;color:var(--ink)">${esc(e.name||'—')}</div>
        <div style="font-size:10px;color:var(--ink3);font-family:var(--mono)">${esc(e.event||'—')}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--ink2)">${esc(e.drive||'—')} ${e.motors?'· '+esc(e.motors):''}</div>
        <div style="font-size:10px;color:var(--ink3);font-family:var(--mono)">${esc(e.type||'—')}</div>
      </div>
      <div style="font-size:11px;color:var(--ink2)">
        <div>${e.sawp==='yes'?'✅ SAWP':e.sawp==='sometimes'?'🟡 SAWP maybe':e.sawp==='no'?'❌ No SAWP':'—'}</div>
        <div style="font-size:10px;color:var(--ink3);font-family:var(--mono)">${esc(e.best_auton||'—')}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm" onclick="pitPrefill(${JSON.stringify(e.id)})" title="Load into form">✏</button>
        <button class="btn btn-sm btn-d" onclick="deletePitEntry(${JSON.stringify(e.id)})" title="Delete">✕</button>
      </div>
    </div>`).join('');
}

function pitPrefill(id) {
  const e = _pitEntries.find(en => String(en.id) === String(id));
  if (!e) return;
  const set = (i, v) => { const el = document.getElementById(i); if (el) el.value = v || ''; };
  set('pit-team', e.team); set('pit-name', e.name); set('pit-event', e.event);
  set('pit-drive', e.drive); set('pit-motors', e.motors); set('pit-ratio', e.ratio);
  set('pit-type', e.type); set('pit-lift', e.lift); set('pit-weight', e.weight);
  set('pit-routes', e.routes); set('pit-best-auton', e.best_auton);
  set('pit-sawp', e.sawp); set('pit-lang', e.lang); set('pit-notes', e.notes);
  switchTab('calendar', document.querySelector('[data-tab="calendar"]'));
  setTimeout(() => openPitForEvent(null), 150);
}

function deletePitEntry(id) {
  if (!confirm('Delete this pit entry?')) return;
  _pitEntries = _pitEntries.filter(e => String(e.id) !== String(id));
  try { localStorage.setItem(PIT_LS_KEY, JSON.stringify(_pitEntries)); } catch(err) {}
  renderPitLog();
}

function exportPitCSV() {
  if (!_pitEntries.length) { showToast('No pit entries to export', 'err', 2000); return; }
  const hdr = 'Team,Name,Event,Drive,Motors,Ratio,Type,Lift,Weight,Routes,BestAuton,SAWP,Lang,Notes,Date';
  const rows = _pitEntries.map(e => [
    e.team, e.name, e.event, e.drive, e.motors, e.ratio, e.type, e.lift, e.weight,
    e.routes, e.best_auton, e.sawp, e.lang,
    '"'+(e.notes||'').replace(/"/g,"'")+'"', e.ts||''
  ].join(','));
  const blob = new Blob([hdr+'\n'+rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'override_pit_scout_'+new Date().toISOString().slice(0,10)+'.csv'; a.click();
  showToast('Pit scout CSV exported — '+_pitEntries.length+' entries', 'ok');
}

// Also expose pit data in the pit section of team profiles
function getPitDataForTeam(team) {
  return _pitEntries.find(e => e.team === (team||'').toUpperCase().trim()) || null;
}

/* ══════════════════════════════════════════════════════════
   ALLIANCE SELECTION HELPER
══════════════════════════════════════════════════════════ */
let _alPickedSet = new Set();
try { _alPickedSet = new Set(JSON.parse(localStorage.getItem('os_al_picked') || '[]')); } catch(e) {}

function alSavePicked() {
  try { localStorage.setItem('os_al_picked', JSON.stringify([..._alPickedSet])); } catch(e) {}
}

function alResetPicked() {
  _alPickedSet.clear();
  alSavePicked();
  const inp = document.getElementById('al-picked');
  if (inp) inp.value = '';
  runAlliance();
}

function alScore(team) {
  // Composite score: 60% avg_pins, 20% awp_pct, 10% success_pct, 10% TrueSkill (if available)
  const avg = parseFloat(team.avg_pins) || 0;
  const awp = parseFloat(team.awp_pct)  || 0;
  const suc = parseFloat(team.success_pct) || 0;
  const ts  = tsGet ? (tsGet(team.team)?.ts || 25) : 25;
  const tsNorm = Math.max(0, Math.min(100, (ts / 50) * 100)); // normalise ts ~0-50 → 0-100
  return avg * 0.6 + awp * 0.2 + suc * 0.1 + tsNorm * 0.1;
}

function runAlliance() {
  const statusEl = document.getElementById('al-status');
  const sugEl = document.getElementById('al-suggestions');
  const tableEl = document.getElementById('al-full-table');
  if (!statusEl || !sugEl || !tableEl) return;

  const myTeam = (document.getElementById('al-my-team')?.value || '').trim().toUpperCase();
  const pickedRaw = (document.getElementById('al-picked')?.value || '');

  // Merge manually typed picks with the persistent set
  pickedRaw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean).forEach(t => _alPickedSet.add(t));
  alSavePicked();

  if (!allTeams || !allTeams.length) {
    statusEl.textContent = 'Loading data…';
    return;
  }

  const excluded = new Set([..._alPickedSet, myTeam].filter(Boolean));
  const available = allTeams.filter(t => !excluded.has(t.team));
  const sorted = available.slice().sort((a, b) => alScore(b) - alScore(a));
  const maxScore = alScore(sorted[0] || {avg_pins:0}) || 1;

  // Top 3 suggestions
  const topN = sorted.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  sugEl.innerHTML = topN.length
    ? topN.map((t, i) => {
        const sc = alScore(t);
        const pct = Math.round(sc / maxScore * 100);
        const tsInfo = tsGet ? tsGet(t.team) : null;
        const pitInfo = getPitDataForTeam(t.team);
        return `<div class="al-suggestion-card rank-${i+1}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span class="al-rank-badge">${medals[i]}</span>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="al-team-num">${esc(t.team)}</span>
                ${tsInfo?.qualified ? '<span class="badge b-awp" style="font-size:9px">Worlds Qual</span>' : ''}
                ${pitInfo ? '<span class="badge" style="background:var(--blue-bg);color:var(--blue);border:1px solid rgba(61,142,240,.3);font-size:9px">🤖 Pit data</span>' : ''}
              </div>
              <div style="font-size:10px;color:var(--ink3);font-family:var(--mono);margin-top:2px">
                ${t.count} matches · Avg ${parseFloat(t.avg_pins).toFixed(1)} pins · AWP ${(parseFloat(t.awp_pct)||0).toFixed(0)}%
                ${tsInfo ? '· TS '+tsInfo.ts.toFixed(1) : ''}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:16px;font-weight:700;font-family:var(--mono)">${pct}<span style="font-size:11px;color:var(--ink3)">%</span></div>
              <div style="font-size:9px;color:var(--ink3);font-family:var(--mono)">score</div>
            </div>
          </div>
          <div class="al-score-bar"><div class="al-score-fill" style="width:${pct}%"></div></div>
          ${pitInfo && pitInfo.routes ? '<div style="font-size:11px;color:var(--ink2);margin-top:6px;font-family:var(--mono)">🔧 '+esc(pitInfo.routes)+'</div>' : ''}
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-sm" onclick="window.shareTeam('${esc(t.team)}')" title="Share team link">🔗 Share</button>
            <button class="btn btn-sm btn-d" onclick="alMarkPicked('${esc(t.team)}')" title="Mark as picked">✕ Mark picked</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">No available teams left.</div>';

  // Full table
  tableEl.innerHTML = `<div style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
    <div style="display:grid;grid-template-columns:auto 1fr auto auto auto auto auto;gap:8px;padding:7px 10px;background:var(--paper3);font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.7px;color:var(--ink3)">
      <div>#</div><div>Team</div><div>Matches</div><div>Avg Pins</div><div>AWP%</div><div>Succ%</div><div>Score</div>
    </div>
    ${allTeams.slice().sort((a,b)=>alScore(b)-alScore(a)).map((t, i) => {
      const isPicked = excluded.has(t.team);
      const isMine   = t.team === myTeam;
      const sc = alScore(t);
      const pct = Math.round(sc / maxScore * 100);
      return `<div class="al-full-row${isPicked?' al-picked':''}${isMine?' al-mine':''}" onclick="alTogglePicked('${esc(t.team)}')" title="${isPicked?'Click to unmark':'Click to mark as picked'}">
        <div style="font-family:var(--mono);font-size:11px;color:var(--ink3)">${i+1}</div>
        <div style="font-family:var(--mono);font-weight:700">${esc(t.team)}${isMine?' <span style="font-size:9px;color:var(--amber)">YOU</span>':''}</div>
        <div style="font-family:var(--mono)">${t.count}</div>
        <div style="font-family:var(--mono);font-weight:600">${parseFloat(t.avg_pins).toFixed(1)}</div>
        <div style="font-family:var(--mono)">${(parseFloat(t.awp_pct)||0).toFixed(0)}%</div>
        <div style="font-family:var(--mono)">${(parseFloat(t.success_pct)||0).toFixed(0)}%</div>
        <div style="font-family:var(--mono);color:${pct>=70?'var(--green)':pct>=40?'var(--amber)':'var(--ink3)'}">${pct}</div>
      </div>`;
    }).join('')}
  </div>`;

  const avail = allTeams.length - excluded.size;
  statusEl.textContent = avail + ' teams available, ' + _alPickedSet.size + ' picked/excluded';
}

function alMarkPicked(team) {
  _alPickedSet.add(team);
  alSavePicked();
  runAlliance();
}

function alTogglePicked(team) {
  if (_alPickedSet.has(team)) _alPickedSet.delete(team);
  else _alPickedSet.add(team);
  alSavePicked();
  runAlliance();
}

// Re-run alliance when data loads
const _origSetAllTeams = window.setAllTeams;
if (typeof setAllTeams === 'function') {
  window.setAllTeams = function(teams) {
    _origSetAllTeams(teams);
    if (_isTabActive && _isTabActive('calendar')) runAlliance();
  };
}

/* ── Pin tabs bar (restore original behaviour) ── */
(function() {
  function pinTabs() {
    var shell = document.getElementById('appShell');
    var topbar = shell.querySelector('.topbar');
    var tabsWrap = shell.querySelector('.tabs-wrap');
    var shellRect = shell.getBoundingClientRect();
    topbar.style.position = 'fixed';
    topbar.style.top = '0';
    topbar.style.left = shellRect.left + 'px';
    topbar.style.right = '0';
    topbar.style.zIndex = '50';
    topbar.style.width = 'auto';
    var topbarH = topbar.offsetHeight;
    tabsWrap.style.position = 'fixed';
    tabsWrap.style.top = topbarH + 'px';
    tabsWrap.style.left = shellRect.left + 'px';
    tabsWrap.style.right = '0';
    tabsWrap.style.zIndex = '40';
    tabsWrap.style.width = 'auto';
    var tabsH = tabsWrap.offsetHeight;
    shell.style.paddingTop = (topbarH + tabsH) + 'px';
  }
  document.addEventListener('DOMContentLoaded', function() {
    pinTabs();
    window.addEventListener('resize', pinTabs);
    document.addEventListener('tabchange', pinTabs);
    document.addEventListener('sidebarToggle', pinTabs);
    // Also render alliance on load
    if(typeof runAlliance === 'function') setTimeout(runAlliance, 200);
  });
})();

/* ═══════════════════════════════════════════════════════
   🧪 EXPERIMENTAL LAB — QUICK-SCOUT MODE
   Lets admins log both robots from a single match
   side-by-side without switching tabs.
════════════════════════════════════════════════════════ */

// Persisted state
let _qsMatches = [];        // matches fetched for current event
let _qsMatchIdx = 0;        // index of currently selected match
let _qsEventId  = null;     // RE event id for the selected event

// Populate pin dropdowns (0-6) on init
(function qsInitPins() {
  document.addEventListener('DOMContentLoaded', () => {
    ['qs-red-g1','qs-red-g2','qs-blue-g1','qs-blue-g2'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      for (let i = 0; i <= 6; i++) el.innerHTML += `<option value="${i}">${i}</option>`;
    });
    // Restore saved RE token
    loadReToken();
  });
})();

// Populate the event picker when the Lab tab opens
document.addEventListener('tabchange', e => {
  if (e.detail && e.detail.tab === 'experimental') qsPopulateEvents();
});

function qsPopulateEvents() {
  const sel = document.getElementById('qs-event-pick');
  if (!sel) return;
  // Keep existing selection if possible
  const prev = sel.value;
  sel.innerHTML = '<option value="">— pick an event —</option>';
  (typeof calEvents !== 'undefined' ? calEvents : [])
    .filter(ev => ev.re_event_id)
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''))
    .forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.id;
      opt.textContent = ev.name + (ev.start_date ? ' · ' + ev.start_date.slice(0,10) : '');
      sel.appendChild(opt);
    });
  if (prev) sel.value = prev;
}

function qsSaveToken() {
  const v = document.getElementById('qs-re-token')?.value.trim();
  saveRobotEventsToken(v);
}

async function qsFetchMatches() {
  const evId  = document.getElementById('qs-event-pick')?.value;
  const token = getREToken();
  const statusEl = document.getElementById('qs-status');

  if (!evId)  { statusEl.textContent = '⚠ Pick an event first.'; statusEl.style.color = 'var(--red-text)'; return; }
  if (!token) { statusEl.textContent = '⚠ Paste your RobotEvents API token.'; statusEl.style.color = 'var(--red-text)'; return; }

  const ev = (typeof calEventsMap !== 'undefined' ? calEventsMap : new Map()).get(String(evId));
  if (!ev?.re_event_id) { statusEl.textContent = '⚠ Event has no RobotEvents ID — re-sync from RobotEvents.'; statusEl.style.color = 'var(--red-text)'; return; }

  _qsEventId = ev.re_event_id;
  statusEl.textContent = 'Fetching schedule…';
  statusEl.style.color = 'var(--green)';

  try {
    // Route all RE calls through Supabase Edge Function proxy to avoid CORS
    const divData = await reProxyFetch(`/events/${_qsEventId}/divisions`, {}, token);
    const divisions = divData.data || [];

    let allMatches = [];
    for (const div of divisions) {
      let page = 1, lastMeta;
      do {
        const mData = await reProxyFetch(
          `/events/${_qsEventId}/divisions/${div.id}/matches`,
          { per_page: '250', page: String(page) },
          token
        );
        allMatches = allMatches.concat((mData.data || []).map(m => ({ ...m, _divName: div.name })));
        lastMeta = mData.meta;
        page++;
      } while (lastMeta && lastMeta.current_page < lastMeta.last_page);
    }

    // Sort: qual first, then by match number
    allMatches.sort((a, b) => {
      const order = { qual: 0, qf: 1, sf: 2, f: 3 };
      const ra = order[(a.round||'').toLowerCase()] ?? 9;
      const rb = order[(b.round||'').toLowerCase()] ?? 9;
      return ra !== rb ? ra - rb : (a.matchnum||0) - (b.matchnum||0);
    });

    _qsMatches = allMatches;
    _qsMatchIdx = 0;

    // Populate match picker
    const matchSel = document.getElementById('qs-match-pick');
    matchSel.innerHTML = '<option value="">— pick a match —</option>';
    allMatches.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      const red  = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='red');
      const blue = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='blue');
      const rNames = (red?.teams||[]).map(t=>t.team?.name||'?').join(' & ');
      const bNames = (blue?.teams||[]).map(t=>t.team?.name||'?').join(' & ');
      opt.textContent = qsMatchLabel(m) + ' — ' + rNames + ' vs ' + bNames;
      matchSel.appendChild(opt);
    });
    matchSel.disabled = false;
    document.getElementById('qs-match-count').textContent = `(${allMatches.length} matches)`;
    statusEl.textContent = `✓ Loaded ${allMatches.length} matches`;
    statusEl.style.color = 'var(--green)';
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = 'var(--red-text)';
  }
}

function qsMatchLabel(m) {
  const r = (m.round||'').toLowerCase();
  const n = m.matchnum || m.instance || '';
  if (r === 'qual') return 'Q' + n;
  if (r === 'practice') return 'P' + n;
  if (r === 'qf') return 'QF' + (m.instance||'') + '-' + n;
  if (r === 'sf') return 'SF' + (m.instance||'') + '-' + n;
  if (r === 'f')  return 'F' + n;
  return (m.round||'') + n;
}

function qsLoadMatches() {
  // When event changes, reset match picker
  const matchSel = document.getElementById('qs-match-pick');
  matchSel.innerHTML = '<option value="">— pick a match —</option>';
  matchSel.disabled = true;
  _qsMatches = [];
  document.getElementById('qs-forms').style.display = 'none';
  document.getElementById('qs-match-count').textContent = '';
  document.getElementById('qs-status').textContent = 'Click "Load Schedule" to fetch matches.';
  document.getElementById('qs-status').style.color = 'var(--ink3)';
}

function qsFillTeams() {
  const idx = parseInt(document.getElementById('qs-match-pick')?.value);
  if (isNaN(idx) || !_qsMatches[idx]) { document.getElementById('qs-forms').style.display = 'none'; return; }
  _qsMatchIdx = idx;
  const m = _qsMatches[idx];
  const red  = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='red');
  const blue = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='blue');
  const redTeam  = (red?.teams||[])[0]?.team?.name || '';
  const blueTeam = (blue?.teams||[])[0]?.team?.name || '';

  document.getElementById('qs-red-team').value  = redTeam.toUpperCase();
  document.getElementById('qs-blue-team').value = blueTeam.toUpperCase();
  // Reset fields
  ['qs-red-g1','qs-red-g2','qs-blue-g1','qs-blue-g2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
  ['qs-red-awp','qs-blue-awp'].forEach(id => { const el = document.getElementById(id); if (el) el.value = 'N'; });
  ['qs-red-failed','qs-blue-failed'].forEach(id => { const el = document.getElementById(id); if (el) el.value = 'N'; });
  ['qs-red-notes','qs-blue-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['qs-red-msg','qs-blue-msg'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });

  document.getElementById('qs-match-label').textContent = qsMatchLabel(m) + ' — ' + redTeam + ' vs ' + blueTeam;
  document.getElementById('qs-forms').style.display = 'block';
}

function qsNextMatch() {
  const matchSel = document.getElementById('qs-match-pick');
  const next = _qsMatchIdx + 1;
  if (next < _qsMatches.length) {
    matchSel.value = next;
    qsFillTeams();
  } else {
    showToast('Last match reached — no more matches.', 'info', 2500);
  }
}

async function qsSaveEntry(side) {
  if (!isAdmin) { showToast('Admin login required to save entries.', 'err', 2500); return; }
  const m    = _qsMatches[_qsMatchIdx];
  const evEl = document.getElementById('qs-event-pick');
  const evName = evEl?.options[evEl.selectedIndex]?.text?.split(' · ')[0] || '';
  const round  = m ? qsMatchLabel(m) : '';

  const team   = document.getElementById(`qs-${side}-team`)?.value.trim().toUpperCase();
  if (!team) { showToast('Team # required', 'err', 2000); return; }
  const g1     = document.getElementById(`qs-${side}-g1`)?.value || '0';
  const g2     = document.getElementById(`qs-${side}-g2`)?.value || '0';
  const awp    = document.getElementById(`qs-${side}-awp`)?.value || 'N';
  const failed = document.getElementById(`qs-${side}-failed`)?.value || 'N';
  const notes  = document.getElementById(`qs-${side}-notes`)?.value.trim();
  const sideCode = side === 'red' ? 'R' : 'B';

  const entry = {
    id: crypto.randomUUID(),
    team, event: evName, round, side: sideCode,
    sig: 'no', type: 'Unknown',
    route: 'Normal',
    pins: g1 + '+' + g2,
    maxpins: '', bonuses: 0,
    awp, failed, notes,
    ts: new Date().toISOString()
  };

  const msgEl = document.getElementById(`qs-${side}-msg`);
  msgEl.style.color = 'var(--ink3)';
  msgEl.textContent = 'Saving…';

  try {
    const r = await fetch(SB_URL + '/rest/v1/entries', {
      method: 'POST',
      headers: { ...adminHdrs(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(entry)
    });
    if (r.ok) {
      allEntries.unshift(entry);
      setAllTeams(buildStats(allEntries));
      msgEl.style.color = 'var(--green)';
      msgEl.textContent = '✓ Saved ' + team;
      showToast('✓ Saved ' + team, 'ok', 2000);
    } else {
      msgEl.style.color = 'var(--red-text)';
      msgEl.textContent = 'Error ' + r.status;
    }
  } catch (e) {
    msgEl.style.color = 'var(--red-text)';
    msgEl.textContent = 'Network error';
  }
}

async function qsSaveBoth() {
  await qsSaveEntry('red');
  await qsSaveEntry('blue');
}

/* ═══════════════════════════════════════════════════════
   🧪 EXPERIMENTAL LAB — ALLIANCE DRAFT SIMULATOR
   Step-through alliance selection just like at competition.
   Seeds pick in order (1→N), then N→1 for 2nd picks.
════════════════════════════════════════════════════════ */

let _adsSeeds    = [];    // ordered seed team numbers
let _adsPicked   = [];    // flat list of picks in order: [{seed, partner, round, action, snapshot}]
let _adsAlliances = [];   // array of {seed, partners:[]} — grows as picks come in
let _adsDeclined = [];    // list of teams that have declined
let _adsDone     = false;

function adsAutoFill() {
  // Pull top N teams from leaderboard by avg_pins desc
  const n = parseInt(document.getElementById('ads-num-alliances')?.value) || 8;
  const top = (allTeams || []).slice().sort((a,b) => parseFloat(b.avg_pins||0) - parseFloat(a.avg_pins||0)).slice(0, n);
  document.getElementById('ads-seeds').value = top.map(t => t.team).join(', ');
  showToast('Auto-filled ' + top.length + ' seeds from leaderboard', 'ok', 2000);
}

function adsLoadTestTeams() {
  const testTeams = [];
  for (let i = 1; i <= 40; i++) {
    testTeams.push({
      team: i + (i % 2 === 0 ? 'A' : 'Z'),
      count: 6,
      avg_pins: (Math.random() * 8 + 2).toFixed(1),
      awp_pct: (Math.random() * 100).toFixed(0),
      success_pct: (Math.random() * 100).toFixed(0)
    });
  }
  testTeams.sort((a,b) => b.avg_pins - a.avg_pins);
  window.allTeams = testTeams;
  if (typeof setAllTeams === 'function') setAllTeams(testTeams);
  adsAutoFill();
  showToast('Loaded 40 test teams!', 'ok', 2000);
}

function adsReset() {
  _adsSeeds = []; _adsPicked = []; _adsAlliances = []; _adsDeclined = []; _adsDone = false;
  document.getElementById('ads-board').style.display = 'none';
  document.getElementById('ads-complete-banner').style.display = 'none';
  document.getElementById('ads-pick-input').value = '';
  document.getElementById('ads-undo-btn').disabled = true;
}

function adsStart() {
  const raw = document.getElementById('ads-seeds')?.value || '';
  const seeds = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (seeds.length < 2) { showToast('Enter at least 2 seed teams.', 'err', 2500); return; }

  _adsSeeds = seeds;
  _adsPicked = [];
  _adsDeclined = [];
  _adsDone = false;
  _adsAlliances = seeds.map(s => ({ seed: s, partners: [] }));

  document.getElementById('ads-board').style.display = 'block';
  document.getElementById('ads-complete-banner').style.display = 'none';
  document.getElementById('ads-undo-btn').disabled = true;
  adsRenderBoard();
  adsAdvance();
}

function adsCurrentPickInfo() {
  const n = _adsSeeds.length;
  for (let i = 0; i < n; i++) {
    if (_adsAlliances[i].partners.length === 0) {
       return { seedIdx: i, round: 1, label: 'Round 1 — Pick a Partner' };
    }
  }
  return null;
}

function adsAdvance() {
  const info = adsCurrentPickInfo();
  if (!info) {
    // All picks done
    _adsDone = true;
    document.getElementById('ads-pick-banner').style.display = 'none';
    document.getElementById('ads-complete-banner').style.display = 'block';
    document.getElementById('ads-pick-input').disabled = true;
    document.querySelector('[onclick="adsConfirmPick()"]').disabled = true;
    document.getElementById('ads-decline-btn').disabled = true;
    return;
  }

  const currentSeed = _adsSeeds[info.seedIdx];
  const myTeam = document.getElementById('ads-my-team')?.value.trim().toUpperCase();
  const isMe = currentSeed === myTeam;

  document.getElementById('ads-current-picker').textContent = currentSeed + (isMe ? ' 👈 YOU' : '');
  document.getElementById('ads-current-picker').style.color = isMe ? 'var(--amber)' : 'var(--ink)';
  document.getElementById('ads-pick-description').textContent = `Seed #${info.seedIdx + 1} · ${info.label}`;
  const pickNumber = _adsPicked.filter(p => p.action === 'accept').length + 1;
  document.getElementById('ads-pick-number').textContent = pickNumber;
  document.getElementById('ads-pick-input').value = '';
  document.getElementById('ads-pick-input').disabled = false;
  document.getElementById('ads-pick-input').focus();
  document.querySelector('[onclick="adsConfirmPick()"]').disabled = false;
  document.getElementById('ads-decline-btn').disabled = false;

  // Show all available teams in a scrollable list (excluding accepted partners, current seed, and declined teams)
  const accepted = _adsPicked.filter(p => p.action === 'accept').map(p => p.partner);
  const taken = new Set([currentSeed, ...accepted, ..._adsDeclined]);
  const available = (allTeams || []).filter(t => !taken.has(t.team));
  const sorted = available.slice().sort((a,b) => alScore(b) - alScore(a));
  const maxScore = alScore(sorted[0] || {}) || 1;

  document.getElementById('ads-suggestions').style.maxHeight = '300px';
  document.getElementById('ads-suggestions').style.overflowY = 'auto';
  document.getElementById('ads-suggestions').innerHTML = sorted.length
    ? sorted.map((t, i) => {
        const pct = Math.round(alScore(t) / maxScore * 100);
        const rankMedal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<span style="font-size:11px;color:var(--ink3)">#${i+1}</span>`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;margin-bottom:6px"
          onclick="document.getElementById('ads-pick-input').value='${t.team}';document.getElementById('ads-pick-input').focus()">
          <span style="font-size:14px;width:20px;text-align:center">${rankMedal}</span>
          <div style="flex:1">
            <div style="font-family:var(--mono);font-weight:700;font-size:13px;color:var(--ink)">${esc(t.team)}</div>
            <div style="font-size:10px;font-family:var(--mono);color:var(--ink3)">${t.count} matches · Avg ${parseFloat(t.avg_pins).toFixed(1)} pins · AWP ${(parseFloat(t.awp_pct)||0).toFixed(0)}%</div>
          </div>
          <div style="font-family:var(--mono);font-weight:700;font-size:13px;color:${pct>=70?'var(--green)':pct>=40?'var(--amber)':'var(--ink3)'}">${pct}%</div>
        </div>`;
      }).join('')
    : '<div class="empty" style="padding:12px">No available teams in database.</div>';
}

function adsConfirmPick() {
  if (_adsDone) return;
  const info = adsCurrentPickInfo();
  if (!info) return;

  const pick = document.getElementById('ads-pick-input')?.value.trim().toUpperCase();
  if (!pick) { showToast('Enter a team number.', 'err', 1500); return; }

  const currentSeed = _adsSeeds[info.seedIdx];
  const accepted = _adsPicked.filter(p => p.action === 'accept').map(p => p.partner);

  if (pick === currentSeed) { showToast('Cannot pick yourself.', 'err', 2500); return; }
  if (accepted.includes(pick)) { showToast(pick + ' has already been picked.', 'err', 2500); return; }
  if (_adsDeclined.includes(pick)) { showToast(pick + ' has already declined and cannot be picked.', 'err', 2500); return; }

  const pickSeedIdx = _adsSeeds.indexOf(pick);

  // Save state for undo
  const snapshot = {
    seeds: [..._adsSeeds],
    alliances: JSON.parse(JSON.stringify(_adsAlliances)),
    declined: [..._adsDeclined]
  };

  _adsPicked.push({ seed: currentSeed, partner: pick, action: 'accept', snapshot });

  // Add to the seed's alliance
  const al = _adsAlliances.find(a => a.seed === currentSeed);
  if (al) al.partners.push(pick);

  // If pick was another seed captain, merge and shift seeds
  if (pickSeedIdx !== -1) {
    _adsSeeds.splice(pickSeedIdx, 1);
    _adsAlliances.splice(pickSeedIdx, 1);
    
    // Pull a new seed from leaderboard to replace
    const takenForSeed = new Set([..._adsSeeds, ..._adsPicked.filter(p => p.action === 'accept').map(p => p.partner)]);
    const available = (allTeams || []).slice().sort((a,b) => parseFloat(b.avg_pins||0) - parseFloat(a.avg_pins||0));
    
    let newSeed = null;
    for (const t of available) {
      if (!takenForSeed.has(t.team)) {
        newSeed = t.team;
        break;
      }
    }
    if (newSeed) {
      _adsSeeds.push(newSeed);
      _adsAlliances.push({ seed: newSeed, partners: [] });
    }
  }

  document.getElementById('ads-undo-btn').disabled = false;
  adsRenderBoard();
  adsAdvance();
}

function adsDeclinePick() {
  if (_adsDone) return;
  const info = adsCurrentPickInfo();
  if (!info) return;

  const pick = document.getElementById('ads-pick-input')?.value.trim().toUpperCase();
  if (!pick) { showToast('Enter a team number to decline.', 'err', 1500); return; }

  const currentSeed = _adsSeeds[info.seedIdx];
  const accepted = _adsPicked.filter(p => p.action === 'accept').map(p => p.partner);

  if (pick === currentSeed) { showToast('Cannot decline yourself.', 'err', 2500); return; }
  if (accepted.includes(pick)) { showToast(pick + ' has already been picked.', 'err', 2500); return; }
  if (_adsDeclined.includes(pick)) { showToast(pick + ' has already declined.', 'err', 2500); return; }

  const snapshot = {
    seeds: [..._adsSeeds],
    alliances: JSON.parse(JSON.stringify(_adsAlliances)),
    declined: [..._adsDeclined]
  };

  _adsPicked.push({ seed: currentSeed, partner: pick, action: 'decline', snapshot });
  _adsDeclined.push(pick);

  document.getElementById('ads-undo-btn').disabled = false;
  adsRenderBoard();
  adsAdvance();
}

function adsUndoPick() {
  if (!_adsPicked.length) return;
  const last = _adsPicked.pop();
  
  // Restore from snapshot
  _adsSeeds = last.snapshot.seeds;
  _adsAlliances = last.snapshot.alliances;
  _adsDeclined = last.snapshot.declined;
  
  _adsDone = false;
  document.getElementById('ads-complete-banner').style.display = 'none';
  document.getElementById('ads-pick-banner').style.display = 'flex';
  document.getElementById('ads-undo-btn').disabled = _adsPicked.length === 0;
  adsRenderBoard();
  adsAdvance();
}

/* ════════════════════════════════════════════════════════
   ROBOTEVENTS MATCH IMPORT → OPENSKILL LEADERBOARD
   Fetches scored matches for a chosen event and inserts
   one entry per team per match into the Supabase entries
   table. Duplicates are skipped via a generated stable ID.

   ⚠ MIGRATION REQUIRED — run once in Supabase SQL editor:
   alter table entries add column if not exists re_import_id text;
   create unique index if not exists entries_re_import_id_idx on entries(re_import_id) where re_import_id is not null;
════════════════════════════════════════════════════════ */

// Populate the event dropdown with only events that have a re_event_id
function lbReImportPopulateEvents() {
  const sel = document.getElementById('lb-re-import-event');
  if (!sel) return;
  sel.innerHTML = '<option value="">— select event —</option>';
  (calEvents || [])
    .filter(e => e.re_event_id)
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''))
    .forEach(e => {
      const opt = document.createElement('option');
      opt.value = String(e.re_event_id);
      opt.dataset.name = e.name || '';
      opt.textContent = (e.name || 'Unnamed') + ' (' + (e.start_date || '?') + ')';
      sel.appendChild(opt);
    });
  // Also sync token field
  const tok = getREToken();
  const inp = document.getElementById('lb-re-import-token');
  if (inp && tok) inp.value = tok;
}

// Route all external fetches through Supabase re-proxy edge function to avoid CORS
const EVEX_API = 'https://events.vex.com/api/v2';
const RE_PROXY_URL = SB_URL + '/functions/v1/re-proxy';

async function proxyFetch(url, token, asText = false) {
  const headers = { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY };
  if (token) headers['x-re-token'] = token;
  const r = await fetch(RE_PROXY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Proxy error HTTP ' + r.status + (txt ? ': ' + txt.slice(0, 120) : ''));
  }
  return asText ? r.text() : r.json();
}

async function reProxyFetch(path, params, token) {
  let qs = '';
  if (params) Object.entries(params).forEach(([k, v]) => { qs += (qs ? '&' : '') + encodeURIComponent(k) + '=' + encodeURIComponent(String(v)); });
  // Try events.vex.com first, fall back to robotevents.com with token
  const evexUrl = EVEX_API + path + (qs ? '?' + qs : '');
  try {
    const data = await proxyFetch(evexUrl, null);
    if (data && !data.error) return data;
  } catch(e) { /* fall through */ }
  const reUrl = RE_API + path + (qs ? '?' + qs : '');
  return proxyFetch(reUrl, token);
}

// Scrape the events.vex.com team profile HTML page to get full history
async function scrapeEvexTeamPage(teamNum) {
  const url = `https://events.vex.com/teams/V5RC/${encodeURIComponent(teamNum)}`;
  const html = await proxyFetch(url, null, true);
  if (!html || html.length < 500) throw new Error('Could not load team page from events.vex.com');
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const result = { rankings: [], awards: [], matches: [], skills: [] };

  // ── Rankings: table#rankings rows ──
  // Each card has a card-header (season name) and table#rankings
  doc.querySelectorAll('.card').forEach(card => {
    const seasonName = card.querySelector('.card-header')?.textContent?.trim() || '';

    // Rankings table
    const rankTable = card.querySelector('table#rankings');
    if (rankTable) {
      rankTable.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return;
        const eventLink = cells[0].querySelector('a');
        const eventName = eventLink?.textContent?.trim() || cells[0].textContent.trim();
        const eventHref = eventLink?.href || '';
        const skuMatch = eventHref.match(/RE-V5RC-[\w-]+/);
        result.rankings.push({
          season: seasonName,
          eventName,
          sku: skuMatch ? skuMatch[0] : '',
          rank: parseInt(cells[1]?.textContent) || 0,
          wins: parseInt(cells[2]?.textContent) || 0,
          losses: parseInt(cells[3]?.textContent) || 0,
          ties: parseInt(cells[4]?.textContent) || 0,
          wpasp: cells[5]?.textContent?.trim() || '',
        });
      });
    }

    // Awards table
    const awardTable = card.querySelector('table:not(#rankings)');
    if (awardTable && awardTable.querySelectorAll('th').length >= 1) {
      // Check if it looks like an awards table
      const headers = [...awardTable.querySelectorAll('th')].map(th => th.textContent.trim().toLowerCase());
      if (headers.some(h => h.includes('award'))) {
        // Get event name from card header link or text above table
        const eventHeader = card.querySelector('h4, h5, .event-header, [class*="header"] a');
        const evName = eventHeader?.textContent?.trim() || seasonName;
        awardTable.querySelectorAll('tbody tr').forEach(row => {
          const cells = row.querySelectorAll('td');
          if (!cells.length) return;
          result.awards.push({
            season: seasonName,
            eventName: evName,
            title: cells[0]?.textContent?.trim() || '',
            qualifiesFor: cells[1]?.textContent?.trim() || '',
          });
        });
      }
    }
  });

  // ── Matches: table#matches or similar ──
  doc.querySelectorAll('table').forEach(table => {
    const headers = [...table.querySelectorAll('th')].map(th => th.textContent.trim().toLowerCase());
    if (!headers.some(h => h.includes('qualifier') || h.includes('match') || h.includes('round'))) {
      // Try detecting match rows by structure (match name + time + teams + score)
      const firstRow = table.querySelector('tbody tr');
      if (!firstRow) return;
      const cells = firstRow.querySelectorAll('td');
      if (cells.length < 4) return;
    }
    // Find season from nearest card-header
    const card = table.closest('.card');
    const seasonName = card?.querySelector('.card-header')?.textContent?.trim() || '';
    table.querySelectorAll('tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) return;
      const matchName = cells[0]?.textContent?.trim();
      if (!matchName || matchName.length > 30) return; // skip non-match rows
      result.matches.push({
        season: seasonName,
        match: matchName,
        time: cells[1]?.textContent?.trim() || '',
        raw: [...cells].map(c => c.textContent.trim()),
      });
    });
  });

  return result;
}

// Called when user clicks "Import Matches"
let _reImportPending = null; // { entries[], eventName }
async function importMatchesFromRE() {
  if (!isAdmin) return;
  const sel  = document.getElementById('lb-re-import-event');
  const eid  = sel?.value;
  const ename = sel?.options[sel.selectedIndex]?.dataset.name || eid;
  const msg  = document.getElementById('lb-re-import-msg');
  const prev = document.getElementById('lb-re-import-preview');

  function setMsg(t, type) {
    if (!msg) return;
    msg.textContent = t;
    msg.style.color = type === 'err' ? 'var(--red-text)' : type === 'ok' ? 'var(--green)' : 'var(--ink3)';
  }

  if (!eid) { setMsg('\u26a0 Select an event first.', 'err'); return; }
  const token = getREToken();
  if (!token) { setMsg('\u26a0 Paste your RobotEvents API token first.', 'err'); return; }

  prev.style.display = 'none';
  setMsg('Fetching divisions…', '');

  try {
    // 1. Get divisions (via Supabase proxy — avoids CORS)
    const divData = await reProxyFetch(`/events/${eid}/divisions`, {}, token);
    const divisions = divData.data || [];
    if (!divisions.length) { setMsg('No divisions found for this event.', 'err'); return; }

    // 2. Fetch all matches across all divisions (via proxy)
    let allMatches = [];
    for (const div of divisions) {
      let page = 1, lastMeta;
      do {
        setMsg(`Fetching matches — division "${div.name}", page ${page}…`, '');
        const mData = await reProxyFetch(
          `/events/${eid}/divisions/${div.id}/matches`,
          { per_page: '250', page: String(page) },
          token
        );
        allMatches = allMatches.concat((mData.data || []).map(m => ({ ...m, _divName: div.name })));
        lastMeta = mData.meta;
        page++;
      } while (lastMeta && lastMeta.current_page < lastMeta.last_page);
    }

    // 3. Filter to scored matches only
    const scored = allMatches.filter(m => m.scored === true || (m.alliances || []).some(a => a.score > 0));
    if (!scored.length) {
      setMsg(`Fetched ${allMatches.length} matches — none scored yet. Try again after the event.`, 'err');
      return;
    }

    // 4. Build entries — one per team per match
    // Stable dedup ID: "re_match_{event_id}_{match_id}_{teamName}"
    const existingImportIds = new Set(
      (allEntries || []).filter(e => e.re_import_id).map(e => e.re_import_id)
    );

    const newEntries = [];
    for (const m of scored) {
      const roundLabel = formatMatchLabel(m);
      const redA  = (m.alliances || []).find(a => (a.color || '').toLowerCase() === 'red');
      const blueA = (m.alliances || []).find(a => (a.color || '').toLowerCase() === 'blue');
      if (!redA || !blueA) continue;

      const redScore  = redA.score  || 0;
      const blueScore = blueA.score || 0;
      const redWon  = redScore  > blueScore;
      const blueWon = blueScore > redScore;

      // Red alliance teams
      for (const t of (redA.teams || [])) {
        const teamName = (t.team?.name || t.teamName || '').toUpperCase().trim();
        if (!teamName) continue;
        const rid = `re_match_${eid}_${m.id}_${teamName}`;
        if (existingImportIds.has(rid)) continue;
        newEntries.push({
          id: crypto.randomUUID(),
          re_import_id: rid,
          team: teamName,
          event: ename,
          round: roundLabel,
          side: 'R',
          sig: 'no',
          type: 'Unknown',
          route: 'Normal',
          pins: redScore + '+0',
          maxpins: '',
          bonuses: 0,
          awp: redWon ? 'Y' : 'N',
          failed: 'N',
          notes: 'Auto-imported from RobotEvents',
          ts: m.started || new Date().toISOString(),
        });
      }
      // Blue alliance teams
      for (const t of (blueA.teams || [])) {
        const teamName = (t.team?.name || t.teamName || '').toUpperCase().trim();
        if (!teamName) continue;
        const rid = `re_match_${eid}_${m.id}_${teamName}`;
        if (existingImportIds.has(rid)) continue;
        newEntries.push({
          id: crypto.randomUUID(),
          re_import_id: rid,
          team: teamName,
          event: ename,
          round: roundLabel,
          side: 'B',
          sig: 'no',
          type: 'Unknown',
          route: 'Normal',
          pins: blueScore + '+0',
          maxpins: '',
          bonuses: 0,
          awp: blueWon ? 'Y' : 'N',
          failed: 'N',
          notes: 'Auto-imported from RobotEvents',
          ts: m.started || new Date().toISOString(),
        });
      }
    }

    if (!newEntries.length) {
      setMsg(`✓ All ${scored.length} scored matches already imported — nothing new.`, 'ok');
      return;
    }

    // Store pending and show preview
    _reImportPending = { entries: newEntries, eventName: ename };
    const prevText = document.getElementById('lb-re-import-preview-text');
    if (prevText) {
      prevText.textContent =
        `Ready to import ${newEntries.length} new entries from ${scored.length} scored match${scored.length !== 1 ? 'es' : ''} ` +
        `(${[...new Set(newEntries.map(e => e.team))].length} unique teams). ` +
        `Existing entries are not modified.`;
    }
    prev.style.display = 'block';
    setMsg(`Found ${scored.length} scored matches → ${newEntries.length} new entries to add.`, 'ok');

  } catch (e) {
    setMsg('Error: ' + e.message, 'err');
    console.error('RE match import error:', e);
  }
}

async function confirmImportMatches() {
  if (!isAdmin || !_reImportPending) return;
  const { entries } = _reImportPending;
  const msg  = document.getElementById('lb-re-import-msg');
  const prev = document.getElementById('lb-re-import-preview');

  function setMsg(t, type) {
    if (!msg) return;
    msg.textContent = t;
    msg.style.color = type === 'err' ? 'var(--red-text)' : type === 'ok' ? 'var(--green)' : 'var(--ink3)';
  }

  prev.style.display = 'none';
  setMsg('Pushing ' + entries.length + ' entries to Supabase…', '');

  // Batch in chunks of 100 (Supabase PostgREST handles array inserts fine)
  const CHUNK = 100;
  let pushed = 0, failed = 0;
  try {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      setMsg(`Pushing ${Math.min(i + CHUNK, entries.length)} / ${entries.length}…`, '');
      const r = await fetch(SB_URL + '/rest/v1/entries', {
        method: 'POST',
        headers: { ...adminHdrs(), 'Prefer': 'return=minimal' },
        body: JSON.stringify(chunk),
      });
      if (r.ok) {
        pushed += chunk.length;
        // Add to local allEntries
        chunk.forEach(e => allEntries.unshift(e));
      } else {
        failed += chunk.length;
        console.warn('Chunk push failed:', r.status, await r.text());
      }
    }

    setAllTeams(buildStats(allEntries));
    setSyncStatus('ok', allTeams.length + ' teams · ' + allEntries.length + ' entries');
    renderLog();
    lbApplyFilter(lbActiveF);
    _reImportPending = null;

    const msg2 = failed
      ? `✓ Imported ${pushed} entries (${failed} failed — check console).`
      : `✓ Imported ${pushed} entries from ${_reImportPending?.eventName || 'event'}. Leaderboard updated.`;
    setMsg(failed
      ? `✓ Imported ${pushed} entries (${failed} failed — check console).`
      : `✓ Imported ${pushed} entries. Leaderboard updated.`, failed ? 'err' : 'ok');
    showToast('Imported ' + pushed + ' match entries', 'ok');

  } catch (e) {
    setMsg('Push error: ' + e.message, 'err');
    console.error('RE import push error:', e);
  }
}

function adsRenderBoard() {
  const myTeam = document.getElementById('ads-my-team')?.value.trim().toUpperCase();
  const n = _adsAlliances.length;
  document.getElementById('ads-alliance-grid').innerHTML = _adsAlliances.map((al, i) => {
    const isMe = al.seed === myTeam || al.partners.includes(myTeam);
    const info = adsCurrentPickInfo();
    const isCurrent = !_adsDone && info && _adsSeeds[info.seedIdx] === al.seed;
    return `<div style="
      border-radius:var(--radius-lg);padding:10px 12px;
      border:2px solid ${isCurrent ? 'var(--blue)' : isMe ? 'var(--amber)' : 'var(--border)'};
      background:${isCurrent ? 'var(--blue-bg)' : isMe ? 'var(--amber-bg)' : 'var(--surface)'};
      position:relative">
      <div style="font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${isCurrent?'var(--blue)':isMe?'var(--amber)':'var(--ink3)'};margin-bottom:4px">
        Seed ${i+1}${isCurrent?' · Picking…':''}
      </div>
      <div style="font-family:var(--mono);font-weight:800;font-size:14px;color:var(--ink);margin-bottom:4px">${esc(al.seed)}${al.seed===myTeam?' 👈':''}</div>
      ${al.partners.map(p => `<div style="font-family:var(--mono);font-size:12px;color:var(--ink2);padding:2px 0">+ ${esc(p)}${p===myTeam?' 👈':''}</div>`).join('')}
      ${al.partners.length === 0 ? '<div style="font-size:10px;color:var(--ink3);font-family:var(--mono);font-style:italic">No partner yet</div>' : ''}
    </div>`;
  }).join('');
}
