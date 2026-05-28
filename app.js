/* ═══════════════════════════════════════════════════════
   CONFIGURATION — set your admin password and Supabase keys
════════════════════════════════════════════════════════ */
// ─────────────────────────────────────────────────────────────────
// SB_URL: the web address of your Supabase project.
// SB_KEY: the public "anon" key — safe to expose, read-only by default.
// adminHdrs(): builds headers using your JWT token for write operations.
// ─────────────────────────────────────────────────────────────────
const SB_URL = 'https://ajymmthxmdyhkiynwhuf.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqeW1tdGh4bWR5aGtpeW53aHVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTcwNjcsImV4cCI6MjA5MzQ5MzA2N30.AJO6Espsp9ceY3gbnjwAf2k4G3pygwkDejIZxMktZso';
/* ═══════════════════════════════════════════════════════
   SUPABASE TABLE REQUIRED — run once in SQL editor:

   create table if not exists robot_types (
     id   serial primary key,
     name text not null unique
   );
   -- Allow anyone to read, only authenticated users to insert:
   alter table robot_types enable row level security;
   create policy "public read"  on robot_types for select using (true);
   create policy "admin insert" on robot_types for insert with check (auth.role() = 'authenticated');

   -- Seed default types:
   insert into robot_types (name) values ('Claw Bot') on conflict do nothing;
════════════════════════════════════════════════════════ */

// Public read-only headers (anon key — safe to expose)
const HDRS = { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' };

/* ═══════════════════════════════════════════════════════
   CHANGELOG SYNC — Supabase table: ul_changelog
   Run once in Supabase SQL editor to create the table:

   create table if not exists ul_changelog (
     key   text primary key,
     data  jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );
   alter table ul_changelog enable row level security;
   create policy "public read"  on ul_changelog for select using (true);
   create policy "admin upsert" on ul_changelog for insert with check (auth.role() = 'authenticated');
   create policy "admin update" on ul_changelog for update using (auth.role() = 'authenticated');

   The table stores one row (key='state') containing all four
   changelog state objects: edits, vblock_edits, dividers, order.
════════════════════════════════════════════════════════ */

// In-memory changelog state (kept in sync with Supabase + localStorage cache)
window._ulState = {
  edits:        [],   // ul_edits_v1
  vblock_edits: {},   // ul_vblock_edits_v1
  dividers:     {},   // ul_dividers_v1
  order:        null  // ul_order_v1
};
const UL_LS_KEY = 'ul_changelog_v1'; // single localStorage cache key

// Load state from localStorage cache (synchronous, used on boot)
function ulStateLoadCache() {
  try {
    const raw = localStorage.getItem(UL_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        window._ulState = Object.assign({ edits:[], vblock_edits:{}, dividers:{}, order:null }, parsed);
      }
    }
  } catch(e) {}
}

// Save state to localStorage cache
function ulStateSaveCache() {
  try { localStorage.setItem(UL_LS_KEY, JSON.stringify(window._ulState)); } catch(e) {}
}

// Push current state to Supabase (admin only — fire-and-forget with toast on error)
async function ulStatePushSupabase() {
  if (!adminToken) return; // only admins write
  try {
    const res = await fetch(SB_URL + '/rest/v1/ul_changelog', {
      method: 'POST',
      headers: Object.assign({}, adminHdrs(), {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      }),
      body: JSON.stringify({ key: 'state', data: window._ulState, updated_at: new Date().toISOString() })
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn('ul_changelog push failed:', err);
      showToast('Changelog sync failed — saved locally only', 'err', 4000);
    }
  } catch(e) {
    console.warn('ul_changelog push error:', e);
  }
}

// Pull state from Supabase and merge into _ulState + localStorage cache
async function ulStatePullSupabase() {
  try {
    const res = await fetch(SB_URL + '/rest/v1/ul_changelog?key=eq.state&select=data', { headers: HDRS });
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows || !rows.length || !rows[0].data) return;
    const remote = rows[0].data;
    window._ulState = Object.assign({ edits:[], vblock_edits:{}, dividers:{}, order:null }, remote);
    ulStateSaveCache(); // update local cache
    // Re-render if DOM is ready
    if (document.readyState !== 'loading') ulRenderFromState();
  } catch(e) {
    console.warn('ul_changelog pull error:', e);
  }
}

// Save state then push to Supabase (call after every changelog mutation)
function ulStateSave() {
  ulStateSaveCache();
  ulStatePushSupabase(); // async, fire-and-forget
}

// Boot: load from cache immediately, then pull fresh data from Supabase in background
ulStateLoadCache();
document.addEventListener('DOMContentLoaded', function() {
  ulRenderFromState(); // instant render from localStorage cache
});
ulStatePullSupabase().then(function() { ulSeedNewVersions(); }); // async pull — will re-render when done

/* ── ulSeedNewVersions: adds any new hardcoded version blocks that don't yet exist in _ulState.
   This is how new changelog entries get added from code rather than the admin UI. ── */
function ulSeedNewVersions() {
  var state  = window._ulState;
  var edits  = Array.isArray(state.edits) ? state.edits : [];
  var vblocks = state.vblock_edits || {};
  var order  = Array.isArray(state.order) ? state.order : [];
  var changed = false;

  function hasVersion(vid) { return !!vblocks[vid]; }
  function addVersion(vid, num, name, entries) {
    if (hasVersion(vid)) return;
    vblocks[vid] = { num: num, name: name };
    entries.forEach(function(e) { edits.push(e); });
    order.push({ type: 'version', id: vid });
    changed = true;
  }

  // ── v3.1.0 — Changelog Supabase Sync ──
  addVersion('v_seed_310', 'v3.1.0', 'Changelog Supabase Sync', [
    { id: 'e_seed_310_1', tag: 'feat', text: 'Changelog state synced to Supabase <code>ul_changelog</code> table — all edits, version block titles, dividers, and drag order stored as a single JSON row', versionId: 'v_seed_310' },
    { id: 'e_seed_310_2', tag: 'feat', text: 'All four localStorage changelog keys (<code>ul_edits_v1</code>, <code>ul_vblock_edits_v1</code>, <code>ul_dividers_v1</code>, <code>ul_order_v1</code>) consolidated into a single <code>window._ulState</code> object with localStorage as a fast local cache', versionId: 'v_seed_310' },
    { id: 'e_seed_310_3', tag: 'feat', text: 'On every write (add/edit/delete/reorder) state is upserted to Supabase; on page load cache is read instantly then Supabase pulls fresher data in background', versionId: 'v_seed_310' },
    { id: 'e_seed_310_4', tag: 'feat', text: '<strong>⬆ Sync to Supabase</strong> admin button added to Update Log header — seeds the table from current DOM state on first run', versionId: 'v_seed_310' },
  ]);

  // ── v3.2.0 — Changelog rendered from Supabase ──
  addVersion('v_seed_320', 'v3.2.0', 'Changelog Rendered from Supabase', [
    { id: 'e_seed_320_1', tag: 'arch', text: 'Removed ~260 lines of hardcoded changelog HTML — all version blocks, entries, and dividers now rendered dynamically from <code>_ulState</code> via <code>ulRenderFromState()</code>', versionId: 'v_seed_320' },
    { id: 'e_seed_320_2', tag: 'feat', text: 'Page renders instantly from localStorage cache then re-renders after Supabase pull — no blank flash on load', versionId: 'v_seed_320' },
    { id: 'e_seed_320_3', tag: 'fix',  text: 'Fixed <code>buildDividerEl is not defined</code> — divider HTML inlined into <code>ulRenderFromState</code> instead of calling the IIFE-scoped helper', versionId: 'v_seed_320' },
    { id: 'e_seed_320_4', tag: 'fix',  text: 'Fixed illegal return statement at line 3031 — <code>saveUpdates()</code> function declaration was accidentally consumed by a <code>str_replace</code> anchor leaving its body as loose top-level code', versionId: 'v_seed_320' },
    { id: 'e_seed_320_5', tag: 'fix',  text: 'Fixed missing <code>/*</code> opening delimiter on <code>ulSnapshotAndSync</code> comment block causing "Unexpected identifier \'full\'" syntax error', versionId: 'v_seed_320' },
  ]);

  // ── v3.3.0 — Changelog Editor, Drag & Drop, Settings Overhaul, Navigation ──
  addVersion('v_seed_330', 'v3.3.0', 'Editor, Drag & Drop, Settings & Navigation', [
    // Changelog editor
    { id: 'e_seed_330_1',  tag: 'feat', text: '✏ Edit button added to all changelog block types (version headers, entries, subheadings) — previously only some blocks had edit controls', versionId: 'v_seed_330' },
    { id: 'e_seed_330_2',  tag: 'fix',  text: 'Fixed edit buttons disappearing after admin login — <code>ulRenderFromState()</code> re-rendered fresh DOM after the admin-visible sweep, leaving new elements without <code>admin-visible</code>; fixed by re-stamping at end of render', versionId: 'v_seed_330' },
    // Drag & drop
    { id: 'e_seed_330_3',  tag: 'feat', text: 'Drag handles added to version block headers and subheading dividers — previously hidden in left margin at <code>left:-26px</code>, now inline and visible for admins', versionId: 'v_seed_330' },
    { id: 'e_seed_330_4',  tag: 'feat', text: 'Drag handles added to individual entry rows within version blocks — allows reordering entries inside a section via pointer drag', versionId: 'v_seed_330' },
    { id: 'e_seed_330_5',  tag: 'fix',  text: 'Fixed drag system targeting <code>.ul-wrap > .ul-draggable</code> — blocks live inside <code>#ul-dynamic-wrap</code> (grandchild), not direct children; updated <code>getWrapItems</code>, <code>getIndicator</code>, and <code>commitDrop</code>', versionId: 'v_seed_330' },
    { id: 'e_seed_330_6',  tag: 'fix',  text: 'Fixed drag not re-binding after admin login re-render — exposed <code>enableAllDrag</code> as <code>window._ulEnableAllDrag</code> so <code>ulRenderFromState</code> can call it after fresh renders', versionId: 'v_seed_330' },
    // Sticky header
    { id: 'e_seed_330_7',  tag: 'feat', text: 'Tab bar now stays on screen when scrolling — implemented via <code>position:fixed</code> JS approach (<code>pinTabs()</code>) since <code>position:sticky</code> requires an explicit height on the scroll container', versionId: 'v_seed_330' },
    { id: 'e_seed_330_8',  tag: 'fix',  text: 'Fixed <code>pinTabs()</code> not accounting for sidebar width — now reads <code>shellRect.left</code> and sets <code>width:auto</code>; re-pins on resize, tab change, and sidebar toggle', versionId: 'v_seed_330' },
    // URL & keyboard
    { id: 'e_seed_330_9',  tag: 'feat', text: 'URL hash deep linking — switching tabs updates <code>location.hash</code> (e.g. <code>#changelog</code>); hash is restored on page load so shared links open the correct tab', versionId: 'v_seed_330' },
    { id: 'e_seed_330_10', tag: 'feat', text: 'Arrow key navigation — ← / → cycles through visible tabs; ↑ / ↓ pages through the leaderboard when on that tab; keys ignored when typing in inputs', versionId: 'v_seed_330' },
    // Mobile leaderboard
    { id: 'e_seed_330_11', tag: 'feat', text: 'Mobile leaderboard card view — below 640px the table is replaced with tap-friendly cards showing rank, team, robot type, avg pins, matches, and AWP bar; respects my-team and rival highlights', versionId: 'v_seed_330' },
    // Settings overhaul
    { id: 'e_seed_330_12', tag: 'feat', text: 'Settings tab overhauled — added Compact mode, Entries per page, Your team number (gold highlight), Rival teams (red highlight), Auto-refresh interval, Show last synced time, Export CSV/JSON, Refresh banner, Clear cache, Remember admin login, and Reset all', versionId: 'v_seed_330' },
    { id: 'e_seed_330_13', tag: 'feat', text: 'Export to CSV and JSON — downloads full leaderboard with rank, avg pins, AWP rate, success %, robot types, routes, and last scouted date', versionId: 'v_seed_330' },
    { id: 'e_seed_330_14', tag: 'feat', text: 'Refresh banner — when enabled, auto-refresh shows a "New data available" banner instead of silently updating; user chooses when to reload', versionId: 'v_seed_330' },
    { id: 'e_seed_330_15', tag: 'feat', text: 'Remember admin login — optionally persists Supabase JWT to localStorage so admin session survives browser restarts; off by default with a security warning', versionId: 'v_seed_330' },
  ]);

  addVersion('v_seed_340', 'v3.4.0', 'TrueSkill, Normal Distribution &amp; Auton Calc', [
    { id: 'e_seed_340_1', tag: 'feat', text: '🆕 Standard normal CDF (<code>normalCDF</code>) added — Abramowitz &amp; Stegun polynomial approximation (max error &lt; 1.5×10⁻⁷); shared primitive used by TrueSkill win-probability', versionId: 'v_seed_340' },
    { id: 'e_seed_340_2', tag: 'feat', text: 'TrueSkill win probability integrated — <code>P(A beats B) = Φ((μA−μB) / √(2β²+σA²+σB²))</code> using Microsoft TrueSkill formula (β = 25/6); alliance σ pooled as RMS of both robots; data from vrc-data-analysis.com (1,362 Worlds teams)', versionId: 'v_seed_340' },
    { id: 'e_seed_340_3', tag: 'feat', text: 'Fail pin distribution added to auton outcome calculator — each robot can now have an empirical discrete distribution over pin counts on fail (e.g. 60% → 0 pins, 30% → 1 pin, 10% → 2 pins); weights normalised to 100% and each pin count becomes a separate branch in the outcome tree', versionId: 'v_seed_340' },
    { id: 'e_seed_340_4', tag: 'arch', text: 'Win probability model extended — original 16-outcome (2⁴) model preserved; new distribution-aware model added alongside it, expanding fail branches via cartesian product using each robot\'s discrete pin distribution; defaults to 0 pins on fail when no distribution is set', versionId: 'v_seed_340' },
    { id: 'e_seed_340_5', tag: 'feat', text: 'Formulas tab updated — new sections for "Fail pin distribution" (NEW) and "TrueSkill win probability" (NEW); win probability section updated to document the distribution-aware outcome model', versionId: 'v_seed_340' },
  ]);

  addVersion('v_seed_350', 'v3.5.0', 'Auton Calculator Persistence &amp; Distribution Integration', [
    { id: 'e_seed_350_1', tag: 'feat', text: 'Auton calculator team numbers now persist across page reloads and tab switches — stored in <code>localStorage</code> under <code>os_em_teams</code>; values are restored on page load and stats are auto-filled immediately', versionId: 'v_seed_350' },
    { id: 'e_seed_350_2', tag: 'feat', text: 'Clearing the calculator from the schedule modal also wipes the persisted team state, so a manual reset stays reset after reload', versionId: 'v_seed_350' },
    { id: 'e_seed_350_3', tag: 'feat', text: 'Fail pin distribution integrated into auton outcome calculator — each robot can define a discrete empirical distribution over pin counts scored on fail (e.g. 60% → 0 pins, 30% → 1 pin, 10% → 2 pins); weights are normalised to 100% and each pin count becomes its own branch in the cartesian-product outcome tree', versionId: 'v_seed_350' },
    { id: 'e_seed_350_4', tag: 'arch', text: 'Outcome tree expanded from fixed 2⁴ (16 branches) to variable cartesian product — branch count scales with each robot\'s distribution size; falls back to 0-pin fail branch when no distribution is entered, preserving existing behaviour', versionId: 'v_seed_350' },
  ]);

  addVersion('v_seed_360', 'v3.6.0', 'Cross-Block Entry Dragging', [
    { id: 'e_seed_360_1', tag: 'feat', text: 'Changelog entries can now be dragged between version blocks — drag handle detects which <code>.ul-entries</code> container the cursor is over and inserts the entry there, not just within the original block', versionId: 'v_seed_360' },
    { id: 'e_seed_360_2', tag: 'feat', text: 'Drop indicator (blue line) follows the cursor across all version blocks during a drag, hiding on the previous block as the cursor moves to a new one', versionId: 'v_seed_360' },
    { id: 'e_seed_360_3', tag: 'arch', text: '<code>saveUlOrder</code> now also walks every version block after a drop and updates each entry\'s <code>versionId</code> in <code>_ulState.edits</code> to match its current block — persists cross-block moves to Supabase correctly', versionId: 'v_seed_360' },
  ]);

  addVersion('v_seed_370', 'v3.7.0', 'Side-by-Side Calculator View', [
    { id: 'e_seed_370_1', tag: 'feat', text: 'New setting: "Side-by-side calculators" — when enabled, the win probability calculator and auton calculator are shown as a flex row on the Predict tab instead of stacked; automatically opens the auton calculator panel when toggled on', versionId: 'v_seed_370' },
    { id: 'e_seed_370_2', tag: 'feat', text: 'Setting persisted to <code>localStorage</code> under <code>os_calc_sidebyside</code> and restored on page load; resets to off with "Reset all settings"', versionId: 'v_seed_370' },
    { id: 'e_seed_370_3', tag: 'arch', text: 'Layout collapses back to stacked on viewports below 900px so the side-by-side view doesn\'t break on mobile or narrow windows', versionId: 'v_seed_370' },
  ]);

  addVersion('v_seed_380', 'v3.8.0', 'Auton Fail Rate Consistency Fix', [
    { id: 'e_seed_380_1', tag: 'fix', text: 'Auton fail % now matches between the win probability and auton outcome calculators for the same robot — both now compute fail rate from all scouted entries rather than the SAWP-filtered subset, since a failed auton is a failed auton regardless of route mode', versionId: 'v_seed_380' },
    { id: 'e_seed_380_2', tag: 'feat', text: 'Team numbers are now linked across both calculators — typing a team in either the win probability calculator or the auton outcome calculator syncs it to the same slot in the other calculator and triggers autofill in both', versionId: 'v_seed_380' },
    { id: 'e_seed_380_3', tag: 'arch', text: 'Unified team persistence: both calculators now save under the same <code>os_em_teams</code> key (keyed by slot ID r1/r2/b1/b2); on restore, both calculators are populated simultaneously; clear button now also resets win-probability team inputs', versionId: 'v_seed_380' },
  ]);

  addVersion('v_seed_390', 'v3.9.0', 'Auton Rate Field &amp; Alliance AWP Bars', [
    { id: 'e_seed_390_1', tag: 'feat', text: 'Renamed "AWP contrib. %" → "Auton rate %" in the Auton Calculator — the field is now visible and editable for all four robots, auto-filled from the scouting database when a team number is entered', versionId: 'v_seed_390' },
    { id: 'e_seed_390_2', tag: 'feat', text: 'Alliance-wide AWP probability bars added below the outcome bar — two side-by-side progress bars show the probability that 🔴 Red and 🔵 Blue each achieve the AWP condition, derived from the full outcome probability model', versionId: 'v_seed_390' },
    { id: 'e_seed_390_3', tag: 'fix',  text: 'Alliance AWP bars hidden and Auton rate inputs reset to 0 when the calculator is cleared via the schedule modal — prevents stale percentages persisting across matches', versionId: 'v_seed_390' },
  ]);

  addVersion('v_seed_3100', 'v3.10.0', 'UX Overhaul &amp; Analytics Expansion', [
    { id: 'e_seed_3100_1',  tag: 'feat', text: '⌨️ Keyboard shortcuts — <code>T</code> opens quick team search, <code>1</code>–<code>9</code> switch tabs, <code>R</code> refreshes data, <code>C</code> opens team comparison, <code>L</code> jumps to leaderboard, <code>?</code> shows the shortcut help overlay', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_2',  tag: 'feat', text: '🔍 Quick search overlay — floating search bar (<code>T</code> key) with live filtered results, arrow-key navigation, and Enter to jump straight to a team profile without leaving the current tab', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_3',  tag: 'feat', text: '🕐 Search history — the Search tab input now shows a dropdown of recently searched teams on focus; individual entries are clickable to re-search; full history can be cleared in one tap', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_4',  tag: 'feat', text: '⭐ Starred teams — every leaderboard row and team profile has a star button; starred teams appear in a persistent quick-access strip at the top of the leaderboard, stored in <code>localStorage</code> under <code>os_starred_teams</code>', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_5',  tag: 'feat', text: '⚖️ Team comparison modal — accessible via <code>C</code> key or the new Compare button on the leaderboard; enter up to 4 team numbers for a side-by-side table covering avg pins, recent avg, best match, matches, AWP rate, fail rate, consistency, TrueSkill rank &amp; score, and OPR; best values highlighted green, worst red, with proportional fill bars per metric', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_6',  tag: 'feat', text: '📈 Performance sparklines — each leaderboard row now shows a mini trend line under the avg pins value rendered on a canvas element; green when recent performance is improving, red when declining', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_7',  tag: 'feat', text: '📊 Extended stats panel in team search — after searching a team, a 6-cell grid appears with Avg Pins, Best Match, Consistency %, AWP Rate, Matches, and Fail Rate computed live from scouting entries', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_8',  tag: 'feat', text: '📉 Performance trend chart in team search — below the stats grid, a larger canvas chart shows the team\'s recent match-by-match pin trajectory with a trending-up or trending-down label', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_9',  tag: 'feat', text: '📊 Prediction accuracy tracker — Win Probability tab now has "Log Prediction" and "View History" buttons after computing an outcome; past predictions can be resolved (red/blue/tie won) and overall accuracy % is tracked with a visual bar; stored in <code>localStorage</code> under <code>os_pred_history</code>', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_10', tag: 'ux',  text: '⚖️ Compare shortcut in team search results — a small Compare button appears in the team profile panel and pre-fills that team into slot 1 of the comparison modal', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_11', tag: 'arch', text: '<code>drawSparkline(canvas, vals)</code> helper added — lightweight canvas-based line chart renderer shared by leaderboard rows, compare modal, and team trend charts; no external charting library', versionId: 'v_seed_3100' },
    { id: 'e_seed_3100_12', tag: 'arch', text: '<code>window.lbRender</code> patched to inject star buttons, sparkline canvases, and compare triggers into leaderboard rows after each render cycle via a <code>setTimeout(0)</code> pass', versionId: 'v_seed_3100' },
  ]);

  // ── v3.11.0 — Pit Scouting, Match Notes, Alliance Selection & Platform Improvements ──
  addVersion('v_seed_3110', 'v3.11.0', 'Pit Scouting, Match Notes, Alliance Selection &amp; Platform Improvements', [
    { id: 'e_seed_3110_1',  tag: 'feat', text: '🤖 Pit scouting form — dedicated form to record robot specs, drive train type, and autonomous capabilities for each team; data stored alongside match scouting entries', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_2',  tag: 'feat', text: '📝 Match notes — quick freeform text field per match for jotting observations mid-competition; notes are exportable alongside match data', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_3',  tag: 'feat', text: '📤 Export to CSV/JSON — full data export covering all scouting entries, pit notes, and match history; compatible with spreadsheets and offline analysis tools for sharing with alliance partners', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_4',  tag: 'feat', text: '🤝 Alliance selection helper — given your team number and the current pick list, suggests optimal alliance partners from remaining available teams based on TrueSkill rank, avg pins, and auton reliability', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_5',  tag: 'feat', text: '📡 Service Worker / offline mode — app shell and static assets cached via Service Worker so Override Scout loads and functions without internet; essential for competition venues with unreliable Wi-Fi', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_6',  tag: 'feat', text: '🔗 Share via URL — team numbers and match setups encoded into the URL hash so a specific calculator or team profile can be shared as a direct link with alliance partners', versionId: 'v_seed_3110' },
    { id: 'e_seed_3110_7',  tag: 'ux',  text: '📱 Bottom navigation bar on mobile — replaces the collapsing top sidebar on narrow screens with a thumb-friendly bottom nav bar; primary tabs accessible without stretching to the top of the screen', versionId: 'v_seed_3110' },
  ]);

  // ── v3.12.0 — Donation Popup &amp; Per-Team Share Links ──
  addVersion('v_seed_3120', 'v3.12.0', 'Donation Popup &amp; Per-Team Share Links', [
    { id: 'e_seed_3120_1', tag: 'feat', text: '💚 Donation popup — rotating animated banner appears 5 s after launch (for public viewers) linking to the team GoFundMe; cycles through 5 message variants every 30 s; auto-hides after 8 s; dismissable via ✕ button; non-intrusive spring-entry animation; hidden for admin sessions', versionId: 'v_seed_3120' },
    { id: 'e_seed_3120_2', tag: 'feat', text: '🔗 Per-team share button in Alliance Selection — each suggestion card and the full ranking table now has a 🔗 Share button that copies a direct link to that team\'s profile (e.g. <code>#search?team=97230F</code>) to the clipboard via <code>window.shareTeam()</code>; falls back to a <code>prompt()</code> on browsers that deny clipboard access', versionId: 'v_seed_3120' },
    { id: 'e_seed_3120_3', tag: 'ux',  text: 'Donation popup styled with gradient accent bar, spring cubic-bezier entrance, and 8 s auto-dismiss — consistent with existing modal design language and respects both dark and light themes via CSS custom properties', versionId: 'v_seed_3120' },
  ]);

  // ── v3.13.0 — Skills Leaderboard ──
  addVersion('v_seed_3130', 'v3.13.0', 'Skills Leaderboard', [
    { id: 'e_seed_3130_1', tag: 'feat', text: '🎯 New Skills tab — dedicated leaderboard for Autonomous Skills and Driver Skills runs; stores all runs in <code>localStorage</code> under <code>os_skills_v1</code>; accessible from the tab bar, sidebar, and URL hash (<code>#skills</code>)', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_2', tag: 'feat', text: 'Admin log-run form — enter team number, event, run type (auton/driver), score, attempt number, and optional notes; validates required fields and confirms with a toast on save', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_3', tag: 'feat', text: 'Three leaderboard views — <strong>Combined</strong> (best auton + best driver per team), <strong>Auton only</strong>, and <strong>Driver only</strong>; filter chips switch the sort key and column layout in real time', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_4', tag: 'feat', text: 'Summary stats strip — shows total teams, total runs logged, best auton score, and best driver score across all entries; hidden when no data exists', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_5', tag: 'feat', text: 'Per-team run drilldown (admin) — expand button on each leaderboard row reveals a full list of that team\'s individual attempts with type, score, attempt number, event, notes, and a delete button', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_6', tag: 'feat', text: 'CSV export — downloads all logged skills runs with team, type, score, attempt, event, notes, and ISO timestamp columns', versionId: 'v_seed_3130' },
    { id: 'e_seed_3130_7', tag: 'ux',  text: 'Your team (from settings) highlighted in gold on the skills leaderboard; medal emoji for top-3 ranks; proportional score bar under each team name for quick visual comparison', versionId: 'v_seed_3130' },
  ]);

  // ── v3.14.0 — Events Tab UI Redesign ──
  addVersion('v_seed_3140', 'v3.14.0', 'Events Tab UI Redesign', [
    { id: 'e_seed_3140_1', tag: 'ux',  text: '&#128197; Events tab cards redesigned — each event now renders as a standalone card with a coloured left-accent stripe (amber for Sig events, green for live), left-aligned date column showing month abbreviation and day number, and a clean body section with title, meta row, optional notes block, and action buttons', versionId: 'v_seed_3140' },
    { id: 'e_seed_3140_2', tag: 'ux',  text: 'Countdown indicators — upcoming events show a days-away chip (orange when &le;7 days); live events show a pulsing green &ldquo;In progress&rdquo; chip; no chip displayed for far-future or past events', versionId: 'v_seed_3140' },
    { id: 'e_seed_3140_3', tag: 'ux',  text: 'Polished filter strip — country and state selects moved into a unified pill-row with a separator and uppercase labels; event count badge rendered as a rounded pill in the section header rather than plain text', versionId: 'v_seed_3140' },
    { id: 'e_seed_3140_4', tag: 'ux',  text: 'Multi-day date range displayed as e.g. &ldquo;14 &ndash; AUG 17&rdquo; in the date column; single-day events show just the day and month', versionId: 'v_seed_3140' },
  ]);

  // ── v3.14.1 — Events Tab Colour Pass ──
  addVersion('v_seed_3141', 'v3.14.1', 'Events Tab Colour Pass', [
    { id: 'e_seed_3141_1', tag: 'ux', text: 'Upcoming event cards now have a blue-tinted background gradient and blue border by default; Sig/qualifier cards use rich amber tones; live events use vivid green — all three states are immediately distinguishable at a glance', versionId: 'v_seed_3141' },
    { id: 'e_seed_3141_2', tag: 'ux', text: 'Date column redesigned as a coloured pill that inherits the card accent colour (blue/amber/green) rather than a plain separator — month label is now bold and colour-matched', versionId: 'v_seed_3141' },
    { id: 'e_seed_3141_3', tag: 'ux', text: 'Meta-row icons now individually coloured: red pin for location, blue globe for country, purple clipboard for scout entry count; notes block border and background tint also matches the card state colour', versionId: 'v_seed_3141' },
    { id: 'e_seed_3141_4', tag: 'ux', text: 'Filter strip uses a blue gradient wash; event count badge is now blue-tinted; countdown chips use pill border-radius and bolder typography for improved readability', versionId: 'v_seed_3141' },
  ]);

  // ── v3.14.2 — Events Tab Site-Palette Colour Pass ──
  addVersion('v_seed_3142', 'v3.14.2', 'Events Tab Site-Palette Colours', [
    { id: 'e_seed_3142_1', tag: 'ux', text: 'Replaced all blue event card accents with the site\'s native red/volt/amber/green mission-control palette — upcoming events now use a red-volt gradient background and red border matching the scrollbar and primary buttons', versionId: 'v_seed_3142' },
    { id: 'e_seed_3142_2', tag: 'ux', text: 'Left accent stripe on upcoming cards is a red-to-volt gradient; date column pill is red-tinted; month label uses <code>--red-text</code>; filter strip uses a red gradient wash; event count badge is red-tinted', versionId: 'v_seed_3142' },
    { id: 'e_seed_3142_3', tag: 'ux', text: 'Meta icons now use site colours: red pin for location, amber globe for country, volt clipboard for scout count — all consistent with the broader Override Scout design language', versionId: 'v_seed_3142' },
  ]);

  // ── v3.15.0 — Alliance Helper moved into Events tab ──
  addVersion('v_seed_3150', 'v3.15.0', 'Alliance Helper Moved to Events Tab', [
    { id: 'e_seed_3150_1', tag: 'ux', text: '🤝 Alliance Selection Helper relocated from its own top-level tab into the Events tab — appears below the event list and alliance filter cards, keeping competition tooling in one place', versionId: 'v_seed_3150' },
    { id: 'e_seed_3150_2', tag: 'arch', text: 'Standalone Alliance tab and tab button removed; sidebar Alliance Helper nav link now navigates to the Events tab; <code>runAlliance()</code> fires automatically when the Events tab is activated', versionId: 'v_seed_3150' },
  ]);

  addVersion('v_seed_3160', 'v3.16.0', 'Alliance Button on Event Cards', [
    { id: 'e_seed_3160_1', tag: 'ux', text: '🤝 Alliance button added to each event card footer (next to Filter LB) — clicking it scrolls to the Alliance Selection Helper and contextually labels it with the event name, ready to become fully event-specific once match schedules are integrated', versionId: 'v_seed_3160' },
  ]);

  // ── v3.17.0 — TrueSkill Tab UI Consistency ──
  addVersion('v_seed_3170', 'v3.17.0', 'TrueSkill Tab UI Consistency', [
    { id: 'e_seed_3170_1', tag: 'ux', text: '⚡ TrueSkill Rankings tab redesigned to match the Leaderboard hero banner — gradient background with decorative radial glow blobs, Barlow Condensed display title, blue/red/green accent stat cards with top-edge highlight stripes', versionId: 'v_seed_3170' },
    { id: 'e_seed_3170_2', tag: 'ux', text: 'Filter chips (All / ✅ Worlds / Top 100) restyled as a joined pill-group matching the Leaderboard filter bar; search input upgraded to the same focus-ring pill with 🔍 icon and blue focus glow', versionId: 'v_seed_3170' },
  ]);

  // ── v3.18.0 — Pit Scout &amp; Alliance as per-event modals ──
  addVersion('v_seed_3180', 'v3.18.0', 'Pit Scout &amp; Alliance as per-event modals', [
    { id: 'e_seed_3180_1', tag: 'ux', text: '🤖 Pit Scout converted to a modal — opens via a new &#129302; Pit Scout button on each event card footer; automatically labels the modal with the event name and pre-fills the Event field; modal has Form and Log tabs with CSV export', versionId: 'v_seed_3180' },
    { id: 'e_seed_3180_2', tag: 'fix', text: '🤝 Alliance Selection converted to a modal — previously the al-my-team / al-suggestions / al-full-table / al-status elements had no corresponding HTML so runAlliance() was non-functional; both modals share the same dismiss-on-backdrop pattern and modalIn spring animation', versionId: 'v_seed_3180' },
    { id: 'e_seed_3180_3', tag: 'arch', text: 'Standalone Pit Scout tab and tab button removed; edit-entry flow opens the Pit Scout modal directly; <code>renderPitLog()</code> deferred to modal open rather than called at DOMContentLoaded', versionId: 'v_seed_3180' },
  ]);

  // ── v3.20.0 — About Tab Redesign & Panel Bleed Fix ──
  addVersion('v_seed_3200', 'v3.20.0', 'About Tab Redesign &amp; Panel Bleed Fix', [
    { id: 'e_seed_3200_1', tag: 'ux',   text: '⚡ About tab gets a full hero banner matching the rest of the app — gradient background with radial glow blobs, inline SVG lightning bolt logo (eliminates the broken <code>about_logo.png</code> image), large Barlow title "Bot Go Brrr", and pill badges for school, location, and Worlds qualification status', versionId: 'v_seed_3200' },
    { id: 'e_seed_3200_2', tag: 'fix',  text: 'Replaced broken <code>&lt;img src="about_logo.png"&gt;</code> with an inline SVG bolt mark so the logo renders reliably without any external file dependency', versionId: 'v_seed_3200' },
    { id: 'e_seed_3200_3', tag: 'ux',   text: 'About cards refreshed — richer description copy, icon grid for donation costs, hover states on Find Us links, direct team RobotEvents URL, and a new "About this app" card showing version, season, and tech stack', versionId: 'v_seed_3200' },
    { id: 'e_seed_3200_4', tag: 'fix',  text: 'Fixed changelog (and other content) bleeding into the bottom of every tab — root cause was the <code>panelOut</code> exit animation keeping panels <code>display:block</code> while the animation played; on slow renders <code>animationend</code> sometimes never fired, leaving the outgoing panel permanently visible underneath the incoming one. Fix: remove the exit animation entirely and hide the outgoing panel synchronously before activating the incoming panel', versionId: 'v_seed_3200' },
  ]);


  addVersion('v_seed_3190', 'v3.19.0', 'TrueSkill Tab Hero Banner', [
    { id: 'e_seed_3190_1', tag: 'ux', text: '⚡ TrueSkill Rankings tab now has a full hero banner matching the Leaderboard and Skills tabs — gradient background (<code>linear-gradient(160deg,paper2,paper)</code>) with decorative blue/red radial glow blobs, large Barlow Condensed title "VRC Worlds 2026 <strong>TrueSkill</strong> Rankings", and subtitle line', versionId: 'v_seed_3190' },
    { id: 'e_seed_3190_2', tag: 'ux', text: 'Three accent stat cards (Total Teams / Showing / Worlds ✅) in a 3-col grid with blue, red, and green gradient backgrounds and top-edge colour stripes — consistent with the Leaderboard\'s 4-card spotlight strip', versionId: 'v_seed_3190' },
    { id: 'e_seed_3190_3', tag: 'ux', text: 'Filter pills (All / ✅ Worlds / Top 100) redesigned as a joined button group matching the Skills tab style — active filter renders in blue with <code>background:var(--blue);color:#fff</code>; inactive buttons use <code>--paper3</code> background', versionId: 'v_seed_3190' },
    { id: 'e_seed_3190_4', tag: 'ux', text: 'Search input upgraded to a focus-ring pill (matching Leaderboard search bubble) with 🔍 icon prefix, blue focus border, and subtle blue glow shadow; table wrapped in <code>.lb-wrap</code> for consistent border, radius, and hover styling', versionId: 'v_seed_3190' },
  ]);

  // ── v3.21.0 — Settings UI Redesign ──
  addVersion('v_seed_3210', 'v3.21.0', 'Settings UI Redesign', [
    { id: 'e_seed_3210_1', tag: 'ux', text: '⚙️ Settings tab redesigned — flat single-card layout replaced with bordered section cards (Display, Scouting, Sync, Data, Session, About), each with an icon-labelled header and a subtle background divider; rows now have hover states and danger styling for destructive actions', versionId: 'v_seed_3210' },
    { id: 'e_seed_3210_2', tag: 'ux', text: 'Danger rows (Clear cache, Reset all settings) now use red tinted hover backgrounds and red-tinted button borders to signal destructive intent at a glance', versionId: 'v_seed_3210' },
    { id: 'e_seed_3210_3', tag: 'arch', text: 'Settings CSS refactored — removed <code>.theme-toggle</code> dead class, added <code>.settings-page</code>, <code>.settings-section</code>, <code>.settings-section-head</code>, and <code>.settings-footer-note</code> to support the new grouped layout', versionId: 'v_seed_3210' },
  ]);

  // ── v3.22.0 — Settings Tab Hero Banner & Layout ──
  addVersion('v_seed_3220', 'v3.22.0', 'Settings Tab Hero Banner &amp; 2-Column Layout', [
    { id: 'e_seed_3220_1', tag: 'ux', text: '⚙️ Settings tab now has a hero banner matching the Leaderboard, TrueSkill, and About tabs — gradient background (<code>linear-gradient(160deg,paper2,paper)</code>) with decorative red/blue radial glow blobs, large Barlow Condensed title "App <strong>Settings</strong>", and a red-tinted kicker and subtitle line', versionId: 'v_seed_3220' },
    { id: 'e_seed_3220_2', tag: 'ux', text: 'Four accent stat pills in the hero (Version, Season, Data, Built by) using the same red/blue/green/amber gradient card pattern as the Leaderboard spotlight strip — gives the settings page visual weight consistent with other tabs', versionId: 'v_seed_3220' },
    { id: 'e_seed_3220_3', tag: 'ux', text: 'Settings sections now laid out in a 2-column grid (max-width 900px) with the About section spanning full width — fills the available space and removes the "empty right half" feel of the previous single-column 600px layout', versionId: 'v_seed_3220' },
    { id: 'e_seed_3220_4', tag: 'ux', text: 'Preferences note ("saved in your browser — no account required") promoted from the footer of the About section card into the hero banner subtitle for immediate visibility; redundant footer note removed from the section card', versionId: 'v_seed_3220' },
  ]);

  // ── v3.24.0 — RFORCE moved to Lab ──
  addVersion('v_seed_3240', 'v3.24.0', 'RFORCE Rankings Moved to Lab', [
    { id: 'e_seed_3240_1', tag: 'ux', text: '⚡ RFORCE-style rankings section moved from its own top-level tab into the 🧪 Lab tab — consolidates experimental/analytical features in one place', versionId: 'v_seed_3240' },
    { id: 'e_seed_3240_2', tag: 'ux', text: 'RFORCE pill added to the Lab hero banner; sidebar RFORCE link now navigates to the Lab tab', versionId: 'v_seed_3240' },
    { id: 'e_seed_3240_3', tag: 'fix', text: 'Tab-active render trigger updated — RFORCE table now rebuilds correctly when the Lab tab is opened', versionId: 'v_seed_3240' },
  ]);

  // ── v3.25.0 — Test Rankings (OPR/DPR/CCWM/OpenSkill) ──
  addVersion('v_seed_3250', 'v3.25.0', 'Test Rankings — OPR, DPR, CCWM &amp; OpenSkill', [
    { id: 'e_seed_3250_1', tag: 'feat', text: '📊 New "Test Rankings" section added to the Lab tab — computes GaelScout-style metrics (OPR, DPR, CCWM, OpenSkill) from scouted match entries', versionId: 'v_seed_3250' },
    { id: 'e_seed_3250_2', tag: 'feat', text: 'OPR (Offensive Power Rating) = avg pins per entry; DPR (Defensive Power Rating) = avg field output advantage team concedes vs event avg; CCWM = OPR − DPR', versionId: 'v_seed_3250' },
    { id: 'e_seed_3250_3', tag: 'feat', text: 'OpenSkill implemented as a simplified Glicko-style rating (μ=25, σ=8.33) — each entry updates μ based on whether team scored above/below their event average, with σ decaying over time', versionId: 'v_seed_3250' },
    { id: 'e_seed_3250_4', tag: 'ux', text: 'Sortable by any column (OpenSkill default, DPR sorts ascending since lower = better); inline mini-bars on OpenSkill and OPR columns; CCWM colour-coded green/red; recalculate button for manual refresh', versionId: 'v_seed_3250' },
  ]);

  addVersion('v_seed_3260', 'v3.26.0', 'RobotEvents Match Import → Leaderboard', [
    { id: 'e_seed_3260_1', tag: 'feat', text: '⬇ RobotEvents match import — new admin card on the Leaderboard tab fetches all scored matches for a chosen event and bulk-inserts one entry per team per match; leaderboard and OpenSkill ratings update immediately', versionId: 'v_seed_3260' },
    { id: 'e_seed_3260_2b', tag: 'arch', text: 'CORS workaround via Supabase Edge Function (<code>re-proxy</code>) — all RobotEvents API calls route server-side through a Deno proxy deployed to the same Supabase project; token sent in a custom header, never stored', versionId: 'v_seed_3260' },
    { id: 'e_seed_3260_2', tag: 'feat', text: 'Duplicate prevention — each imported entry carries a stable <code>re_import_id</code> (<code>re_match_{eventId}_{matchId}_{team}</code>); re-running the import skips already-present IDs so the same event can be safely re-imported after more matches are scored', versionId: 'v_seed_3260' },
    { id: 'e_seed_3260_3', tag: 'ux', text: 'Two-step confirm flow — import first shows a preview (match count, new entry count, unique teams) then requires explicit confirmation before writing to the database', versionId: 'v_seed_3260' },
    { id: 'e_seed_3260_4', tag: 'arch', text: 'Token field synced via the shared <code>syncReTokenInputs</code> helper — token entered anywhere (Settings, Schedule, Quick Scout, or the new import card) propagates to all inputs automatically', versionId: 'v_seed_3260' },
  ]);

  addVersion('v_seed_3270', 'v3.27.0', 'CORS Fix — All RobotEvents Calls Via Proxy', [
    { id: 'e_seed_3270_1', tag: 'fix', text: '🐛 Fixed CORS failure on all RobotEvents API calls made directly from the browser — <code>syncFromRobotEvents</code> (Events tab sync), <code>reApiFetch</code> (team profiles/rankings/awards/skills), <code>fetchSchedule</code> (event schedule modal), and <code>qsFetchMatches</code> (Quick Scout schedule load) were all hitting <code>robotevents.com</code> directly and being blocked by the browser; these now route through the Supabase <code>re-proxy</code> Edge Function introduced in v3.26.0', versionId: 'v_seed_3270' },
    { id: 'e_seed_3270_2', tag: 'fix', text: 'Fixed <code>reProxyFetch</code> missing the Supabase <code>apikey</code> header — Supabase Edge Functions require the anon key in every request or they return 401 before the function runs; <code>SB_KEY</code> is now included alongside <code>re-token</code>', versionId: 'v_seed_3270' },
    { id: 'e_seed_3270_3', tag: 'fix', text: 'Fixed <code>reProxyFetch</code> double-encoding path slashes — <code>URL.searchParams.set</code> percent-encodes slashes in the path value so the Edge Function received <code>%2Fevents%2F123</code> instead of <code>/events/123</code>, causing HTTP 404 from RobotEvents; query string now built manually with <code>encodeURIComponent</code>', versionId: 'v_seed_3270' },
    { id: 'e_seed_3270_4', tag: 'arch', text: '<code>reProxyFetch</code> simplified to call RobotEvents directly — RobotEvents allows CORS GET requests from HTTP origins; the Supabase Edge Function proxy is no longer required and has been removed from the call path', versionId: 'v_seed_3270' },
  ]);

  addVersion('v_seed_3280', 'v3.28.0', 'Team Sign-Up Accounts', [
    { id: 'e_seed_3280_1', tag: 'feat', text: '🏆 Team account sign-up — new "Sign Up" button in the topbar opens a registration modal; users enter their team number, email, and password to create a Supabase-backed team account with <code>account_type: team</code> stored in user metadata', versionId: 'v_seed_3280' },
    { id: 'e_seed_3280_2', tag: 'ux', text: 'Sign-up modal includes team number, email, password, and confirm-password fields with inline validation (min length, match check); success state shows confirmation message with email-verification notice if Supabase requires it', versionId: 'v_seed_3280' },
    { id: 'e_seed_3280_3', tag: 'ux', text: '"Already have an account? Sign in" link in signup modal switches directly to the admin login modal; Sign Up button hidden automatically when logged in as admin and restored on logout', versionId: 'v_seed_3280' },
  ]);

  addVersion('v_seed_3290', 'v3.29.0', 'Team Login — Role-Based Access', [
    { id: 'e_seed_3290_1', tag: 'fix', text: '🔒 Fixed team accounts incorrectly receiving admin access on login — <code>tryLogin</code> now decodes the Supabase JWT and checks <code>user_metadata.account_type</code>; only accounts without <code>account_type: team</code> are elevated to admin', versionId: 'v_seed_3290' },
    { id: 'e_seed_3290_2', tag: 'feat', text: 'Team users get a dedicated "My Team" tab and sidebar link after sign-in showing their stats: match count, avg pins, best match, AWP rate, TrueSkill rank, and last 30 match entries', versionId: 'v_seed_3290' },
    { id: 'e_seed_3290_3', tag: 'ux', text: 'Sidebar logo replaced with a large blue team number badge when a team user is logged in; restored to default branding on logout', versionId: 'v_seed_3290' },
    { id: 'e_seed_3290_4', tag: 'ux', text: 'Login modal relabelled "Sign in to your account" (works for both team and admin); topbar "Admin" button renamed to "Sign In"; login modal now includes "No account? Create team account" link', versionId: 'v_seed_3290' },
  ]);

  addVersion('v_seed_3300', 'v3.30.0', 'Sidebar Polish', [
    { id: 'e_seed_3300_1', tag: 'fix', text: 'Fixed sidebar open/close shifting icons — icons now live in a fixed 36 px slot via <code>margin:0 9px</code> on the SVG instead of <code>justify-content:center → flex-start + padding</code>; icon position is constant regardless of open state', versionId: 'v_seed_3300' },
    { id: 'e_seed_3300_2', tag: 'ux', text: 'Smoother sidebar collapse — labels animate via <code>width:0 → 130px</code> + <code>opacity</code> transition; section labels use <code>height:0 → 22px</code>; no more instant <code>display:none</code> snap', versionId: 'v_seed_3300' },
  ]);

  // ── v3.31.0 — Security Hardening ──
  addVersion('v_seed_3310', 'v3.31.0', 'Security Hardening', [
    { id: 'e_seed_3310_1', tag: 'fix', text: '🔒 RLS enabled on <code>entries</code>, <code>sig_events</code>, <code>app_updates</code>, and <code>teams</code> tables — previously any holder of the public anon key could read or mutate all scouting data', versionId: 'v_seed_3310' },
    { id: 'e_seed_3310_2', tag: 'fix', text: '🔒 Admin detection moved from <code>user_metadata</code> to <code>app_metadata</code> in <code>tryLogin</code> — team accounts could previously self-demote their <code>account_type</code> flag via the Supabase API to gain admin access; <code>app_metadata</code> is server-only and cannot be modified by users', versionId: 'v_seed_3310' },
    { id: 'e_seed_3310_3', tag: 'fix', text: '🔒 Write RLS policies updated — replaced <code>auth.role() = \'authenticated\'</code> (any logged-in user) with <code>auth.jwt() -&gt; \'app_metadata\' -&gt;&gt; \'account_type\' IS DISTINCT FROM \'team\'</code> so team accounts cannot insert, update, or delete records', versionId: 'v_seed_3310' },
  ]);

  // ── v3.32.0 — XSS & Injection Hardening ──
  addVersion('v_seed_3320', 'v3.32.0', 'XSS &amp; Injection Hardening', [
    { id: 'e_seed_3320_1', tag: 'fix', text: '🔒 DOMPurify added — all changelog <code>innerHTML</code> assignments now run through <code>DOMPurify.sanitize()</code>; a compromised admin account or direct DB write could previously inject stored XSS that ran for every visitor', versionId: 'v_seed_3320' },
    { id: 'e_seed_3320_2', tag: 'fix', text: '🔒 Admin JWT moved to <code>sessionStorage</code> only — "Remember admin login" feature removed; the token is no longer written to <code>localStorage</code> where any JS on the page could read it', versionId: 'v_seed_3320' },
    { id: 'e_seed_3320_3', tag: 'fix', text: '🔒 Fixed <code>prefillAddEntry</code> onclick injection — team/round/side strings from RobotEvents were embedded raw in <code>onclick</code> attributes; replaced with <code>data-team</code>, <code>data-round</code>, <code>data-side</code> attributes and a single <code>addEventListener</code>', versionId: 'v_seed_3320' },
    { id: 'e_seed_3320_4', tag: 'fix', text: '🔒 Fixed <code>openDetail</code> double-serialize — team object was embedded as <code>JSON.stringify(JSON.stringify(t))</code> in an HTML attribute; fields containing <code>&lt;/script&gt;</code> or <code>"</code> could break the attribute; replaced with <code>data-team-id</code> + <code>teamDetailMap</code> lookup via <code>addEventListener</code>', versionId: 'v_seed_3320' },
  ]);

  addVersion('v_seed_3330', 'v3.33.0', 'Source Split into Separate Files', [
    { id: 'e_seed_3330_1', tag: 'arch', text: 'Monolithic <code>index.html</code> (~13 800 lines) split into <code>index.html</code> (shell + HTML panels), <code>styles.css</code> (~1 750 lines), <code>app.js</code> (~7 500 lines), and <code>app2.js</code> (~1 700 lines) — each concern is now independently editable and cacheable', versionId: 'v_seed_3330' },
    { id: 'e_seed_3330_2', tag: 'arch', text: 'Inline <code>&lt;style&gt;</code> block replaced with <code>&lt;link rel="stylesheet" href="styles.css"&gt;</code>; inline <code>&lt;script&gt;</code> blocks replaced with <code>&lt;script src="app.js"&gt;</code> and <code>&lt;script src="app2.js"&gt;</code> — no functional changes', versionId: 'v_seed_3330' },
  ]);

  if (changed) {
    state.edits       = edits;
    state.vblock_edits = vblocks;
    state.order       = order;
    ulStateSave();
    ulRenderFromState();
  }
}

/* ── formatMatchPins: formats a pins string like "2+1+0+3" into "G1:2 G2:1 G3:0 G4:3"
   for display in match history rows. Falls back to "N pins" for single values. ── */
function formatMatchPins(pinsStr) {
  const p = (pinsStr || '0').split('+');
  if (p.length >= 2) {
    let out = `G1:${esc(p[0])} G2:${esc(p[1])}`;
    if (p[2] !== undefined) out += ` G3:${esc(p[2])}`;
    if (p[3] !== undefined) out += ` G4:${esc(p[3])}`;
    return out;
  }
  return esc(pinsStr) + ' pins';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// debounce: wraps fn so it only fires after `wait` ms of inactivity
function debounce(fn, wait) {
  let timer;
  return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), wait); };
}
const tsApplyDebounced   = debounce(() => tsApply(),   150);
const renderLogDebounced = debounce(() => { logPg = 1; renderLog(); }, 150);

// Admin auth token — set after Supabase login, cleared on logout
let adminToken = null;
function adminHdrs() {
  if (!adminToken) throw new Error('Not authenticated — please log in as admin.');
  return {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + adminToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

/* ── State ── */
let isAdmin = false;
let isTeamUser = false;
let teamUserNumber = null; // e.g. "97230F"
let teamUserToken = null;

// Decode a Supabase JWT and return the user_metadata payload
function decodeJwtMeta(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g,'+').replace(/_/g,'/'));
    return JSON.parse(json);
  } catch { return {}; }
}
let allEntries = [], allTeams = [];
const teamDetailMap = {};
function setAllTeams(arr) {
  allTeams = arr;
  arr.forEach(t => { teamDetailMap[t.team] = t; });
}
let localDb = [];
try { localDb = JSON.parse(localStorage.getItem('override_scout_v3') || '[]'); } catch(e) { /* localStorage unavailable (e.g. private browsing) — start with empty local cache */ }

/* ── Helpers ── */
function sumPins(val){ return (val||'0').split('+').map(n=>parseInt(n)||0).reduce((a,b)=>a+b,0); }
function pins(e){ return sumPins(e.pins); }

/* ═══════════════════════════════════════════════════════
   AUTH
════════════════════════════════════════════════════════ */
function openLoginModal() {
  document.getElementById('loginModal')?.classList.add('open');
  document.getElementById('unInput').focus();
  document.getElementById('loginErr').textContent = '';
}
function closeLoginModal() {
  document.getElementById('loginModal')?.classList.remove('open');
  document.getElementById('pwInput').value = '';
  document.getElementById('unInput').value = '';
  document.getElementById('loginErr').textContent = '';
}

/* ── SIGN UP ── */
function openSignupModal() {
  document.getElementById('signupModal')?.classList.add('open');
  document.getElementById('signupTeam').focus();
  document.getElementById('signupErr').textContent = '';
  document.getElementById('signupOk').style.display = 'none';
}
function closeSignupModal() {
  document.getElementById('signupModal')?.classList.remove('open');
  ['signupTeam','signupEmail','signupPw','signupPw2'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('signupErr').textContent = '';
  document.getElementById('signupOk').style.display = 'none';
}
async function trySignUp() {
  const team  = document.getElementById('signupTeam')?.value.trim().toUpperCase();
  const email = document.getElementById('signupEmail')?.value.trim();
  const pw    = document.getElementById('signupPw')?.value;
  const pw2   = document.getElementById('signupPw2')?.value;
  const errEl = document.getElementById('signupErr');
  const okEl  = document.getElementById('signupOk');
  const btn   = document.getElementById('signupSubmitBtn');

  errEl.textContent = ''; okEl.style.display = 'none';
  if(!team)  { errEl.textContent = 'Enter your team number.'; return; }
  if(!email) { errEl.textContent = 'Enter an email address.'; return; }
  if(!pw || pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if(pw !== pw2) { errEl.textContent = 'Passwords do not match.'; return; }

  errEl.style.color = 'var(--ink3)';
  errEl.textContent = 'Creating account…';
  btn.disabled = true;

  try {
    const res = await fetch(SB_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password: pw,
        data: { team_number: team, account_type: 'team' }
      })
    });
    const data = await res.json();

    if(!res.ok || data.error) {
      errEl.textContent = data.error?.message || data.msg || 'Sign-up failed — try a different email.';
      errEl.style.color = 'var(--red)';
      btn.disabled = false;
      return;
    }

    errEl.textContent = '';
    okEl.style.display = 'block';
    // Supabase may require email confirmation
    if(data.session) {
      okEl.textContent = `✓ Account created for ${team}! You can now sign in.`;
    } else {
      okEl.textContent = `✓ Account created for ${team}! Check your email to confirm before signing in.`;
    }
    btn.disabled = false;
  } catch(e) {
    errEl.textContent = 'Network error — check your connection.';
    errEl.style.color = 'var(--red)';
    btn.disabled = false;
  }
}

async function tryLogin() {
  const email = document.getElementById('unInput')?.value.trim();
  const pw    = document.getElementById('pwInput')?.value;
  const errEl = document.getElementById('loginErr');
  const btn   = document.getElementById('loginBtn');

  if(!email || !pw) { errEl.textContent = 'Enter your email and password.'; return; }

  errEl.textContent = 'Signing in…';
  errEl.style.color = 'var(--ink3)';
  btn.disabled = true;

  try {
    // Supabase Auth REST endpoint — no client library needed
    const res = await fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password: pw })
    });
    const data = await res.json();

    if(!res.ok || data.error) {
      errEl.textContent = 'Invalid email or password.';
      errEl.style.color = 'var(--red)';
      document.getElementById('pwInput').value = '';
      document.getElementById('pwInput').focus();
      btn.disabled = false;
      return;
    }

    // Supabase returned a valid JWT — decode metadata to check account type
    const jwt = data.access_token;
    const meta = decodeJwtMeta(jwt);
    const accountType = meta?.user_metadata?.account_type || meta?.app_metadata?.account_type || '';
    const teamNum = (meta?.user_metadata?.team_number || '').toUpperCase();

    if (accountType === 'team') {
      // ── TEAM USER ──
      teamUserToken = jwt;
      teamUserNumber = teamNum;
      isTeamUser = true;
      sessionStorage.setItem('sb_team_token', jwt);
      sessionStorage.setItem('sb_team_exp', Date.now() + (data.expires_in * 1000));
      sessionStorage.setItem('sb_team_number', teamNum);

      errEl.textContent = '';
      btn.disabled = false;
      closeLoginModal();

      document.getElementById('modeBadge').textContent = teamNum || 'Team';
      document.getElementById('modeBadge').className = 'mode-badge mode-team';
      document.getElementById('logoutBtn').style.display = '';
      document.getElementById('adminLoginBtn').style.display = 'none';
      document.getElementById('signupBtn').style.display = 'none';

      // Update sidebar branding to show team number in blue
      applyTeamUserSidebar(teamNum);
      const sbLink = document.getElementById('sbMyTeamLink');
      if (sbLink) sbLink.style.display = '';

      // Reveal team tab and switch to it
      document.querySelectorAll('.team-only').forEach(el => el.classList.add('team-visible'));
      const teamTabBtn = document.querySelector('[data-tab="myteam"]');
      if (teamTabBtn) { teamTabBtn.style.display = ''; teamTabBtn.click(); }
      renderTeamPage();

    } else {
      // ── ADMIN ──
      adminToken = jwt;
      const expMs = Date.now() + (data.expires_in * 1000);
      sessionStorage.setItem('sb_token', adminToken);
      sessionStorage.setItem('sb_token_exp', expMs);
      _persistAdminToken(adminToken, expMs);

      isAdmin = true;
      errEl.textContent = '';
      btn.disabled = false;
      closeLoginModal();

      document.querySelectorAll('.admin-only').forEach(el => el.classList.add('admin-visible'));
      document.getElementById('modeBadge').textContent = 'Admin';
      document.getElementById('modeBadge').className = 'mode-badge mode-admin';
      document.getElementById('logoutBtn').style.display = '';
      document.getElementById('adminLoginBtn').style.display = 'none';
      document.getElementById('signupBtn').style.display = 'none';
      applyViewerGates(true);
      renderLog();
      renderCalList();
      applyUpdatesAdminState();
      if (typeof window._ulApplyDragMode === 'function') window._ulApplyDragMode();
      ulStatePullSupabase().then(() => { window._ulReapplyAll && window._ulReapplyAll(); });
      if (typeof loadData === 'function') loadData();
    }

  } catch(e) {
    errEl.textContent = 'Network error — check your connection.';
    errEl.style.color = 'var(--red)';
    btn.disabled = false;
    console.error('Login error:', e);
  }
}

async function logout() {
  const token = adminToken || teamUserToken;
  if(token) {
    try {
      await fetch(SB_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + token }
      });
    } catch(e) { /* best effort */ }
  }
  adminToken = null; isAdmin = false;
  teamUserToken = null; isTeamUser = false; teamUserNumber = null;
  sessionStorage.removeItem('sb_token');
  sessionStorage.removeItem('sb_token_exp');
  sessionStorage.removeItem('sb_team_token');
  sessionStorage.removeItem('sb_team_exp');
  sessionStorage.removeItem('sb_team_number');

  document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('admin-visible'));
  document.querySelectorAll('.team-only').forEach(el => el.classList.remove('team-visible'));
  const teamTabBtn = document.querySelector('[data-tab="myteam"]');
  if (teamTabBtn) teamTabBtn.style.display = 'none';

  // Restore sidebar branding
  restoreDefaultSidebar();
  const sbLink = document.getElementById('sbMyTeamLink');
  if (sbLink) sbLink.style.display = 'none';

  document.getElementById('modeBadge').textContent = 'Viewer';
  document.getElementById('modeBadge').className = 'mode-badge mode-pub';
  document.getElementById('logoutBtn').style.display = 'none';
  document.getElementById('adminLoginBtn').style.display = '';
  document.getElementById('signupBtn').style.display = '';
  applyViewerGates(false);
  const _lbTabBtn = document.querySelector('[data-tab="leaderboard"]');
  if (_lbTabBtn) _lbTabBtn.click();
  renderCalList();
  applyUpdatesAdminState();
  if (typeof window._ulApplyDragMode === 'function') window._ulApplyDragMode();
}
function applyTeamUserSidebar(teamNum) {
  const brand = document.getElementById('sbBrand');
  if (!brand) return;
  brand.className = 'sb-brand team-mode';
  brand.title = teamNum + ' · Override Scout';
  brand.innerHTML = `<span style="font-family:var(--barlow);font-size:13px;font-weight:800;letter-spacing:.5px;flex-shrink:0">${teamNum}</span><span class="sb-label" style="font-size:12px;font-weight:700;color:rgba(255,255,255,.8)">My Team</span>`;
}
function restoreDefaultSidebar() {
  const brand = document.getElementById('sbBrand');
  if (!brand) return;
  brand.className = 'sb-brand';
  brand.title = 'Override Scout · 97230F';
  brand.innerHTML = `<img src="logo.png" alt="Override Scout" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;filter:brightness(0) invert(1);opacity:.9"><span class="sb-label">Override Scout</span>`;
}

function renderTeamPage() {
  if (!isTeamUser || !teamUserNumber) return;
  const num = teamUserNumber;
  const panel = document.getElementById('tab-myteam');
  if (!panel) return;

  // Pull this team's entries from allEntries
  const entries = allEntries.filter(e => (e.team||'').toUpperCase() === num);
  const detail  = teamDetailMap[num] || {};

  const totalMatches = entries.length;
  const avgPins = totalMatches
    ? (entries.reduce((s,e) => s + (parseFloat(e.avg_pins)||parseFloat(e.pins)||0), 0) / totalMatches).toFixed(2)
    : '—';
  const awpCount = entries.filter(e => e.awp || e.auton_win_point).length;
  const awpRate  = totalMatches ? Math.round(awpCount / totalMatches * 100) : 0;
  const bestPins = totalMatches ? Math.max(...entries.map(e => parseFloat(e.avg_pins)||parseFloat(e.pins)||0)).toFixed(1) : '—';
  const tsRank   = detail.ts_rank ?? detail.trueskill_rank ?? '—';

  const matchRows = entries.slice().reverse().slice(0, 30).map(e => {
    const pins = parseFloat(e.avg_pins||e.pins||0).toFixed(1);
    const awp  = e.awp || e.auton_win_point;
    const evt  = e.event_name || e.event || 'Match';
    const date = e.date ? e.date.slice(0,10) : '';
    return `<div class="team-match-row">
      <span class="team-match-event">${evt}</span>
      ${awp ? `<span class="team-match-awp">AWP</span>` : ''}
      <span class="team-match-pins">${pins}</span>
      <span class="team-match-date">${date}</span>
    </div>`;
  }).join('') || `<div style="padding:1.5rem;text-align:center;color:var(--ink3);font-family:var(--mono);font-size:12px">No match entries found for ${num} yet.</div>`;

  panel.innerHTML = `
    <div class="team-page-hero">
      <div class="team-page-num">${num}</div>
      <div class="team-page-label">Your Team · Override Scout</div>
      <div class="team-stat-grid">
        <div class="team-stat-card">
          <div class="team-stat-label">Matches</div>
          <div class="team-stat-val">${totalMatches}</div>
          <div class="team-stat-sub">recorded entries</div>
        </div>
        <div class="team-stat-card">
          <div class="team-stat-label">Avg Pins</div>
          <div class="team-stat-val">${avgPins}</div>
          <div class="team-stat-sub">across all entries</div>
        </div>
        <div class="team-stat-card">
          <div class="team-stat-label">Best Match</div>
          <div class="team-stat-val">${bestPins}</div>
          <div class="team-stat-sub">pins in one match</div>
        </div>
        <div class="team-stat-card">
          <div class="team-stat-label">AWP Rate</div>
          <div class="team-stat-val">${awpRate}%</div>
          <div class="team-stat-sub">${awpCount} of ${totalMatches}</div>
        </div>
        <div class="team-stat-card">
          <div class="team-stat-label">TrueSkill Rank</div>
          <div class="team-stat-val">${tsRank === '—' ? tsRank : '#' + tsRank}</div>
          <div class="team-stat-sub">overall ranking</div>
        </div>
      </div>
    </div>
    <div style="padding:1rem 1.5rem .5rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)">
      <div style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3)">Recent matches</div>
      <div style="font-size:10px;font-family:var(--mono);color:var(--ink3)">${totalMatches} total</div>
    </div>
    <div style="background:var(--surface);border-radius:0 0 var(--radius-lg) var(--radius-lg)">${matchRows}</div>`;
}

/* ── VIEWER GATE: tabs/panels locked for unauthenticated users ── */
const VIEWER_GATED_TABS = ['leaderboard','skills','updates','experimental','roadmap'];

function buildLockGate() {
  const el = document.createElement('div');
  el.className = 'viewer-lock-gate';
  el.innerHTML = '<div class="viewer-lock-card">'
    + '<span class="viewer-lock-icon">\uD83D\uDD12</span>'
    + '<div class="viewer-lock-title">Override <span>Scout</span></div>'
    + '<div class="viewer-lock-sub">Sign in or create a free account to access<br>scouting data, rankings, and analytics.</div>'
    + '<div class="viewer-lock-btns">'
    + '<button class="viewer-lock-btn-primary" onclick="openLoginModal()">Sign In</button>'
    + '<div class="viewer-lock-divider">or</div>'
    + '<button class="viewer-lock-btn-secondary" onclick="openSignupModal()">Create Account</button>'
    + '</div></div>';
  return el;
}

function applyViewerGates(admin) {
  VIEWER_GATED_TABS.forEach(function(tabId) {
    var panel = document.getElementById('tab-' + tabId);
    var tabBtn = document.querySelector('.tab[data-tab="' + tabId + '"]');
    if (!panel) return;
    if (!admin) {
      if (tabBtn) tabBtn.classList.add('viewer-gated');
      panel.classList.add('viewer-locked-panel');
      if (!panel.querySelector('.viewer-lock-gate')) {
        panel.appendChild(buildLockGate());
      }
    } else {
      if (tabBtn) tabBtn.classList.remove('viewer-gated');
      panel.classList.remove('viewer-locked-panel');
      var gate = panel.querySelector('.viewer-lock-gate');
      if (gate) gate.remove();
    }
  });
}

function launchApp(admin) {
  document.getElementById('appShell').style.display = 'block';
  // Admin tabs hidden by default for viewers
  document.querySelectorAll('.admin-only').forEach(el => {
    if(admin) el.classList.add('admin-visible');
    else el.classList.remove('admin-visible');
  });
  document.getElementById('modeBadge').textContent = admin ? 'Admin' : 'Viewer';
  // Start donation popup now that user is in the app (viewers only - team members know the app)
  if (!admin && window._startDonation) window._startDonation();
  document.getElementById('modeBadge').className = 'mode-badge ' + (admin ? 'mode-admin' : 'mode-pub');
  // Apply / remove viewer gates
  applyViewerGates(admin);
  document.getElementById('logoutBtn').style.display = admin ? '' : 'none';
  document.getElementById('adminLoginBtn').style.display = admin ? 'none' : '';
  // Only fetch from the network on first load; subsequent calls (e.g. after login)
  // just re-render with already-loaded data to avoid redundant network requests.
  if (!allEntries.length) {
    loadData();
  } else {
    lbApplyFilter(lbActiveF);
    pubRenderAll();
    if(admin) { renderLog(); renderRoutes(); }
  }
  loadRobotTypes();
  setTimeout(() => { if (typeof skLoadFromSupabase === 'function') skLoadFromSupabase(); }, 0);
  // Always re-render after login/logout so admin UI state is correct
  lbApplyFilter(lbActiveF);
  pubRenderAll();
  if(admin) { renderLog(); renderRoutes(); }
}

/* ═══════════════════════════════════════════════════════
   DATA LOADING
════════════════════════════════════════════════════════ */
// loadData: fetches all scouting entries from Supabase in batches of 1000
// (Supabase has a default page limit, so we loop until we have everything).
// After loading, it builds team stats, updates the leaderboard summary cards,
// and renders the leaderboard and search tab.
async function loadData() {
  setSyncStatus('syncing', 'Loading…');
  try {
    let rows = [], off = 0, batch;
    do {
      const r = await fetch(SB_URL+'/rest/v1/entries?select=*&order=created_at.desc&limit=1000&offset='+off, {headers:HDRS});
      if(!r.ok) throw new Error('HTTP '+r.status+': '+(await r.text()).slice(0,120));
      batch = await r.json();
      rows = rows.concat(batch);
      off += 1000;
    } while(batch.length === 1000);

    allEntries = rows;
    setAllTeams(buildStats(rows));

    // Prune localDb: remove any entries that are now confirmed in Supabase
    if (localDb.length) {
      const supabaseIds = new Set(rows.map(e => String(e.id)));
      const prunedLocalDb = localDb.filter(le => !supabaseIds.has(String(le.id)));
      if (prunedLocalDb.length !== localDb.length) {
        localDb = prunedLocalDb;
        try { localStorage.setItem('override_scout_v3', JSON.stringify(localDb)); } catch(e) {}
      }
    }

    // Merge any local entries not yet in Supabase
    if(isAdmin) {
      localDb.forEach(le => {
        if(!allEntries.find(e => String(e.id) === String(le.id))) allEntries.unshift(le);
      });
      setAllTeams(buildStats(allEntries));
    }

    setSyncStatus('ok', allTeams.length + ' teams · ' + allEntries.length + ' entries');

    // Update summary cards
    const totP = allEntries.reduce((s,e)=>s+pins(e),0);
    const avgP = allEntries.length ? (totP/allEntries.length).toFixed(1) : '—';
    const awpR = allEntries.length ? Math.round(allEntries.filter(e=>e.awp==='Y').length/allEntries.length*100) : 0;
    document.getElementById('lbT').textContent = allTeams.length;
    document.getElementById('lbE').textContent = allEntries.length;
    document.getElementById('lbP').textContent = avgP;
    document.getElementById('lbA').textContent = awpR + '%';
    // lbCards always visible in hero banner

    // Render
    lbApplyFilter(lbActiveF);
    pubRenderAll();
    if (_isTabActive('experimental')) { renderRforce(); trBuild(); }
    if(isAdmin) { renderLog(); renderRoutes(); }
  } catch(err) {
    setSyncStatus('err', 'Connection failed');
    console.error(err);
    document.getElementById('pubResult').innerHTML = `<div class="empty" style="color:var(--red-text)">Could not load database: ${esc(err.message)}</div>`;
  }
}

/* ═══════════════════════════════════════════════════════
   FUTURE UPDATES TAB
   Supabase table: app_updates (id, future text, fixes text, updated_at)
   Public can read; admins can upsert row id=1.
════════════════════════════════════════════════════════ */
async function loadUpdates() {
  try {
    const r = await fetch(SB_URL + '/rest/v1/app_updates?id=eq.1&select=*', { headers: HDRS });
    const rows = r.ok ? await r.json() : [];
    const row = rows[0] || {};

    const futureText = row.future || '';
    const fixesText  = row.fixes  || '';
    const ts         = row.updated_at ? new Date(row.updated_at).toLocaleString() : null;

    // Populate view divs
    document.getElementById('updates-future-view').textContent = futureText || 'Nothing listed yet.';
    document.getElementById('updates-fixes-view').textContent  = fixesText  || 'Nothing listed yet.';

    // Populate edit textareas
    document.getElementById('updates-future-edit').value = futureText;
    document.getElementById('updates-fixes-edit').value  = fixesText;

    // Show timestamp footer
    if(ts) {
      document.getElementById('updates-footer').style.display = 'block';
      document.getElementById('updates-ts').textContent = ts;
    }

    document.getElementById('updates-loading').style.display = 'none';
    document.getElementById('updates-content').style.display = 'block';

    // Show admin controls if logged in
    applyUpdatesAdminState();
  } catch(e) {
    document.getElementById('updates-loading').innerHTML =
      `<span style="color:var(--red-text)">Could not load updates: ${e.message}</span>`;
  }
}

function applyUpdatesAdminState() {
  const editFuture = document.getElementById('updates-future-edit');
  const viewFuture = document.getElementById('updates-future-view');
  const editFixes  = document.getElementById('updates-fixes-edit');
  const viewFixes  = document.getElementById('updates-fixes-view');
  const saveWrap   = document.getElementById('updates-save-wrap');
  if(!editFuture) return;
  if(isAdmin) {
    editFuture.style.display = 'block';
    viewFuture.style.display = 'none';
    editFixes.style.display  = 'block';
    viewFixes.style.display  = 'none';
    if(saveWrap) saveWrap.style.display = 'block';
  } else {
    editFuture.style.display = 'none';
    viewFuture.style.display = 'block';
    editFixes.style.display  = 'none';
    viewFixes.style.display  = 'block';
    if(saveWrap) saveWrap.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════════════
   RENDER CHANGELOG FROM _ulState
   Builds all version blocks, entries, and dividers from
   the Supabase-sourced state object instead of hardcoded HTML.
════════════════════════════════════════════════════════ */
/* ── Changelog order toggle ── */
window._ulNewestFirst = true; // default: newest at top (current behaviour)

function ulToggleOrder() {
  window._ulNewestFirst = !window._ulNewestFirst;
  const btn = document.getElementById('ul-order-btn');
  if (btn) btn.textContent = window._ulNewestFirst ? '↓ Newest first' : '↑ Oldest first';
  ulRenderFromState();
}

function ulRenderFromState() {
  const wrap = document.getElementById('ul-dynamic-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const state       = window._ulState;
  const edits       = Array.isArray(state.edits) ? state.edits : [];
  const vblockEdits = state.vblock_edits || {};
  const dividers    = state.dividers || {};
  const order       = Array.isArray(state.order) ? state.order : [];

  // Build lookup maps
  const entryMap   = {}; // id → edit object
  const versionMap = {}; // versionId → [entries]
  const newVersionBlocks = []; // entries with isVersionBlock

  edits.forEach(function(e) {
    if (e.deleted) return;
    if (e.isVersionBlock) { newVersionBlocks.push(e); return; }
    entryMap[e.id] = e;
    if (e.versionId) {
      if (!versionMap[e.versionId]) versionMap[e.versionId] = [];
      versionMap[e.versionId].push(e);
    }
  });

  // Gather all version ids from order + any in vblockEdits not in order
  const orderedIds = order.map(function(o) { return o.id; });
  const allVids = Object.keys(vblockEdits).concat(
    newVersionBlocks.map(function(v) { return v.id; })
  ).filter(function(id, i, arr) { return arr.indexOf(id) === i; });

  // Build render order: use saved order, append anything not in it
  const renderOrder = [];
  order.forEach(function(item) { renderOrder.push(item); });
  allVids.forEach(function(vid) {
    if (!orderedIds.includes(vid)) renderOrder.push({ type: 'version', id: vid });
  });
  Object.keys(dividers).forEach(function(divId) {
    if (!orderedIds.includes(divId)) renderOrder.push({ type: 'divider', id: divId });
  });

  if (renderOrder.length === 0) {
    wrap.innerHTML = '<p style="color:var(--ink3);font-size:13px;padding:32px 0;text-align:center">No changelog entries yet.</p>';
    return;
  }

  // Apply order direction (newest first = default, oldest first = reversed)
  const orderedItems = window._ulNewestFirst ? renderOrder : [...renderOrder].reverse();

  orderedItems.forEach(function(item) {
    if (item.type === 'divider') {
      const d = dividers[item.id];
      if (!d) return;
      const divEl = document.createElement('div');
      divEl.className = 'ul-date-divider ul-draggable';
      divEl.setAttribute('data-ul-div-id', item.id);
      divEl.dataset.ulText = d.text;
      divEl.innerHTML =
        '<span class="ul-drag-handle admin-only" title="Drag to reorder">⠿</span>' +
        '<span class="ul-div-label">' + escHtml(d.text) + '</span>' +
        '<span class="ul-divider-actions admin-only">' +
          '<button class="ul-entry-btn" onclick="editUlDivider(this)">✏ Edit</button>' +
          '<button class="ul-entry-btn del" onclick="deleteUlDivider(this)">✕</button>' +
        '</span>';
      wrap.appendChild(divEl);
    } else if (item.type === 'version') {
      const ve = vblockEdits[item.id];
      if (!ve) return;
      // Build version block
      const vb = document.createElement('div');
      vb.className = 'ul-version-block ul-draggable';
      vb.setAttribute('draggable', 'false');
      vb.dataset.ulVid = item.id;

      const header = document.createElement('div');
      header.className = 'ul-version-header';
      header.innerHTML =
        '<span class="ul-drag-handle admin-only" title="Drag to reorder" style="position:static;margin-right:4px">⠿</span>' +
        '<span class="ul-v-number">' + escHtml(ve.num || '') + '</span>' +
        '<span class="ul-v-name">'   + escHtml(ve.name || '') + '</span>' +
        (ve.date ? '<span class="ul-v-date">' + escHtml(ve.date) + '</span>' : '') +
        '<div class="ul-version-actions admin-only">' +
          '<button class="ul-entry-btn" onclick="editUlVBlock(this)">✏ Edit version</button>' +
          '<button class="ul-entry-btn" onclick="addUlEntryToVersion(this)">＋ Entry</button>' +
        '</div>';
      vb.appendChild(header);

      const entriesDiv = document.createElement('div');
      entriesDiv.className = 'ul-entries';
      const entries = versionMap[item.id] || [];
      entries.forEach(function(e) {
        const row = document.createElement('div');
        row.className = 'ul-entry ul-draggable';
        row.dataset.ulId = e.id;
        row.innerHTML =
          '<span class="ul-drag-handle admin-only" title="Drag to reorder">⠿</span>' +
          '<span class="ul-entry-tag ul-tag-' + escHtml(e.tag || 'feat') + '">' + escHtml(e.tag || 'feat') + '</span>' +
          '<span class="ul-entry-text">' + DOMPurify.sanitize(e.text || '') + '</span>' +
          '<div class="ul-entry-actions admin-only">' +
            '<button class="ul-entry-btn" onclick="editUlEntry(this)">✏ Edit</button>' +
            '<button class="ul-entry-btn del" onclick="deleteUlEntry(this)">✕</button>' +
          '</div>';
        entriesDiv.appendChild(row);
      });
      vb.appendChild(entriesDiv);
      wrap.appendChild(vb);
    }
  });

  // Re-init drag handles
  if (typeof window._ulEnableAllDrag === 'function') window._ulEnableAllDrag();
  else if (typeof enableAllDrag === 'function') enableAllDrag();

  // If admin is already logged in, reveal any newly rendered admin-only elements and ensure drag mode
  if (typeof isAdmin !== 'undefined' && isAdmin) {
    document.body.classList.add('ul-admin-drag');
    wrap.querySelectorAll('.admin-only').forEach(function(el) { el.classList.add('admin-visible'); });
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* ═══════════════════════════════════════════════════════
   CHANGELOG SNAPSHOT — pushes the current _ulState to Supabase.
════════════════════════════════════════════════════════ */
async function ulSnapshotAndSync() {
  if (!isAdmin) return;
  const btn = document.getElementById('ul-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
  try {
    ulStateSaveCache();
    await ulStatePushSupabase();
    const count = (window._ulState.edits || []).length;
    if (btn) { btn.textContent = '✅ Synced!'; btn.disabled = false; }
    showToast('Changelog synced to Supabase (' + count + ' entries)', 'ok', 4000);
    setTimeout(function() { if (btn) btn.textContent = '⬆ Sync to Supabase'; }, 3000);
  } catch(e) {
    console.error('ulSnapshotAndSync error:', e);
    if (btn) { btn.textContent = '⬆ Sync to Supabase'; btn.disabled = false; }
    showToast('Sync failed: ' + e.message, 'err', 5000);
  }
}

async function saveUpdates() {
  if(!isAdmin) return;
  const future = document.getElementById('updates-future-edit')?.value.trim();
  const fixes  = document.getElementById('updates-fixes-edit')?.value.trim();
  const status = document.getElementById('updates-save-status');
  status.textContent = 'Saving…';
  status.style.color = 'var(--ink3)';
  try {
    const r = await fetch(SB_URL + '/rest/v1/app_updates', {
      method: 'POST',
      headers: { ...adminHdrs(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id: 1, future, fixes, updated_at: new Date().toISOString() })
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const ts = new Date().toLocaleString();
    // Sync view divs with saved content
    document.getElementById('updates-future-view').textContent = future || 'Nothing listed yet.';
    document.getElementById('updates-fixes-view').textContent  = fixes  || 'Nothing listed yet.';
    document.getElementById('updates-footer').style.display = 'block';
    document.getElementById('updates-ts').textContent = ts;
    status.textContent = '✓ Saved';
    status.style.color = 'var(--green)';
    setTimeout(() => status.textContent = '', 3000);
    showToast('Updates saved successfully', 'ok');
  } catch(e) {
    status.textContent = '⚠ Save failed: ' + e.message;
    status.style.color = 'var(--red)';
    showToast('Save failed: ' + e.message, 'err', 5000);
  }
}


/* ═══════════════════════════════════════════════════════
   UPDATE LOG EDITOR — add / edit / delete entries in #tab-updates
   Changes synced to Supabase (ul_changelog table) and cached
   in localStorage under 'ul_changelog_v1'. Applied
   on top of the hardcoded HTML on each page load.
════════════════════════════════════════════════════════ */
(function() {
  let _ulEditTarget = null;
  let _ulSelectedTag = 'feat';

  function stampIds() {
    document.querySelectorAll('#tab-updates .ul-version-block').forEach((vb, vi) => {
      if (!vb.dataset.ulVid) vb.dataset.ulVid = 'v' + vi;
    });
    document.querySelectorAll('#tab-updates .ul-entry').forEach((e, i) => {
      if (!e.dataset.ulId) e.dataset.ulId = 'e' + i;
    });
  }

  function loadEdits() {
    return Array.isArray(window._ulState.edits) ? window._ulState.edits : [];
  }
  function saveEdits(edits) {
    window._ulState.edits = edits;
    ulStateSave();
  }

  function applyUlEdits() {
    const edits = loadEdits();
    edits.forEach(function(edit) {
      if (edit.isVersionBlock) return;
      if (edit.deleted) {
        const el = document.querySelector('[data-ul-id="' + edit.id + '"]');
        if (el) el.remove();
      } else if (edit.isNew) {
        const vb = document.querySelector('[data-ul-vid="' + edit.versionId + '"]');
        if (vb) {
          const container = vb.querySelector('.ul-entries');
          if (container && !document.querySelector('[data-ul-id="' + edit.id + '"]')) {
            container.appendChild(buildEntryEl(edit.id, edit.tag, edit.text));
          }
        }
      } else {
        const el = document.querySelector('[data-ul-id="' + edit.id + '"]');
        if (el) {
          const tagEl = el.querySelector('.ul-entry-tag');
          const txtEl = el.querySelector('.ul-entry-text');
          if (tagEl) { tagEl.className = 'ul-entry-tag ul-tag-' + edit.tag; tagEl.textContent = edit.tag; }
          if (txtEl) txtEl.innerHTML = DOMPurify.sanitize(edit.text);
        }
      }
    });
  }

  function buildEntryEl(id, tag, text) {
    const div = document.createElement('div');
    div.className = 'ul-entry ul-draggable';
    div.dataset.ulId = id;
    div.innerHTML =
      '<span class="ul-drag-handle admin-only" title="Drag to reorder">⠿</span>' +
      '<span class="ul-entry-tag ul-tag-' + tag + '">' + tag + '</span>' +
      '<span class="ul-entry-text">' + DOMPurify.sanitize(text) + '</span>' +
      '<div class="ul-entry-actions admin-only">' +
      '<button class="ul-entry-btn" onclick="editUlEntry(this)">&#9999; Edit</button>' +
      '<button class="ul-entry-btn del" onclick="deleteUlEntry(this)">&#10005;</button>' +
      '</div>';
    return div;
  }

  function populateVersionPicker() {
    const sel = document.getElementById('ul-editor-version-pick');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    document.querySelectorAll('#tab-updates .ul-version-block').forEach(function(vb) {
      const num  = (vb.querySelector('.ul-v-number') || {}).textContent || '';
      const name = (vb.querySelector('.ul-v-name')   || {}).textContent || '';
      const opt  = document.createElement('option');
      opt.value = vb.dataset.ulVid;
      opt.textContent = num + ' — ' + name;
      sel.appendChild(opt);
    });
  }

  window.openUlEditor = function(versionBlockEl) {
    if (!isAdmin) return;
    stampIds();
    populateVersionPicker();
    _ulEditTarget = { mode: 'new', versionBlock: versionBlockEl || null };
    document.getElementById('ul-editor-heading').innerHTML = 'Add <span>Entry</span>';
    document.getElementById('ul-editor-text').value = '';
    document.getElementById('ul-editor-version-row').style.display = 'block';
    document.getElementById('ul-editor-vnumber').value = '';
    document.getElementById('ul-editor-vname').value = '';
    const sel = document.getElementById('ul-editor-version-pick');
    if (versionBlockEl && versionBlockEl.dataset && versionBlockEl.dataset.ulVid) {
      sel.value = versionBlockEl.dataset.ulVid;
      ulVersionPickChange(sel.value);
    } else {
      sel.value = '__new__';
      ulVersionPickChange('__new__');
    }
    ulPickTag(document.querySelector('.ul-tag-opt[data-tag="feat"]'));
    document.getElementById('ul-editor-modal-bg').classList.add('open');
    setTimeout(function() { var t = document.getElementById('ul-editor-text'); if(t) t.focus(); }, 80);
  };

  window.closeUlEditor = function() {
    document.getElementById('ul-editor-modal-bg').classList.remove('open');
    _ulEditTarget = null;
  };

  window.ulPickTag = function(el) {
    document.querySelectorAll('.ul-tag-opt').forEach(function(o) { o.classList.remove('selected'); });
    el.classList.add('selected');
    _ulSelectedTag = el.dataset.tag;
  };

  window.ulVersionPickChange = function(val) {
    const newFields = document.getElementById('ul-editor-new-version-fields');
    if (newFields) newFields.style.display = val === '__new__' ? 'block' : 'none';
    if (val === '__new__') {
      // Auto-suggest the next version number based on the highest existing one
      const numEl = document.getElementById('ul-editor-vnumber');
      if (numEl && !numEl.value.trim()) {
        numEl.value = ulNextVersion();
      }
    }
  };

  function ulNextVersion() {
    let best = [0, 0, 0];
    document.querySelectorAll('#tab-updates .ul-v-number').forEach(function(el) {
      // grab the last version in ranges like "v1.5.0 – 1.6.0"
      const matches = el.textContent.match(/\d+\.\d+\.\d+/g);
      if (!matches) return;
      const last = matches[matches.length - 1].split('.').map(Number);
      if (last[0] > best[0] || (last[0] === best[0] && last[1] > best[1]) || (last[0] === best[0] && last[1] === best[1] && last[2] > best[2])) {
        best = last;
      }
    });
    // Increment patch by default
    return 'v' + best[0] + '.' + (best[1] + 1) + '.0';
  }

  window.editUlEntry = function(btn) {
    if (!isAdmin) return;
    stampIds();
    populateVersionPicker();
    const entryEl = btn.closest('.ul-entry');
    const tagEl = entryEl.querySelector('.ul-entry-tag');
    const txtEl = entryEl.querySelector('.ul-entry-text');
    const tag  = tagEl ? tagEl.textContent.trim() : 'feat';
    const text = txtEl ? txtEl.innerHTML : '';
    _ulEditTarget = { mode: 'edit', entryEl: entryEl };
    document.getElementById('ul-editor-heading').innerHTML = 'Edit <span>Entry</span>';
    document.getElementById('ul-editor-text').value = text;
    document.getElementById('ul-editor-version-row').style.display = 'none';
    const tagBtn = document.querySelector('.ul-tag-opt[data-tag="' + tag + '"]');
    if (tagBtn) ulPickTag(tagBtn); else ulPickTag(document.querySelector('.ul-tag-opt'));
    document.getElementById('ul-editor-modal-bg').classList.add('open');
    setTimeout(function() { var t = document.getElementById('ul-editor-text'); if(t) t.focus(); }, 80);
  };

  window.deleteUlEntry = function(btn) {
    if (!isAdmin) return;
    if (!confirm('Delete this changelog entry?')) return;
    const entryEl = btn.closest('.ul-entry');
    const id = entryEl.dataset.ulId;
    const edits = loadEdits().filter(function(e) { return e.id !== id; });
    edits.push({ id: id, deleted: true });
    saveEdits(edits);
    entryEl.remove();
    showToast('Entry deleted', 'ok');
  };

  window.addUlEntryToVersion = function(btn) {
    if (!isAdmin) return;
    const vb = btn.closest('.ul-version-block');
    openUlEditor(vb);
  };

  window.saveUlEntry = function() {
    if (!isAdmin) return;
    const text = document.getElementById('ul-editor-text').value.trim();
    if (!text) { showToast('Entry text cannot be empty', 'err'); return; }
    const edits = loadEdits();

    if (_ulEditTarget && _ulEditTarget.mode === 'edit') {
      const entryEl = _ulEditTarget.entryEl;
      const id = entryEl.dataset.ulId;
      const tagEl = entryEl.querySelector('.ul-entry-tag');
      const txtEl = entryEl.querySelector('.ul-entry-text');
      if (tagEl) { tagEl.className = 'ul-entry-tag ul-tag-' + _ulSelectedTag; tagEl.textContent = _ulSelectedTag; }
      if (txtEl) txtEl.innerHTML = DOMPurify.sanitize(text);
      const idx = edits.findIndex(function(e) { return e.id === id && !e.deleted && !e.isNew && !e.isVersionBlock; });
      const record = { id: id, tag: _ulSelectedTag, text: text };
      if (idx >= 0) edits[idx] = record; else edits.push(record);
      saveEdits(edits);
      showToast('Entry updated', 'ok');
    } else {
      const sel = document.getElementById('ul-editor-version-pick');
      const pickedVid = sel.value;
      let targetVb;
      if (pickedVid === '__new__') {
        const vnum  = (document.getElementById('ul-editor-vnumber').value || '').trim() || 'vX.X.X';
        const vname = (document.getElementById('ul-editor-vname').value   || '').trim() || 'Untitled';
        targetVb = createVersionBlock(vnum, vname);
      } else {
        targetVb = document.querySelector('[data-ul-vid="' + pickedVid + '"]');
      }
      if (!targetVb) { showToast('Could not find version block', 'err'); return; }
      stampIds();
      const newId = 'ul_new_' + Date.now();
      const newEl = buildEntryEl(newId, _ulSelectedTag, text);
      targetVb.querySelector('.ul-entries').appendChild(newEl);
      edits.push({ id: newId, tag: _ulSelectedTag, text: text, isNew: true, versionId: targetVb.dataset.ulVid });
      saveEdits(edits);
      showToast('Entry added', 'ok');
    }
    closeUlEditor();
  };

  function createVersionBlock(vnum, vname) {
    const footer = document.querySelector('#tab-updates .ul-footer');
    const wrap   = document.querySelector('#tab-updates .ul-wrap');
    const vb = document.createElement('div');
    const vid = 'v_new_' + Date.now();
    vb.className = 'ul-version-block';
    vb.dataset.ulVid = vid;
    vb.innerHTML =
      '<div class="ul-version-header">' +
      '<span class="ul-drag-handle admin-only" title="Drag to reorder" style="position:static;margin-right:4px">⠿</span>' +
      '<span class="ul-v-number">' + vnum + '</span>' +
      '<span class="ul-v-name">' + vname + '</span>' +
      '<div class="ul-version-actions admin-only">' +
      '<button class="ul-entry-btn" onclick="editUlVBlock(this)">✏ Edit version</button>' +
      '<button class="ul-entry-btn" onclick="addUlEntryToVersion(this)">＋ Entry</button>' +
      '</div></div>' +
      '<div class="ul-entries"></div>';
    const edits = loadEdits();
    edits.push({ id: vid, isVersionBlock: true, vnum: vnum, vname: vname });
    saveEdits(edits);
    if (footer) wrap.insertBefore(vb, footer);
    else wrap.appendChild(vb);
    return vb;
  }

  function restoreNewVersionBlocks() {
    const edits = loadEdits();
    const footer = document.querySelector('#tab-updates .ul-footer');
    const wrap   = document.querySelector('#tab-updates .ul-wrap');
    edits.filter(function(e) { return e.isVersionBlock; }).forEach(function(e) {
      if (document.querySelector('[data-ul-vid="' + e.id + '"]')) return;
      const vb = document.createElement('div');
      vb.className = 'ul-version-block';
      vb.dataset.ulVid = e.id;
      vb.innerHTML =
        '<div class="ul-version-header">' +
        '<span class="ul-drag-handle admin-only" title="Drag to reorder" style="position:static;margin-right:4px">⠿</span>' +
        '<span class="ul-v-number">' + e.vnum + '</span>' +
        '<span class="ul-v-name">' + e.vname + '</span>' +
        '<div class="ul-version-actions admin-only">' +
        '<button class="ul-entry-btn" onclick="editUlVBlock(this)">✏ Edit version</button>' +
        '<button class="ul-entry-btn" onclick="addUlEntryToVersion(this)">＋ Entry</button>' +
        '</div></div>' +
        '<div class="ul-entries"></div>';
      if (footer) wrap.insertBefore(vb, footer);
      else wrap.appendChild(vb);
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    stampIds();
    restoreNewVersionBlocks();
    applyUlEdits();
    stampIds();
  });
  // Expose for _ulReapplyAll (called after Supabase pull)
  window._ulApplyEntries = function() {
    stampIds();
    restoreNewVersionBlocks();
    applyUlEdits();
    stampIds();
  };
})();

/* ── VERSION BLOCK EDITOR ── */
(function() {
  let _ulVBlockTarget = null; // the version block element being edited

  window.editUlVBlock = function(btn) {
    if (!isAdmin) return;
    const vb = btn.closest('.ul-version-block');
    _ulVBlockTarget = vb;
    const num  = (vb.querySelector('.ul-v-number') || {}).textContent || '';
    const name = (vb.querySelector('.ul-v-name')   || {}).textContent || '';
    document.getElementById('ul-vblock-number').value = num;
    document.getElementById('ul-vblock-name').value   = name;
    const bg = document.getElementById('ul-vblock-modal-bg');
    bg.style.display = 'flex';
    setTimeout(function() { document.getElementById('ul-vblock-number').focus(); }, 80);
  };

  window.closeUlVBlockEditor = function() {
    document.getElementById('ul-vblock-modal-bg').style.display = 'none';
    _ulVBlockTarget = null;
  };

  window.saveUlVBlock = function() {
    if (!isAdmin || !_ulVBlockTarget) return;
    const num  = document.getElementById('ul-vblock-number').value.trim();
    const name = document.getElementById('ul-vblock-name').value.trim();
    if (!num && !name) { showToast('Enter a version number or name', 'err'); return; }

    // Update DOM
    const numEl  = _ulVBlockTarget.querySelector('.ul-v-number');
    const nameEl = _ulVBlockTarget.querySelector('.ul-v-name');
    if (numEl)  numEl.textContent  = num;
    if (nameEl) nameEl.textContent = name;

    // Persist in _ulState (syncs to Supabase)
    const vid = _ulVBlockTarget.dataset.ulVid;
    if (!window._ulState.vblock_edits) window._ulState.vblock_edits = {};
    window._ulState.vblock_edits[vid] = { num: num, name: name };
    ulStateSave();

    showToast('Version updated', 'ok');
    closeUlVBlockEditor();
  };

  // Re-apply any saved version block title edits on load
  function applyUlVBlockEdits() {
    try {
      const stored = window._ulState.vblock_edits || {};
      Object.keys(stored).forEach(function(vid) {
        const vb = document.querySelector('[data-ul-vid="' + vid + '"]');
        if (!vb) return;
        const e = stored[vid];
        const numEl  = vb.querySelector('.ul-v-number');
        const nameEl = vb.querySelector('.ul-v-name');
        if (numEl  && e.num)  numEl.textContent  = e.num;
        if (nameEl && e.name) nameEl.textContent = e.name;
      });
    } catch(e) {}
  }
  document.addEventListener('DOMContentLoaded', function() {
    applyUlVBlockEdits();
  });
  window._applyUlVBlockEdits = applyUlVBlockEdits;
})();


/* ═══════════════════════════════════════════════════════
   SUBHEADINGS + DRAG & DROP for Update Log  (v2 — clean rewrite)
════════════════════════════════════════════════════════ */
(function() {

  /* ────────────────────────────────────────────────────
     SUBHEADING EDITOR
  ──────────────────────────────────────────────────── */
  var _dividerTarget = null;

  window.openUlSubheading = function(divEl) {
    if (!isAdmin) return;
    _dividerTarget = divEl || null;
    var heading = document.getElementById('ul-subheading-heading');
    var input   = document.getElementById('ul-subheading-text');
    if (_dividerTarget) {
      heading.innerHTML = 'Edit <span>Subheading</span>';
      // Text is stored in data-ul-text attribute for reliability
      input.value = _dividerTarget.dataset.ulText || '';
    } else {
      heading.innerHTML = 'Add <span>Subheading</span>';
      input.value = '';
    }
    var bg = document.getElementById('ul-subheading-modal-bg');
    bg.style.display = 'flex';
    setTimeout(function() { input.focus(); input.select(); }, 60);
  };

  window.closeUlSubheading = function() {
    document.getElementById('ul-subheading-modal-bg').style.display = 'none';
    _dividerTarget = null;
  };

  window.editUlDivider = function(btn) {
    if (!isAdmin) return;
    openUlSubheading(btn.closest('.ul-date-divider'));
  };

  window.deleteUlDivider = function(btn) {
    if (!isAdmin) return;
    if (!confirm('Delete this subheading?')) return;
    var el = btn.closest('.ul-date-divider');
    var id = el.getAttribute('data-ul-div-id');
    if (id) {
      if (!window._ulState.dividers) window._ulState.dividers = {};
      delete window._ulState.dividers[id];
      // Remove from order
      if (window._ulState.order) {
        window._ulState.order = window._ulState.order.filter(function(o) { return o.id !== id; });
      }
      ulStateSave();
    }
    ulRenderFromState();
    showToast('Subheading deleted', 'ok');
  };

  window.saveUlSubheading = function() {
    if (!isAdmin) return;
    var text = document.getElementById('ul-subheading-text').value.trim();
    if (!text) { showToast('Subheading cannot be empty', 'err'); return; }

    if (_dividerTarget) {
      // Update existing
      var id = _dividerTarget.getAttribute('data-ul-div-id');
      if (!window._ulState.dividers) window._ulState.dividers = {};
      if (!window._ulState.dividers[id]) window._ulState.dividers[id] = {};
      window._ulState.dividers[id].text = text;
      ulStateSave();
      ulRenderFromState();
      showToast('Subheading updated', 'ok');
    } else {
      // Create new — add to end of order
      var id = 'div_' + Date.now();
      if (!window._ulState.dividers) window._ulState.dividers = {};
      window._ulState.dividers[id] = { text: text };
      if (!window._ulState.order) window._ulState.order = [];
      window._ulState.order.push({ type: 'divider', id: id });
      ulStateSave();
      ulRenderFromState();
      showToast('Subheading added', 'ok');
    }
    closeUlSubheading();
  };

  function buildDividerEl(id, text) {
    var el = document.createElement('div');
    el.className = 'ul-date-divider ul-draggable';
    el.setAttribute('data-ul-div-id', id);
    el.dataset.ulText = text;
    el.innerHTML =
      '<span class="ul-drag-handle admin-only" title="Drag to reorder">⠿</span>' +
      '<span class="ul-div-label">' + text + '</span>' +
      '<span class="ul-divider-actions admin-only">' +
      '<button class="ul-entry-btn" onclick="editUlDivider(this)">&#9999; Edit</button>' +
      '<button class="ul-entry-btn del" onclick="deleteUlDivider(this)">&#10005;</button>' +
      '</span>';
    return el;
  }

  /* ────────────────────────────────────────────────────
     DRAG & DROP  (pointer-events based — reliable cross-browser)
  ──────────────────────────────────────────────────── */
  var _dragEl   = null;
  var _dragGhost = null;
  var _offsetX  = 0;
  var _offsetY  = 0;
  var _indicator = null;   // the drop-position line

  function getWrapItems() {
    return Array.from(document.querySelectorAll('#ul-dynamic-wrap > .ul-draggable'));
  }

  function getIndicator() {
    if (!_indicator) {
      _indicator = document.createElement('div');
      _indicator.style.cssText = 'height:2px;background:var(--red);border-radius:2px;margin:0;pointer-events:none;display:none;transition:top .08s;position:absolute;left:0;right:0;';
      document.getElementById('ul-dynamic-wrap').appendChild(_indicator);
    }
    return _indicator;
  }

  function bindDrag(el) {
    if (el._ulDragBound) return;
    el._ulDragBound = true;

    var handle = el.querySelector('.ul-drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', function(e) {
      if (!isAdmin) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      var rect = el.getBoundingClientRect();
      _offsetX = e.clientX - rect.left;
      _offsetY = e.clientY - rect.top;
      _dragEl = el;

      // Create ghost
      _dragGhost = el.cloneNode(true);
      _dragGhost.style.cssText =
        'position:fixed;width:' + rect.width + 'px;opacity:0.55;pointer-events:none;' +
        'z-index:9999;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.4);border-radius:var(--radius);' +
        'background:var(--surface2);border:1px solid var(--border2);';
      document.body.appendChild(_dragGhost);

      el.style.opacity = '0.3';
      getIndicator().style.display = 'block';
    });

    handle.addEventListener('pointermove', function(e) {
      if (!_dragEl || _dragEl !== el) return;
      e.preventDefault();
      var x = e.clientX - _offsetX;
      var y = e.clientY - _offsetY;
      _dragGhost.style.left = x + 'px';
      _dragGhost.style.top  = y + 'px';

      // Find insertion point
      var items = getWrapItems().filter(function(i) { return i !== _dragEl; });
      var target = null, before = true;
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        var mid = r.top + r.height / 2;
        if (e.clientY < mid) { target = items[i]; before = true; break; }
        else { target = items[i]; before = false; }
      }
      var ind = getIndicator();
      var wrap = document.querySelector('#tab-updates .ul-wrap');
      var wrapRect = wrap.getBoundingClientRect();
      if (target) {
        var tr = target.getBoundingClientRect();
        ind.style.display = 'block';
        ind.style.position = 'absolute';
        var indY = before
          ? (tr.top - wrapRect.top + wrap.scrollTop - 1)
          : (tr.bottom - wrapRect.top + wrap.scrollTop - 1);
        ind.style.top = indY + 'px';
        ind.style.left = '0';
        ind.style.right = '0';
        ind.style.width = '';
        ind._insertTarget = target;
        ind._insertBefore = before;
      } else {
        ind.style.display = 'none';
        ind._insertTarget = null;
      }
    });

    handle.addEventListener('pointerup', function(e) {
      if (!_dragEl || _dragEl !== el) return;
      commitDrop();
    });

    handle.addEventListener('pointercancel', function() {
      cancelDrag();
    });
  }

  function commitDrop() {
    if (!_dragEl) return;
    var ind = getIndicator();
    var wrap = document.getElementById('ul-dynamic-wrap');
    if (ind._insertTarget) {
      if (ind._insertBefore) {
        wrap.insertBefore(_dragEl, ind._insertTarget);
      } else {
        ind._insertTarget.after(_dragEl);
      }
    }
    cancelDrag();
    saveUlOrder();
  }

  function cancelDrag() {
    if (_dragEl) _dragEl.style.opacity = '';
    if (_dragGhost) _dragGhost.remove();
    var ind = getIndicator();
    ind.style.display = 'none';
    ind._insertTarget = null;
    _dragEl = null;
    _dragGhost = null;
  }

  function enableAllDrag() {
    // Bind top-level blocks (version blocks + dividers)
    getWrapItems().forEach(bindDrag);
    // Bind individual entry rows within each version block
    document.querySelectorAll('#ul-dynamic-wrap .ul-entries .ul-entry.ul-draggable').forEach(function(entry) {
      bindEntryDrag(entry);
    });
  }

  function bindEntryDrag(el) {
    if (el._ulEntryDragBound) return;
    el._ulEntryDragBound = true;
    var handle = el.querySelector('.ul-drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', function(e) {
      if (!isAdmin) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);

      var rect = el.getBoundingClientRect();
      _dragEl = el;
      _dragEl._entryContainer = el.closest('.ul-entries');
      _dragEl._activeEntryContainer = _dragEl._entryContainer;

      _dragGhost = el.cloneNode(true);
      _dragGhost.style.cssText =
        'position:fixed;width:' + rect.width + 'px;opacity:0.55;pointer-events:none;' +
        'z-index:9999;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);background:var(--surface2);border:1px solid var(--border2);';
      document.body.appendChild(_dragGhost);
      el.style.opacity = '0.3';
    });

    handle.addEventListener('pointermove', function(e) {
      if (!_dragEl || _dragEl !== el) return;
      e.preventDefault();
      _dragGhost.style.left = (e.clientX - (el.getBoundingClientRect().width / 2)) + 'px';
      _dragGhost.style.top  = (e.clientY - 14) + 'px';

      // Find which .ul-entries container the cursor is hovering over
      var allContainers = Array.from(document.querySelectorAll('#ul-dynamic-wrap .ul-entries'));
      var hoveredContainer = null;
      for (var ci = 0; ci < allContainers.length; ci++) {
        var cr = allContainers[ci].getBoundingClientRect();
        // Extend hit area: accept if cursor is within horizontal bounds and within 24px vertically
        if (e.clientX >= cr.left && e.clientX <= cr.right &&
            e.clientY >= cr.top - 24 && e.clientY <= cr.bottom + 24) {
          hoveredContainer = allContainers[ci];
          break;
        }
      }
      // Fall back to the original container if cursor isn't over any block
      if (!hoveredContainer) hoveredContainer = _dragEl._entryContainer;

      // Hide indicator on previous container if it changed
      if (_dragEl._activeEntryContainer && _dragEl._activeEntryContainer !== hoveredContainer) {
        var oldInd = getEntryIndicator(_dragEl._activeEntryContainer);
        oldInd.style.display = 'none';
        oldInd._insertTarget = null;
      }
      _dragEl._activeEntryContainer = hoveredContainer;

      var siblings = Array.from(hoveredContainer.querySelectorAll(':scope > .ul-entry.ul-draggable')).filter(function(i) { return i !== _dragEl; });
      var target = null, before = true;
      for (var i = 0; i < siblings.length; i++) {
        var r = siblings[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { target = siblings[i]; before = true; break; }
        else { target = siblings[i]; before = false; }
      }
      var ind = getEntryIndicator(hoveredContainer);
      var cRect = hoveredContainer.getBoundingClientRect();
      if (target) {
        var tr = target.getBoundingClientRect();
        ind.style.display = 'block';
        ind.style.top = (before ? (tr.top - cRect.top - 1) : (tr.bottom - cRect.top - 1)) + 'px';
        ind._insertTarget = target;
        ind._insertBefore = before;
      } else {
        // No siblings or cursor is below all — append to bottom of container
        ind.style.display = 'block';
        ind.style.top = (hoveredContainer.getBoundingClientRect().bottom - cRect.top - 1) + 'px';
        ind._insertTarget = null;
        ind._insertBefore = false;
        ind._appendTo = hoveredContainer;
      }
    });

    handle.addEventListener('pointerup', function() {
      if (!_dragEl || _dragEl !== el) return;
      var container = _dragEl._activeEntryContainer || _dragEl._entryContainer;
      var ind = getEntryIndicator(container);

      if (ind._insertTarget) {
        if (ind._insertBefore) container.insertBefore(_dragEl, ind._insertTarget);
        else ind._insertTarget.after(_dragEl);
      } else if (ind._appendTo) {
        ind._appendTo.appendChild(_dragEl);
      }

      // If entry moved to a different version block, update its versionId in state
      var newVid = container.closest('.ul-version-block') && container.closest('.ul-version-block').getAttribute('data-ul-vid');
      var entryId = _dragEl.dataset.ulId;
      if (newVid && entryId && window._ulState && window._ulState.edits && window._ulState.edits[entryId]) {
        window._ulState.edits[entryId].versionId = newVid;
      }

      // Hide all entry indicators
      document.querySelectorAll('#ul-dynamic-wrap .ul-entries').forEach(function(c) {
        var i = _entryIndicators.get(c);
        if (i) { i.style.display = 'none'; i._insertTarget = null; i._appendTo = null; }
      });

      if (_dragEl) _dragEl.style.opacity = '';
      if (_dragGhost) _dragGhost.remove();
      _dragEl = null; _dragGhost = null;
      saveUlOrder();
    });

    handle.addEventListener('pointercancel', cancelDrag);
  }

  var _entryIndicators = new WeakMap();
  function getEntryIndicator(container) {
    if (!_entryIndicators.has(container)) {
      var ind = document.createElement('div');
      ind.style.cssText = 'height:2px;background:var(--blue);border-radius:2px;pointer-events:none;display:none;position:absolute;left:0;right:0;';
      container.style.position = 'relative';
      container.appendChild(ind);
      _entryIndicators.set(container, ind);
    }
    return _entryIndicators.get(container);
  }

  function applyDragMode() {
    if (isAdmin) {
      document.body.classList.add('ul-admin-drag');
    } else {
      document.body.classList.remove('ul-admin-drag');
    }
    enableAllDrag();
  }
  window._ulApplyDragMode = applyDragMode;
  window._ulEnableAllDrag = enableAllDrag;

  /* ────────────────────────────────────────────────────
     PERSIST & RESTORE ORDER
  ──────────────────────────────────────────────────── */
  function saveUlOrder() {
    var wrap = document.getElementById('ul-dynamic-wrap');
    if (!wrap) return;
    var order = [];
    wrap.querySelectorAll(':scope > .ul-draggable').forEach(function(el) {
      var vid   = el.getAttribute('data-ul-vid');
      var divId = el.getAttribute('data-ul-div-id');
      if (vid)   order.push({ type: 'version', id: vid });
      else if (divId) order.push({ type: 'divider', id: divId });
    });
    window._ulState.order = order;

    // Persist entry order within each version block (supports cross-block drags)
    wrap.querySelectorAll('.ul-version-block').forEach(function(vb) {
      var vid = vb.getAttribute('data-ul-vid');
      if (!vid) return;
      vb.querySelectorAll(':scope .ul-entries > .ul-entry[data-ul-id]').forEach(function(row) {
        var eid = row.getAttribute('data-ul-id');
        if (!eid || !window._ulState.edits) return;
        if (!window._ulState.edits[eid]) window._ulState.edits[eid] = {};
        window._ulState.edits[eid].versionId = vid;
      });
    });

    ulStateSave();
  }

  function restoreUlOrder() {
    // No-op — order is applied via ulRenderFromState
  }

  /* ────────────────────────────────────────────────────
     RESTORE CUSTOM DIVIDERS FROM STATE
  ──────────────────────────────────────────────────── */
  function restoreDividers() {
    // No-op — dividers are rendered via ulRenderFromState
  }

  /* ────────────────────────────────────────────────────
     STAMP IDs + UPDATE HARDCODED DIVIDER STRUCTURE
  ──────────────────────────────────────────────────── */
  function initDividers() {
    // Stamp IDs on hardcoded dividers and fix their inner HTML to use .ul-div-label
    document.querySelectorAll('#tab-updates .ul-date-divider').forEach(function(el, i) {
      if (!el.getAttribute('data-ul-div-id')) el.setAttribute('data-ul-div-id', 'hd_' + i);
      // Rebuild innerHTML for reliable text extraction
      var labelEl = el.querySelector('.ul-div-label');
      if (!labelEl) {
        // Old structure: <span class="ul-drag-handle">...</span><span>TEXT<span actions>...</span></span>
        var spanWrap = el.querySelector('span:not(.ul-drag-handle):not(.ul-divider-actions)');
        var txt = '';
        if (spanWrap) {
          spanWrap.childNodes.forEach(function(n) { if (n.nodeType === 3) txt += n.textContent; });
        }
        txt = txt.trim();
        if (!txt) {
          // fallback: try full text content minus button text
          txt = el.textContent.replace(/✏ Edit|✕|⠿|⣿|⠿/g, '').trim();
        }
        el.dataset.ulText = txt;
        el.innerHTML =
          '<span class="ul-drag-handle admin-only" title="Drag to reorder">⠿</span>' +
          '<span class="ul-div-label">' + txt + '</span>' +
          '<span class="ul-divider-actions admin-only">' +
          '<button class="ul-entry-btn" onclick="editUlDivider(this)">&#9999; Edit</button>' +
          '<button class="ul-entry-btn del" onclick="deleteUlDivider(this)">&#10005;</button>' +
          '</span>';
      } else {
        el.dataset.ulText = labelEl.textContent.trim();
      }
    });
  }

  /* ── Boot ── */
  function ulReapplyAll() {
    ulRenderFromState();
  }
  window._ulReapplyAll = ulReapplyAll;

  document.addEventListener('DOMContentLoaded', function() {
    ulReapplyAll();
  });

})();



function setSyncStatus(s, t) {
  document.getElementById('syncDot').className = 'sync-dot' + (s==='ok'?' ok':s==='err'?' err':'');
  document.getElementById('syncTxt').textContent = t;
}

/* ── Build team stats ─────────────────────────────────────────────
   Takes the raw array of all scouting entries and groups them by team.
   Returns one object per team with calculated averages:
   - avg_pins:     average total pins placed per match
   - awp_pct:      percentage of matches where AWP was achieved
   - sig_count:    how many of their matches were at Sig events
   - routes:       all known auto routes (deduplicated)
   - matches:      the raw match entries (used in the detail card)
──────────────────────────────────────────────────────────────── */
function buildStats(entries) {
  const m = {};
  entries.forEach(e => {
    const k = (e.team||'').toUpperCase().trim(); if(!k) return;
    if(!m[k]) m[k] = {team:k,rows:[],routes:new Set(),types:new Set(),last:''};
    m[k].rows.push(e);
    if(e.route && e.route !== 'Unknown route') m[k].routes.add(e.route);
    if(e.type) m[k].types.add(e.type);
    if((e.created_at||'') > m[k].last) m[k].last = e.created_at||'';
  });
  return Object.values(m).map(g => {
    const rows=g.rows, n=rows.length;
    const totPins=rows.reduce((s,e)=>s+pins(e),0);
    const awpN=rows.filter(e=>e.awp==='Y').length;
    const sigN=rows.filter(e=>e.sig==='yes').length;
    const successN=rows.filter(e=>e.failed==='N').length; // failed==='N' means auton did NOT fail
    return {
      team:g.team, count:n,
      avg_pins:n?(totPins/n).toFixed(2):0,
      awp_pct:n?(awpN/n*100).toFixed(1):0,
      awp_count:awpN, sig_count:sigN,
      success_pct:n?(successN/n*100).toFixed(1):0,
      routes:[...g.routes].join(' · ')||'—',
      types:[...g.types].join(', ')||'—',
      last:g.last, matches:rows
    };
  });
}

/* ═══════════════════════════════════════════════════════
   RFORCE-STYLE RANKINGS
════════════════════════════════════════════════════════ */
function rfRankPoints(rank, total, scale) {
  total = Math.max(1, total || 1);
  scale = scale || 10;
  return Math.round((((1 + (total - rank)) / total) * scale) * 100) / 100;
}

function rfEventLevelMultiplier(eventName, rows) {
  const forced = document.getElementById('rf-platform')?.value || 'all';
  if (forced === 'local') return 1;
  if (forced === 'regional') return 1.25;
  if (forced === 'national') return 1.5;

  const name = String(eventName || '').toLowerCase();
  const sig = rows.some(e => String(e.sig || '').toLowerCase() === 'yes');
  if (name.includes('world')) return 2;
  if (name.includes('national') || name.includes('championship')) return 1.5;
  if (sig || name.includes('signature') || name.includes('regional')) return 1.25;
  return 1;
}

function rfBuildRows() {
  const eventMap = {};
  (allEntries || []).forEach(e => {
    const team = (e.team || '').toUpperCase().trim();
    if (!team) return;
    const eventName = (e.event || 'Unlisted event').trim() || 'Unlisted event';
    const key = eventName.toLowerCase();
    if (!eventMap[key]) eventMap[key] = { name: eventName, rows: [], teams: {} };
    eventMap[key].rows.push(e);
    if (!eventMap[key].teams[team]) eventMap[key].teams[team] = [];
    eventMap[key].teams[team].push(e);
  });

  const teamEventCounts = {};
  Object.values(eventMap).forEach(ev => {
    Object.keys(ev.teams).forEach(team => {
      teamEventCounts[team] = (teamEventCounts[team] || 0) + 1;
    });
  });
  const maxEvents = Math.max(1, ...Object.values(teamEventCounts));

  const teamMap = {};
  Object.values(eventMap).forEach(ev => {
    const eventTeams = Object.keys(ev.teams).map(team => {
      const rows = ev.teams[team];
      const n = rows.length || 1;
      const avgPins = rows.reduce((s, e) => s + pins(e), 0) / n;
      const awp = rows.filter(e => e.awp === 'Y').length / n * 100;
      const success = rows.filter(e => e.failed === 'N').length / n * 100;
      return { team, rows, avgPins, awp, success };
    });

    const rankBy = key => {
      const sorted = eventTeams.slice().sort((a, b) => b[key] - a[key] || a.team.localeCompare(b.team));
      const out = {};
      sorted.forEach((t, i) => { out[t.team] = rfRankPoints(i + 1, sorted.length, 10); });
      return out;
    };

    const pinsRank = rankBy('avgPins');
    const awpRank = rankBy('awp');
    const successRank = rankBy('success');
    const eventCaliber = eventTeams.reduce((s, t) => s + t.avgPins, 0) / Math.max(1, eventTeams.length);
    const level = rfEventLevelMultiplier(ev.name, ev.rows);

    eventTeams.forEach(t => {
      const ep = pinsRank[t.team] + awpRank[t.team] + successRank[t.team];
      const en = teamEventCounts[t.team] || 1;
      const enb = 1 + (((en * en) - 1) / Math.max(1, maxEvents * maxEvents));
      const rfer = 1 + (Math.log10(eventCaliber + 1) * level * enb);
      const es = ep * rfer;
      if (!teamMap[t.team]) {
        teamMap[t.team] = { team: t.team, events: [], totalEs: 0, totalEp: 0, bestEs: 0, avgPins: 0, awp: 0, success: 0 };
      }
      teamMap[t.team].events.push({ event: ev.name, ep, rfer, es });
      teamMap[t.team].totalEs += es;
      teamMap[t.team].totalEp += ep;
      teamMap[t.team].bestEs = Math.max(teamMap[t.team].bestEs, es);
      teamMap[t.team].avgPins += t.avgPins;
      teamMap[t.team].awp += t.awp;
      teamMap[t.team].success += t.success;
    });
  });

  return Object.values(teamMap).map(t => {
    const n = Math.max(1, t.events.length);
    return {
      team: t.team,
      events: n,
      rforce: t.totalEs / n,
      avgEp: t.totalEp / n,
      bestEs: t.bestEs,
      avgPins: t.avgPins / n,
      awp: t.awp / n,
      success: t.success / n
    };
  });
}

function rfAddCombinedScores(rows) {
  const rfMax = Math.max(1, ...rows.map(r => r.rforce || 0));
  return rows.map(r => {
    const ts = typeof tsGet === 'function' ? tsGet(r.team) : null;
    const rfNorm = Math.min(100, ((r.rforce || 0) / rfMax) * 100);
    const tsNorm = ts ? Math.max(0, Math.min(100, ((ts.ts || 0) / 50) * 100)) : 0;
    return {
      ...r,
      ts,
      tsScore: ts ? ts.ts : null,
      tsRank: ts ? ts.ts_rank : null,
      rfNorm,
      tsNorm,
      combined: (rfNorm * 0.6) + (tsNorm * 0.4)
    };
  });
}

function renderRforce() {
  const body = document.getElementById('rf-tbody');
  if (!body) return;
  const q = (document.getElementById('rf-search')?.value || '').trim().toUpperCase();
  const sort = document.getElementById('rf-sort')?.value || 'combined';
  let rows = rfAddCombinedScores(rfBuildRows());
  if (q) rows = rows.filter(r => r.team.includes(q));

  rows.sort((a, b) => {
    if (sort === 'team') return a.team.localeCompare(b.team);
    if (sort === 'ts') return (b.tsScore || -1) - (a.tsScore || -1) || a.team.localeCompare(b.team);
    return (b[sort] || 0) - (a[sort] || 0) || a.team.localeCompare(b.team);
  });

  const allRows = rfAddCombinedScores(rfBuildRows());
  const top = allRows.length ? Math.max(...allRows.map(r => r.rforce)) : 0;
  const avg = allRows.length ? allRows.reduce((s, r) => s + r.rforce, 0) / allRows.length : 0;
  const events = new Set((allEntries || []).map(e => (e.event || 'Unlisted event').trim() || 'Unlisted event'));
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setText('rf-stat-teams', allRows.length);
  setText('rf-stat-events', events.size);
  setText('rf-stat-top', top ? top.toFixed(2) : '—');
  setText('rf-stat-avg', avg ? avg.toFixed(2) : '—');

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">No combined rankings yet. Add scouting entries with team and event names first.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((r, i) => {
    const color = i === 0 ? 'var(--amber)' : i === 1 ? 'var(--ink2)' : i === 2 ? '#cd7f32' : 'var(--ink3)';
    const tsLabel = r.ts
      ? `<span style="font-family:var(--mono);font-weight:700;color:var(--blue)">${r.tsScore.toFixed(1)}</span><div style="font-size:10px;color:var(--ink3);font-family:var(--mono)">#${Math.round(r.tsRank)}</div>`
      : '<span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">No TS</span>';
    return `<tr onclick="openDetail('${esc(r.team)}')" style="cursor:pointer">
      <td style="font-family:var(--mono);font-weight:800;color:${color}">#${i + 1}</td>
      <td><span class="tn">${esc(r.team)}</span></td>
      <td style="font-family:var(--mono);font-weight:900;color:var(--green)">${r.combined.toFixed(1)}</td>
      <td style="font-family:var(--mono);font-weight:800;color:var(--amber)">${r.rforce.toFixed(2)}</td>
      <td>${tsLabel}</td>
      <td style="font-family:var(--mono)">${r.events}</td>
      <td style="font-family:var(--mono)">${r.avgEp.toFixed(2)}</td>
      <td style="font-family:var(--mono)">${r.bestEs.toFixed(2)}</td>
      <td style="font-family:var(--mono)">${r.avgPins.toFixed(1)}</td>
      <td style="font-family:var(--mono)">${r.awp.toFixed(0)}%</td>
      <td style="font-family:var(--mono)">${r.success.toFixed(0)}%</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════
   TEST RANKINGS — OPR / DPR / CCWM / OpenSkill
   ─────────────────────────────────────────────────────
   OPR  = avg pins per entry (offensive output)
   DPR  = avg field advantage conceded vs event mean
   CCWM = OPR − DPR

   OpenSkill — Weng-Lin Bradley-Terry Full model
   (Weng & Lin, JMLR 2011, §3.1)
   μ₀=25, σ₀=25/3, β=25/6, κ=0.0001, τ=25/300

   Per entry, team plays 1v1 vs "field" rating
   (field = event avg pins mapped to a virtual player μ_f).
   Win  = team pins > field μ_f
   Loss = team pins ≤ field μ_f
   Ordinal = μ − 3σ  (99.7% lower bound, same as openskill.js)
════════════════════════════════════════════════════════ */

// ── Weng-Lin helpers ──
const _OS_MU    = 25;
const _OS_SIG   = 25 / 3;          // ≈ 8.333
const _OS_BETA  = 25 / 6;          // ≈ 4.167
const _OS_TAU   = 25 / 300;        // dynamic factor (≈ 0.0833)
const _OS_KAPPA = 0.0001;          // σ floor multiplier

// Standard normal PDF and CDF (erf-based, matches Python NormalDist)
function _osPhi(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
function _osCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const approx = 1 - _osPhi(Math.abs(x)) * poly;
  return x >= 0 ? approx : 1 - approx;
}

// Bradley-Terry Full: update one player against one opponent
// rank: 1=win, 2=loss (lower rank = better)
function _osUpdate(player, opponent, rank_player, rank_opponent) {
  const { mu: mu_i, sigma: sig_i } = player;
  const { mu: mu_q, sigma: sig_q } = opponent;

  const c = Math.sqrt(sig_i * sig_i + sig_q * sig_q + 2 * _OS_BETA * _OS_BETA);
  const p_iq = _osCDF((mu_i - mu_q) / c);         // P(i beats q)

  // s(i,q): 1 if i wins, 0 if i loses
  const s = rank_player < rank_opponent ? 1 : 0;

  const delta = (sig_i * sig_i / c) * (s - p_iq);
  const eta   = (sig_i * sig_i / (c * c)) * p_iq * (1 - p_iq);

  // Apply dynamic factor τ then floor σ at κ·σ₀
  const sig_new = Math.sqrt(
    Math.max(sig_i * sig_i * (1 - eta) + _OS_TAU * _OS_TAU, (_OS_KAPPA * _OS_SIG) ** 2)
  );

  return { mu: mu_i + delta, sigma: sig_new };
}

// Ordinal = μ − 3σ (conservative lower bound)
function _osOrdinal(r) { return r.mu - 3 * r.sigma; }

let _trRows = [];

function trBuild() {
  const entries = (allEntries || []).filter(e => (e.team||'').trim());

  // ── per-event stats ──
  const eventPinMap = {};
  entries.forEach(e => {
    const ev = (e.event || 'Unknown').trim();
    if (!eventPinMap[ev]) eventPinMap[ev] = [];
    eventPinMap[ev].push(pins(e));
  });
  const eventAvg = {};
  Object.keys(eventPinMap).forEach(ev => {
    const arr = eventPinMap[ev];
    eventAvg[ev] = arr.reduce((a,b)=>a+b,0) / arr.length;
  });

  // ── per-team entry grouping ──
  const teamMap = {};
  entries.forEach(e => {
    const t = (e.team||'').toUpperCase().trim();
    if (!teamMap[t]) teamMap[t] = [];
    teamMap[t].push(e);
  });

  // ── Weng-Lin state per team ──
  const os = {};
  Object.keys(teamMap).forEach(t => { os[t] = { mu: _OS_MU, sigma: _OS_SIG }; });

  // "Field" virtual player: fixed at μ=25 (league-average opponent)
  // Each entry: team's pins vs event average — rescale to [0, 50] rating space
  // Win = pins >= event avg; field mu = 25 (neutral)
  const sorted = entries.slice().sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
  sorted.forEach(e => {
    const t = (e.team||'').toUpperCase().trim();
    if (!os[t]) return;
    const ev    = (e.event || 'Unknown').trim();
    const avg   = eventAvg[ev] || 0;
    const score = pins(e);

    // Field opponent: fixed at league average (mu=25, sigma=sigma₀/2 — somewhat known)
    const field = { mu: _OS_MU, sigma: _OS_SIG / 2 };
    const rank_team  = score >= avg ? 1 : 2;   // 1 = win, 2 = loss
    const rank_field = 3 - rank_team;           // opposite

    os[t] = _osUpdate(os[t], field, rank_team, rank_field);
  });

  // ── Build final rows ──
  _trRows = Object.entries(teamMap).map(([team, rows]) => {
    const n   = rows.length;
    const opr = rows.reduce((s,e)=>s+pins(e),0) / n;

    const dpr = rows.reduce((s,e) => {
      const ev  = (e.event||'Unknown').trim();
      const avg = eventAvg[ev] || 0;
      return s + Math.max(0, avg - pins(e));
    }, 0) / n;

    const ccwm    = opr - dpr;
    const rating  = os[team];
    const ordinal = _osOrdinal(rating);
    return { team, opr, dpr, ccwm, mu: rating.mu, sigma: rating.sigma, ordinal, matches: n };
  });

  if (_trRows.length) {
    const topOpr = Math.max(..._trRows.map(r=>r.opr));
    const topOs  = Math.max(..._trRows.map(r=>r.ordinal));
    document.getElementById('tr-stat-teams').textContent   = _trRows.length;
    document.getElementById('tr-stat-opr').textContent     = topOpr.toFixed(2);
    document.getElementById('tr-stat-os').textContent      = topOs.toFixed(2);
    document.getElementById('tr-stat-entries').textContent = entries.length;
  }

  trRender();
}

function trRender() {
  const body = document.getElementById('tr-tbody');
  if (!body) return;
  if (!_trRows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No data — entries needed to calculate rankings.</td></tr>';
    return;
  }
  const q    = (document.getElementById('tr-search')?.value || '').trim().toUpperCase();
  const sort = document.getElementById('tr-sort')?.value || 'ordinal';

  let rows = q ? _trRows.filter(r => r.team.includes(q)) : _trRows.slice();
  const dir = sort === 'dpr' ? 1 : -1;
  rows.sort((a,b) => dir * (b[sort] - a[sort]));

  const osMax  = Math.max(0.001, ...rows.map(r => Math.max(0, r.ordinal)));
  const oprMax = Math.max(0.001, ...rows.map(r=>r.opr));

  body.innerHTML = rows.map((r, i) => {
    const ccwmColor = r.ccwm >= 0 ? 'var(--green)' : 'var(--red-text)';
    const osBar  = Math.max(0, Math.round((Math.max(0, r.ordinal) / osMax) * 60));
    const oprBar = Math.max(0, Math.round((r.opr / oprMax) * 60));
    return `<tr>
      <td style="font-family:var(--mono);color:var(--ink3)">${i+1}</td>
      <td style="font-family:var(--mono);font-weight:700">${esc(r.team)}</td>
      <td>
        <div style="font-family:var(--mono);font-weight:800;color:var(--blue)">${r.ordinal.toFixed(2)}</div>
        <div style="height:3px;background:var(--border);border-radius:2px;width:60px;margin-top:3px;overflow:hidden">
          <div style="height:100%;width:${osBar}px;background:var(--blue);border-radius:2px"></div>
        </div>
        <div style="font-size:9px;font-family:var(--mono);color:var(--ink3);margin-top:2px">μ=${r.mu.toFixed(2)} σ=${r.sigma.toFixed(2)}</div>
      </td>
      <td>
        <div style="font-family:var(--mono);font-weight:700;color:var(--amber)">${r.opr.toFixed(2)}</div>
        <div style="height:3px;background:var(--border);border-radius:2px;width:60px;margin-top:3px;overflow:hidden">
          <div style="height:100%;width:${oprBar}px;background:var(--amber);border-radius:2px"></div>
        </div>
      </td>
      <td style="font-family:var(--mono);color:var(--ink2)">${r.dpr.toFixed(2)}</td>
      <td style="font-family:var(--mono);font-weight:700;color:${ccwmColor}">${r.ccwm >= 0 ? '+' : ''}${r.ccwm.toFixed(2)}</td>
      <td style="font-family:var(--mono);color:var(--ink3)">${r.matches}</td>
    </tr>`;
  }).join('');
}


/* ═══════════════════════════════════════════════════════
   PUBLIC SEARCH (embedded in leaderboard tab)
════════════════════════════════════════════════════════ */
function pubRenderAll() {
  // Search result panel is hidden by default; shown on search
}

function pubDoSearch() {
  const resultEl = document.getElementById('pubResult');
  if (resultEl) resultEl.style.display = 'block';
  const q = document.getElementById('pubSearch')?.value.trim().toUpperCase();
  if(!q) { pubRenderAll(); return; }
  const res = allTeams.filter(t => t.team.includes(q));
  if(!res.length) {
    // No scouting data — check TrueSkill DB before giving up
    const ts = tsGet(q);
    if(ts) {
      const qual = ts.qualified ? '<span class="badge b-awp" style="font-size:10px;margin-left:6px">✅ Worlds Qualified</span>' : '';
      document.getElementById('pubResult').innerHTML = `
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--blue)">${esc(q)}</div>
            ${qual}
          </div>
          <div style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--ink3);margin-bottom:10px">
            No autonomous scouting entries yet — TrueSkill data from Worlds 2026 qualifier events
          </div>
          <div class="g4" style="margin-bottom:12px">
            <div class="sbox"><div class="sbox-l">TrueSkill</div><div class="sbox-v" style="color:var(--blue)">${ts.ts.toFixed(1)}</div></div>
            <div class="sbox"><div class="sbox-l">TS Rank</div><div class="sbox-v">#${Math.round(ts.ts_rank)}</div></div>
            <div class="sbox"><div class="sbox-l">W/L</div><div class="sbox-v" style="font-size:15px">${ts.wins}–${ts.losses}</div></div>
            <div class="sbox"><div class="sbox-l">Win %</div><div class="sbox-v">${ts.wp_pct}%</div></div>
          </div>
          <div class="g4" style="margin-bottom:12px">
            <div class="sbox"><div class="sbox-l">μ (mean)</div><div class="sbox-v" style="font-size:15px">${ts.mu.toFixed(1)}</div></div>
            <div class="sbox"><div class="sbox-l">σ (sigma)</div><div class="sbox-v" style="font-size:15px">${ts.sigma.toFixed(2)}</div></div>
            <div class="sbox"><div class="sbox-l">CCWM</div><div class="sbox-v" style="font-size:15px">${ts.ccwm.toFixed(1)}</div></div>
            <div class="sbox"><div class="sbox-l">OPR</div><div class="sbox-v" style="font-size:15px">${ts.opr.toFixed(1)}</div></div>
          </div>
          <div class="dr"><span class="dk">AutoMax (best single-match auto score)</span><span class="dv" style="font-weight:700;color:var(--ink)">${ts.auto_max} pts</span></div>
          <div class="dr"><span class="dk">AWP / match</span><span class="dv">${(ts.awp_per_match*100).toFixed(0)}%</span></div>
          <div class="dr"><span class="dk">Driver Max</span><span class="dv">${ts.driver_max} pts</span></div>
          <div class="dr"><span class="dk">Total Max (best full match)</span><span class="dv">${ts.total_max} pts</span></div>
          <div style="margin-top:10px;font-size:11px;color:var(--ink3);font-family:var(--mono)">Add a scouting entry for this team under the Scout Log tab to track their autonomous routines here.</div>
        </div>`;
    } else {
      document.getElementById('pubResult').innerHTML = `<div class="empty">No data found for "${esc(q)}".<br>Check the team number and try again.</div>`;
    }
    return;
  }
  if(res.length === 1) { openDetail(res[0]); return; }
  // Multiple matches — show mini table
  document.getElementById('pubResult').innerHTML = `
    <div class="card">
      <p class="sec">${res.length} teams matching "${esc(q)}"</p>
      <div class="tw"><table>
        <thead><tr><th>Team</th><th>Matches</th><th>Avg Pins</th><th>AWP Rate</th><th>Robot Type</th></tr></thead>
        <tbody>
          ${res.map(t=>`<tr data-team="${esc(t.team)}" style="cursor:pointer">
            <td><span class="tn">${esc(t.team)}</span></td>
            <td style="font-family:var(--mono)">${t.count}</td>
            <td style="font-family:var(--mono);font-weight:600">${parseFloat(t.avg_pins).toFixed(1)}</td>
            <td style="font-family:var(--mono)">${(parseFloat(t.awp_pct)||0).toFixed(0)}%</td>
            <td style="font-size:12px;color:var(--ink2)">${esc(t.types)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   LEADERBOARD TAB
════════════════════════════════════════════════════════ */
const LB_PG = 25;
let lbFiltered = [], lbPg = 1, lbSortC = 'avg_pins', lbSortD = 1, lbActiveF = 'all';

function lbFilter(f, el) {
  document.querySelectorAll('#tab-leaderboard .chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on'); lbActiveF=f; lbPg=1; lbApplyFilter(f);
}
function lbApplyFilter(f) {
  if(f==='all') lbFiltered=[...allTeams];
  else if(f==='sig') lbFiltered=allTeams.filter(t=>t.sig_count>0);
  else if(f==='awp') lbFiltered=allTeams.filter(t=>t.awp_count>0);
  else if(f==='top') {
    // Force sort state to avg_pins descending so lbSortRender doesn't override the intended order
    lbSortC='avg_pins'; lbSortD=1;
    lbFiltered=[...allTeams];
  }
  // Skip DOM work when the leaderboard tab isn't visible; switchTab will flush.
  if (!_isTabActive('leaderboard')) { _lbDirty = true; return; }
  _lbDirty = false;
  lbSortRender();
}
function lbSortBy(col) {
  if(lbSortC===col) lbSortD*=-1; else{lbSortC=col;lbSortD=1;}
  document.querySelectorAll('th.sorted').forEach(e=>e.classList.remove('sorted'));
  document.getElementById('lbth-'+col)?.classList.add('sorted');
  lbSortRender();
}
function lbSortRender() {
  lbFiltered.sort((a,b)=>{
    const d=(parseFloat(b[lbSortC])||0)-(parseFloat(a[lbSortC])||0);
    return d*lbSortD || a.team.localeCompare(b.team);
  });
  lbRender();
}

let _gradeCache = {};
try { _gradeCache = JSON.parse(localStorage.getItem('os_grade_cache') || '{}'); } catch(e) {}
let _gradesToFetch = new Set();
let _fetchGradesTimer = null;

function getGradeBadgeHTML(team) {
  if (!team) return '';
  const g = _gradeCache[team];
  if (g === 'High School') return '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:rgba(0,100,255,.1);color:var(--blue);border:1px solid rgba(0,100,255,.2);margin-left:5px;vertical-align:middle">HS</span>';
  if (g === 'Middle School') return '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:rgba(150,50,255,.1);color:#9333ea;border:1px solid rgba(150,50,255,.2);margin-left:5px;vertical-align:middle">MS</span>';
  
  if (!g) {
    _gradesToFetch.add(team);
    if (!_fetchGradesTimer) _fetchGradesTimer = setTimeout(flushGradesFetch, 800);
  }
  return '';
}

async function flushGradesFetch() {
  _fetchGradesTimer = null;
  const token = typeof getREToken === 'function' ? getREToken() : null;
  if (!token) {
    _gradesToFetch.forEach(t => _gradeCache[t] = 'Unknown');
    _gradesToFetch.clear();
    return;
  }
  const teams = Array.from(_gradesToFetch);
  _gradesToFetch.clear();
  if (!teams.length) return;
  
  let changed = false;
  for (let i = 0; i < teams.length; i += 40) {
    const chunk = teams.slice(i, i + 40);
    const query = chunk.map(t => 'number[]=' + encodeURIComponent(t)).join('&');
    try {
      // Route through Supabase proxy to avoid CORS
      const res = await reProxyFetch('/teams?' + query + '&program[]=1', {}, token).catch(() =>
        reProxyFetch('/teams', Object.fromEntries([...chunk.map(t => ['number[]', t]), ['program[]', '1']]), token)
      );
      
      const fetchedMap = {};
      if (res && res.data) {
        res.data.forEach(t => { fetchedMap[t.number] = t.grade; });
      }
      chunk.forEach(t => {
        _gradeCache[t] = fetchedMap[t] || 'Not Found';
      });
      changed = true;
    } catch(e) {
      console.warn("Failed to fetch grades", e);
    }
  }
  
  if (changed) {
    localStorage.setItem('os_grade_cache', JSON.stringify(_gradeCache));
    if (typeof _isTabActive === 'function') {
      if (_isTabActive('leaderboard') && typeof lbRender === 'function') lbRender();
      if (_isTabActive('skills') && typeof skRender === 'function') skRender();
    }
  }
}

function lbRender() {
  const start=(lbPg-1)*LB_PG, sl=lbFiltered.slice(start,start+LB_PG), tot=lbFiltered.length, pages=Math.ceil(tot/LB_PG);
  if(!sl.length){ 
    document.getElementById('lbMain').innerHTML = allTeams.length === 0
      ? '<div class="empty"><span class="spin"></span><br><br>Loading…</div>'
      : '<div class="empty">No teams match this filter.</div>';
    return; 
  }
  const medals = ['🥇','🥈','🥉'];
  const myTeam = (localStorage.getItem('os_my_team')||'').toUpperCase().trim();
  const rival   = (localStorage.getItem('os_rival_team')||'').toUpperCase().trim();
  const maxPins = Math.max(...sl.map(t=>parseFloat(t.avg_pins)||0), 1);
  const sortArrow = col => lbSortC===col ? (lbSortD===1?'↓':'↑') : '';

  document.getElementById('lbMain').innerHTML=`
    <div class="lb-grid-wrap" style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface)">
      <!-- Header -->
      <div style="display:grid;grid-template-columns:56px 1fr 80px 120px 120px 1fr;gap:0;background:var(--paper2);border-bottom:1px solid var(--border2)">
        <div style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);font-weight:600">#</div>
        <div onclick="lbSortBy('team')" id="lbth-team"   style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${lbSortC==='team'?'var(--amber)':'var(--ink3)'};font-weight:600;cursor:pointer;user-select:none;transition:color .12s" onmouseover="this.style.color='var(--ink)'" onmouseout="this.style.color='${lbSortC==='team'?'var(--amber)':'var(--ink3)'}'">Team ${sortArrow('team')}</div>
        <div onclick="lbSortBy('count')" id="lbth-count" style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${lbSortC==='count'?'var(--amber)':'var(--ink3)'};font-weight:600;cursor:pointer;user-select:none;transition:color .12s" onmouseover="this.style.color='var(--ink)'" onmouseout="this.style.color='${lbSortC==='count'?'var(--amber)':'var(--ink3)'}'">Matches ${sortArrow('count')}</div>
        <div onclick="lbSortBy('avg_pins')" id="lbth-avg_pins" style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${lbSortC==='avg_pins'?'var(--amber)':'var(--ink3)'};font-weight:600;cursor:pointer;user-select:none;transition:color .12s" onmouseover="this.style.color='var(--ink)'" onmouseout="this.style.color='${lbSortC==='avg_pins'?'var(--amber)':'var(--ink3)'}'">Avg Pins ${sortArrow('avg_pins')}</div>
        <div onclick="lbSortBy('awp_pct')" id="lbth-awp_pct" style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${lbSortC==='awp_pct'?'var(--amber)':'var(--ink3)'};font-weight:600;cursor:pointer;user-select:none;transition:color .12s" onmouseover="this.style.color='var(--ink)'" onmouseout="this.style.color='${lbSortC==='awp_pct'?'var(--amber)':'var(--ink3)'}'">AWP Rate ${sortArrow('awp_pct')}</div>
        <div style="padding:10px 12px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);font-weight:600">Robot</div>
      </div>
      <!-- Rows -->
      ${sl.map((t,i)=>{
        const rank = start+i+1;
        const medal = rank<=3 ? `<span style="font-size:15px;line-height:1">${medals[rank-1]}</span>` : '';
        const isMe = myTeam && t.team===myTeam;
        const isRival = rival && t.team===rival;
        const rowBg = isMe ? 'background:rgba(240,192,48,.06);border-left:2px solid var(--amber);'
                    : isRival ? 'background:rgba(204,61,20,.05);border-left:2px solid var(--red);'
                    : 'border-left:2px solid transparent;';
        const avgPins = parseFloat(t.avg_pins)||0;
        const awpPct  = parseFloat(t.awp_pct)||0;
        const pinPct  = Math.round(avgPins/maxPins*100);
        const pinColor = avgPins>=6?'var(--green)':avgPins>=3?'var(--amber)':'var(--red)';
        const tsInfo = typeof tsGet==='function' ? tsGet(t.team) : null;
        const worldsBadge = tsInfo?.qualified ? '<span style="display:inline-flex;align-items:center;font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:rgba(61,189,110,.15);color:var(--green);border:1px solid rgba(61,189,110,.3);margin-left:5px;vertical-align:middle">✅ WQ</span>' : '';
        return `<div data-team-id="${esc(t.team)}" style="display:grid;grid-template-columns:56px 1fr 80px 120px 120px 1fr;gap:0;${rowBg}border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s" onmouseover="this.style.background='var(--paper3)'" onmouseout="this.style.background='${isMe?'rgba(240,192,48,.06)':isRival?'rgba(204,61,20,.05)':'transparent'}'">
          <!-- Rank -->
          <div style="padding:13px 12px;display:flex;align-items:center;justify-content:center;gap:4px;flex-direction:column">
            ${medal || `<span style="font-family:var(--mono);font-size:11px;color:var(--ink3)">${rank}</span>`}
          </div>
          <!-- Team -->
          <div style="padding:13px 12px;display:flex;flex-direction:column;justify-content:center;gap:3px">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--ink)">${esc(t.team)}</span>
              ${isMe ? '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:rgba(240,192,48,.15);color:var(--amber);border:1px solid rgba(240,192,48,.3)">YOU</span>' : ''}
              ${worldsBadge}
              ${getGradeBadgeHTML(t.team)}
            </div>
            <div style="font-size:10px;color:var(--ink3);font-family:var(--mono)">${esc(t.types||'—')}</div>
          </div>
          <!-- Matches -->
          <div style="padding:13px 12px;display:flex;align-items:center">
            <span style="font-family:var(--mono);font-size:13px;color:var(--ink2)">${t.count}</span>
          </div>
          <!-- Avg Pins -->
          <div style="padding:13px 12px;display:flex;flex-direction:column;justify-content:center;gap:5px">
            <span style="font-family:var(--mono);font-size:15px;font-weight:700;color:${pinColor}">${avgPins.toFixed(1)}</span>
            <div style="height:3px;background:var(--border2);border-radius:2px;width:70px;overflow:hidden">
              <div style="height:3px;background:${pinColor};border-radius:2px;width:${pinPct}%;transition:width .3s"></div>
            </div>
          </div>
          <!-- AWP Rate -->
          <div style="padding:13px 12px;display:flex;flex-direction:column;justify-content:center;gap:5px">
            <span style="font-family:var(--mono);font-size:13px;color:${awpPct>=50?'var(--green)':awpPct>=20?'var(--amber)':'var(--ink2)'};font-weight:600">${awpPct.toFixed(0)}%</span>
            <div style="height:3px;background:var(--border2);border-radius:2px;width:70px;overflow:hidden">
              <div style="height:3px;background:var(--green);border-radius:2px;width:${Math.min(awpPct,100)}%;transition:width .3s"></div>
            </div>
          </div>
          <!-- Robot type -->
          <div style="padding:13px 12px;display:flex;align-items:center">
            <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">${esc(t.types||'—')}</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  const pg=document.getElementById('lbPager');
  if(pages>1){
    pg.style.display='flex';
    document.getElementById('lbPi').textContent=`Page ${lbPg} of ${pages} (${tot} teams)`;
    document.getElementById('lbPrev').disabled=lbPg===1;
    document.getElementById('lbNext').disabled=lbPg===pages;
  } else pg.style.display='none';

  // Bind clicks for team rows (replaces inline onclick with double-serialized JSON)
  document.getElementById('lbMain').querySelectorAll('[data-team-id]').forEach(el => {
    el.addEventListener('click', function() {
      const t = teamDetailMap[this.dataset.teamId] || allTeams.find(x => x.team === this.dataset.teamId);
      if (t) openDetail(t);
    });
  });
}
function lbDoSearch() {
  const res = document.getElementById('pubResult');
  if (res) res.style.display = 'block';
  const clr = document.getElementById('lb-search-clear');
  if (clr) clr.style.display = 'block';
  pubDoSearch();
}
function lbClearSearch() {
  const inp = document.getElementById('pubSearch');
  if (inp) inp.value = '';
  const res = document.getElementById('pubResult');
  if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  const clr = document.getElementById('lb-search-clear');
  if (clr) clr.style.display = 'none';
}


/* ═══════════════════════════════════════════════════════
   DETAIL OVERLAY (shared)
════════════════════════════════════════════════════════ */
function openDetail(t) {
  if(typeof t==='string') {
    // Try as JSON first; if that fails, treat as a team number and look it up
    try { t=JSON.parse(t); } catch(_) {
      t = teamDetailMap[t] || allTeams.find(x=>x.team===t) || lbFiltered.find(x=>x.team===t);
      if(!t) return;
    }
  }
  const awpPct=parseFloat(t.awp_pct||0);
  const routes=(t.routes||'—').split(' · ').map(r=>`<code>${esc(r)}</code>`).join(' ');
  document.getElementById('dc').innerHTML=`
    <div class="dc-team">${esc(t.team)}</div>
    <div class="dc-sub">${esc(t.types)} · ${t.count} match${t.count!==1?'es':''} scouted</div>
    <div class="sgrid">
      <div class="sbox"><div class="sbox-l">Matches</div><div class="sbox-v">${t.count}</div></div>
      <div class="sbox"><div class="sbox-l">Avg Pins</div><div class="sbox-v">${parseFloat(t.avg_pins).toFixed(1)}</div></div>
      <div class="sbox"><div class="sbox-l">AWP Rate</div><div class="sbox-v">${awpPct.toFixed(0)}%</div></div>
      <div class="sbox" style="cursor:pointer;position:relative" onclick="this.querySelector('.success-detail').style.display=this.querySelector('.success-detail').style.display==='block'?'none':'block'">
        <div class="sbox-l">Success %</div>
        <div class="sbox-v" style="color:var(--green)">${parseFloat(t.success_pct||0).toFixed(0)}%</div>
        <div class="success-detail" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--paper);border:1px solid var(--paper3);border-radius:var(--radius);padding:8px;font-size:11px;color:var(--ink2);z-index:10;box-shadow:2px 2px 6px rgba(0,0,0,.12);white-space:normal;font-family:var(--mono)">
          Matches recorded as "auton did NOT fail": <strong>${parseFloat(t.success_pct||0).toFixed(0)}%</strong> (${Math.round(parseFloat(t.success_pct||0)/100*t.count)}/${t.count})
        </div>
      </div>
    </div>
    <div class="dr"><span class="dk">AWP achieved</span><span class="dv">${t.awp_count} / ${t.count}</span></div>
    <div class="dr"><span class="dk">Known routes</span><span class="dv">${routes}</span></div>
    <div class="dr"><span class="dk">Robot types</span><span class="dv">${esc(t.types)}</span></div>
    <div class="dr"><span class="dk">Last scouted</span><span class="dv">${t.last?new Date(t.last).toLocaleDateString():'—'}</span></div>
    ${t.matches&&t.matches.length?`
    <div class="mh-hd">Match history (${t.matches.length})</div>
    ${t.matches.slice(0,20).map(e=>`
      <div class="mh-row">
        <span style="font-size:11px;color:var(--ink2)">${esc(e.event||'—')}</span>
        <span style="font-family:var(--mono);font-size:11px">${esc(e.round||'—')}</span>
        <span style="font-family:var(--mono);font-size:11px">${formatMatchPins(e.pins)}</span>
        <span><span class="badge ${e.awp==='Y'?'b-awp':'b-no'}">${esc(e.awp||'N')}</span></span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--ink3)">${esc(e.side||'')}</span>
      </div>`).join('')}
    ${t.matches.length>20?`<div style="font-size:11px;color:var(--ink3);padding-top:6px;font-family:var(--mono)">+${t.matches.length-20} more</div>`:''}
    `:''}
    ${(()=>{
      const ts = tsGet(t.team);
      if(!ts) return '';
      const qual = ts.qualified ? '<span class="badge b-awp" style="font-size:10px">✅ Worlds</span>' : '';
      return `<div style="margin:14px 0 10px;padding:10px 12px;background:var(--blue-bg);border-radius:var(--radius);border-left:3px solid var(--blue)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--blue);font-weight:600">⚙️ TrueSkill (Worlds 2026 Data)</span>
          ${qual}
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">
          <div class="sbox"><div class="sbox-l">TS Score</div><div class="sbox-v" style="color:var(--blue);font-size:16px">${ts.ts.toFixed(1)}</div></div>
          <div class="sbox"><div class="sbox-l">TS Rank</div><div class="sbox-v" style="font-size:16px">#${Math.round(ts.ts_rank)}</div></div>
          <div class="sbox"><div class="sbox-l">W/L</div><div class="sbox-v" style="font-size:14px">${ts.wins}–${ts.losses}</div></div>
          <div class="sbox"><div class="sbox-l">AutoMax</div><div class="sbox-v" style="font-size:16px">${ts.auto_max}pts</div></div>
        </div>
        <div style="font-size:11px;color:var(--ink2);font-family:var(--mono)">μ=${ts.mu.toFixed(1)} · σ=${ts.sigma.toFixed(2)} · CCWM ${ts.ccwm.toFixed(1)} · AWP/match ${(ts.awp_per_match*100).toFixed(0)}%</div>
      </div>`;
    })()}
    <button class="re-expand-btn" id="re-expand-btn" onclick="toggleREProfile('${esc(t.team)}')">
      🌐 Expand — Full Team Profile (RobotEvents)
    </button>
    <div id="re-profile-panel"></div>
    ${(()=>{
      const pit = getPitDataForTeam ? getPitDataForTeam(t.team) : null;
      if (!pit) return '';
      return `<div style="margin:14px 0 0;padding:10px 12px;background:var(--green-bg);border-radius:var(--radius);border-left:3px solid var(--green)">
        <div style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--green);font-weight:600;margin-bottom:8px">🤖 Pit Scout Data</div>
        <div style="font-size:12px;color:var(--ink2);line-height:1.7">
          ${pit.drive ? '<div><strong>Drive:</strong> '+esc(pit.drive)+(pit.motors?' · '+esc(pit.motors):'')+'</div>' : ''}
          ${pit.type  ? '<div><strong>Robot:</strong> '+esc(pit.type)+(pit.lift?' · '+esc(pit.lift):'')+'</div>' : ''}
          ${pit.routes ? '<div><strong>Routes:</strong> '+esc(pit.routes)+'</div>' : ''}
          ${pit.best_auton ? '<div><strong>Best auton:</strong> '+esc(pit.best_auton)+'</div>' : ''}
          ${pit.sawp  ? '<div><strong>SAWP capable:</strong> '+esc(pit.sawp)+'</div>' : ''}
          ${pit.notes ? '<div style="margin-top:4px;font-style:italic;color:var(--ink3)">'+esc(pit.notes)+'</div>' : ''}
        </div>
      </div>`;
    })()}
    <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="window.shareTeam('${esc(t.team)}')" title="Copy shareable link">🔗 Share team link</button>
    </div>
  `;
  document.getElementById('overlay')?.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeDetail() {
  document.getElementById('overlay')?.classList.remove('open');
  document.body.style.overflow='';
  _reProfileOpen = false;
}
document.addEventListener('keydown', e=>{
  // Ignore when typing in an input/textarea/select
  const tag = document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement.isContentEditable;

  if(e.key==='Escape') {
    closeDetail();
    closeLoginModal();
    closeSchedModal();
    closeEditEntryModal();
    closeEditCalModal();
  }

  // Arrow left/right — cycle visible tabs
  if(!typing && (e.key==='ArrowLeft' || e.key==='ArrowRight')) {
    e.preventDefault();
    const visibleTabs = Array.from(document.querySelectorAll('.tab:not([style*="display:none"])')).filter(b => {
      return window.getComputedStyle(b).display !== 'none';
    });
    const activeIdx = visibleTabs.findIndex(b => b.classList.contains('active'));
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const nextIdx = (activeIdx + dir + visibleTabs.length) % visibleTabs.length;
    const next = visibleTabs[nextIdx];
    if(next) { next.click(); next.scrollIntoView({ block:'nearest', inline:'center' }); }
  }

  // Arrow up/down — page through leaderboard if on leaderboard tab
  if(!typing && (e.key==='ArrowDown' || e.key==='ArrowUp')) {
    const lb = document.getElementById('tab-leaderboard');
    if(lb && lb.classList.contains('active')) {
      e.preventDefault();
      lbPage(e.key==='ArrowDown' ? 1 : -1);
    }
  }
});

// Restore tab from URL hash on load
(function() {
  const hash = location.hash.replace('#','');
  if(hash) {
    const btn = document.querySelector(`.tab[data-tab="${hash}"]`);
    if(btn && window.getComputedStyle(btn).display !== 'none') {
      // Defer until after app init
      window.addEventListener('load', function() {
        setTimeout(function() { btn.click(); }, 100);
      });
    }
  }
})();
// Delegated click handler for team rows (works on dynamically generated innerHTML)
document.addEventListener('click', function(e) {
  if(e.target.closest('button,a[onclick],[data-action]')) return; // ignore edit/delete controls inside rows
  const tr = e.target.closest('tr[data-team]');
  if(!tr) return;
  const team = tr.dataset.team;
  const t = teamDetailMap[team] || allTeams.find(x => x.team === team) || lbFiltered.find(x => x.team === team);
  if(t) openDetail(t);
});

/* ═══════════════════════════════════════════════════════
   ROBOTEVENTS FULL TEAM PROFILE
   Fetches: team info, event history + rankings, awards,
   and skills scores — all displayed in the detail overlay.
════════════════════════════════════════════════════════ */
let _reProfileOpen = false;

function toggleREProfile(teamNum) {
  const panel = document.getElementById('re-profile-panel');
  const btn   = document.getElementById('re-expand-btn');
  if(_reProfileOpen) {
    panel.innerHTML = '';
    btn.textContent = '🌐 Expand — Full Team Profile (RobotEvents)';
    _reProfileOpen = false;
  } else {
    _reProfileOpen = true;
    btn.textContent = '▲ Collapse Team Profile';
    loadRETeamProfile(teamNum);
  }
}

function getREToken() {
  // Prefer whichever RobotEvents token field the user last filled, then fall back to browser storage.
  const inputToken = document.getElementById('settings-re-token')?.value.trim()
    || document.getElementById('re-token')?.value.trim()
    || document.getElementById('sched-re-token')?.value.trim()
    || document.getElementById('qs-re-token')?.value.trim()
    || '';
  if(inputToken) return inputToken;
  try { return localStorage.getItem(RE_TOKEN_KEY) || ''; } catch(e) { return ''; }
}

async function reApiFetch(path) {
  const token = getREToken(); // still passed for robotevents.com fallback
  return reProxyFetch(path, {}, token);
}

async function loadRETeamProfile(teamNum) {
  const panel = document.getElementById('re-profile-panel');
  const btn   = document.getElementById('re-expand-btn');
  btn.classList.add('loading');
  panel.innerHTML = '<div style="text-align:center;padding:1.5rem;font-family:var(--mono);font-size:12px;color:var(--ink3)"><span class="spin"></span> Loading team data\u2026</div>';

  try {
    // 1. Get team info via proxy
    const teamData = await proxyFetch(
      `https://events.vex.com/api/v2/teams?number[]=${encodeURIComponent(teamNum)}&program[]=1`,
      null
    );
    const team = (teamData.data || [])[0];

    if (!team) {
      panel.innerHTML = `<div class="re-err">Team <strong>${esc(teamNum)}</strong> not found on events.vex.com for V5RC.</div>`;
      btn.classList.remove('loading');
      return;
    }

    // 2. Scrape full history from the HTML page
    panel.innerHTML = '<div style="text-align:center;padding:1.5rem;font-family:var(--mono);font-size:12px;color:var(--ink3)"><span class="spin"></span> Loading event history\u2026</div>';
    const scraped = await scrapeEvexTeamPage(teamNum);

    // -- Render --
    const grade = team.grade || '\u2014';
    const org   = team.organization || '\u2014';
    const loc   = [team.location?.city, team.location?.region, team.location?.country].filter(Boolean).join(', ');
    const robot = team.robot_name || '\u2014';

    let html = `<div class="re-profile">`;

    // -- Team info --
    html += `<div class="re-section-hd">\u{1F4CB} Team Info</div>
    <div class="re-info-grid">
      <div class="re-info-item"><div class="re-info-l">Team Number</div><div class="re-info-v" style="color:var(--blue);font-family:var(--mono);font-size:16px;font-weight:700">${esc(team.number)}</div></div>
      <div class="re-info-item"><div class="re-info-l">Team Name</div><div class="re-info-v">${esc(team.team_name||'\u2014')}</div></div>
      <div class="re-info-item"><div class="re-info-l">Organisation</div><div class="re-info-v">${esc(org)}</div></div>
      <div class="re-info-item"><div class="re-info-l">Location</div><div class="re-info-v">${esc(loc)}</div></div>
      <div class="re-info-item"><div class="re-info-l">Grade</div><div class="re-info-v">${esc(grade)}</div></div>
      <div class="re-info-item"><div class="re-info-l">Robot Name</div><div class="re-info-v">${esc(robot)}</div></div>
    </div>`;

    // -- Rankings / Event History --
    const rankings = scraped.rankings;
    const bySeason = {};
    rankings.forEach(r => { if (!bySeason[r.season]) bySeason[r.season] = []; bySeason[r.season].push(r); });
    const seasonNames = Object.keys(bySeason);

    html += `<div class="re-section-hd">\u{1F3C6} Event History (${rankings.length} events)</div>`;
    if (!rankings.length) {
      html += `<div class="re-empty">No event history found.</div>`;
    } else {
      window._reScrapedRankings = rankings;
      html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <label style="font-size:11px;font-family:var(--mono);color:var(--ink3);margin:0;white-space:nowrap">Season:</label>
        <select id="re-ranking-season" onchange="reRenderRankings()"
          style="flex:1;min-width:160px;max-width:320px;font-size:12px;font-family:var(--mono);padding:5px 8px;border-radius:var(--radius);border:.5px solid var(--paper3);background:var(--paper);color:var(--ink)">
          <option value="">All Seasons</option>
          ${seasonNames.map((s,i) => `<option value="${esc(s)}"${i===0?' selected':''}>${esc(s)}</option>`).join('')}
        </select>
      </div>
      <div id="re-rankings-body"></div>`;
    }

    // -- Awards --
    const awards = scraped.awards;
    html += `<div class="re-section-hd">\u{1F947} Awards (${awards.length})</div>`;
    if (!awards.length) {
      html += `<div class="re-empty">No awards on record.</div>`;
    } else {
      const awardIcons = {
        'tournament champions': '\u{1F3C6}', 'excellence': '\u2B50', 'design': '\u{1F3A8}', 'skills': '\u26A1',
        'sportsmanship': '\u{1F91D}', 'judges': '\u{1F469}\u200D\u2696\uFE0F', 'create': '\u{1F527}', 'innovate': '\u{1F4A1}',
        'think': '\u{1F9E0}', 'amaze': '\u{1F31F}', 'inspire': '\u2728', 'finalist': '\u{1F948}',
      };
      awards.forEach(a => {
        const name = a.title || '\u2014';
        const iconKey = Object.keys(awardIcons).find(k => name.toLowerCase().includes(k));
        const icon = iconKey ? awardIcons[iconKey] : '\u{1F3C5}';
        html += `<div class="re-award-row">
          <div class="re-award-icon">${icon}</div>
          <div>
            <div class="re-award-name">${esc(name)}</div>
            <div class="re-award-event">${esc(a.eventName)}</div>
            <div style="font-size:10px;font-family:var(--mono);color:var(--ink3);margin-top:1px">${esc(a.season)}</div>
          </div>
        </div>`;
      });
    }

    html += `</div>`; // .re-profile
    panel.innerHTML = html;

    // Render rankings for default season
    if (rankings.length) reRenderRankings();

  } catch(err) {
    panel.innerHTML = `<div class="re-err">\u26A0 ${esc(err.message)}</div>`;
    console.error('Team profile error:', err);
  }
  btn.classList.remove('loading');
}

/* -- Render rankings filtered by selected season -- */
function reRenderRankings() {
  const body = document.getElementById('re-rankings-body');
  const sel  = document.getElementById('re-ranking-season');
  if (!body) return;
  const season = sel?.value || '';
  const rankings = (window._reScrapedRankings || []).filter(r => !season || r.season === season);
  if (!rankings.length) { body.innerHTML = '<div class="re-empty">No events for this season.</div>'; return; }
  body.innerHTML = rankings.map(r => {
    const [wp, ap, sp] = (r.wpasp || '').split('/').map(x => x.trim());
    const isTop3 = r.rank > 0 && r.rank <= 3;
    return `<div class="re-event-row">
      <div>
        <div class="re-event-name">${esc(r.eventName)}</div>
        <div style="font-size:10px;font-family:var(--mono);color:var(--ink3);margin-top:2px">${esc(r.season)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        ${r.rank ? `<div class="re-rank-badge${isTop3?' gold':''}">#${r.rank}</div>` : ''}
        <div style="font-size:10px;font-family:var(--mono);color:var(--ink3);margin-top:3px">W:${r.wins} L:${r.losses} T:${r.ties}</div>
        ${wp ? `<div style="font-size:10px;font-family:var(--mono);color:var(--ink3)">WP:${wp} AP:${ap||0} SP:${sp||0}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════
   ADMIN — ADD ENTRY
════════════════════════════════════════════════════════ */
async function addEntry() {
  if(!isAdmin) return;
  const team = document.getElementById('f-team')?.value.trim();
  if(!team){ showMsg('add-msg','Team # required','err'); return; }
  const maxpinsRaw = document.getElementById('f-maxpins')?.value.trim();
  if(maxpinsRaw !== '' && (isNaN(Number(maxpinsRaw)) || Number(maxpinsRaw) > MAX_PINS * 4 || Number(maxpinsRaw) < 0)) {
    showMsg('add-msg', `Max Possible Pins must be between 0 and ${MAX_PINS * 4}.`, 'err'); return;
  }
  const entry = {
    id: crypto.randomUUID(),
    team, event:document.getElementById('f-event')?.value.trim(),
    round:document.getElementById('f-round')?.value.trim(),
    side:document.getElementById('f-side')?.value,
    sig:document.getElementById('f-sig')?.value,
    type:(()=>{ const sel=document.getElementById('f-type')?.value; return sel==='Other'?(document.getElementById('f-type-custom')?.value.trim()||'Other'):sel; })(),
    // Calculate pins string from dropdowns based on auto mode
    // Normal: Goal1+Goal2  |  SAWP: OwnG1+OwnG2+TeamG1+TeamG2
    route: document.getElementById('f-auto-mode')?.value,
    pins: (()=>{
      const mode = document.getElementById('f-auto-mode')?.value;
      if(mode === 'SAWP') {
        // SAWP stores 4 values: own quadrant G1+G2 and teammate G1+G2
        const og1 = document.getElementById('f-sawp-own-g1')?.value;
        const og2 = document.getElementById('f-sawp-own-g2')?.value;
        const tg1 = document.getElementById('f-sawp-team-g1')?.value;
        const tg2 = document.getElementById('f-sawp-team-g2')?.value;
        return og1+'+'+og2+'+'+tg1+'+'+tg2;
      } else {
        // Normal stores 2 values: G1+G2
        const g1 = document.getElementById('f-pin-g1')?.value;
        const g2 = document.getElementById('f-pin-g2')?.value;
        return g1+'+'+g2;
      }
    })(),
    maxpins:document.getElementById('f-maxpins')?.value.trim(),
    bonuses: 0,
    awp:document.getElementById('f-awp')?.value,
    failed:document.getElementById('f-failed')?.value,
    notes:document.getElementById('f-notes')?.value.trim(),
    ts:new Date().toISOString()
  };
  localDb.unshift(entry);
  try{ localStorage.setItem('override_scout_v3', JSON.stringify(localDb)); }catch(e){}
  clearForm();
  showMsg('add-msg','Saved locally! Pushing to Supabase…','ok');
  // Push to Supabase
  try {
    const r = await fetch(SB_URL+'/rest/v1/entries', {
      method:'POST',
      headers:{...adminHdrs(),'Prefer':'return=minimal'},
      body:JSON.stringify(entry)
    });
    if(r.ok){
      showMsg('add-msg','✓ Entry saved for '+team+' and synced to database.','ok');
      allEntries.unshift(entry);
      setAllTeams(buildStats(allEntries));
      setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries');
      renderLog(); lbApplyFilter(lbActiveF);
    } else {
      showMsg('add-msg','Saved locally but Supabase push failed ('+r.status+')','err');
    }
  } catch(e) {
    showMsg('add-msg','Saved locally but could not reach Supabase.','err');
  }
}

// clearForm: resets all Add Entry fields back to their defaults
function clearForm() {
  // Reset text inputs and textarea
  ['f-team','f-event','f-round','f-maxpins','f-notes'].forEach(id=>document.getElementById(id).value='');
  // Reset dropdowns
  document.getElementById('f-awp').value = 'N';
  document.getElementById('f-failed').value = 'N';
  document.getElementById('f-auto-mode').value = 'Normal';
  document.getElementById('f-type').selectedIndex = 0;
  document.getElementById('f-type-custom').value = '';
  document.getElementById('f-type-custom').style.display = 'none';
  document.getElementById('f-pin-g1').value = '0';
  document.getElementById('f-pin-g2').value = '0';
  document.getElementById('f-sawp-own-g1').value = '0';
  document.getElementById('f-sawp-own-g2').value = '0';
  document.getElementById('f-sawp-team-g1').value = '0';
  document.getElementById('f-sawp-team-g2').value = '0';
  // Reset auto mode back to Normal view
  toggleAutoMode('Normal');
}

// toggleCustomType: shows/hides the free-text robot type input
function toggleCustomType(val) {
  const customInput = document.getElementById('f-type-custom');
  if(val === 'Other') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
    customInput.value = '';
  }
}

// toggleAutoMode: shows/hides pin sections based on selected auto type
function toggleAutoMode(mode) {
  const isNormal = mode === 'Normal';
  document.getElementById('section-normal').style.display = isNormal ? 'block' : 'none';
  document.getElementById('section-sawp').style.display   = isNormal ? 'none'  : 'block';
}

function showMsg(id, txt, type) {
  const el=document.getElementById(id);
  if(el){ el.textContent=txt; el.className=type==='ok'?'msg-ok':'msg-err'; setTimeout(()=>el.textContent='',3500); }
  // Also show as a toast for better visibility
  showToast(txt, type==='ok'?'ok':'err', 3500);
}

/* ═══════════════════════════════════════════════════════
   ADMIN — SCOUT LOG
════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════
   SCOUT LOG — paginated render
   LOG_PG rows per page; only renders DOM when tab is active.
════════════════════════════════════════════════════════ */
const LOG_PG = 50;
let logPg = 1;
let _logDirty = false; // true when data changed but tab isn't visible
let _lbDirty  = false; // true when leaderboard data changed but tab isn't visible

function _isTabActive(tabId) {
  return document.getElementById('tab-' + tabId)?.classList.contains('active');
}

function renderLog() {
  // If the log tab isn't visible, mark dirty and bail — switchTab will call us.
  if (!_isTabActive('log')) { _logDirty = true; return; }
  _logDirty = false;

  const q   = (document.getElementById('logQ')?.value || '').toLowerCase();
  const fil = document.getElementById('logFil')?.value || '';

  const rows = allEntries.filter(e => {
    if (q && ![e.team, e.event, e.round, e.side, e.type, e.route, e.pins, e.notes, e.awp, e.sig]
               .some(v => (v || '').toLowerCase().includes(q))) return false;
    if (fil === 'sig' && e.sig !== 'yes') return false;
    if (fil === 'awp' && e.awp !== 'Y') return false;
    return true;
  });

  // Summary cards (always uses full allEntries, not filtered slice)
  const teams = new Set(allEntries.map(e => e.team)).size;
  const awps  = allEntries.filter(e => e.awp === 'Y').length;
  const avg   = allEntries.length
    ? (allEntries.reduce((s, e) => s + pins(e), 0) / allEntries.length).toFixed(1)
    : '—';
  document.getElementById('logCards').innerHTML = `
    <div class="mc"><div class="mc-l">Entries</div><div class="mc-v">${allEntries.length}</div></div>
    <div class="mc"><div class="mc-l">Teams</div><div class="mc-v">${teams}</div></div>
    <div class="mc"><div class="mc-l">Avg pins</div><div class="mc-v">${avg}</div></div>
    <div class="mc"><div class="mc-l">AWP achieved</div><div class="mc-v">${awps}</div></div>`;

  // Local cache banner
  const localIds  = new Set(localDb.map(e => String(e.id)));
  const cacheCard = document.getElementById('localCacheCard');
  const cacheBtn  = document.getElementById('clearCacheBtn');
  if (localDb.length > 0) {
    if (cacheCard) { cacheCard.style.display = 'block'; document.getElementById('localCacheCount').textContent = localDb.length; }
    if (cacheBtn)  cacheBtn.style.display = '';
  } else {
    if (cacheCard) cacheCard.style.display = 'none';
    if (cacheBtn)  cacheBtn.style.display = 'none';
  }

  if (!rows.length) {
    document.getElementById('logBody').innerHTML = `<tr><td colspan="13" class="empty">No entries yet.</td></tr>`;
    document.getElementById('logPager').style.display = 'none';
    return;
  }

  // Clamp page to valid range after filter changes
  const pages = Math.ceil(rows.length / LOG_PG);
  if (logPg > pages) logPg = pages;
  if (logPg < 1)     logPg = 1;

  const start  = (logPg - 1) * LOG_PG;
  const pageRows = rows.slice(start, start + LOG_PG);

  document.getElementById('logBody').innerHTML = pageRows.map(e => {
    const isLocal = localIds.has(String(e.id));
    const rawTs = e.ts || e.created_at || '';
    const tsDisplay = rawTs ? (() => {
      const d = new Date(rawTs);
      if (isNaN(d)) return rawTs.slice(0, 10) || '—';
      const pad = n => String(n).padStart(2, '0');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
             + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    })() : '—';
    return `<tr${isLocal ? ' style="background:rgba(122,92,0,.06)"' : ''}>
    <td style="text-align:center"><input type="checkbox" class="log-row-cb" data-id="${esc(e.id)}" onchange="logUpdateBatchBar()" style="width:auto;margin:0"></td>
    <td><strong>${esc(e.team)}</strong>${isLocal ? ' <span class="badge" style="background:var(--amber-bg);color:var(--amber);border:1px solid #f0d070;font-size:10px">Local</span>' : ''}</td>
    <td>${esc(e.event || '—')} ${e.sig === 'yes' ? '<span class="badge b-sig">Sig</span>' : ''}</td>
    <td>${esc(e.round || '—')}</td><td>${esc(e.side || '—')}</td><td>${esc(e.type || '—')}</td>
    <td><code>${esc(e.route || '—')}</code></td>
    <td>${esc(e.pins || '0')}${e.maxpins ? ' / ' + esc(e.maxpins) : ''}</td>
    <td>${parseInt(e.bonuses) || 0}</td>
    <td><span class="badge ${e.awp === 'Y' ? 'b-awp' : e.awp === '?' ? 'b-q' : 'b-no'}">${esc(e.awp || 'N')}</span></td>
    <td style="max-width:160px;font-size:12px;color:var(--ink2)">${esc(e.notes || '')}</td>
    <td style="font-family:var(--mono);font-size:11px;color:var(--ink3);white-space:nowrap">${tsDisplay}</td>
    <td style="display:flex;gap:4px;align-items:center">
      <button class="btn btn-sm" onclick="openEditEntryModal('${esc(e.id)}')" title="Edit entry">✏</button>
      <button class="btn btn-sm btn-d log-del-cb" data-id="${esc(e.id)}" onclick="deleteEntry('${esc(e.id)}')" title="Delete entry">✕</button>
    </td>
  </tr>`;
  }).join('');

  // Pager
  const pager = document.getElementById('logPager');
  if (pages > 1) {
    pager.style.display = 'flex';
    document.getElementById('logPi').textContent = `Page ${logPg} of ${pages} (${rows.length} entries)`;
    document.getElementById('logPrev').disabled = logPg === 1;
    document.getElementById('logNext').disabled = logPg === pages;
  } else {
    pager.style.display = 'none';
  }
}

function logPageNav(dir) {
  logPg += dir;
  renderLog();
  // Scroll log table into view smoothly
  document.getElementById('tab-log')?.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Scout Log batch delete helpers ── */
function logUpdateBatchBar() {
  const cbs = [...document.querySelectorAll('.log-row-cb')];
  const checked = cbs.filter(c=>c.checked);
  const bar = document.getElementById('logBatchBar');
  const headCb = document.getElementById('logSelectAllHead');
  const allCb  = document.getElementById('logSelectAll');
  const countEl = document.getElementById('logSelectedCount');
  if(bar) bar.style.display = checked.length > 0 ? 'flex' : 'none';
  if(countEl) countEl.textContent = checked.length + ' of ' + cbs.length + ' selected';
  const allChecked = cbs.length > 0 && checked.length === cbs.length;
  if(headCb) headCb.checked = allChecked;
  if(allCb)  allCb.checked  = allChecked;
}
function logToggleAll(checked) {
  document.querySelectorAll('.log-row-cb').forEach(cb => cb.checked = checked);
  logUpdateBatchBar();
}
function logClearSelection() {
  document.querySelectorAll('.log-row-cb').forEach(cb => cb.checked = false);
  logUpdateBatchBar();
}
async function logDeleteSelected() {
  if(!isAdmin) return;
  const ids = [...document.querySelectorAll('.log-row-cb:checked')].map(cb=>cb.dataset.id);
  if(!ids.length) { showToast('No entries selected.','info'); return; }
  if(!confirm('Delete '+ids.length+' entr'+(ids.length===1?'y':'ies')+'? This cannot be undone.')) return;
  let failed = 0;
  for(const id of ids) {
    try {
      const r = await fetch(SB_URL+'/rest/v1/entries?id=eq.'+id, { method:'DELETE', headers: adminHdrs() });
      if(!r.ok) failed++;
      else {
        allEntries = allEntries.filter(e=>String(e.id)!==String(id));
        localDb    = localDb.filter(e=>String(e.id)!==String(id));
      }
    } catch(e){ failed++; }
  }
  try{ localStorage.setItem('override_scout_v3', JSON.stringify(localDb)); }catch(e){}
  setAllTeams(buildStats(allEntries));
  renderLog(); lbApplyFilter(lbActiveF);
  setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries');
  if(failed) showToast(failed+' deletion(s) failed.','err');
  else showToast('Deleted '+ids.length+' entr'+(ids.length===1?'y':'ies')+'.','ok');
}

function clearLocalCache() {
  if(!localDb.length) { showToast('No local entries to clear.', 'info'); return; }
  const n = localDb.length;
  if(!confirm(`Clear ${n} local cache entr${n===1?'y':'ies'} from your browser?\n\nThis only removes them from local storage — if they already synced to Supabase they will still appear in the log.`)) return;
  localDb = [];
  try { localStorage.removeItem('override_scout_v3'); } catch(e) {}
  renderLog();
  showToast(`Cleared ${n} local entr${n===1?'y':'ies'} from cache.`, 'ok');
}

async function deleteEntry(id) {
  if(!isAdmin) return;
  if(!confirm('Delete this entry?')) return;
  // Remove from Supabase
  try {
    const dr = await fetch(SB_URL+'/rest/v1/entries?id=eq.'+id, {
      method:'DELETE', headers: adminHdrs()
    });
    if (!dr.ok) throw new Error('Delete failed: HTTP ' + dr.status);
  } catch(e){ console.error(e); showToast('Failed to delete entry: ' + e.message, 'err'); return; }
  // Remove locally
  allEntries = allEntries.filter(e=>String(e.id)!==String(id));
  localDb    = localDb.filter(e=>String(e.id)!==String(id));
  try{ localStorage.setItem('override_scout_v3', JSON.stringify(localDb)); }catch(e){}
  setAllTeams(buildStats(allEntries));
  renderLog(); lbApplyFilter(lbActiveF);
  setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries');
}

/* ── Edit entry modal ── */
let _editEntryId = null;

function openEditEntryModal(id) {
  if(!isAdmin) return;
  const e = allEntries.find(en => String(en.id) === String(id));
  if(!e) return;
  _editEntryId = id;
  document.getElementById('ee-team').value    = e.team    || '';
  document.getElementById('ee-event').value   = e.event   || '';
  document.getElementById('ee-round').value   = e.round   || '';
  document.getElementById('ee-side').value    = e.side    || 'L';
  document.getElementById('ee-type').value    = e.type    || '';
  document.getElementById('ee-sig').value     = e.sig     || 'no';
  document.getElementById('ee-route').value   = e.route   || '';
  document.getElementById('ee-pins').value    = e.pins    || '0';
  document.getElementById('ee-maxpins').value = e.maxpins || '';
  document.getElementById('ee-bonuses').value = e.bonuses || 0;
  document.getElementById('ee-awp').value     = e.awp     || 'N';
  document.getElementById('ee-notes').value   = e.notes   || '';
  document.getElementById('edit-entry-err').textContent = '';
  document.getElementById('editEntryModal')?.classList.add('open');
}

function closeEditEntryModal() {
  document.getElementById('editEntryModal')?.classList.remove('open');
  _editEntryId = null;
}

async function saveEditEntry() {
  if(!isAdmin || !_editEntryId) return;
  const errEl = document.getElementById('edit-entry-err');
  const team  = document.getElementById('ee-team')?.value.trim().toUpperCase();
  if(!team) { errEl.style.color='var(--red)'; errEl.textContent = 'Team # is required.'; return; }
  errEl.style.color = 'var(--ink3)';
  errEl.textContent = 'Saving…';
  const updates = {
    team,
    event:    document.getElementById('ee-event')?.value.trim(),
    round:    document.getElementById('ee-round')?.value.trim(),
    side:     document.getElementById('ee-side')?.value,
    type:     document.getElementById('ee-type')?.value.trim(),
    sig:      document.getElementById('ee-sig')?.value,
    route:    document.getElementById('ee-route')?.value.trim(),
    pins:     document.getElementById('ee-pins')?.value.trim() || '0',
    maxpins:  document.getElementById('ee-maxpins')?.value.trim() || null,
    bonuses:  parseInt(document.getElementById('ee-bonuses')?.value) || 0,
    awp:      document.getElementById('ee-awp')?.value,
    notes:    document.getElementById('ee-notes')?.value.trim() || null,
  };
  try {
    const r = await fetch(SB_URL + '/rest/v1/entries?id=eq.' + _editEntryId, {
      method: 'PATCH',
      headers: { ...adminHdrs(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(updates)
    });
    if(!r.ok) { const t = await r.text(); throw new Error(t); }
    // Update in local state
    const idx = allEntries.findIndex(en => String(en.id) === String(_editEntryId));
    if(idx !== -1) allEntries[idx] = { ...allEntries[idx], ...updates };
    const lidx = localDb.findIndex(en => String(en.id) === String(_editEntryId));
    if(lidx !== -1) localDb[lidx] = { ...localDb[lidx], ...updates };
    try { localStorage.setItem('override_scout_v3', JSON.stringify(localDb)); } catch(e) {}
    setAllTeams(buildStats(allEntries));
    errEl.style.color = 'var(--green)';
    errEl.textContent = '✓ Saved!';
    setTimeout(closeEditEntryModal, 700);
    renderLog(); lbApplyFilter(lbActiveF);
    setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries');
  } catch(e) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = 'Failed: ' + e.message;
  }
}

function exportCSV() {
  const hdr='Team,Event,Round,Side,Sig,RobotType,Route,Pins,MaxPins,Bonuses,AWP,Notes,Date';
  const rows=allEntries.map(e=>[e.team,e.event,e.round,e.side,e.sig,e.type,e.route,e.pins,e.maxpins||'',e.bonuses,e.awp,'"'+(e.notes||'').replace(/"/g,"'")+'"',e.ts||e.created_at||''].join(','));
  const blob=new Blob([hdr+'\n'+rows.join('\n')],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='override_scout_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
  showToast('CSV exported — '+allEntries.length+' entries', 'ok');
}

function importClick(){ document.getElementById('importFile').click(); }
// parseCSVLine: splits a single CSV line respecting double-quoted fields
// e.g. 'a,b,"hello, world",d' → ['a','b','hello, world','d']
function parseCSVLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for(let i = 0; i < line.length; i++) {
    const ch = line[i];
    if(inQ) {
      if(ch === '"' && line[i+1] === '"') { cur += '"'; i++; } // escaped quote
      else if(ch === '"') inQ = false;
      else cur += ch;
    } else {
      if(ch === '"') inQ = true;
      else if(ch === ',') { cols.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function importCSV(ev) {
  const file=ev.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async e=>{
    const lines=e.target.result.split('\n').slice(1).filter(l=>l.trim());
    let added=0, failed=0;
    for(const line of lines){
      const c=parseCSVLine(line);
      if(!c[0]) continue;
      const entry={id:Date.now()+Math.random(),team:c[0],event:c[1]||'',round:c[2]||'',side:c[3]||'L',sig:c[4]||'no',type:c[5]||'',route:c[6]||'Unknown route',pins:c[7]||'0',maxpins:c[8]||'',bonuses:parseInt(c[9])||0,awp:c[10]||'N',notes:c[11]||'',ts:c[12]||''};
      try{
        const r = await fetch(SB_URL+'/rest/v1/entries',{method:'POST',headers:{...adminHdrs(),'Prefer':'return=minimal'},body:JSON.stringify(entry)});
        if(!r.ok) failed++;
      }catch(e){ failed++; }
      allEntries.unshift(entry); added++;
    }
    setAllTeams(buildStats(allEntries));
    renderLog(); lbApplyFilter(lbActiveF);
    if(failed > 0) {
      showToast(`Imported ${added} entr${added===1?'y':'ies'} — ⚠ ${failed} failed to sync to Supabase.`, 'err', 5000);
    } else {
      showToast('Imported '+added+' entr'+(added===1?'y':'ies')+'.', 'ok', 3500);
    }
  };
  reader.readAsText(file); ev.target.value='';
}

/* ═══════════════════════════════════════════════════════
   ADMIN — WIN PROBABILITY
════════════════════════════════════════════════════════ */
function autoFill(id) {
  const team=document.getElementById(id)?.value.trim().toUpperCase();
  if(!team) return;
  const ms=allEntries.filter(e=>(e.team||'').toUpperCase()===team);
  if(!ms.length) return;

  // Detect whether this team has any SAWP entries
  // addEntry() stores the auto mode in the 'route' field (value = 'SAWP' or 'Normal')
  const sawpEntries   = ms.filter(e=>(e.route||'').toUpperCase()==='SAWP');
  const normalEntries = ms.filter(e=>(e.route||'').toUpperCase()!=='SAWP');
  const hasSawp = sawpEntries.length > 0;

  // Show / hide the SAWP toggle pill for this robot slot
  const toggleEl = document.getElementById(id+'-sawp-toggle');
  if(toggleEl) {
    toggleEl.style.display = hasSawp ? 'flex' : 'none';
    if(!hasSawp) {
      const radio = document.getElementById(id+'-mode-normal');
      if(radio) radio.checked = true;
    }
  }

  // Read which mode is currently selected (defaults to normal)
  const useSawp = hasSawp && document.getElementById(id+'-mode-sawp')?.checked;
  const src = useSawp ? sawpEntries : (normalEntries.length ? normalEntries : ms);

  // Compute averages from chosen source
  const avgG1=src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[0])||0);},0)/src.length;
  const avgG2=src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[1])||0);},0)/src.length;
  const awpRate=Math.round(src.filter(e=>e.awp==='Y').length/src.length*100);
  // Fail rate uses all entries (not SAWP-filtered) so both calculators stay consistent
  const knownEntries=ms.filter(e=>e.failed==='Y'||e.failed==='N');
  const failRate=knownEntries.length ? Math.round(knownEntries.filter(e=>e.failed==='Y').length/knownEntries.length*100) : 0;

  const g1m={r1:'r1g1',r2:'r2g1',b1:'b1g1',b2:'b2g1'};
  const g2m={r1:'r1g2',r2:'r2g2',b1:'b1g2',b2:'b2g2'};
  const fm={r1:'r1fail',r2:'r2fail',b1:'b1fail',b2:'b2fail'};

  if(useSawp) {
    // Populate 4-field SAWP layout: own quadrant = p[0]+p[1], alliance quadrant = p[2]+p[3]
    const avgOwnG1  = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[0])||0);},0)/src.length;
    const avgOwnG2  = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[1])||0);},0)/src.length;
    const avgAllyG1 = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[2])||0);},0)/src.length;
    const avgAllyG2 = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[3])||0);},0)/src.length;
    const ownG1el  = document.getElementById(id+'-own-g1');
    const ownG2el  = document.getElementById(id+'-own-g2');
    const allyG1el = document.getElementById(id+'-ally-g1');
    const allyG2el = document.getElementById(id+'-ally-g2');
    if(ownG1el)  ownG1el.value  = Math.round(avgOwnG1);
    if(ownG2el)  ownG2el.value  = Math.round(avgOwnG2);
    if(allyG1el) allyG1el.value = Math.round(avgAllyG1);
    if(allyG2el) allyG2el.value = Math.round(avgAllyG2);
    // g1/g2 for calcProb = total across both quadrants
    if(g1m[id]) document.getElementById(g1m[id]).value = Math.round(avgOwnG1 + avgAllyG1);
    if(g2m[id]) document.getElementById(g2m[id]).value = Math.round(avgOwnG2 + avgAllyG2);
  } else {
    // Only write if the field isn't locked by a partner's SAWP mode
    const g1el = g1m[id] ? document.getElementById(g1m[id]) : null;
    const g2el = g2m[id] ? document.getElementById(g2m[id]) : null;
    if(g1el && !g1el.disabled) g1el.value = Math.round(avgG1);
    if(g2el && !g2el.disabled) g2el.value = Math.round(avgG2);
  }

  // Toggle the visible pin section
  const normalSec = document.getElementById(id+'-pins-normal');
  const sawpSec   = document.getElementById(id+'-pins-sawp');
  if(normalSec) normalSec.style.display = useSawp ? 'none' : 'block';
  if(sawpSec)   sawpSec.style.display   = useSawp ? 'block' : 'none';
  if(fm[id])  document.getElementById(fm[id]).value=failRate;

  // Update the stats badge shown under the toggle
  const badge = document.getElementById(id+'-sawp-badge');
  if(badge && hasSawp) {
    badge.textContent = useSawp
      ? `SAWP mode · ${sawpEntries.length} entr${sawpEntries.length!==1?'ies':'y'}`
      : `Normal mode · ${src.length} entr${src.length!==1?'ies':'y'}`;
    badge.style.color = useSawp ? 'var(--blue)' : 'var(--ink3)';
  }

  calcProb();
}

// Called when the Normal/SAWP radio is switched — toggles pin layout and re-fills stats.
// When SAWP is active, the partner robot sits idle — zero and lock their pin inputs.
function switchAutoMode(id) {
  const useSawp = document.getElementById(id+'-mode-sawp')?.checked;
  document.getElementById(id+'-pins-normal').style.display = useSawp ? 'none' : 'block';
  document.getElementById(id+'-pins-sawp').style.display   = useSawp ? 'block' : 'none';

  // Determine partner slot
  const partner = {r1:'r2', r2:'r1', b1:'b2', b2:'b1'}[id];
  const g1map   = {r1:'r1g1',r2:'r2g1',b1:'b1g1',b2:'b2g1'};
  const g2map   = {r1:'r1g2',r2:'r2g2',b1:'b1g2',b2:'b2g2'};

  if(partner) {
    const pg1 = document.getElementById(g1map[partner]);
    const pg2 = document.getElementById(g2map[partner]);
    const pNormalSec = document.getElementById(partner+'-pins-normal');
    const pSawpSec   = document.getElementById(partner+'-pins-sawp');

    if(useSawp) {
      // Partner is idle — zero pins and grey out their section
      if(pg1) { pg1.value = 0; pg1.disabled = true; }
      if(pg2) { pg2.value = 0; pg2.disabled = true; }
      if(pNormalSec) pNormalSec.style.opacity = '0.35';
      if(pSawpSec)   pSawpSec.style.opacity   = '0.35';
      // Add idle label if not already there
      const pPanel = pNormalSec || pSawpSec;
      if(pPanel && !document.getElementById(partner+'-idle-note')) {
        const note = document.createElement('div');
        note.id = partner+'-idle-note';
        note.style.cssText = 'font-size:11px;font-family:var(--mono);color:var(--amber);background:var(--amber-bg);border-radius:var(--radius);padding:5px 8px;margin-bottom:6px';
        note.textContent = '⚠ Idle — partner is running SAWP solo';
        pPanel.parentElement.insertBefore(note, pPanel);
      }
    } else {
      // Restore partner fields
      if(pg1) { pg1.disabled = false; }
      if(pg2) { pg2.disabled = false; }
      if(pNormalSec) pNormalSec.style.opacity = '';
      if(pSawpSec)   pSawpSec.style.opacity   = '';
      const note = document.getElementById(partner+'-idle-note');
      if(note) note.remove();
      // Re-run autofill on partner to restore their real stats
      autoFill(partner);
    }
  }

  autoFill(id);
}

// syncSawpPins: when SAWP 4-field inputs change manually, sum into g1/g2 for calcProb
function syncSawpPins(id) {
  const v = fid => parseFloat(document.getElementById(fid)?.value) || 0;
  const totalG1 = v(id+'-own-g1') + v(id+'-ally-g1');
  const totalG2 = v(id+'-own-g2') + v(id+'-ally-g2');
  const g1map = {r1:'r1g1',r2:'r2g1',b1:'b1g1',b2:'b2g1'};
  const g2map = {r1:'r1g2',r2:'r2g2',b1:'b1g2',b2:'b2g2'};
  if(g1map[id]) document.getElementById(g1map[id]).value = Math.round(totalG1);
  if(g2map[id]) document.getElementById(g2map[id]).value = Math.round(totalG2);
  calcProb();
}

/* ═══════════════════════════════════════════════════════
   ROBOT TYPES — Supabase-backed persistent list
   Table: robot_types (id serial, name text unique)
   Anyone can read; admins can insert.
════════════════════════════════════════════════════════ */
let knownRobotTypes = ['Claw Bot'];

async function loadRobotTypes() {
  try {
    const r = await fetch(SB_URL + '/rest/v1/robot_types?select=name&order=name.asc', { headers: HDRS });
    if(!r.ok) return;
    const data = await r.json();
    if(data.length) {
      knownRobotTypes = data.map(d => d.name);
      rebuildTypeSelect();
    }
  } catch(e) { /* non-critical, silently ignore */ }
}

async function saveRobotType(name) {
  if(!name || !isAdmin) return;
  if(knownRobotTypes.includes(name)) return; // already saved
  try {
    const r = await fetch(SB_URL + '/rest/v1/robot_types', {
      method: 'POST',
      headers: { ...adminHdrs(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name })
    });
    if(r.ok) {
      knownRobotTypes.push(name);
      knownRobotTypes.sort();
      rebuildTypeSelect();
    }
  } catch(e) { /* best effort */ }
}

function rebuildTypeSelect() {
  const sel = document.getElementById('f-type');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = knownRobotTypes.map(t => `<option value="${t}">${t}</option>`).join('')
    + '<option value="Other">Other (type below)…</option>';
  // Restore selection if still valid
  if(knownRobotTypes.includes(cur)) sel.value = cur;
}

// Hook: when admin blurs the custom type input, persist it
function onCustomTypeBlur() {
  const val = document.getElementById('f-type-custom')?.value.trim();
  if(val) saveRobotType(val);
}

// ── Colour by point margin: bigger win = deeper colour, tie = gray ──
// margin: absolute point difference between alliances
function outcomeColour(winner, index, margin) {
  if (winner === 'Tie') {
    // Gray for ties — slight variation so multiple tie segments are distinguishable
    const lightness = 55 + (index % 3) * 6; // 55%, 61%, 67%
    return `hsl(0,0%,${lightness}%)`;
  }
  // Map margin to colour intensity:
  // 0–6 pts  → light/washed shade   (t=0.25)
  // 12–18 pts → mid shade            (t=0.60)
  // 30+ pts  → fully saturated shade (t=1.00)
  const maxMargin = 62; // theoretical max: 10 pins × 5 = 50 + 12 bonus = 62
  const t = Math.min(margin / maxMargin, 1); // 0..1, higher = bigger win
  if (winner === 'Red wins') {
    // Deep red (#9e2800) → bright red (#e8500a) based on t
    const r = Math.round(158 + t * 74);  // 158..232
    const g = Math.round(40  + t * 40);  // 40..80
    const b = Math.round(0   + t * 10);  // 0..10
    return `rgb(${r},${g},${b})`;
  } else {
    // Dark blue (#0d3a7a) → bright blue (#2879e0) based on t
    const r = Math.round(13  + t * 27);  // 13..40
    const g = Math.round(58  + t * 63);  // 58..121
    const b = Math.round(122 + t * 102); // 122..224
    return `rgb(${r},${g},${b})`;
  }
}

function calcProb() {
  const nv = id => parseFloat(document.getElementById(id)?.value) || 0;

  // Per-robot inputs — no AWP % input; AWP is computed from the rule
  const robots = [
    { id:'r1', side:'red',  g1:nv('r1g1'), g2:nv('r1g2'), fail:nv('r1fail')/100,
      label: (document.getElementById('r1')?.value.trim().toUpperCase() || 'R1') },
    { id:'r2', side:'red',  g1:nv('r2g1'), g2:nv('r2g2'), fail:nv('r2fail')/100,
      label: (document.getElementById('r2')?.value.trim().toUpperCase() || 'R2') },
    { id:'b1', side:'blue', g1:nv('b1g1'), g2:nv('b1g2'), fail:nv('b1fail')/100,
      label: (document.getElementById('b1')?.value.trim().toUpperCase() || 'B1') },
    { id:'b2', side:'blue', g1:nv('b2g1'), g2:nv('b2g2'), fail:nv('b2fail')/100,
      label: (document.getElementById('b2')?.value.trim().toUpperCase() || 'B2') },
  ];

  // AWP rule: alliance scores ≥7 total pins AND ≥3 goals with ≥2 pins each
  function allianceAwp(allianceRobots) {
    const goals = allianceRobots.flatMap(r => r.succeeds ? [r.g1, r.g2] : [0, 0]);
    const totalPins = goals.reduce((s, g) => s + g, 0);
    const goalsWithTwoPlus = goals.filter(g => g >= 2).length;
    return totalPins >= 7 && goalsWithTwoPlus >= 3;
  }

  // Enumerate all 16 outcomes (each robot succeeds/fails)
  const outcomes = [];
  for (let mask = 0; mask < 16; mask++) {
    const robotStates = robots.map((r, i) => {
      const succeeds = !!(mask & (1 << i));
      const prob = succeeds ? (1 - r.fail) : r.fail;
      const pins = succeeds ? (r.g1 + r.g2) : 0;
      return { ...r, succeeds, prob, pins };
    });

    // Joint probability of this exact combination
    const probability = robotStates.reduce((p, r) => p * r.prob, 1);

    // Scores per alliance
    const redPins  = robotStates.filter(r => r.side==='red' ).reduce((s,r)=>s+r.pins,0);
    const bluePins = robotStates.filter(r => r.side==='blue').reduce((s,r)=>s+r.pins,0);
    const redRaw   = redPins  * 5;
    const blueRaw  = bluePins * 5;

    // Auto bonus (+12 to winner, +6 each if tied)
    let redScore  = redRaw;
    let blueScore = blueRaw;
    if      (redRaw > blueRaw)  { redScore  += 12; }
    else if (blueRaw > redRaw)  { blueScore += 12; }
    else                        { redScore  += 6; blueScore += 6; }

    // AWP: deterministic rule check per alliance
    const redAwp  = allianceAwp(robotStates.filter(r => r.side==='red'));
    const blueAwp = allianceAwp(robotStates.filter(r => r.side==='blue'));

    const winner = redScore > blueScore ? 'Red wins' : blueScore > redScore ? 'Blue wins' : 'Tie';

    // Human-readable label for which robots ran
    const successLabels = robotStates.filter(r=>r.succeeds).map(r=>r.label);
    const failLabels    = robotStates.filter(r=>!r.succeeds).map(r=>r.label);

    outcomes.push({
      mask, probability, robotStates,
      redPins, bluePins, redRaw, blueRaw, redScore, blueScore,
      redAwp, blueAwp, winner,
      successLabels, failLabels
    });
  }

  // Sort by probability descending for the bar (largest segments first within each category)
  // Actually sort by winner category then probability so colours group nicely
  const winOrder = {'Red wins':0,'Tie':1,'Blue wins':2};
  outcomes.sort((a,b) => {
    const wdiff = winOrder[a.winner] - winOrder[b.winner];
    return wdiff !== 0 ? wdiff : b.probability - a.probability;
  });

  const totalProb = outcomes.reduce((s,o)=>s+o.probability,0) || 1;
  const mostLikely = [...outcomes].sort((a,b)=>b.probability-a.probability)[0];

  // ── Update header
  document.getElementById('mostOutcome').textContent =
    'Most probable: ' + mostLikely.winner + ' — ' +
    mostLikely.robotStates.filter(r=>r.succeeds).map(r=>r.label).join('+') +
    ' succeed (' + (mostLikely.probability*100).toFixed(1) + '%)';

  // ── Build the bar
  const bar = document.getElementById('outcomeBar');
  bar.innerHTML = '';
  let colourCounters = {'Red wins':0,'Tie':0,'Blue wins':0};

  outcomes.forEach((o, idx) => {
    const pct = (o.probability / totalProb) * 100;
    if (pct < 0.1) return; // skip invisible slivers
    const margin = Math.abs(o.redScore - o.blueScore);
    const colour = outcomeColour(o.winner, colourCounters[o.winner]++, margin);
    const seg = document.createElement('div');
    seg.className = 'outcome-seg';
    seg.style.cssText = `flex:${pct};background:${colour};`;
    seg.title = o.winner + ' · ' + (o.probability*100).toFixed(1) + '%';
    seg.dataset.mask = o.mask; // unique key for reliable lookup
    if (pct > 3) {
      const lbl = document.createElement('span');
      lbl.className = 'outcome-seg-label';
      lbl.textContent = (o.probability*100).toFixed(0) + '%';
      seg.appendChild(lbl);
    }
    // Add a golden star to the highest-probability segment
    if (o === mostLikely) {
      const star = document.createElement('span');
      star.textContent = '★';
      star.style.cssText = 'font-size:14px;color:#ffd700;text-shadow:0 0 4px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.4);margin-left:3px;pointer-events:none;line-height:1;filter:drop-shadow(0 0 3px rgba(255,215,0,.7))';
      seg.appendChild(star);
    }
    seg.addEventListener('click', () => showOutcomeDetail(o, seg, outcomes));
    bar.appendChild(seg);
  });

  // ── Build legend
  const legend = document.getElementById('outcomeLegend');
  const redTotal  = outcomes.filter(o=>o.winner==='Red wins').reduce((s,o)=>s+o.probability,0);
  const tieTotal  = outcomes.filter(o=>o.winner==='Tie').reduce((s,o)=>s+o.probability,0);
  const blueTotal = outcomes.filter(o=>o.winner==='Blue wins').reduce((s,o)=>s+o.probability,0);
  const redAwpTotal  = outcomes.filter(o=>o.redAwp).reduce((s,o)=>s+o.probability,0);
  const blueAwpTotal = outcomes.filter(o=>o.blueAwp).reduce((s,o)=>s+o.probability,0);
  legend.innerHTML = [
    { label:'Red wins',  colour:'#c8410a',         prob:redTotal },
    { label:'Tie',       colour:'#888888',          prob:tieTotal },
    { label:'Blue wins', colour:'#1a5fb4',          prob:blueTotal },
    { label:'Red AWP',   colour:'#c8410a',opacity:.55, prob:redAwpTotal },
    { label:'Blue AWP',  colour:'#1a5fb4',opacity:.55, prob:blueAwpTotal },
  ].map(l=>`
    <div class="outcome-legend-item">
      <div class="outcome-legend-swatch" style="background:${l.colour};${l.opacity?'opacity:'+l.opacity:''}"></div>
      <span>${l.label}: <strong>${(l.prob*100).toFixed(1)}%</strong></span>
    </div>`).join('');

  // Store both orderings for arrow navigation
  const filtered = outcomes.filter(o => (o.probability / totalProb) * 100 >= 0.1);
  window._outcomesBarOrder  = [...filtered]; // bar visual order (red→tie→blue, prob desc within)
  window._outcomesProbOrder = [...filtered].sort((a,b) => b.probability - a.probability);
  window._currentOutcomeIdx = 0;
  if (!window._outcomeNavMode) window._outcomeNavMode = 'prob'; // 'prob' | 'bar'

  // Clear any open detail
  const det = document.getElementById('outcomeDetail');
  det.style.display = 'none';
  det.innerHTML = '';

  // Auto-show the most likely outcome
  const mostSeg = bar.children[0];
  if (mostSeg) mostSeg.click();
}

function showOutcomeDetail(o, clickedSeg, allOutcomes) {
  // Highlight selected segment using data-mask for reliable matching
  document.querySelectorAll('.outcome-seg').forEach(s=>s.classList.remove('selected'));
  if (clickedSeg) {
    clickedSeg.classList.add('selected');
  } else {
    // Find by mask if no seg reference passed
    const bar = document.getElementById('outcomeBar');
    if (bar) {
      const found = bar.querySelector('[data-mask="'+o.mask+'"]');
      if (found) found.classList.add('selected');
    }
  }

  // Pick the active ordered list based on current nav mode
  const mode = window._outcomeNavMode || 'prob';
  const activeList = mode === 'bar'
    ? (window._outcomesBarOrder  || [...allOutcomes])
    : (window._outcomesProbOrder || [...allOutcomes].sort((a,b)=>b.probability-a.probability));

  const idx = activeList.indexOf(o);
  if (idx !== -1) window._currentOutcomeIdx = idx;

  const det = document.getElementById('outcomeDetail');
  det.style.display = 'block';

  const rank  = idx + 1;
  const total = activeList.length;

  const winColor = o.winner==='Red wins' ? 'var(--red)' : o.winner==='Blue wins' ? 'var(--blue)' : '#777777';
  const modeLabel = mode === 'bar' ? 'bar order' : 'high→low probability';

  // ── Alliance stat columns (red | blue), each robot in its own row ──
  const redRobots  = o.robotStates.filter(r=>r.side==='red');
  const blueRobots = o.robotStates.filter(r=>r.side==='blue');

  function robotRow(r) {
    const c = r.side==='red' ? 'var(--red)' : 'var(--blue)';
    const bg = r.side==='red' ? 'rgba(200,65,10,.07)' : 'rgba(26,95,180,.07)';
    return `<div style="background:${bg};border-radius:var(--radius);padding:7px 9px;margin-bottom:5px;border:1px solid ${r.succeeds?(r.side==='red'?'rgba(200,65,10,.2)':'rgba(26,95,180,.2)'):'var(--paper3)'}">
      <div style="font-weight:600;font-family:var(--mono);font-size:12px;color:${c};margin-bottom:3px">${r.label} ${r.succeeds?'✅':'❌'}</div>
      <div style="font-size:11px;color:var(--ink2)">
        ${r.succeeds
          ? `G1: <strong>${r.g1}</strong> · G2: <strong>${r.g2}</strong> · Total: <strong>${r.pins}</strong> pins`
          : `<span style="color:var(--ink3)">Failed — 0 pins</span>`}
      </div>
      <div style="font-size:10px;color:var(--ink3);font-family:var(--mono);margin-top:2px">
        Fail rate: ${(r.fail*100).toFixed(0)}%
      </div>
    </div>`;
  }

  // Compute AWP for each alliance in this outcome using the rule
  const redRobotsD  = o.robotStates.filter(r=>r.side==='red');
  const blueRobotsD = o.robotStates.filter(r=>r.side==='blue');
  function awpCheck(allianceRobots) {
    const goals = allianceRobots.flatMap(r => r.succeeds ? [r.g1, r.g2] : [0, 0]);
    const total = goals.reduce((s, g) => s + g, 0);
    const qualified = goals.filter(g => g >= 2).length;
    return { met: total >= 7 && qualified >= 3, total, qualified };
  }
  const redAwpD  = awpCheck(redRobotsD);
  const blueAwpD = awpCheck(blueRobotsD);

  det.innerHTML = `
    <div class="outcome-detail" style="position:relative">

      <!-- NAV MODE TOGGLE -->
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;font-size:11px;font-family:var(--mono);color:var(--ink3)">
        <span>Navigate by:</span>
        <button onclick="setOutcomeNavMode('prob')"
          style="padding:3px 10px;border-radius:99px;border:1px solid var(--paper3);font-size:11px;font-family:var(--mono);cursor:pointer;transition:all .15s;
            background:${mode==='prob'?'var(--ink)':'var(--paper2)'};color:${mode==='prob'?'var(--paper)':'var(--ink2)'}">
          High→Low %
        </button>
        <button onclick="setOutcomeNavMode('bar')"
          style="padding:3px 10px;border-radius:99px;border:1px solid var(--paper3);font-size:11px;font-family:var(--mono);cursor:pointer;transition:all .15s;
            background:${mode==='bar'?'var(--ink)':'var(--paper2)'};color:${mode==='bar'?'var(--paper)':'var(--ink2)'}">
          Bar order
        </button>
      </div>

      <div style="display:flex;align-items:stretch;gap:0">
        <!-- LEFT ARROW -->
        <button onclick="navigateOutcome(-1)" title="Previous scenario"
          style="flex-shrink:0;width:36px;background:var(--ink);color:var(--paper);border:none;border-radius:var(--radius) 0 0 var(--radius);cursor:pointer;font-size:18px;transition:background .15s;display:flex;align-items:center;justify-content:center;">&#8592;</button>

        <!-- MAIN CONTENT -->
        <div style="flex:1;min-width:0;padding:0 12px">

          <!-- Header row -->
          <div class="outcome-detail-head">
            <div>
              <div class="outcome-detail-title" style="color:${winColor}">${o.winner}</div>
              <div style="font-size:12px;color:var(--ink3);font-family:var(--mono);margin-top:2px">
                #${rank} of ${total} (${modeLabel}) · Ran: ${o.successLabels.join(', ')||'none'}${o.failLabels.length?' · Failed: '+o.failLabels.join(', '):''}
              </div>
            </div>
            <div class="outcome-detail-prob">${(o.probability*100).toFixed(2)}% chance</div>
          </div>

          <!-- Two-column alliance stats -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">

            <!-- RED column -->
            <div style="background:rgba(200,65,10,.06);border:1.5px solid rgba(200,65,10,.25);border-radius:var(--radius-lg);padding:10px">
              <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.6px;color:var(--red);font-weight:700;margin-bottom:8px">🔴 Red Alliance${o.winner==='Red wins'?' <span style="color:#FFD700;font-size:11px;letter-spacing:.3px">WIN 👑</span>':''}</div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Final score</span>
                <span style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--red)">${o.redScore}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pins scored</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono);color:var(--red)">${o.redPins}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pin pts</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${o.redRaw}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0" title="≥7 total pins AND ≥3 goals with ≥2 pins each">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">AWP</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${redAwpD.met?'✅ Yes':'❌ No'} <span style="font-size:10px;color:var(--ink3)">(${redAwpD.total}pins · ${redAwpD.qualified}goals≥2)</span></span>
              </div>
              <div style="margin-top:8px">${redRobotsD.map(robotRow).join('')}</div>
            </div>

            <!-- BLUE column -->
            <div style="background:rgba(26,95,180,.06);border:1.5px solid rgba(26,95,180,.25);border-radius:var(--radius-lg);padding:10px">
              <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.6px;color:var(--blue);font-weight:700;margin-bottom:8px">🔵 Blue Alliance${o.winner==='Blue wins'?' <span style="color:#FFD700;font-size:11px;letter-spacing:.3px">WIN 👑</span>':''}</div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Final score</span>
                <span style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--blue)">${o.blueScore}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pins scored</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono);color:var(--blue)">${o.bluePins}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pin pts</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${o.blueRaw}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0" title="≥7 total pins AND ≥3 goals with ≥2 pins each">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">AWP</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${blueAwpD.met?'✅ Yes':'❌ No'} <span style="font-size:10px;color:var(--ink3)">(${blueAwpD.total}pins · ${blueAwpD.qualified}goals≥2)</span></span>
              </div>
              <div style="margin-top:8px">${blueRobotsD.map(robotRow).join('')}</div>
            </div>
          </div>

          <!-- Score breakdown footer -->
          <div style="font-size:11px;color:var(--ink3);font-family:var(--mono);border-top:.5px solid var(--paper3);padding-top:8px">
            <span style="color:var(--red)">${o.redPins} pins × 5 = ${o.redRaw}${o.redScore>o.redRaw?' + 12 bonus':o.redScore===o.redRaw+6?' + 6 tie':''} = <strong>${o.redScore}</strong></span>
            &nbsp;vs&nbsp;
            <span style="color:var(--blue)">${o.bluePins} pins × 5 = ${o.blueRaw}${o.blueScore>o.blueRaw?' + 12 bonus':o.blueScore===o.blueRaw+6?' + 6 tie':''} = <strong>${o.blueScore}</strong></span>
          </div>
        </div>

        <!-- RIGHT ARROW -->
        <button onclick="navigateOutcome(1)" title="Next scenario"
          style="flex-shrink:0;width:36px;background:var(--ink);color:var(--paper);border:none;border-radius:0 var(--radius) var(--radius) 0;cursor:pointer;font-size:18px;transition:background .15s;display:flex;align-items:center;justify-content:center;">&#8594;</button>
      </div>
    </div>`;
}

function findSegByMask(mask) {
  return document.getElementById('outcomeBar')?.querySelector('[data-mask="'+mask+'"]') || null;
}

function navigateOutcome(dir) {
  const mode = window._outcomeNavMode || 'prob';
  const list = mode === 'bar' ? window._outcomesBarOrder : window._outcomesProbOrder;
  if (!list || !list.length) return;
  const cur = window._currentOutcomeIdx || 0;
  const newIdx = (cur + dir + list.length) % list.length;
  const o = list[newIdx];
  showOutcomeDetail(o, findSegByMask(o.mask), list);
}

function setOutcomeNavMode(mode) {
  window._outcomeNavMode = mode;
  const curList = mode === 'bar' ? window._outcomesBarOrder : window._outcomesProbOrder;
  if (!curList || !curList.length) return;
  const oldList = mode === 'bar' ? window._outcomesProbOrder : window._outcomesBarOrder;
  const oldO = oldList ? oldList[window._currentOutcomeIdx || 0] : null;
  const newIdx = oldO ? Math.max(0, curList.indexOf(oldO)) : 0;
  window._currentOutcomeIdx = newIdx;
  const o = curList[newIdx];
  showOutcomeDetail(o, findSegByMask(o.mask), curList);
}

/* ═══════════════════════════════════════════════════════
   ROUTES
════════════════════════════════════════════════════════ */
// sidebarNav: activates a tab by its data-tab name.
// Used by sidebar links so clicking them navigates the main content area.
// ── Sidebar hover + pin logic ──
(function() {
  let hoverTimer;
  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const rail = document.getElementById('sbRail');
    if (!sidebar || !rail) return;

    function open()  { rail.classList.add('is-open'); }
    function close() { if (!sidebar.classList.contains('sb-pinned')) rail.classList.remove('is-open'); }

    sidebar.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); open(); });
    sidebar.addEventListener('mouseleave', () => { hoverTimer = setTimeout(close, 120); });

    // Restore pin state
    if (localStorage.getItem('sb_pinned') === '1') {
      sidebar.classList.add('sb-pinned');
      rail.classList.add('is-open');
      const btn = document.getElementById('sbExpandBtn');
      if (btn) {
        btn.setAttribute('data-tip', 'Unpin sidebar');
        const lbl = btn.querySelector('.sb-label');
        if (lbl) lbl.textContent = 'Unpin';
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSidebar);
  else initSidebar();
})();

function toggleSidebarExpand() {
  const sb   = document.getElementById('sidebar');
  const rail = document.getElementById('sbRail');
  const btn  = document.getElementById('sbExpandBtn');
  const pinned = sb.classList.toggle('sb-pinned');
  if (pinned) rail.classList.add('is-open');
  localStorage.setItem('sb_pinned', pinned ? '1' : '0');
  if (btn) {
    btn.setAttribute('data-tip', pinned ? 'Unpin sidebar' : 'Pin sidebar open');
    const lbl = btn.querySelector('.sb-label');
    if (lbl) lbl.textContent = pinned ? 'Unpin' : 'Pin open';
  }
}

function sidebarNav(tab) {
  const btn = document.querySelector('[data-tab="'+tab+'"]');
  if(btn) switchTab(tab, btn);
}

function setSidebarActiveLink(tab) {
  // New icon rail: highlight by data-tab-target
  document.querySelectorAll('#sidebar .sb-icon-btn[data-tab-target]').forEach(btn => btn.classList.remove('nav-active'));
  document.querySelectorAll('#sidebar .sb-icon-btn[data-tab-target="'+tab+'"]').forEach(btn => btn.classList.add('nav-active'));
  // My Team button special case
  const myTeamBtn = document.getElementById('sbMyTeamLink');
  if (myTeamBtn && tab === 'myteam') myTeamBtn.classList.add('nav-active');
  else if (myTeamBtn) myTeamBtn.classList.remove('nav-active');
}

function toggleSidebar() {
  const col = document.getElementById('sbCollapsible');
  const chev = document.getElementById('sbChevron');
  if(!col) return;
  col.classList.toggle('collapsed');
  if(chev) chev.classList.toggle('open');
}

let _toastTimer;
function showToast(msg, type='info', dur=3000) {
  const t = document.getElementById('toast');
  if(!t) return;
  clearTimeout(_toastTimer);
  t.textContent = msg;
  t.className = 'show ' + type;
  _toastTimer = setTimeout(() => { t.classList.remove('show'); }, dur);
}

const ROUTES=[
  
];

function renderRoutes() {
  document.getElementById('routeBody').innerHTML=ROUTES.map(([c,n,d])=>
    `<tr><td><code>${c}</code></td><td><strong>${n}</strong></td><td style="font-size:12px;color:var(--ink2)">${d}</td></tr>`
  ).join('');
}

/* ═══════════════════════════════════════════════════════
   TABS
════════════════════════════════════════════════════════ */
function switchTab(t, el) {
  const incoming = document.getElementById('tab-'+t);
  if (!incoming) {
    console.warn('Unknown tab:', t);
    return false;
  }
  el = el || document.querySelector('.tab[data-tab="'+t+'"]');
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  if (el) el.classList.add('active');
  setSidebarActiveLink(t);

  // Update URL hash for deep linking
  try { history.replaceState(null, '', '#' + t); } catch(e) {}

  // Swap panels synchronously so a tab-specific render error cannot leave panels stacked.
  const outgoing = document.querySelector('.panel.active');
  if (outgoing === incoming) return true;

  document.querySelectorAll('.panel').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });
  incoming.style.display = 'block';
  void incoming.offsetWidth; // force reflow so animation triggers
  incoming.classList.add('active');

  try {
    if(t==='predict') { calcProb(); updateTsBadges(); }
    if(t==='routes') renderRoutes();
    if(t==='log') { logPg = _logDirty ? 1 : logPg; renderLog(); }
    if(t==='leaderboard' && _lbDirty) { _lbDirty = false; lbSortRender(); }
    if(t==='roadmap') loadUpdates().catch(e => console.warn('Roadmap load failed:', e));
    if(t==='ts-rankings') tsApply();
    if(t==='experimental') { renderRforce(); trBuild(); }
    if(t==='skills') { skRender(); }
    if(t==='calendar') {
      loadCalEvents().catch(e => console.warn('Calendar load failed:', e));
      setTimeout(function() {
        try { runAlliance(); } catch(e) { console.warn('Alliance helper render failed:', e); }
      }, 100);
    }
  } catch(e) {
    console.error('Tab setup failed for "' + t + '":', e);
    showToast('That tab hit a render error, but navigation recovered.', 'err', 3500);
  }

  try {
    document.dispatchEvent(new CustomEvent('tabchange', { detail: { tab: t } }));
  } catch(e) {
    console.warn('Tabchange listener failed for "' + t + '":', e);
  }
  return true;
}

/* ── Auton Calculator panel toggle ── */
function toggleAutonCalcPanel() {
  const p    = document.getElementById('auton-calc-panel');
  const btn  = document.getElementById('auton-calc-toggle-btn');
  const chev = document.getElementById('auton-calc-chevron');
  // Clear any stuck exit animation on the predict panel before resizing
  const predictPanel = document.getElementById('tab-predict');
  if (predictPanel) { predictPanel.classList.remove('exit'); }
  const isOpen = p.style.display === 'block';
  requestAnimationFrame(() => {
    p.style.display = isOpen ? 'none' : 'block';
    btn.setAttribute('aria-pressed', String(!isOpen));
    btn.style.borderColor = isOpen ? '' : 'var(--red)';
    btn.style.color       = isOpen ? '' : 'var(--ink)';
    chev.style.transform  = isOpen ? '' : 'rotate(180deg)';
  });
}

/* ── True Skill panel toggle ── */
function toggleTrueSkillPanel() {
  const panel = document.getElementById('ts-correlation-panel');
  const btn   = document.getElementById('ts-toggle-btn');
  const chev  = document.getElementById('ts-toggle-chevron');
  const open  = panel.style.display !== 'none';
  if (open) {
    panel.style.display = 'none';
    btn.style.background = 'var(--paper2)';
    btn.style.color = 'var(--ink2)';
    btn.style.borderColor = 'var(--paper3)';
    btn.setAttribute('aria-pressed','false');
    chev.style.transform = '';
    updateTsBadges(); // clear badges when toggled off
  } else {
    panel.style.display = 'block';
    btn.style.background = 'var(--blue-bg)';
    btn.style.color = 'var(--blue)';
    btn.style.borderColor = 'var(--blue)';
    btn.setAttribute('aria-pressed','true');
    chev.style.transform = 'rotate(180deg)';
    updateTsBadges();
  }
}

/* ═══════════════════════════════════════════════════════
   INIT — check if already logged in this session
════════════════════════════════════════════════════════ */
// Restore admin session — sessionStorage only (localStorage removed for security)
const storedToken = sessionStorage.getItem('sb_token');
const storedExp = parseInt(sessionStorage.getItem('sb_token_exp') || '0');
if(storedToken && Date.now() < storedExp) {
  adminToken = storedToken;
  isAdmin = true;
  launchApp(true);
} else {
  // Clear any stale session data
  sessionStorage.removeItem('sb_token');
  sessionStorage.removeItem('sb_token_exp');
  launchApp(false);
}

/* ═══════════════════════════════════════════════════════
   SIG CALENDAR — Supabase backed
════════════════════════════════════════════════════════ */
let calEvents = [];
let calEventsMap = new Map(); // id → event object, avoids fragile inline JSON serialisation
let activeCalFilter = null;

// Shared region map used by both the Add and Edit calendar event forms
const REGION_MAP = {
  'USA': ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'],
  'Canada': ['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland','Nova Scotia','Ontario','Prince Edward Island','Quebec','Saskatchewan'],
  'Australia': ['ACT','New South Wales','Northern Territory','Queensland','South Australia','Tasmania','Victoria','Western Australia'],
  'China': ['Beijing','Chongqing','Fujian','Guangdong','Guangxi','Guizhou','Hainan','Hebei','Heilongjiang','Henan','Hubei','Hunan','Inner Mongolia','Jiangsu','Jiangxi','Jilin','Liaoning','Ningxia','Qinghai','Shaanxi','Shandong','Shanghai','Shanxi','Sichuan','Tianjin','Tibet','Xinjiang','Yunnan','Zhejiang'],
};

/* ── Load events from Supabase (public — anyone can read) ── */
async function loadCalEvents() {
  try {
    const r = await fetch(SB_URL + '/rest/v1/sig_events?select=*&order=start_date.asc', { headers: HDRS });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    calEvents = await r.json();
    calEventsMap = new Map(calEvents.map(e => [String(e.id), e]));
    renderCalList();
    updateCalSelect();
    lbReImportPopulateEvents();
  } catch(e) {
    console.error('Could not load sig events:', e);
    document.getElementById('calList').innerHTML = '<div class="empty" style="color:var(--red-text)">Could not load events from database.</div>';
  }
}

/* ── Add event → Supabase (admin only) ── */
function toggleCalRegion(country) {
  const wrap = document.getElementById('cal-region-wrap');
  const dl   = document.getElementById('cal-region-list');
  if(country && REGION_MAP[country]) {
    dl.innerHTML = REGION_MAP[country].map(r=>`<option value="${r}">`).join('');
    wrap.style.display = 'block';
  } else if(country) {
    dl.innerHTML = '';
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
    document.getElementById('cal-region').value = '';
  }
}

async function addCalEvent() {
  if(!isAdmin) return;
  const name  = document.getElementById('cal-name')?.value.trim();
  const start = document.getElementById('cal-start')?.value;
  const end   = document.getElementById('cal-end')?.value;
  const loc   = document.getElementById('cal-loc')?.value.trim();
  const notes = document.getElementById('cal-notes')?.value.trim();
  const maps  = document.getElementById('cal-maps')?.value.trim();
  const country = document.getElementById('cal-country')?.value.trim();
  const region  = document.getElementById('cal-region')?.value.trim();
  if(!name || !start || !end) { showMsg('cal-msg','Name, start and end date are required.','err'); return; }
  if(start > end)             { showMsg('cal-msg','Start date must be before end date.','err'); return; }

  // Check for duplicate before submitting
  const duplicate = calEvents.find(e => e.name === name && e.start_date === start);
  if(duplicate) { showMsg('cal-msg','An event with this name and start date already exists.','err'); return; }

  showMsg('cal-msg','Saving…','ok');
  try {
    const r = await fetch(SB_URL + '/rest/v1/sig_events', {
      method: 'POST',
      headers: { ...adminHdrs(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ name, start_date: start, end_date: end, location: loc, notes, maps_url: maps||null, country: country||null, region: region||null, is_sig: document.getElementById('cal-is-sig')?.checked })
    });
    if(!r.ok) { const t=await r.text(); throw new Error(t); }
    clearCalForm();
    showMsg('cal-msg', '✓ Event saved to database!', 'ok');
    await loadCalEvents();
  } catch(e) {
    showMsg('cal-msg', 'Failed to save: ' + e.message, 'err');
    console.error(e);
  }
}

function clearCalForm() {
  ['cal-name','cal-start','cal-end','cal-loc','cal-notes','cal-maps'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cal-country').value = '';
  document.getElementById('cal-region').value = '';
  document.getElementById('cal-region-wrap').style.display = 'none';
  document.getElementById('cal-is-sig').checked = false;
}

/* ── Delete event (admin only) ── */
async function deleteCalEvent(id) {
  if(!isAdmin) return;
  if(!confirm('Delete this event?')) return;
  try {
    const r = await fetch(SB_URL + '/rest/v1/sig_events?id=eq.' + id, {
      method: 'DELETE',
      headers: adminHdrs()
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    if(activeCalFilter && activeCalFilter.id === id) clearCalFilter();
    await loadCalEvents();
  } catch(e) {
    alert('Could not delete event: ' + e.message);
  }
}

/* ── Edit event modal ── */
let _editCalId = null;

function openEditCalById(id) {
  const ev = calEvents.find(e => String(e.id) === String(id));
  if(ev) openEditCalModal(ev);
}

function openEditCalModal(ev) {
  _editCalId = ev.id;
  document.getElementById('edit-cal-name').value    = ev.name || '';
  document.getElementById('edit-cal-start').value   = ev.start_date || '';
  document.getElementById('edit-cal-end').value     = ev.end_date || '';
  document.getElementById('edit-cal-loc').value     = ev.location || '';
  document.getElementById('edit-cal-notes').value   = ev.notes || '';
  document.getElementById('edit-cal-maps').value    = ev.maps_url || '';
  document.getElementById('edit-cal-country').value = ev.country || '';
  document.getElementById('edit-cal-region').value  = ev.region || '';
  document.getElementById('edit-cal-is-sig').checked = !!ev.is_sig;
  toggleEditCalRegion(ev.country || '');
  document.getElementById('edit-cal-err').textContent = '';
  document.getElementById('editCalModal')?.classList.add('open');
}

function closeEditCalModal() {
  document.getElementById('editCalModal')?.classList.remove('open');
  _editCalId = null;
}

function toggleEditCalRegion(country) {
  const wrap = document.getElementById('edit-cal-region-wrap');
  const dl   = document.getElementById('edit-cal-region-list');
  if(country && REGION_MAP[country]) {
    dl.innerHTML = REGION_MAP[country].map(r=>`<option value="${r}">`).join('');
    wrap.style.display = 'block';
  } else if(country) {
    dl.innerHTML = '';
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
    document.getElementById('edit-cal-region').value = '';
  }
}

async function saveEditCalEvent() {
  if(!isAdmin || !_editCalId) return;
  const name    = document.getElementById('edit-cal-name')?.value.trim();
  const start   = document.getElementById('edit-cal-start')?.value;
  const end     = document.getElementById('edit-cal-end')?.value;
  const loc     = document.getElementById('edit-cal-loc')?.value.trim();
  const notes   = document.getElementById('edit-cal-notes')?.value.trim();
  const maps    = document.getElementById('edit-cal-maps')?.value.trim();
  const country = document.getElementById('edit-cal-country')?.value.trim();
  const region  = document.getElementById('edit-cal-region')?.value.trim();
  const errEl   = document.getElementById('edit-cal-err');
  if(!name || !start || !end) { errEl.textContent = 'Name, start and end date are required.'; return; }
  if(start > end)             { errEl.textContent = 'Start date must be before end date.';    return; }
  errEl.textContent = 'Saving…';
  try {
    const calPatch = await fetch(SB_URL + '/rest/v1/sig_events?id=eq.' + _editCalId, {
      method: 'PATCH',
      headers: { ...adminHdrs(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        name, start_date: start, end_date: end,
        location: loc || null, notes: notes || null,
        maps_url: maps || null, country: country || null, region: region || null,
        is_sig: document.getElementById('edit-cal-is-sig')?.checked
      })
    });
    if(!r.ok) { const t = await r.text(); throw new Error(t); }
    errEl.style.color = 'var(--green)';
    errEl.textContent = '✓ Saved!';
    setTimeout(closeEditCalModal, 700);
    await loadCalEvents();
  } catch(e) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = 'Failed: ' + e.message;
  }
}

/* ── Render calendar list ── */
let _calShowPast = false;
function calTogglePast() {
  _calShowPast = !_calShowPast;
  renderCalList();
}

function calCountryFilterChange() {
  const country = document.getElementById('cal-country-filter')?.value;
  const stateEl = document.getElementById('cal-state-filter');
  // Only show states present in actual events for this country
  const statesInData = [...new Set(
    calEvents.filter(e => e.country === country && e.region).map(e => e.region)
  )].sort();
  if(country && statesInData.length) {
    stateEl.innerHTML = '<option value="">All states</option>' +
      statesInData.map(s=>`<option value="${s}">${s}</option>`).join('');
    stateEl.style.display = '';
  } else {
    stateEl.style.display = 'none';
    stateEl.value = '';
  }
  renderCalList();
}

function populateCalCountryFilter() {
  const sel = document.getElementById('cal-country-filter');
  const cur = sel.value;
  const countriesInData = [...new Set(calEvents.map(e=>e.country).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All countries</option>' +
    countriesInData.map(c=>`<option value="${c}">${c}</option>`).join('');
  // Restore previously selected country if it still exists in data
  if(cur && countriesInData.includes(cur)) sel.value = cur;
}

function renderCalList() {
  const el = document.getElementById('calList');
  // Keep the toggle button in sync with state
  const pastChip = document.getElementById('cal-show-past-chip');
  if(pastChip) pastChip.classList.toggle('on', _calShowPast);
  if(!calEvents.length) {
    el.innerHTML = '<div class="empty" style="padding:1.5rem">No Sig events added yet.</div>';
    document.getElementById('cal-event-count').textContent = '';
    if(document.getElementById('hero-cal-total')) {
      document.getElementById('hero-cal-total').textContent = '0';
      document.getElementById('hero-cal-upcoming').textContent = '0';
      document.getElementById('hero-cal-live').textContent = '0';
    }
    return;
  }

  // Rebuild country dropdown from live data
  populateCalCountryFilter();

  // Apply country + state filters
  const selectedCountry = document.getElementById('cal-country-filter')?.value;
  const selectedState   = document.getElementById('cal-state-filter')?.value || '';
  const filtered = calEvents.filter(e => {
    if(selectedCountry && (e.country||'') !== selectedCountry) return false;
    if(selectedState   && (e.region||'')  !== selectedState)   return false;
    return true;
  });

  const now = new Date().toISOString().slice(0,10);

  if(document.getElementById('hero-cal-total')) {
    let u = 0, l = 0;
    calEvents.forEach(e => {
      if (e.start_date <= now && e.end_date >= now) l++;
      else if (e.start_date > now) u++;
    });
    document.getElementById('hero-cal-total').textContent = calEvents.length;
    document.getElementById('hero-cal-upcoming').textContent = u;
    document.getElementById('hero-cal-live').textContent = l;
  }

  // Filter out past events unless _calShowPast is enabled
  const filtered2 = _calShowPast ? filtered : filtered.filter(e => e.end_date >= now);

  document.getElementById('cal-event-count').textContent =
    filtered2.length + ' event' + (filtered2.length!==1?'s':'') + (_calShowPast ? '' : ' (upcoming)');

  if(!filtered2.length) {
    el.innerHTML = '<div class="empty" style="padding:1.5rem">No '+ (_calShowPast?'':'upcoming ') +'events match this filter.</div>';
    return;
  }

  // Mass-delete toolbar (admin only) — hidden until a checkbox is ticked
  const massToolbar = isAdmin ? `
    <div id="cal-mass-bar" style="display:none;align-items:center;gap:8px;margin-bottom:10px;padding:8px 10px;background:var(--paper2);border-radius:var(--radius);border:.5px solid var(--paper3);flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-family:var(--mono);color:var(--ink2);cursor:pointer;margin:0">
        <input type="checkbox" id="cal-select-all" onchange="calToggleAll(this.checked)" style="width:auto;margin:0">
        Select all
      </label>
      <span id="cal-selected-count" style="font-size:11px;font-family:var(--mono);color:var(--ink3)">0 selected</span>
      <button class="btn btn-sm danger" onclick="calDeleteSelected()" style="margin-left:auto">\uD83D\uDDD1 Delete selected</button>
    </div>` : '';

  const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  el.innerHTML = massToolbar + '<div class="cal-events-grid">' + filtered2.map(e => {
    const isPast    = e.end_date < now;
    const isCurrent = e.start_date <= now && e.end_date >= now;

    // Status badge + countdown
    let statusBadge, countdownHtml = '';
    if(isCurrent) {
      statusBadge = '<span class="badge b-awp" style="font-size:9px;padding:2px 7px;letter-spacing:.5px">&#9679; LIVE NOW</span>';
      countdownHtml = '<span class="cal-event-countdown live">&#9679; In progress</span>';
    } else if(isPast) {
      statusBadge = '<span class="badge b-no" style="font-size:9px">PAST</span>';
    } else {
      statusBadge = '<span class="badge b-sig" style="font-size:9px">UPCOMING</span>';
      // Days until
      const msUntil = new Date(e.start_date) - new Date(now);
      const daysUntil = Math.ceil(msUntil / 86400000);
      if(daysUntil <= 7) {
        countdownHtml = `<span class="cal-event-countdown soon">&#9677; ${daysUntil}d away</span>`;
      } else if(daysUntil <= 30) {
        countdownHtml = `<span class="cal-event-countdown">${daysUntil}d away</span>`;
      }
    }

    // Date column
    const startParts = e.start_date ? e.start_date.split('-') : [];
    const startDay   = startParts[2] ? parseInt(startParts[2],10) : '?';
    const startMonth = startParts[1] ? MONTH_ABBR[parseInt(startParts[1],10)-1] : '';
    const endParts   = e.end_date && e.end_date !== e.start_date ? e.end_date.split('-') : null;
    const endDay     = endParts ? parseInt(endParts[2],10) : null;
    const endMonth   = endParts ? MONTH_ABBR[parseInt(endParts[1],10)-1] : null;

    let mapsUrl = e.maps_url || '';
    if(!mapsUrl && e.location) {
      mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.location);
    }

    const entryCount = allEntries.filter(en => {
      const d = (en.created_at||en.ts||'').slice(0,10);
      return d >= e.start_date && d <= e.end_date;
    }).length;

    const checkbox = isAdmin
      ? `<input type="checkbox" class="cal-evt-cb" data-id="${e.id}" onchange="calUpdateSelectedCount()" style="position:absolute;top:14px;right:14px;width:auto;margin:0;accent-color:var(--red)">`
      : '';

    const cardClasses = [
      'cal-event-card',
      e.is_sig ? 'is-sig' : '',
      isCurrent ? 'is-live' : '',
      isPast ? 'is-past' : ''
    ].filter(Boolean).join(' ');

    return `<div class="${cardClasses}">
      ${checkbox}
      <div class="cal-event-inner">
        <div class="cal-event-datecol">
          <div class="cal-event-month">${startMonth}</div>
          <div class="cal-event-day">${startDay}</div>
          ${endDay ? `<div class="cal-event-dayend">&ndash; ${endMonth !== startMonth ? endMonth+' ' : ''}${endDay}</div>` : ''}
          <div class="cal-event-sep"></div>
        </div>
        <div class="cal-event-body">
          <div class="cal-event-title-row">
            <div class="cal-event-title">${e.is_sig ? '<span class="cal-sig-crown" style="margin-right:4px">&#11088;</span>' : ''}${esc(e.name)}</div>
            <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;flex-wrap:wrap">${statusBadge}${countdownHtml}</div>
          </div>
          <div class="cal-event-meta">
            ${e.location ? `<span class="cal-event-meta-item"><span class="mi-icon mi-loc">&#128205;</span> ${mapsUrl ? `<a href="${esc(mapsUrl)}" target="_blank" rel="noopener" class="cal-event-meta-link">${esc(e.location)} &#8599;</a>` : esc(e.location)}</span>` : ''}
            ${e.country ? `<span class="cal-event-meta-item"><span class="mi-icon mi-globe">&#127758;</span> ${esc(e.country)}${e.region ? ' &middot; '+esc(e.region) : ''}</span>` : ''}
            <span class="cal-event-meta-item"><span class="mi-icon mi-scout">&#128203;</span> ${entryCount} scout entr${entryCount!==1?'ies':'y'}</span>
          </div>
          ${e.notes ? `<div class="cal-event-notes">${esc(e.notes)}</div>` : ''}
          <div class="cal-event-footer">
            <button class="btn btn-sm" onclick="openSchedModal('${e.id}')">&#128203; Schedule</button>
            <button class="btn btn-sm" onclick="filterByEvent('${e.id}')">&#128202; Filter LB</button>
            <button class="btn btn-sm" onclick="openAllianceForEvent('${e.id}')">&#129309; Alliance</button>
            <button class="btn btn-sm" onclick="openPitForEvent('${e.id}')">&#129302; Pit Scout</button>
            ${isAdmin ? `<button class="btn btn-sm" onclick="openEditCalById('${e.id}')">&#9998; Edit</button>` : ''}
            ${isAdmin ? `<button class="btn btn-sm btn-d" onclick="deleteCalEvent('${e.id}')" title="Delete event">&#215;</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('') + '</div>';
}

function calToggleAll(checked) {
  document.querySelectorAll('.cal-evt-cb').forEach(cb => cb.checked = checked);
  calUpdateSelectedCount();
}

function calUpdateSelectedCount() {
  const n = document.querySelectorAll('.cal-evt-cb:checked').length;
  const total = document.querySelectorAll('.cal-evt-cb').length;
  const countEl = document.getElementById('cal-selected-count');
  if(countEl) countEl.textContent = n + ' of ' + total + ' selected';
  const allCb = document.getElementById('cal-select-all');
  if(allCb) allCb.checked = n > 0 && n === total;
  const massBar = document.getElementById('cal-mass-bar');
  if(massBar) massBar.style.display = n > 0 ? 'flex' : 'none';
}

async function calDeleteSelected() {
  if(!isAdmin) return;
  const checked = [...document.querySelectorAll('.cal-evt-cb:checked')];
  if(!checked.length) { alert('No events selected.'); return; }
  if(!confirm(`Delete ${checked.length} event${checked.length!==1?'s':''}? This cannot be undone.`)) return;
  const ids = checked.map(cb => cb.dataset.id);
  let failed = 0;
  for(const id of ids) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/sig_events?id=eq.' + id, {
        method: 'DELETE', headers: adminHdrs()
      });
      if(!r.ok) failed++;
    } catch(e) { failed++; }
  }
  if(failed) alert(failed + ' deletion(s) failed.');
  if(activeCalFilter && ids.includes(String(activeCalFilter.id))) clearCalFilter();
  await loadCalEvents();
}

/* ── Update the filter dropdown ── */
function updateCalSelect() {
  const sel = document.getElementById('cal-filter-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Show all entries (no filter) —</option>';
  calEvents.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name + ' (' + e.start_date + ' → ' + e.end_date + ')';
    sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

function filterByEvent(id) {
  const ev = calEvents.find(e => String(e.id) === String(id));
  if(!ev) return;
  activeCalFilter = ev;
  applyCalFilterToLeaderboard(ev);
}

function openAllianceForEvent(id) {
  const ev = calEvents.find(e => String(e.id) === String(id));
  const labelEl = document.getElementById('al-modal-event-label');
  if(ev && labelEl) labelEl.textContent = ev.name;
  document.getElementById('al-modal-bg').classList.add('open');
  runAlliance();
}

function closeAlModal() {
  document.getElementById('al-modal-bg').classList.remove('open');
}

function openPitForEvent(id) {
  const ev = id ? calEvents.find(e => String(e.id) === String(id)) : null;
  const labelEl = document.getElementById('pit-modal-event-label');
  if(labelEl) labelEl.textContent = ev ? ev.name : '';
  // Pre-fill event field if event context is known and field is empty
  const pitEventEl = document.getElementById('pit-event');
  if(ev && pitEventEl && !pitEventEl.value) pitEventEl.value = ev.name;
  pitModalTab('form', document.querySelector('.pit-modal-tab'));
  document.getElementById('pit-modal-bg').classList.add('open');
  renderPitLog();
}

function closePitModal() {
  document.getElementById('pit-modal-bg').classList.remove('open');
}

function pitModalTab(name, btn) {
  document.querySelectorAll('.pit-modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pit-modal-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('pit-modal-panel-' + name)?.classList.add('active');
  if(name === 'log') renderPitLog();
}

function applyCalFilter() {
  const id = document.getElementById('cal-filter-select')?.value;
  if(!id) { clearCalFilter(); return; }
  const ev = calEvents.find(e => String(e.id) === String(id));
  if(ev) { activeCalFilter = ev; applyCalFilterToLeaderboard(ev); }
}

function applyCalFilterToLeaderboard(ev) {
  const filtered = allEntries.filter(en => {
    const d = (en.created_at||en.ts||'').slice(0,10);
    return d >= ev.start_date && d <= ev.end_date;
  });
  const filteredTeams = buildStats(filtered);
  filteredTeams.forEach(t => { teamDetailMap[t.team] = t; }); // ensure click handler can find them
  lbFiltered = [...filteredTeams];
  lbPg = 1;
  lbSortRender();
  const totP = filtered.reduce((s,e)=>s+pins(e),0);
  const avgP = filtered.length ? (totP/filtered.length).toFixed(1) : '—';
  const awpR = filtered.length ? Math.round(filtered.filter(e=>e.awp==='Y').length/filtered.length*100) : 0;
  document.getElementById('lbT').textContent = filteredTeams.length;
  document.getElementById('lbE').textContent = filtered.length;
  document.getElementById('lbP').textContent = avgP;
  document.getElementById('lbA').textContent = awpR + '%';
  document.getElementById('cal-filter-status').innerHTML =
    '✓ Filtered to <strong>' + esc(ev.name) + '</strong> (' + esc(ev.start_date) + ' → ' + esc(ev.end_date) + ') — ' +
    filtered.length + ' entries, ' + filteredTeams.length + ' teams. ' +
    '<a href="#" onclick="clearCalFilter();return false;" style="color:var(--blue)">Clear filter</a>';
  // Jump to leaderboard
  const _lbBtn2 = document.querySelector('[data-tab="leaderboard"]');
  if (_lbBtn2) _lbBtn2.click();
  setSyncStatus('ok', 'Filtered: ' + ev.name);
}

function clearCalFilter() {
  activeCalFilter = null;
  document.getElementById('cal-filter-select').value = '';
  document.getElementById('cal-filter-status').textContent = '';
  lbFiltered = [...allTeams];
  lbPg = 1;
  lbSortRender();
  const totP = allEntries.reduce((s,e)=>s+pins(e),0);
  const avgP = allEntries.length ? (totP/allEntries.length).toFixed(1) : '—';
  const awpR = allEntries.length ? Math.round(allEntries.filter(e=>e.awp==='Y').length/allEntries.length*100) : 0;
  document.getElementById('lbT').textContent = allTeams.length;
  document.getElementById('lbE').textContent = allEntries.length;
  document.getElementById('lbP').textContent = avgP;
  document.getElementById('lbA').textContent = awpR + '%';
  setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries');
}

// Load calendar on init
loadCalEvents();

/* ═══════════════════════════════════════════════════════
   ROBOTEVENTS API INTEGRATION
   Fetches VRC Signature events and imports them into
   the Supabase sig_events table.
   API key stored in localStorage (browser only).

   ⚠ MIGRATION REQUIRED — run once in Supabase SQL editor:
   alter table sig_events add column if not exists re_event_id bigint;

════════════════════════════════════════════════════════ */

const RE_API = 'https://www.robotevents.com/api/v2';
// Single canonical localStorage key for the RobotEvents API token
const RE_TOKEN_KEY = 'override_scout_re_token';

// VRC program ID on RobotEvents is 1
const RE_VRC_PROGRAM = 1;

/* ── Token persistence ── */
function syncReTokenInputs(val) {
  ['settings-re-token', 're-token', 'sched-re-token', 'qs-re-token', 'lb-re-import-token'].forEach(id => {
    const el = document.getElementById(id);
    if(el && el.value !== val) el.value = val;
  });
}

function saveRobotEventsToken(val) {
  val = (val || '').trim();
  try {
    if(val) localStorage.setItem(RE_TOKEN_KEY, val);
    else localStorage.removeItem(RE_TOKEN_KEY);
  } catch(e) {}
  syncReTokenInputs(val);
}

function saveReToken() {
  const val = document.getElementById('re-token')?.value.trim();
  saveRobotEventsToken(val);
}
function clearReToken() {
  saveRobotEventsToken('');
  const msg = document.getElementById('re-msg');
  if(msg) msg.textContent = 'API key cleared.';
}
function loadReToken() {
  try {
    const legacyQuickScoutToken = localStorage.getItem('os_qs_re_token') || '';
    const t = localStorage.getItem(RE_TOKEN_KEY) || legacyQuickScoutToken;
    if(t) saveRobotEventsToken(t);
    else syncReTokenInputs('');
  } catch(e) {}
}

/* ── Main sync function ── */
async function syncFromRobotEvents() {
  const token = getREToken();
  if(!token) {
    setReMsg('⚠ Paste your RobotEvents API token first.', 'err');
    return;
  }

  setReMsg('Fetching events from RobotEvents…', 'ok');
  document.getElementById('re-preview').style.display = 'none';

  try {
    // Fetch all upcoming VRC events across all levels
    // We paginate until we have everything (RobotEvents returns max 250/page)
    const today = new Date().toISOString().slice(0, 10);
    let page = 1, allFetched = [], lastMeta;

    do {
      // Route through Supabase Edge Function proxy to avoid CORS
      const data = await reProxyFetch('/events', {
        'program[]': RE_VRC_PROGRAM,
        'start': today + 'T00:00:00.000Z',
        'per_page': '250',
        'page': String(page)
      }, token);
      allFetched = allFetched.concat(data.data || []);
      lastMeta = data.meta;
      page++;
    } while(lastMeta && lastMeta.current_page < lastMeta.last_page);

    if(!allFetched.length) {
      setReMsg('No upcoming VRC events found.', 'err');
      return;
    }

    // Filter out events already in our Supabase list (match by name + start_date)
    const existingKeys = new Set(calEvents.map(e => e.name + '|' + e.start_date));

    const newEvents = allFetched.filter(re => {
      const start = (re.start || '').slice(0, 10);
      return !existingKeys.has(re.name + '|' + start);
    });

    setReMsg(`Found ${allFetched.length} event${allFetched.length!==1?'s':''} total, ${newEvents.length} new.`, 'ok');

    // Show preview
    renderRePreview(allFetched, existingKeys);

  } catch(e) {
    setReMsg('Error: ' + e.message, 'err');
    console.error(e);
  }
}

/* ── Render the preview list with checkboxes ── */
function renderRePreview(events, existingKeys) {
  const now = new Date().toISOString().slice(0, 10);

  // ── Deduplicate by RobotEvents ID, then fallback to name+date ──
  const seen = new Set();
  const deduped = events.filter(re => {
    const key = re.id ? String(re.id) : (re.name + '|' + (re.start||'').slice(0,10));
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Populate country filter dropdown ──
  const countries = [...new Set(
    deduped.map(re => re.location?.country).filter(Boolean).sort()
  )];
  const sel = document.getElementById('re-country-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All countries</option>' +
    countries.map(c => `<option value="${c}"${c===prev?' selected':''}>${c}</option>`).join('');

  // Store for filtering
  window._reEventsFetched = deduped;
  window._reExistingKeys  = existingKeys;

  reApplyFilters();
}

function reApplyFilters() {
  const now      = new Date().toISOString().slice(0, 10);
  const country  = document.getElementById('re-country-filter')?.value;
  const events   = window._reEventsFetched || [];
  const existingKeys = window._reExistingKeys || new Set();
  const list     = document.getElementById('re-preview-list');

  const filtered = country ? events.filter(re => re.location?.country === country) : events;

  document.getElementById('re-visible-count').textContent =
    filtered.length + ' event' + (filtered.length !== 1 ? 's' : '');

  if(!filtered.length) {
    list.innerHTML = '<div class="empty" style="padding:1rem">No events for this country.</div>';
    return;
  }

  list.innerHTML = filtered.map((re, i) => {
    const origIdx   = events.indexOf(re);
    const start     = (re.start || '').slice(0, 10);
    const end       = (re.end   || '').slice(0, 10);
    const alreadyIn = existingKeys.has(re.name + '|' + start);
    const isUpcoming = start >= now;

    // Location parts
    const locParts = [re.location?.venue, re.location?.city, re.location?.region, re.location?.country].filter(Boolean);
    const locText  = locParts.join(', ');

    // Google Maps link — use venue + city if available, else event name + city
    const mapsQuery = encodeURIComponent(
      [re.location?.venue || re.name, re.location?.city, re.location?.region, re.location?.country]
        .filter(Boolean).join(', ')
    );
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

    return `
    <div data-re-country="${esc(re.location?.country||'')}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:.5px solid var(--paper3);">
      <label style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;cursor:${alreadyIn?'default':'pointer'};opacity:${alreadyIn?'0.55':'1'}">
        <input type="checkbox" data-re-idx="${origIdx}" ${alreadyIn?'disabled checked':''} ${isUpcoming&&!alreadyIn?'checked':''} style="margin-top:3px;flex-shrink:0">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;margin-bottom:3px;display:flex;flex-wrap:wrap;align-items:center;gap:4px">
            <span style="flex:1;min-width:120px;word-break:break-word">${esc(re.name)}</span>
            ${alreadyIn ? '<span class="badge b-no">Already imported</span>' : '<span class="badge b-sig">New</span>'}
            ${re.level && re.level !== 'Signature' ? `<span class="badge b-q">${esc(re.level)}</span>` : ''}
          </div>
          <div style="font-size:11px;font-family:var(--mono);color:var(--ink3);margin-bottom:2px">
            ${esc(start)}${end!==start?' → '+esc(end):''}&nbsp;
          </div>
          ${locText ? `<div style="font-size:11px;color:var(--ink2);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>${esc(locText)}</span>
            <a href="${esc(mapsUrl)}" target="_blank" rel="noopener"
              style="display:inline-flex;align-items:center;gap:3px;color:var(--blue);text-decoration:none;font-family:var(--mono);font-size:10px;white-space:nowrap"
              onclick="event.stopPropagation()">📍 Maps</a>
          </div>` : ''}
        </div>
      </label>
    </div>`;
  }).join('');

  document.getElementById('re-preview').style.display = 'block';
}

function reSelectAll(checked) {
  document.querySelectorAll('#re-preview-list input[type=checkbox]:not(:disabled)').forEach(cb => {
    cb.checked = checked;
  });
}


/* ── Import checked events into Supabase ── */
async function importSelectedReEvents() {
  const checkboxes = document.querySelectorAll('#re-preview-list input[type=checkbox]:not(:disabled):checked');
  if(!checkboxes.length) {
    setReMsg('No new events selected.', 'err');
    return;
  }

  const events = window._reEventsFetched || [];
  setReMsg(`Importing ${checkboxes.length} event${checkboxes.length!==1?'s':''}…`, 'ok');

  let saved = 0, failed = 0;
  for(const cb of checkboxes) {
    const re = events[parseInt(cb.dataset.reIdx)];
    if(!re) continue;

    const start = (re.start || '').slice(0, 10);
    const end   = (re.end   || '').slice(0, 10);
    const location = [re.location?.venue, re.location?.city, re.location?.region]
                       .filter(Boolean).join(', ');
    const notes = re.location?.country && re.location.country !== 'United States'
      ? re.location.country
      : '';
    const mapsQuery = encodeURIComponent(
      [re.location?.venue || re.name, re.location?.city, re.location?.region, re.location?.country]
        .filter(Boolean).join(', ')
    );
    const maps_url = mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${mapsQuery}` : null;

    // Skip if already in calEvents by re_event_id or name+date match
    const alreadyExists = calEvents.some(existing =>
      (re.id && existing.re_event_id && String(existing.re_event_id) === String(re.id)) ||
      (existing.name === re.name && existing.start_date === start)
    );
    if(alreadyExists) { saved++; continue; }

    try {
      const evRes = await fetch(SB_URL + '/rest/v1/sig_events', {
        method: 'POST',
        headers: { ...adminHdrs(), 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          name:         re.name,
          start_date:   start,
          end_date:     end,
          location:     location || null,
          notes:        notes || null,
          re_event_id:  re.id || null,
          maps_url:     maps_url || null
        })
      });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      saved++;
    } catch(e) {
      console.error('Failed to save', re.name, e);
      failed++;
    }
  }

  document.getElementById('re-preview').style.display = 'none';
  setReMsg(
    `✓ Imported ${saved} event${saved!==1?'s':''}${failed?' · '+failed+' failed':''}`,
    failed ? 'err' : 'ok'
  );
  await loadCalEvents();
}

function setReMsg(msg, type) {
  const el = document.getElementById('re-msg');
  el.textContent = msg;
  el.style.color = type === 'err' ? 'var(--red-text)' : 'var(--green)';
}

/* ═══════════════════════════════════════════════════════
   MATCH SCHEDULE MODAL
════════════════════════════════════════════════════════ */
let _schedEvent = null;       // current event object
let _schedMatches = [];       // all fetched matches
let _schedFilter = 'qual';    // 'qual' | 'elim' | 'all'
let _schedSelectedMatch = null;

function saveSchedToken() {
  const v = document.getElementById('sched-re-token')?.value.trim();
  saveRobotEventsToken(v);
}
function loadSchedToken() {
  try {
    const v = localStorage.getItem(RE_TOKEN_KEY) || '';
    syncReTokenInputs(v);
  } catch(e){}
}

function openSchedModal(evOrId) {
  // Accept either a plain event object or an event ID string
  let ev;
  if (typeof evOrId === 'string' || typeof evOrId === 'number') {
    ev = calEventsMap.get(String(evOrId));
    if (!ev) { console.error('openSchedModal: event not found for id', evOrId); return; }
  } else {
    ev = evOrId;
  }
  _schedEvent = ev;
  _schedMatches = [];
  _schedSelectedMatch = null;
  _schedFilter = 'qual';

  document.getElementById('schedModalTitle').textContent = ev.name;
  document.getElementById('schedModalSub').textContent =
    ev.start_date + (ev.end_date !== ev.start_date ? ' → ' + ev.end_date : '') +
    (ev.location ? ' · ' + ev.location : '');
  document.getElementById('sched-status').textContent = ev.re_event_id
    ? 'RobotEvents ID: ' + ev.re_event_id + ' · Click "Load Schedule" to fetch matches.'
    : 'No RobotEvents ID linked to this event. Import the event via RobotEvents sync to enable schedule loading.';
  document.getElementById('sched-list').innerHTML = '<div class="empty" style="padding:2rem">Click "Load Schedule" to fetch matches from RobotEvents.</div>';
  document.getElementById('sched-filter-bar').style.display = 'none';
  document.getElementById('sched-match-from').style.display = 'none';
  document.getElementById('em-add-entry-bar').style.display = 'none';

  // Reset calc — clear both calculators
  ['em-r1','em-r2','em-b1','em-b2'].forEach(id => { document.getElementById(id).value = ''; });
  ['r1','r2','b1','b2'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  ['em-r1g1','em-r1g2','em-r2g1','em-r2g2','em-b1g1','em-b1g2','em-b2g1','em-b2g2'].forEach(id => { document.getElementById(id).value = 2; });
  ['em-r1fail','em-r2fail','em-b1fail','em-b2fail'].forEach(id => { document.getElementById(id).value = 0; });
  ['em-r1awp','em-r2awp','em-b1awp','em-b2awp'].forEach(id => { const el=document.getElementById(id); if(el) el.value=0; });
  const awpBarsEl = document.getElementById('em-awp-bars');
  if (awpBarsEl) awpBarsEl.style.display = 'none';
  try { localStorage.removeItem('os_em_teams'); } catch(e) {}
  emCalcProb();

  // Restore token
  loadSchedToken();

  // Switch to schedule tab
  switchSchedTab('schedule', document.querySelector('.sched-tab'));

  document.getElementById('schedModal')?.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSchedModal() {
  document.getElementById('schedModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function switchSchedTab(name, el) {
  document.querySelectorAll('.sched-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sched-panel').forEach(p => p.classList.remove('active'));
  if(el) el.classList.add('active');
  document.getElementById('sched-panel-' + name)?.classList.add('active');
}

/* ── Fetch match schedule from RobotEvents ── */
async function fetchSchedule() {
  if(!_schedEvent) return;
  const token = getREToken();
  if(!token) {
    document.getElementById('sched-status').textContent = '⚠ Paste your RobotEvents API token first.';
    document.getElementById('sched-status').style.color = 'var(--red-text)';
    return;
  }
  if(!_schedEvent.re_event_id) {
    document.getElementById('sched-status').textContent = '⚠ This event has no RobotEvents ID. Re-import it via the RobotEvents sync tool.';
    document.getElementById('sched-status').style.color = 'var(--red-text)';
    return;
  }

  document.getElementById('sched-status').textContent = 'Fetching schedule…';
  document.getElementById('sched-status').style.color = 'var(--green)';
  document.getElementById('sched-list').innerHTML = '<div class="empty"><span class="spin"></span><br><br>Loading…</div>';

  try {
    // Route all RE calls through Supabase Edge Function proxy to avoid CORS
    const eid = _schedEvent.re_event_id;

    // Get divisions for this event
    const divData = await reProxyFetch(`/events/${eid}/divisions`, {}, token);
    const divisions = divData.data || [];

    let allMatches = [];
    for(const div of divisions) {
      // Fetch all pages of matches for this division
      let page = 1, lastMeta;
      do {
        const mData = await reProxyFetch(
          `/events/${eid}/divisions/${div.id}/matches`,
          { per_page: '250', page: String(page) },
          token
        );
        const matches = (mData.data || []).map(m => ({ ...m, _divName: div.name }));
        allMatches = allMatches.concat(matches);
        lastMeta = mData.meta;
        page++;
      } while(lastMeta && lastMeta.current_page < lastMeta.last_page);
    }

    if(!allMatches.length) {
      document.getElementById('sched-status').textContent = 'No matches found for this event yet.';
      document.getElementById('sched-status').style.color = 'var(--ink3)';
      document.getElementById('sched-list').innerHTML = '<div class="empty" style="padding:2rem">Schedule not posted yet. Check back closer to the event.</div>';
      return;
    }

    // Sort by round type then match number
    allMatches.sort((a, b) => {
      const roundOrder = { 'qual': 0, 'qf': 1, 'sf': 2, 'f': 3 };
      const ra = roundOrder[(a.round||'').toLowerCase()] ?? 9;
      const rb = roundOrder[(b.round||'').toLowerCase()] ?? 9;
      if(ra !== rb) return ra - rb;
      return (a.matchnum || 0) - (b.matchnum || 0);
    });

    _schedMatches = allMatches;
    document.getElementById('sched-status').textContent =
      `✓ Loaded ${allMatches.length} match${allMatches.length!==1?'es':''} · Click any row to analyse in the Auton Calculator.`;
    document.getElementById('sched-status').style.color = 'var(--green)';
    document.getElementById('sched-filter-bar').style.display = 'block';

    // Reset filter chips
    document.querySelectorAll('#sched-filter-bar .chip').forEach(c => c.classList.remove('on'));
    document.querySelector('#sched-filter-bar .chip').classList.add('on');
    _schedFilter = 'qual';
    renderSchedule();
  } catch(e) {
    document.getElementById('sched-status').textContent = 'Error: ' + e.message;
    document.getElementById('sched-status').style.color = 'var(--red-text)';
    document.getElementById('sched-list').innerHTML = '<div class="empty" style="padding:2rem;color:var(--red-text)">' + esc(e.message) + '</div>';
    console.error(e);
  }
}

function schedFilter(f, el) {
  document.querySelectorAll('#sched-filter-bar .chip').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
  _schedFilter = f;
  renderSchedule();
}

function renderSchedule() {
  const isQual = m => (m.round||'').toLowerCase() === 'qual' || (m.round||'').toLowerCase() === 'practice';
  let shown = _schedMatches;
  if(_schedFilter === 'qual') shown = _schedMatches.filter(isQual);
  if(_schedFilter === 'elim') shown = _schedMatches.filter(m => !isQual(m));

  document.getElementById('sched-match-count').textContent = shown.length + ' match' + (shown.length !== 1 ? 'es' : '');

  if(!shown.length) {
    document.getElementById('sched-list').innerHTML = '<div class="empty" style="padding:1.5rem">No matches in this category.</div>';
    return;
  }

  document.getElementById('sched-list').innerHTML = shown.map((m, idx) => {
    const red  = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='red');
    const blue = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='blue');
    const redTeams  = (red?.teams  || []).map(t => t.team?.name || t.teamName || '?');
    const blueTeams = (blue?.teams || []).map(t => t.team?.name || t.teamName || '?');
    const label = formatMatchLabel(m);
    const time  = m.scheduled ? new Date(m.scheduled).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
    const isSelected = _schedSelectedMatch && _schedSelectedMatch.id === m.id;
    // Store index into _schedMatchesShown so selectMatch can look up the full object
    return `<div class="match-row${isSelected?' selected':''}" onclick="selectMatchByIdx(${idx})">
      <div class="match-num">${label}</div>
      <div class="alliance-cell">
        ${redTeams.map(t=>`<span class="team-chip red">${esc(t)}</span>`).join('')}
      </div>
      <div class="alliance-cell">
        ${blueTeams.map(t=>`<span class="team-chip blue">${esc(t)}</span>`).join('')}
      </div>
      <div class="match-time">${time}</div>
    </div>`;
  }).join('');
  // Store the currently-shown list so selectMatchByIdx can reference it
  window._schedMatchesShown = shown;
}

function formatMatchLabel(m) {
  const r = (m.round||'').toLowerCase();
  const n = m.matchnum || m.instance || '';
  if(r === 'qual') return 'Q' + n;
  if(r === 'practice') return 'P' + n;
  if(r === 'qf') return 'QF' + (m.instance||'') + '-' + n;
  if(r === 'sf') return 'SF' + (m.instance||'') + '-' + n;
  if(r === 'f')  return 'F' + n;
  return (m.round||'') + n;
}

function selectMatchByIdx(idx) {
  const m = (window._schedMatchesShown || [])[idx];
  if (m) selectMatch(m);
}

function selectMatch(m) {
  _schedSelectedMatch = m;

  const red  = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='red');
  const blue = (m.alliances||[]).find(a=>(a.color||'').toLowerCase()==='blue');
  const redTeams  = (red?.teams  || []).map(t => (t.team?.name || t.teamName || '').toUpperCase());
  const blueTeams = (blue?.teams || []).map(t => (t.team?.name || t.teamName || '').toUpperCase());

  // Re-render schedule to show selection highlight
  renderSchedule();

  // Switch to calculator tab
  const calcTab = document.querySelectorAll('.sched-tab')[1];
  switchSchedTab('calc', calcTab);

  // Fill team inputs
  const label = formatMatchLabel(m);
  document.getElementById('sched-match-pill').textContent = label + ' — ' +
    redTeams.join(' & ') + ' vs ' + blueTeams.join(' & ');
  document.getElementById('sched-match-from').style.display = 'block';

  const slots = ['em-r1','em-r2','em-b1','em-b2'];
  const teams = [redTeams[0]||'', redTeams[1]||'', blueTeams[0]||'', blueTeams[1]||''];
  slots.forEach((id, i) => {
    document.getElementById(id).value = teams[i];
    if(teams[i]) emAutoFill(id);
  });

  // Show "Add Entry" quick-fill buttons
  const allTeamsInMatch = [...redTeams, ...blueTeams].filter(Boolean);
  const r = (m.round||'').toLowerCase();
  const roundStr = r === 'qual' ? 'Q' + (m.matchnum||m.instance||'') :
                   r === 'sf'   ? 'SF' + (m.instance||'') + '-' + (m.matchnum||'') :
                   r === 'qf'   ? 'QF' + (m.instance||'') + '-' + (m.matchnum||'') :
                   r === 'f'    ? 'F' + (m.matchnum||'') : label;

  document.getElementById('em-add-buttons').innerHTML = allTeamsInMatch.map((team, i) => {
    const side = i < 2 ? 'R' : 'B';
    return `<button class="btn ${side==='R'?'':'btn-p'}" style="${side==='R'?'color:var(--red-text);border-color:var(--red-bg)':''}"
      data-team="${esc(team)}" data-round="${esc(roundStr)}" data-side="${esc(side)}">
      Log ${esc(team)} (${side==='R'?'Red':'Blue'})
    </button>`;
  }).join('');
  document.getElementById('em-add-buttons').querySelectorAll('button[data-team]').forEach(btn => {
    btn.addEventListener('click', function() {
      prefillAddEntry(this.dataset.team, this.dataset.round, this.dataset.side);
      closeSchedModal();
    });
  });
  document.getElementById('em-add-entry-bar').style.display = 'block';
}

/* prefill the main Add Entry form and switch to it */
function prefillAddEntry(team, round, side) {
  if(!isAdmin) return;
  document.getElementById('f-team').value  = team;
  document.getElementById('f-round').value = round;
  document.getElementById('f-side').value  = side;
  // Switch to add tab
  const _addBtn = document.querySelector('[data-tab="add"]');
  if (_addBtn) _addBtn.click();
}

/* ═══════════════════════════════════════════════════════
   EMBEDDED AUTON CALCULATOR (em- prefix)
════════════════════════════════════════════════════════ */
function emAutoFill(id) {
  const team = document.getElementById(id)?.value.trim().toUpperCase();
  const suffix = id.replace('em-', ''); // r1, r2, b1, b2
  if(!team) return;
  const ms = allEntries.filter(e => (e.team||'').toUpperCase() === team);
  if(!ms.length) return;

  const normalEntries = ms.filter(e => (e.route||'').toUpperCase() !== 'SAWP');
  const src = normalEntries.length ? normalEntries : ms;

  const avgG1 = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[0])||0);},0)/src.length;
  const avgG2 = src.reduce((s,e)=>{const p=(e.pins||'0').split('+');return s+(parseInt(p[1])||0);},0)/src.length;
  // AWP and fail rates use all entries so they stay consistent with the win-prob calculator
  const awpRate = Math.round(src.filter(e=>e.awp==='Y').length/src.length*100);
  const knownEntries = ms.filter(e=>e.failed==='Y'||e.failed==='N');
  const failRate = knownEntries.length ? Math.round(knownEntries.filter(e=>e.failed==='Y').length/knownEntries.length*100) : 0;

  const g1el = document.getElementById('em-'+suffix+'g1');
  const g2el = document.getElementById('em-'+suffix+'g2');
  const awpEl = document.getElementById('em-'+suffix+'awp');
  const failEl = document.getElementById('em-'+suffix+'fail');

  if(g1el) g1el.value = Math.round(avgG1);
  if(g2el) g2el.value = Math.round(avgG2);
  if(awpEl) awpEl.value = awpRate;
  if(failEl) failEl.value = failRate;
  emCalcProb();
}

function emAddFailPin(robotId) {
  const container = document.getElementById(robotId + '-faildist');
  const rows = container.querySelectorAll('.em-faildist-row');
  const nextPin = rows.length; // 0, 1, 2...
  const row = document.createElement('div');
  row.className = 'em-faildist-row';
  row.style.cssText = 'display:flex;align-items:center;gap:6px';
  row.innerHTML = `<span style="font-size:11px;font-family:var(--mono);color:var(--ink2);min-width:38px">${nextPin} pin${nextPin!==1?'s':''}</span>
    <input type="number" min="0" max="100" value="0" step="1"
      style="width:60px;font-size:12px;padding:3px 6px"
      oninput="emUpdateFailDistTotal('${robotId}');emCalcProb()">
    <span style="font-size:10px;color:var(--ink3)">%</span>`;
  container.appendChild(row);
  // Auto-open if collapsed
  const body = document.getElementById(robotId + '-faildist-body');
  if (body && body.style.display === 'none') {
    body.style.display = 'block';
    const chevron = body.previousElementSibling?.querySelector('.em-faildist-chevron');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }
  emUpdateFailDistTotal(robotId);
  emCalcProb();
}

function emRemoveFailPin(robotId) {
  const container = document.getElementById(robotId + '-faildist');
  const rows = container.querySelectorAll('.em-faildist-row');
  if (rows.length > 0) { rows[rows.length - 1].remove(); }
  emUpdateFailDistTotal(robotId);
  emCalcProb();
}

function emToggleFailDistPanel() {
  const panel  = document.getElementById('em-faildist-panel');
  const btn    = document.getElementById('em-faildist-toggle-btn');
  const chev   = document.getElementById('em-faildist-toggle-chevron');
  const open   = panel.style.display !== 'none';
  if (open) {
    panel.style.display = 'none';
    btn.style.background   = 'var(--paper2)';
    btn.style.color        = 'var(--ink2)';
    btn.style.borderColor  = 'var(--paper3)';
    btn.setAttribute('aria-pressed','false');
    chev.style.transform   = '';
  } else {
    panel.style.display = 'block';
    btn.style.background   = 'rgba(200,255,0,.08)';
    btn.style.color        = 'var(--volt)';
    btn.style.borderColor  = 'var(--volt)';
    btn.setAttribute('aria-pressed','true');
    chev.style.transform   = 'rotate(180deg)';
    // Sync robot name labels
    ['r1','r2','b1','b2'].forEach(s => {
      const team = document.getElementById('em-'+s)?.value?.trim();
      const lbl  = document.getElementById('em-'+s+'-faildist-name');
      if (lbl) lbl.textContent = team ? '— '+team : '';
    });
  }
}

function emToggleFailDist(robotId, btn) {
  const body = document.getElementById(robotId + '-faildist-body');
  const chevron = btn.querySelector('.em-faildist-chevron');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  chevron.style.transform = open ? 'rotate(180deg)' : '';
}

function emUpdateFailDistTotal(robotId) {
  const container = document.getElementById(robotId + '-faildist');
  const inputs = container.querySelectorAll('input');
  const total = Array.from(inputs).reduce((s, el) => s + (+el.value || 0), 0);
  const label = document.getElementById(robotId + '-faildist-total');
  if (label) {
    const rows = container.querySelectorAll('.em-faildist-row');
    if (rows.length === 0) {
      label.textContent = '0%';
      label.style.color = 'var(--ink3)';
    } else {
      label.textContent = 'total: ' + total + '%';
      label.style.color = Math.abs(total - 100) < 0.01 ? 'var(--green)' : total > 100 ? 'var(--red)' : 'var(--ink3)';
    }
  }
}

function emGetFailDist(robotId) {
  // Returns array of {pins, weight} normalised to sum=1. Falls back to 0 pins if empty.
  const container = document.getElementById(robotId + '-faildist');
  if (!container) return [{pins:0, weight:1}];
  const rows = container.querySelectorAll('.em-faildist-row');
  if (!rows.length) return [{pins:0, weight:1}];
  const entries = Array.from(rows).map((row, i) => ({
    pins: i,
    weight: +(row.querySelector('input')?.value || 0)
  })).filter(e => e.weight > 0);
  if (!entries.length) return [{pins:0, weight:1}];
  const total = entries.reduce((s, e) => s + e.weight, 0);
  return entries.map(e => ({pins: e.pins, weight: e.weight / total}));
}

function emCalcProb() {
  const robots = [
    { id:'em-r1', g1:+document.getElementById('em-r1g1')?.value||0, g2:+document.getElementById('em-r1g2')?.value||0, fail:(+document.getElementById('em-r1fail')?.value||0)/100, failDist:emGetFailDist('em-r1'), alliance:'red' },
    { id:'em-r2', g1:+document.getElementById('em-r2g1')?.value||0, g2:+document.getElementById('em-r2g2')?.value||0, fail:(+document.getElementById('em-r2fail')?.value||0)/100, failDist:emGetFailDist('em-r2'), alliance:'red' },
    { id:'em-b1', g1:+document.getElementById('em-b1g1')?.value||0, g2:+document.getElementById('em-b1g2')?.value||0, fail:(+document.getElementById('em-b1fail')?.value||0)/100, failDist:emGetFailDist('em-b1'), alliance:'blue' },
    { id:'em-b2', g1:+document.getElementById('em-b2g1')?.value||0, g2:+document.getElementById('em-b2g2')?.value||0, fail:(+document.getElementById('em-b2fail')?.value||0)/100, failDist:emGetFailDist('em-b2'), alliance:'blue' },
  ];

  // AWP rule: ≥7 total alliance pins AND ≥3 goals with ≥2 pins each
  function allianceAwp(allianceRobots) {
    const goals = allianceRobots.flatMap(r => [r.pinsG1, r.pinsG2]);
    const total  = goals.reduce((s, g) => s + g, 0);
    const qualified = goals.filter(g => g >= 2).length;
    return { met: total >= 7 && qualified >= 3, total, qualified };
  }

  // Build all outcome scenarios via cartesian product.
  // Each robot contributes: 1 success branch + N fail branches (one per pin count in dist).
  // Start with a single seed scenario, then expand robot by robot.
  let scenarios = [{ prob:1, robotStates:[] }];
  robots.forEach(r => {
    const next = [];
    scenarios.forEach(sc => {
      // Success branch
      next.push({
        prob: sc.prob * (1 - r.fail),
        robotStates: [...sc.robotStates, { ...r, success:true, pinsG1:r.g1, pinsG2:r.g2, failPins:null }]
      });
      // Fail branches — one per pin count in distribution
      r.failDist.forEach(({pins, weight}) => {
        next.push({
          prob: sc.prob * r.fail * weight,
          robotStates: [...sc.robotStates, { ...r, success:false, pinsG1:pins, pinsG2:0, failPins:pins }]
        });
      });
    });
    scenarios = next;
  });

  // Collapse scenarios into display outcomes (score + winner)
  const outcomes = scenarios.map(sc => {
    const robotStates = sc.robotStates;
    const redPins  = robotStates.filter(r=>r.alliance==='red').reduce((s,r)=>s+r.pinsG1+r.pinsG2,0);
    const bluePins = robotStates.filter(r=>r.alliance==='blue').reduce((s,r)=>s+r.pinsG1+r.pinsG2,0);
    const redRaw = redPins*5, blueRaw = bluePins*5;
    let redFinal=redRaw, blueFinal=blueRaw;
    if(redRaw>blueRaw){redFinal+=12;}else if(blueRaw>redRaw){blueFinal+=12;}else{redFinal+=6;blueFinal+=6;}
    const winner = redFinal>blueFinal?'Red wins':blueFinal>redFinal?'Blue wins':'Tie';
    const redA  = allianceAwp(robotStates.filter(r=>r.alliance==='red'));
    const blueA = allianceAwp(robotStates.filter(r=>r.alliance==='blue'));
    return { prob:sc.prob, robotStates, redRaw, blueRaw, redFinal, blueFinal, winner,
      redAwp:redA.met, blueAwp:blueA.met,
      redAwpDetail:redA, blueAwpDetail:blueA,
      redPins, bluePins, margin:Math.abs(redFinal-blueFinal) };
  });

  // Merge scenarios with identical scores into single bar segments (for display only)
  const merged = [];
  outcomes.forEach(o => {
    const key = `${o.redFinal}|${o.blueFinal}`;
    const existing = merged.find(m => `${m.redFinal}|${m.blueFinal}` === key);
    if (existing) {
      const oldProb = existing.prob;
      existing.prob += o.prob;
      // AWP: treat as probability-weighted (true=1, false=0) for merged display
      existing.redAwpProb  = (existing.redAwpProb  * oldProb + (o.redAwp  ? o.prob : 0)) / existing.prob;
      existing.blueAwpProb = (existing.blueAwpProb * oldProb + (o.blueAwp ? o.prob : 0)) / existing.prob;
    } else {
      merged.push({...o, redAwpProb: o.redAwp?1:0, blueAwpProb: o.blueAwp?1:0});
    }
  });

  // Keep full unmerged list for navigation (preserves all robotStates detail)
  const allForNav = [...outcomes].filter(o => o.prob > 0.0001);
  window._emOutcomesBarOrder  = allForNav;
  window._emOutcomesProbOrder = [...allForNav].sort((a,b) => b.prob - a.prob);

  const totalProb = merged.reduce((s,o)=>s+o.prob,0)||1;
  const mostLikely = [...merged].sort((a,b)=>b.prob-a.prob)[0];
  const emWinnerLabel = mostLikely.winner === 'Red wins' ? '🔴 Red' : mostLikely.winner === 'Blue wins' ? '🔵 Blue' : '🤝 Tie';
  document.getElementById('em-mostOutcome').textContent = 'Most likely to win: ' + emWinnerLabel + ' (' + (mostLikely.prob*100).toFixed(1) + '%)';

  // Colour helpers (same as main)
  const emOutcomeColour = (winner, idx, margin) => {
    if(winner==='Tie'){const l=55+(idx%3)*6;return `hsl(0,0%,${l}%)`;}
    const t=Math.min(margin/62,1);
    if(winner==='Red wins') return `hsl(12,${40+Math.round(t*55)}%,${58-Math.round(t*18)}%)`;
    return `hsl(213,${40+Math.round(t*55)}%,${58-Math.round(t*18)}%)`;
  };

  const sorted = [...merged].sort((a,b)=>{
    const wmap={'Red wins':0,'Tie':1,'Blue wins':2};
    const d=(wmap[a.winner]??1)-(wmap[b.winner]??1);
    return d!==0?d:b.prob-a.prob;
  });
  const bar = document.getElementById('em-outcomeBar');
  bar.innerHTML = '';
  sorted.forEach((o,i)=>{
    const pct=(o.prob/totalProb)*100;
    if(pct<0.05) return;
    const seg=document.createElement('div');
    seg.className='outcome-seg';
    seg.style.cssText=`flex:${pct};background:${emOutcomeColour(o.winner,i,o.margin)};`;
    if(pct>5){const lbl=document.createElement('div');lbl.className='outcome-seg-label';lbl.textContent=pct.toFixed(0)+'%';seg.appendChild(lbl);}
    seg.onclick=()=>{
      document.querySelectorAll('#em-outcomeBar .outcome-seg').forEach(s=>s.classList.remove('selected'));
      seg.classList.add('selected');
      // Find the highest-prob unmerged outcome matching this score bucket
      const match = allForNav
        .filter(x => x.redFinal === o.redFinal && x.blueFinal === o.blueFinal)
        .sort((a,b) => b.prob - a.prob)[0] || o;
      showEmOutcomeDetail(match, pct, totalProb, allForNav);
    };
    bar.appendChild(seg);
  });

  // Auto-show most likely outcome
  const mostSeg = bar.children[0];
  if (mostSeg) mostSeg.click();

  // Legend
  const redPct      = outcomes.filter(o=>o.winner==='Red wins').reduce((s,o)=>s+o.prob,0)/totalProb*100;
  const tiePct      = outcomes.filter(o=>o.winner==='Tie').reduce((s,o)=>s+o.prob,0)/totalProb*100;
  const bluePct     = outcomes.filter(o=>o.winner==='Blue wins').reduce((s,o)=>s+o.prob,0)/totalProb*100;
  const redAwpLeg   = outcomes.filter(o=>o.redAwp).reduce((s,o)=>s+o.prob,0)/totalProb*100;
  const blueAwpLeg  = outcomes.filter(o=>o.blueAwp).reduce((s,o)=>s+o.prob,0)/totalProb*100;
  document.getElementById('em-outcomeLegend').innerHTML =
    `<span class="outcome-legend-item"><span class="outcome-legend-swatch" style="background:var(--red)"></span>Red ${redPct.toFixed(1)}%</span>
     <span class="outcome-legend-item"><span class="outcome-legend-swatch" style="background:#aaa"></span>Tie ${tiePct.toFixed(1)}%</span>
     <span class="outcome-legend-item"><span class="outcome-legend-swatch" style="background:var(--blue)"></span>Blue ${bluePct.toFixed(1)}%</span>
     <span class="outcome-legend-item"><span class="outcome-legend-swatch" style="background:var(--red);opacity:.55"></span>Red AWP ${redAwpLeg.toFixed(1)}%</span>
     <span class="outcome-legend-item"><span class="outcome-legend-swatch" style="background:var(--blue);opacity:.55"></span>Blue AWP ${blueAwpLeg.toFixed(1)}%</span>`;

  // Alliance AWP probability bars
  const awpBarsEl = document.getElementById('em-awp-bars');
  if (awpBarsEl) {
    awpBarsEl.style.display = 'block';
    const rPct = Math.min(redAwpLeg, 100);
    const bPct = Math.min(blueAwpLeg, 100);
    document.getElementById('em-awp-red-pct').textContent  = rPct.toFixed(1) + '%';
    document.getElementById('em-awp-blue-pct').textContent = bPct.toFixed(1) + '%';
    document.getElementById('em-awp-red-fill').style.width  = rPct + '%';
    document.getElementById('em-awp-blue-fill').style.width = bPct + '%';
  }
}

function showEmOutcomeDetail(o, pct, totalProb, allOutcomes) {
  // Store state for navigation
  const mode = window._emOutcomeNavMode || 'prob';
  const probOrder = [...allOutcomes].sort((a,b)=>b.prob-a.prob);
  const barOrder  = allOutcomes;
  window._emOutcomesProbOrder = probOrder;
  window._emOutcomesBarOrder  = barOrder;
  const activeList = mode === 'bar' ? barOrder : probOrder;
  const idx = activeList.indexOf(o);
  if (idx !== -1) window._emCurrentOutcomeIdx = idx;

  const detail = document.getElementById('em-outcomeDetail');
  detail.style.display = 'block';

  const rank  = idx + 1;
  const total = activeList.length;
  const winColor = o.winner==='Red wins' ? 'var(--red)' : o.winner==='Blue wins' ? 'var(--blue)' : '#777777';
  const modeLabel = mode === 'bar' ? 'bar order' : 'high→low probability';

  const redRobots  = o.robotStates.filter(r=>r.alliance==='red');
  const blueRobots = o.robotStates.filter(r=>r.alliance==='blue');

  function emAwpCheck(allianceRobots) {
    const goals = allianceRobots.flatMap(r => [r.pinsG1, r.pinsG2]);
    const total  = goals.reduce((s, g) => s + g, 0);
    const qualified = goals.filter(g => g >= 2).length;
    return { met: total >= 7 && qualified >= 3, total, qualified };
  }
  const redAwpD  = o.redAwpDetail  || emAwpCheck(redRobots);
  const blueAwpD = o.blueAwpDetail || emAwpCheck(blueRobots);

  function robotRow(r) {
    const c  = r.alliance==='red' ? 'var(--red)' : 'var(--blue)';
    const bg = r.alliance==='red' ? 'rgba(200,65,10,.07)' : 'rgba(26,95,180,.07)';
    const border = r.success ? (r.alliance==='red' ? 'rgba(200,65,10,.2)' : 'rgba(26,95,180,.2)') : 'var(--paper3)';
    const teamInputId = r.id;
    const teamName = (document.getElementById(teamInputId)?.value || r.id).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const label = r.alliance==='red'
      ? (r.id==='em-r1' ? 'R1' : 'R2')
      : (r.id==='em-b1' ? 'B1' : 'B2');
    return `<div style="background:${bg};border-radius:var(--radius);padding:7px 9px;margin-bottom:5px;border:1px solid ${border}">
      <div style="font-weight:600;font-family:var(--mono);font-size:12px;color:${c};margin-bottom:3px">${label} ${r.success?'✅':'❌'}</div>
      <div style="font-size:11px;color:var(--ink2)">
        ${r.success
          ? `G1: <strong>${r.pinsG1}</strong> · G2: <strong>${r.pinsG2}</strong> · Total: <strong>${r.pinsG1+r.pinsG2}</strong> pins`
          : `<span style="color:var(--ink3)">Failed — ${r.pinsG1>0?r.pinsG1+' pins':'0 pins'}</span>`}
      </div>
      <div style="font-size:10px;color:var(--ink3);font-family:var(--mono);margin-top:2px">
        Fail rate: ${(r.fail*100).toFixed(0)}%
      </div>
    </div>`;
  }

  const successLabels = o.robotStates.filter(r=>r.success).map(r=>r.alliance==='red'?(r.id==='em-r1'?'R1':'R2'):(r.id==='em-b1'?'B1':'B2'));
  const failLabels    = o.robotStates.filter(r=>!r.success).map(r=>r.alliance==='red'?(r.id==='em-r1'?'R1':'R2'):(r.id==='em-b1'?'B1':'B2'));

  detail.innerHTML = `
    <div class="outcome-detail" style="position:relative">

      <!-- NAV MODE TOGGLE -->
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;font-size:11px;font-family:var(--mono);color:var(--ink3)">
        <span>Navigate by:</span>
        <button onclick="setEmOutcomeNavMode('prob')"
          style="padding:3px 10px;border-radius:99px;border:1px solid var(--paper3);font-size:11px;font-family:var(--mono);cursor:pointer;transition:all .15s;
            background:${mode==='prob'?'var(--ink)':'var(--paper2)'};color:${mode==='prob'?'var(--paper)':'var(--ink2)'}">
          High→Low %
        </button>
        <button onclick="setEmOutcomeNavMode('bar')"
          style="padding:3px 10px;border-radius:99px;border:1px solid var(--paper3);font-size:11px;font-family:var(--mono);cursor:pointer;transition:all .15s;
            background:${mode==='bar'?'var(--ink)':'var(--paper2)'};color:${mode==='bar'?'var(--paper)':'var(--ink2)'}">
          Bar order
        </button>
      </div>

      <div style="display:flex;align-items:stretch;gap:0">
        <!-- LEFT ARROW -->
        <button onclick="navigateEmOutcome(-1)" title="Previous scenario"
          style="flex-shrink:0;width:36px;background:var(--ink);color:var(--paper);border:none;border-radius:var(--radius) 0 0 var(--radius);cursor:pointer;font-size:18px;transition:background .15s;display:flex;align-items:center;justify-content:center;">&#8592;</button>

        <!-- MAIN CONTENT -->
        <div style="flex:1;min-width:0;padding:0 12px">

          <!-- Header row -->
          <div class="outcome-detail-head">
            <div>
              <div class="outcome-detail-title" style="color:${winColor}">${o.winner}</div>
              <div style="font-size:12px;color:var(--ink3);font-family:var(--mono);margin-top:2px">
                #${rank} of ${total} (${modeLabel}) · Ran: ${successLabels.join(', ')||'none'}${failLabels.length?' · Failed: '+failLabels.join(', '):''}
              </div>
            </div>
            <div class="outcome-detail-prob">${(o.prob*100).toFixed(2)}% chance</div>
          </div>

          <!-- Two-column alliance stats -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">

            <!-- RED column -->
            <div style="background:rgba(200,65,10,.06);border:1.5px solid rgba(200,65,10,.25);border-radius:var(--radius-lg);padding:10px">
              <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.6px;color:var(--red);font-weight:700;margin-bottom:8px">🔴 Red Alliance${o.winner==='Red wins'?' <span style="color:#FFD700;font-size:11px;letter-spacing:.3px">WIN 👑</span>':''}</div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Final score</span>
                <span style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--red)">${o.redFinal}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pins scored</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono);color:var(--red)">${o.redPins}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(200,65,10,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pin pts</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${o.redRaw}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0" title="≥7 total pins AND ≥3 goals with ≥2 pins each">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">AWP</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${redAwpD.met?'✅ Yes':'❌ No'} <span style="font-size:10px;color:var(--ink3)">(${redAwpD.total}pins · ${redAwpD.qualified}goals≥2)</span></span>
              </div>
              <div style="margin-top:8px">${redRobots.map(robotRow).join('')}</div>
            </div>

            <!-- BLUE column -->
            <div style="background:rgba(26,95,180,.06);border:1.5px solid rgba(26,95,180,.25);border-radius:var(--radius-lg);padding:10px">
              <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.6px;color:var(--blue);font-weight:700;margin-bottom:8px">🔵 Blue Alliance${o.winner==='Blue wins'?' <span style="color:#FFD700;font-size:11px;letter-spacing:.3px">WIN 👑</span>':''}</div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Final score</span>
                <span style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--blue)">${o.blueFinal}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pins scored</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono);color:var(--blue)">${o.bluePins}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:.5px solid rgba(26,95,180,.15)">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">Pin pts</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${o.blueRaw}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0" title="≥7 total pins AND ≥3 goals with ≥2 pins each">
                <span style="font-size:11px;color:var(--ink3);font-family:var(--mono)">AWP</span>
                <span style="font-size:13px;font-weight:600;font-family:var(--mono)">${blueAwpD.met?'✅ Yes':'❌ No'} <span style="font-size:10px;color:var(--ink3)">(${blueAwpD.total}pins · ${blueAwpD.qualified}goals≥2)</span></span>
              </div>
              <div style="margin-top:8px">${blueRobots.map(robotRow).join('')}</div>
            </div>
          </div>

          <!-- Score breakdown footer -->
          <div style="font-size:11px;color:var(--ink3);font-family:var(--mono);border-top:.5px solid var(--paper3);padding-top:8px">
            <span style="color:var(--red)">${o.redPins} pins × 5 = ${o.redRaw}${o.redFinal>o.redRaw?' + 12 bonus':o.redFinal===o.redRaw+6?' + 6 tie':''} = <strong>${o.redFinal}</strong></span>
            &nbsp;vs&nbsp;
            <span style="color:var(--blue)">${o.bluePins} pins × 5 = ${o.blueRaw}${o.blueFinal>o.blueRaw?' + 12 bonus':o.blueFinal===o.blueRaw+6?' + 6 tie':''} = <strong>${o.blueFinal}</strong></span>
          </div>
        </div>

        <!-- RIGHT ARROW -->
        <button onclick="navigateEmOutcome(1)" title="Next scenario"
          style="flex-shrink:0;width:36px;background:var(--ink);color:var(--paper);border:none;border-radius:0 var(--radius) var(--radius) 0;cursor:pointer;font-size:18px;transition:background .15s;display:flex;align-items:center;justify-content:center;">&#8594;</button>
      </div>
    </div>`;
}

function navigateEmOutcome(dir) {
  const mode = window._emOutcomeNavMode || 'prob';
  const list = mode === 'bar' ? window._emOutcomesBarOrder : window._emOutcomesProbOrder;
  if (!list || !list.length) return;
  const cur = window._emCurrentOutcomeIdx || 0;
  const newIdx = (cur + dir + list.length) % list.length;
  const o = list[newIdx];
  const totalProb = list.reduce((s,x)=>s+x.prob,0)||1;
  showEmOutcomeDetail(o, o.prob/totalProb*100, totalProb, window._emOutcomesBarOrder);
}

function setEmOutcomeNavMode(mode) {
  window._emOutcomeNavMode = mode;
  const curList  = mode === 'bar' ? window._emOutcomesBarOrder  : window._emOutcomesProbOrder;
  const prevList = mode === 'bar' ? window._emOutcomesProbOrder : window._emOutcomesBarOrder;
  if (!curList || !curList.length) return;
  const prevO = prevList ? prevList[window._emCurrentOutcomeIdx || 0] : null;
  const newIdx = prevO ? Math.max(0, curList.indexOf(prevO)) : 0;
  window._emCurrentOutcomeIdx = newIdx;
  const o = curList[newIdx];
  const totalProb = curList.reduce((s,x)=>s+x.prob,0)||1;
  showEmOutcomeDetail(o, o.prob/totalProb*100, totalProb, window._emOutcomesBarOrder);
}

// Init embedded calc on page load — seed with realistic test data
(function seedTestData() {
  const teams = ['97230F','1234A','5678B','9999Z'];
  ['em-r1','em-r2','em-b1','em-b2'].forEach((id,i)=>{
    const el=document.getElementById(id); if(el&&!el.value) el.value=teams[i];
  });
  const fields = {
    'em-r1g1':4,'em-r2g1':3,'em-b1g1':5,'em-b2g1':2,
    'em-r1g2':2,'em-r2g2':1,'em-b1g2':3,'em-b2g2':1,
    'em-r1fail':20,'em-r2fail':35,'em-b1fail':15,'em-b2fail':40,
    'em-r1awp':70,'em-r2awp':55,'em-b1awp':80,'em-b2awp':45,
  };
  Object.entries(fields).forEach(([id,v])=>{ const el=document.getElementById(id); if(el) el.value=v; });
  const dists = {
    'em-r1':[50,30,20],
    'em-r2':[60,25,15],
    'em-b1':[40,35,25],
    'em-b2':[70,20,10],
  };
  Object.entries(dists).forEach(([robotId,dist])=>{
    dist.forEach(()=>emAddFailPin(robotId));
    const rows=document.getElementById(robotId+'-faildist').querySelectorAll('.em-faildist-row');
    rows.forEach((row,i)=>{ const inp=row.querySelector('input'); if(inp) inp.value=dist[i]; });
    emUpdateFailDistTotal(robotId);
  });
  emCalcProb();
})();


// ── SEED TEST DATA: 10,000 auton entries across 100 teams ──────────────────
// Cached in localStorage under 'os_seed_v1' so it is only generated once.
// To force a fresh seed, run: localStorage.removeItem('os_seed_v1') in console.
(function injectTestEntries() {
  const SEED_KEY    = 'os_seed_v1';
  const SEED_MARKER = 'seeded_10k_v1'; // bump this string to invalidate old cache

  // ── Check whether we already injected this seed ──────────────────────────
  try {
    if (localStorage.getItem(SEED_KEY) === SEED_MARKER) {
      // Data already in localDb / override_scout_v3 — just rebuild UI state.
      setAllTeams(buildStats(allEntries));
      setSyncStatus('ok', allTeams.length + ' teams · ' + allEntries.length + ' entries (seed cached)');
      renderLog();
      lbApplyFilter(lbActiveF);
      console.log('[TestSeed] Skipped — seed already present (' + allEntries.length + ' entries)');
      return;
    }
  } catch(e) {}

  // ── 100-team roster: number prefix + letter suffix, varied stats ──────────
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const teams = [];
  // Keep the original showcase teams first
  const showcaseTeams = [
    { id:'97230F', failRate:0.15, g1Avg:4, g2Avg:2, awpRate:0.75, failPinAvg:0.8 },
    { id:'1234A',  failRate:0.30, g1Avg:3, g2Avg:1, awpRate:0.55, failPinAvg:0.5 },
    { id:'5678B',  failRate:0.10, g1Avg:5, g2Avg:3, awpRate:0.85, failPinAvg:1.2 },
    { id:'9999Z',  failRate:0.40, g1Avg:2, g2Avg:1, awpRate:0.40, failPinAvg:0.3 },
    { id:'4321C',  failRate:0.20, g1Avg:4, g2Avg:2, awpRate:0.60, failPinAvg:0.6 },
    { id:'8888D',  failRate:0.25, g1Avg:3, g2Avg:2, awpRate:0.50, failPinAvg:1.0 },
    { id:'1111E',  failRate:0.05, g1Avg:6, g2Avg:3, awpRate:0.90, failPinAvg:1.5 },
    { id:'2222F',  failRate:0.35, g1Avg:2, g2Avg:1, awpRate:0.45, failPinAvg:0.2 },
    { id:'3333G',  failRate:0.18, g1Avg:4, g2Avg:2, awpRate:0.70, failPinAvg:0.7 },
    { id:'7777H',  failRate:0.22, g1Avg:3, g2Avg:2, awpRate:0.65, failPinAvg:0.9 },
  ];
  showcaseTeams.forEach(t => teams.push(t));

  // Generate remaining 90 teams deterministically from index so stats are stable
  const bases = [100,200,300,400,500,600,700,800,900,1000,
                 1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,
                 2100,2200,2300,2400,2500,2600,2700,2800,2900,3000,
                 3100,3200,3300,3400,3500,3600,3700,3800,3900,4000,
                 4100,4200,4300,4400,4500,4600,4700,4800,4900,5000,
                 5100,5200,5300,5400,5500,5600,5700,5800,5900,6000,
                 6100,6200,6300,6400,6500,6600,6700,6800,6900,7000,
                 7100,7200,7300,7400,7500,7600,7700,7800,7900,8000,
                 8100,8200,8300,8400,8500,8600,8700,8800,8900,9000];
  bases.forEach((base, i) => {
    const letter = letters[i % letters.length];
    const frac   = i / 89; // 0→1 across the set
    teams.push({
      id:          String(base) + letter,
      failRate:    0.05 + frac * 0.45,          // 5%→50%
      g1Avg:       Math.max(1, 6 - frac * 4),   // 6→2
      g2Avg:       Math.max(0, 3 - frac * 2.5), // 3→0.5
      awpRate:     0.90 - frac * 0.60,           // 90%→30%
      failPinAvg:  0.2 + frac * 1.5,            // 0.2→1.7
    });
  });

  const events = [
    'NSW-SIG-2026','VIC-REG-2026','QLD-REG-2026','SA-REG-2026',
    'WA-REG-2026','TAS-REG-2026','ACT-REG-2026','NT-REG-2026',
    'NZ-SIG-2026','APAC-OPEN-2026'
  ];
  const sides  = ['red','blue'];
  const types  = ['Catapult','Flywheel','Puncher','Intake','Slingshot'];
  const routes = ['Normal','Risky','Safe','Corner','Diagonal'];
  const rounds = [];
  for (let q = 1; q <= 50; q++) rounds.push('Q' + q);
  rounds.push('QF1','QF2','SF1','SF2','F1','F2');

  function ri(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
  function rn(avg,sd){
    let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.max(0, avg + sd*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v));
  }

  const existing = new Set((localDb||[]).map(e=>e.id));
  let added = 0;
  const ENTRIES_PER_TEAM = 100; // 100 teams × 100 = 10,000

  teams.forEach(team => {
    for (let i = 0; i < ENTRIES_PER_TEAM; i++) {
      const failed  = Math.random() < team.failRate ? 'Y' : 'N';
      const g1      = failed==='Y' ? Math.max(0,Math.round(rn(team.failPinAvg,0.8))) : Math.max(0,Math.round(rn(team.g1Avg,1.2)));
      const g2      = failed==='Y' ? 0 : Math.max(0,Math.round(rn(team.g2Avg,0.8)));
      const awp     = (failed==='N' && Math.random()<team.awpRate) ? 'Y' : 'N';
      const maxpins = g1 + g2 + ri(0,3);
      // Spread timestamps across the past 120 days
      const daysAgo = ri(0, 120);
      const entry = {
        id:      crypto.randomUUID(),
        team:    team.id,
        event:   events[ri(0,events.length-1)],
        round:   rounds[ri(0,rounds.length-1)],
        side:    sides[ri(0,1)],
        sig:     Math.random()<0.3 ? 'Y' : 'N',
        type:    types[ri(0,types.length-1)],
        route:   routes[ri(0,routes.length-1)],
        pins:    g1+'+'+g2,
        maxpins: String(maxpins),
        bonuses: 0,
        awp,
        failed,
        notes:   '',
        ts:      new Date(Date.now() - daysAgo*86400000 - ri(0,86400)*1000).toISOString()
      };
      if (!existing.has(entry.id)) {
        localDb.unshift(entry);
        allEntries.unshift(entry);
        added++;
      }
    }
  });

  // Persist to localStorage once — refresh will not regenerate
  try {
    localStorage.setItem('override_scout_v3', JSON.stringify(localDb));
    localStorage.setItem(SEED_KEY, SEED_MARKER);
  } catch(e) {
    console.warn('[TestSeed] localStorage write failed (quota?)', e);
  }

  setAllTeams(buildStats(allEntries));
  setSyncStatus('ok', allTeams.length+' teams · '+allEntries.length+' entries ('+added+' test entries injected)');
  renderLog();
  lbApplyFilter(lbActiveF);
  console.log('[TestSeed] Injected '+added+' entries across '+teams.length+' teams');
})();
// ────────────────────────────────────────────────────────────────────────────

// Restore saved tokens on load
loadReToken();

// RobotEvents token is entered by the user via the UI — no preset token is embedded here.

/* ═══════════════════════════════════════════════════════
   WIN PROBABILITY — ROBOT PANEL BUILDER (Fix #5)
   Generates the repeated red/blue robot panel HTML from a
   single source of truth instead of duplicating it in HTML.
   
   Params:
     color   — 'red' | 'blue'  (used for colour vars and labels)
     robots  — array of 2 robot IDs, e.g. ['r1','r2'] or ['b1','b2']
     calcFn  — string name of the oninput calc function, e.g. 'calcProb()'
     fillFn  — string name of the autofill function, e.g. 'autoFill'
     syncFn  — string name of the SAWP sync function, e.g. 'syncSawpPins'
════════════════════════════════════════════════════════ */
function renderRobotPanel(color, robots, calcFn, fillFn, syncFn) {
  const cssColor = `var(--${color})`;
  const emoji    = color === 'red' ? '🔴' : '🔵';
  const allianceLabel = color === 'red' ? '🔴 Red Alliance' : '🔵 Blue Alliance';
  const ownEmoji  = emoji;
  const allyEmoji = color === 'red' ? '🔵' : '🔴';

  const robotBlock = (id, robotNum, isLast) => {
    const phMap = { r1:'e.g. 73017D', r2:'e.g. 9123X', b1:'e.g. 5678A', b2:'e.g. 9999Z' };
    const mb = isLast ? '' : ' margin-bottom:10px;';
    return `
    <div style="background:var(--paper2);border-radius:var(--radius);padding:10px;${mb}">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:${cssColor};margin-bottom:8px">Robot ${robotNum}</div>
      <div style="margin-bottom:8px">
        <label>Team #</label>
        <input id="${id}" placeholder="${phMap[id]||'e.g. team #'}" oninput="${fillFn}('${id}');syncTeamSlot('${id}');updateTsBadges()">
        <div class="ts-mini-badge" id="ts-badge-${id}"></div>
      </div>
      <div class="sawp-toggle" id="${id}-sawp-toggle">
        <input type="radio" name="${id}-mode" id="${id}-mode-normal" value="normal" checked onchange="switchAutoMode('${id}')">
        <label for="${id}-mode-normal">Normal auton</label>
        <input type="radio" name="${id}-mode" id="${id}-mode-sawp" value="sawp" onchange="switchAutoMode('${id}')">
        <label for="${id}-mode-sawp">⚡ SAWP run</label>
      </div>
      <div class="sawp-badge" id="${id}-sawp-badge"></div>
      <div id="${id}-pins-normal" style="margin-bottom:8px">
        <div class="g2">
          <div><label>Avg G1 pins</label><input type="number" id="${id}g1" min="0" max="10" step="1" value="2" oninput="${calcFn}"></div>
          <div><label>Avg G2 pins</label><input type="number" id="${id}g2" min="0" max="10" step="1" value="1" oninput="${calcFn}"></div>
        </div>
      </div>
      <div id="${id}-pins-sawp" style="display:none;margin-bottom:8px">
        <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.4px;color:var(--ink3);margin-bottom:5px">${ownEmoji} Own quadrant</div>
        <div class="g2" style="margin-bottom:6px">
          <div><label>Own G1 pins</label><input type="number" id="${id}-own-g1" min="0" max="10" step="1" value="2" oninput="${syncFn}('${id}')"></div>
          <div><label>Own G2 pins</label><input type="number" id="${id}-own-g2" min="0" max="10" step="1" value="1" oninput="${syncFn}('${id}')"></div>
        </div>
        <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.4px;color:var(--ink3);margin-bottom:5px">${allyEmoji} Alliance quadrant</div>
        <div class="g2">
          <div><label>Alliance G1 pins</label><input type="number" id="${id}-ally-g1" min="0" max="10" step="1" value="1" oninput="${syncFn}('${id}')"></div>
          <div><label>Alliance G2 pins</label><input type="number" id="${id}-ally-g2" min="0" max="10" step="1" value="0" oninput="${syncFn}('${id}')"></div>
        </div>
      </div>
      <div class="g2">
        <div><label>Failure rate %</label><input type="number" id="${id}fail" min="0" max="100" value="0" oninput="${calcFn}"></div>
      </div>
    </div>`;
  };

  return `
    <p class="sec" style="color:${cssColor}">${allianceLabel}</p>
    <p style="font-size:11px;color:var(--ink3);font-family:var(--mono);margin-bottom:10px">
      Type a team # — stats auto-fill from database
    </p>
    ${robotBlock(robots[0], 1, false)}
    ${robotBlock(robots[1], 2, true)}`;
}

// Initialise the predict tab panels (Fix #5)
(function initPredictPanels() {
  const redEl  = document.getElementById('predict-red-panel');
  const blueEl = document.getElementById('predict-blue-panel');
  if(redEl)  redEl.innerHTML  = renderRobotPanel('red',  ['r1','r2'], 'calcProb()', 'autoFill', 'syncSawpPins');
  if(blueEl) blueEl.innerHTML = renderRobotPanel('blue', ['b1','b2'], 'calcProb()', 'autoFill', 'syncSawpPins');
})();

/* ── Pin-select helper ────────────────────────────────────────────────
   Builds the 0-5 pin options for every goal select in the Add Entry form.
   Call once on init; if the max pin count ever changes, update MAX_PINS. ── */
const MAX_PINS = 5;
function fillPinSelects() {
  const ids = ['f-pin-g1','f-pin-g2','f-sawp-own-g1','f-sawp-own-g2','f-sawp-team-g1','f-sawp-team-g2'];
  const opts = Array.from({length: MAX_PINS + 1}, (_,i) =>
    `<option value="${i}">${i} ${i === 1 ? 'pin' : 'pins'}</option>`
  ).join('');
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.innerHTML = opts;
  });
}
fillPinSelects();
// Enforce f-maxpins upper bound from MAX_PINS: max is 4 goals × MAX_PINS pins each (SAWP mode)
(function() {
  const el = document.getElementById('f-maxpins');
  if(el) { el.max = MAX_PINS * 4; el.placeholder = 'e.g. ' + MAX_PINS * 2; }
})();


/* ═══════════════════════════════════════════════════════
   TRUESKILL DATA — VEX HS Worlds 2026 (vrc-data-analysis.com)
   Fields per team: ts_rank, ts (display), mu (raw μ), sigma (σ),
                    ccwm, wins, losses, wp_pct, awp_per_match,
                    opr, auto_max, driver_max, total_max, qualified
   
   TrueSkill win probability formula (Microsoft):
     P(A beats B) = Φ((μA − μB) / √(2β² + σA² + σB²))
     β = 25/6 ≈ 4.167  (standard TrueSkill β parameter)
   
   Correlation with auton: CCWM and awp_per_match are the strongest
   predictors of autonomous round performance. OPR reflects overall
   scoring contribution per match.
════════════════════════════════════════════════════════ */
let TS_DB ={}; // built from Supabase data

function _buildTsDb() {
  TS_DB = {};
  for (const r of TS_ROWS) {
    TS_DB[r.team.toUpperCase().trim()] = r;
  }
};
const TS_BETA = 25/6; // Standard TrueSkill β

/* Get TrueSkill data for a team (case-insensitive) */
function tsGet(team) {
  if (typeof TS_DB === 'undefined') return null;
  return TS_DB[(team||'').toUpperCase().trim()] || null;
}

/* TrueSkill win probability: probability team A beats team B */
function tsWinProb(tA, tB) {
  if(!tA || !tB) return null;
  const muA = tA.mu, muB = tB.mu;
  const sigA = tA.sigma, sigB = tB.sigma;
  const denom = Math.sqrt(2 * TS_BETA * TS_BETA + sigA * sigA + sigB * sigB);
  return normalCDF((muA - muB) / denom);
}

/* Standard normal CDF (Abramowitz & Stegun approximation, max error < 1.5e-7) */
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/* Render a TrueSkill badge card for the Win Probability panel */
function renderTsBadge(team, tsData) {
  if(!tsData) return `<div class="ts-badge ts-badge-unknown"><span class="ts-badge-label">TrueSkill</span><span class="ts-badge-val">No data</span></div>`;
  const rank = tsData.ts_rank ? '#' + Math.round(tsData.ts_rank) : '—';
  const qual = tsData.qualified ? '✅ Worlds' : '';
  return `<div class="ts-badge">
    <span class="ts-badge-label">TrueSkill <span class="ts-rank-pill">${rank}</span></span>
    <span class="ts-badge-val">${tsData.ts.toFixed(1)}</span>
    <span class="ts-badge-sub">μ=${tsData.mu.toFixed(1)} σ=${tsData.sigma.toFixed(2)}</span>
    ${qual ? `<span class="ts-worlds-badge">${qual}</span>` : ''}
  </div>`;
}

/* Estimate auto pins from TrueSkill data.
   Correlation: auto_max / ~5 (each pin ≈ 5 pts in auton).
   We scale conservatively: expected avg = auto_max / 8 pins-per-goal-group */
function tsEstimatePins(tsData) {
  if(!tsData || !tsData.auto_max) return null;
  // auto_max is the best single-match auto score seen.
  // Avg auton ≈ auto_max * 0.6 (conservative regression to mean)
  // Pin pts = auto_max * 0.6, divide by 5 to get pin count estimate
  const avgAutoPts = tsData.auto_max * 0.6;
  const estPins = avgAutoPts / 5;
  return Math.round(estPins * 10) / 10; // 1 decimal
}

/* Show a TrueSkill correlation panel next to the win probability results */
function renderTsCorrelation(r1Team, r2Team, b1Team, b2Team) {
  const r1 = tsGet(r1Team), r2 = tsGet(r2Team);
  const b1 = tsGet(b1Team), b2 = tsGet(b2Team);
  
  const el = document.getElementById('ts-correlation-panel');
  if(!el) return;
  
  // Alliance μ = average of both robots' μ values
  const redMu  = (r1 && r2) ? (r1.mu  + r2.mu)  / 2 : (r1 ? r1.mu  : r2 ? r2.mu  : null);
  const blueMu = (b1 && b2) ? (b1.mu  + b2.mu)  / 2 : (b1 ? b1.mu  : b2 ? b2.mu  : null);
  const redSig  = r1 && r2 ? Math.sqrt((r1.sigma**2 + r2.sigma**2)/2) : (r1||r2) ? (r1||r2).sigma : 1;
  const blueSig = b1 && b2 ? Math.sqrt((b1.sigma**2 + b2.sigma**2)/2) : (b1||b2) ? (b1||b2).sigma : 1;
  
  // Win probability using combined alliance TrueSkill
  let tsRedWin = null, tsBlueWin = null;
  if(redMu !== null && blueMu !== null) {
    const denom = Math.sqrt(2 * TS_BETA**2 + redSig**2 + blueSig**2);
    tsRedWin  = normalCDF((redMu  - blueMu) / denom) * 100;
    tsBlueWin = normalCDF((blueMu - redMu)  / denom) * 100;
  }

  // Auton correlation: CCWM correlates with autonomous points
  // Auto contribution ≈ ccwm / total_max * auto_max
  const autoCorr = (t) => t ? `AWP/match: ${(t.awp_per_match*100).toFixed(0)}% · AutoMax: ${t.auto_max}` : '—';
  
  let html = `<div class="ts-panel-inner">
    <div class="ts-panel-title">⚙️ TrueSkill Prediction (Worlds 2026 Data)</div>`;

  // Figure out what's missing so we can show a helpful message
  const anyEntered = r1Team || r2Team || b1Team || b2Team;
  const redHasData  = redMu !== null;
  const blueHasData = blueMu !== null;
  const redMissing  = (r1Team && !r1) || (r2Team && !r2);
  const blueMissing = (b1Team && !b1) || (b2Team && !b2);

  if(tsRedWin !== null) {
    const barRed  = Math.round(tsRedWin);
    const barBlue = Math.round(tsBlueWin);
    html += '<div class="ts-win-bar-wrap">'
      + '<div class="ts-win-seg ts-red-seg" style="flex:' + barRed + '">' + barRed + '%</div>'
      + '<div class="ts-win-seg ts-blue-seg" style="flex:' + barBlue + '">' + barBlue + '%</div>'
      + '</div>'
      + '<div class="ts-bar-labels"><span style="color:var(--red)">🔴 Red ' + barRed + '%</span><span style="color:var(--blue)">Blue 🔵 ' + barBlue + '%</span></div>';
    if(redMissing || blueMissing) {
      html += '<div class="ts-no-data" style="margin-bottom:8px">⚠ Win % is estimated — some teams above are not in the TrueSkill database and were excluded from this calculation.</div>';
    }
  } else if(!anyEntered) {
    html += '<div class="ts-no-data" style="text-align:center;padding:.5rem">Type team numbers in the Red and Blue alliance slots above to see TrueSkill win probability.</div>';
  } else if(!redHasData && !blueHasData) {
    html += '<div class="ts-no-data" style="text-align:center;padding:.5rem">None of the entered teams were found in the TrueSkill database. The database covers ~1,200 top teams from Worlds 2026 qualifier events.</div>';
  } else if(!redHasData) {
    html += '<div class="ts-no-data" style="text-align:center;padding:.5rem">No Red alliance teams found in TrueSkill database — win % cannot be calculated. Individual Blue cards shown below.</div>';
  } else {
    html += '<div class="ts-no-data" style="text-align:center;padding:.5rem">No Blue alliance teams found in TrueSkill database — win % cannot be calculated. Individual Red cards shown below.</div>';
  }

  // Individual robot cards
  html += `<div class="ts-robots-grid">`;
  const robots = [
    { id: 'r1', team: r1Team, data: r1, color: 'red' },
    { id: 'r2', team: r2Team, data: r2, color: 'red' },
    { id: 'b1', team: b1Team, data: b1, color: 'blue' },
    { id: 'b2', team: b2Team, data: b2, color: 'blue' },
  ];
  robots.forEach(rbt => {
    const t = rbt.data;
    const teamDisplay = rbt.team || '—';
    html += `<div class="ts-robot-card ts-${rbt.color}-card">
      <div class="ts-robot-num" style="color:var(--${rbt.color})">${teamDisplay}</div>`;
    if(t) {
      html += `
      <div class="ts-robot-stat">Rank <strong>#${Math.round(t.ts_rank)||'—'}</strong></div>
      <div class="ts-robot-stat">TS: <strong>${t.ts.toFixed(1)}</strong> (μ=${t.mu.toFixed(1)})</div>
      <div class="ts-robot-stat">W/L: ${t.wins}–${t.losses} (${t.wp_pct}%)</div>
      <div class="ts-robot-stat">CCWM: ${t.ccwm.toFixed(1)}</div>
      <div class="ts-robot-stat">AutoMax: <strong>${t.auto_max} pts</strong></div>
      <div class="ts-robot-stat">AWP/match: ${(t.awp_per_match*100).toFixed(0)}%</div>
      ${t.qualified ? '<div class="ts-worlds-badge">✅ Worlds</div>' : ''}`;
    } else if(teamDisplay !== '—') {
      html += `<div class="ts-no-data">Not in database</div>`;
    } else {
      html += `<div class="ts-no-data">No team entered</div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;

  // Correlation note
  html += `<div class="ts-corr-note">
    <strong>How this correlates with your auton scouting:</strong>
    TrueSkill μ measures overall match performance. CCWM (Contribution to Win Margin) 
    reflects scoring efficiency per match — higher CCWM teams typically score more pins in auton.
    AutoMax shows the peak single-match autonomous score observed. Use AWP/match as a 
    proxy for how reliably a team achieves the Autonomous Win Point condition.
  </div>`;
  
  html += `</div>`;
  el.innerHTML = html;
}

/* Update TrueSkill badges in the predict tab when team numbers change */
function updateTsBadges() {
  const tsOn = document.getElementById('ts-correlation-panel')?.style.display !== 'none';

  // If toggle is off, clear all badges and skip
  if(!tsOn) {
    ['r1','r2','b1','b2'].forEach(id => {
      const badgeEl = document.getElementById('ts-badge-'+id);
      if(badgeEl) { badgeEl.innerHTML = ''; badgeEl.style.cssText = ''; }
    });
    return;
  }

  const teams = {
    r1: (document.getElementById('r1')?.value||'').trim().toUpperCase(),
    r2: (document.getElementById('r2')?.value||'').trim().toUpperCase(),
    b1: (document.getElementById('b1')?.value||'').trim().toUpperCase(),
    b2: (document.getElementById('b2')?.value||'').trim().toUpperCase(),
  };

  // Update badge for each slot with clear found/not-found styling
  ['r1','r2','b1','b2'].forEach(id => {
    const badgeEl = document.getElementById('ts-badge-'+id);
    if(!badgeEl) return;
    const team = teams[id];
    if(!team) { badgeEl.innerHTML = ''; badgeEl.style.cssText = ''; return; }
    const t = tsGet(team);
    if(t) {
      badgeEl.style.background = 'var(--green-bg)';
      badgeEl.style.color = 'var(--green)';
      badgeEl.style.borderColor = '#b8ddb8';
      badgeEl.innerHTML = '<span class="ts-mini-rank">#' + (Math.round(t.ts_rank)||'?') + '</span> TS <strong>' + t.ts.toFixed(1) + '</strong> \u00b7 \u03bc=' + t.mu.toFixed(1) + ' \u00b7 AutoMax ' + t.auto_max + 'pts';
    } else {
      badgeEl.style.background = 'var(--red-bg)';
      badgeEl.style.color = 'var(--red-text)';
      badgeEl.style.borderColor = '#f8c5b5';
      badgeEl.innerHTML = '\u26a0 <strong>' + esc(team) + '</strong> not in TrueSkill database';
    }
  });

  renderTsCorrelation(teams.r1, teams.r2, teams.b1, teams.b2);
}

/* ═══════════════════════════════════════════════════════
   TRUESKILL RANKINGS TAB
════════════════════════════════════════════════════════ */
let TS_ROWS =[]; // loaded from Supabase

(async function loadTeamData() {
  try {
    const res = await fetch(
      SB_URL + '/rest/v1/teams?select=*&order=rank.asc',
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    TS_ROWS = await res.json();
    _buildTsDb();
    console.log('Loaded ' + TS_ROWS.length + ' teams from Supabase');
    // Cache for offline fallback
    try { localStorage.setItem('ts_cache', JSON.stringify(TS_ROWS)); } catch(e) {}
    // Remove cache warning if present
    const cacheWarn = document.getElementById('ts-cache-warn');
    if (cacheWarn) cacheWarn.remove();
    if (document.getElementById('ts-tb')) { try { tsSetFilter(tsFilterMode, document.getElementById('ts-filter-' + (tsFilterMode === 'q' ? 'q' : tsFilterMode === 'top100' ? 'top100' : 'all'))); } catch(e) {} }
  } catch(e) {
    console.error('Failed to load team data:', e);
    // Fallback: try localStorage cache
    try {
      const cached = localStorage.getItem('ts_cache');
      if (cached) {
        TS_ROWS = JSON.parse(cached);
        _buildTsDb();
        tsSetFilter && tsSetFilter(tsFilterMode, document.getElementById('ts-filter-' + (tsFilterMode === 'q' ? 'q' : tsFilterMode === 'top100' ? 'top100' : 'all')));
        // Show cache warning banner
        const warn = document.createElement('div');
        warn.id = 'ts-cache-warn';
        warn.style.cssText = 'background:var(--amber-bg);border:1px solid var(--amber);color:var(--amber);font-family:var(--mono);font-size:11px;padding:6px 12px;border-radius:var(--radius);margin-bottom:8px;display:flex;align-items:center;gap:8px;';
        warn.innerHTML = '⚠️ <span>Offline mode — showing cached rankings from last successful load. Data may be outdated.</span>';
        const table = document.getElementById('ts-table');
        if (table) table.parentNode.insertBefore(warn, table);
        console.warn('TS: loaded from cache', TS_ROWS.length, 'teams');
      }
    } catch(cacheErr) { console.error('Cache load failed:', cacheErr); }
  }
})();

let tsSortCol = 'rank';
let tsSortAsc = true;
let tsFilterMode = 'all';
let tsPage_ = 1;
const TS_PAGE_SIZE = 50;
let tsFiltered = [...TS_ROWS];

function tsSetFilter(mode, el) {
  // Button-style pill filters (like Skills tab)
  const btns = [
    document.getElementById('ts-filter-all'),
    document.getElementById('ts-filter-q'),
    document.getElementById('ts-filter-top100')
  ];
  btns.forEach(b => {
    if (!b) return;
    b.style.background = 'var(--paper3)';
    b.style.color = 'var(--ink2)';
    b.style.borderColor = 'var(--border2)';
  });
  if (el) {
    el.style.background = 'var(--blue)';
    el.style.color = '#fff';
    el.style.borderColor = 'var(--blue)';
  }
  tsFilterMode = mode;
  tsApply();
}

function tsSort(col) {
  if (tsSortCol === col) { tsSortAsc = !tsSortAsc; }
  else { tsSortCol = col; tsSortAsc = (col === 'rank' || col === 'team'); }
  // Update sorted header highlight
  document.querySelectorAll('#ts-table th').forEach(th => th.classList.remove('sorted'));
  const headers = ['rank','team','ts','mu','wins','losses','wp_pct','ccwm','opr','awp_per_match','auto_max','total_max','qualified'];
  const idx = headers.indexOf(col);
  if (idx >= 0) document.querySelectorAll('#ts-table th')[idx]?.classList.add('sorted');
  tsApply();
}

function tsApply() {
  const q = (document.getElementById('ts-search')?.value || '').trim().toUpperCase();
  const sortSel = document.getElementById('ts-sort')?.value;
  if (sortSel) tsSortCol = sortSel;

  let d = [...TS_ROWS];
  if (tsFilterMode === 'q') d = d.filter(x => x.qualified);
  if (tsFilterMode === 'top100') d = d.filter(x => x.rank <= 100);
  if (q) d = d.filter(x => x.team.toUpperCase().includes(q));

  d.sort((a, b) => {
    let av = a[tsSortCol], bv = b[tsSortCol];
    if (typeof av === 'string') return tsSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return tsSortAsc ? av - bv : bv - av;
  });

  tsFiltered = d;
  tsPage_ = 1;
  tsRender();
}

function tsPage(dir) {
  tsPage_ += dir;
  tsRender();
  // #appShell is the scrollable container; #tab-ts-rankings itself has no scroll
  document.getElementById('appShell').scrollTo({ top: 0, behavior: 'smooth' });
}

function tsRender() {
  const total = tsFiltered.length;
  const pages = Math.ceil(total / TS_PAGE_SIZE);
  const start = (tsPage_ - 1) * TS_PAGE_SIZE;
  const slice = tsFiltered.slice(start, start + TS_PAGE_SIZE);

  document.getElementById('ts-stat-showing').textContent = total.toLocaleString();
  document.getElementById('ts-stat-count').textContent = TS_ROWS.length.toLocaleString();

  const tbody = document.getElementById('ts-tbody');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">No teams found</td></tr>';
  } else {
    tbody.innerHTML = slice.map(d => {
      const rankN = Math.round(d.rank);
      const isDark = !document.documentElement.classList.contains('light');
      const tnStyle = rankN === 1 ? 'color:#FFD700;font-weight:800' :
                      rankN === 2 ? 'color:#C0C0C0;font-weight:800' :
                      rankN === 3 ? 'color:#CD7F32;font-weight:800' :
                      isDark ? 'color:#0a1f4a;font-weight:700' : 'color:var(--ink);font-weight:700';
      const wpBar = Math.min(100, d.wp_pct).toFixed(0);
      const tsColor = d.ts >= 28 ? 'var(--green)' : d.ts >= 25 ? 'var(--blue)' : 'var(--ink2)';
      const re_url = 'https://www.robotevents.com/teams/V5RC/' + d.team;
      const qBadge = d.qualified
        ? '<span class="badge b-q" style="font-size:10px">✅ Yes</span>'
        : '<span style="color:var(--ink3);font-size:11px;font-family:var(--mono)">—</span>';
      return '<tr onclick="window.open(\'' + re_url + '\',\'_blank\')" style="cursor:pointer">'
        + '<td class="tn" style="' + tnStyle + '">#' + rankN + '</td>'
        + '<td><span class="tn">' + esc(d.team) + '</span></td>'
        + '<td style="font-family:var(--mono);font-weight:700;color:' + tsColor + '">' + d.ts.toFixed(1) + '</td>'
        + '<td style="font-family:var(--mono);font-size:12px;color:var(--ink2)">' + d.mu.toFixed(1) + ' <span style="color:var(--ink3)">±' + d.sigma.toFixed(2) + '</span></td>'
        + '<td style="font-family:var(--mono);color:var(--green)">' + d.wins + '</td>'
        + '<td style="font-family:var(--mono);color:var(--red)">' + d.losses + '</td>'
        + '<td><span style="font-family:var(--mono);font-size:12px">' + d.wp_pct.toFixed(1) + '%</span>'
        +   '<div class="awp-wrap" style="margin-top:3px"><div class="awp-fill" style="width:' + wpBar + '%;background:var(--blue)"></div></div></td>'
        + '<td style="font-family:var(--mono);font-size:12px">' + d.ccwm.toFixed(1) + '</td>'
        + '<td style="font-family:var(--mono);font-size:12px">' + d.opr.toFixed(1) + '</td>'
        + '<td style="font-family:var(--mono);font-size:12px">' + (d.awp_per_match * 100).toFixed(0) + '%</td>'
        + '<td style="font-family:var(--mono);font-size:12px">' + d.auto_max + '</td>'
        + '<td style="font-family:var(--mono);font-size:12px">' + d.total_max + '</td>'
        + '<td>' + qBadge + '</td>'
        + '</tr>';
    }).join('');
  }

  // Pager
  const pager = document.getElementById('ts-pager');
  const prev = document.getElementById('ts-prev');
  const next = document.getElementById('ts-next');
  const pi   = document.getElementById('ts-pi');
  if (pages > 1) {
    pager.style.display = 'flex';
    prev.disabled = tsPage_ <= 1;
    next.disabled = tsPage_ >= pages;
    pi.textContent = 'Page ' + tsPage_ + ' of ' + pages + ' · ' + total.toLocaleString() + ' teams';
  } else {
    pager.style.display = 'none';
  }
}

// tsApply is now called directly inside switchTab — no monkey-patch needed.

/* ═══════════════════════════════════════════════════════
   THEME — light / dark toggle
════════════════════════════════════════════════════════ */
function applyTheme(isLight) {
  document.documentElement.classList.toggle('light', isLight);
  localStorage.setItem('os_theme', isLight ? 'light' : 'dark');
  const toggle = document.getElementById('lightModeToggle');
  if (toggle) toggle.checked = isLight;
}


// Restore saved theme on load
(function() {
  const saved = localStorage.getItem('os_theme');
  if (saved === 'light') applyTheme(true);
})();

/* ═══════════════════════════════════════════════════════
   SETTINGS — compact mode, per page, scouting, sync, cache
════════════════════════════════════════════════════════ */

// ── Compact mode ──
function applyCompactMode(on) {
  document.body.classList.toggle('compact-mode', on);
  try { localStorage.setItem('os_compact', on ? '1' : '0'); } catch(e) {}
  const t = document.getElementById('compactToggle');
  if (t) t.checked = on;
}

// ── Entries per page ──
let LB_PG_OVERRIDE = null;
function applyPerPage(val) {
  LB_PG_OVERRIDE = parseInt(val) || 25;
  try { localStorage.setItem('os_per_page', val); } catch(e) {}
  const sel = document.getElementById('perPageSelect');
  if (sel) sel.value = val;
  lbApplyFilter(lbActiveF);
}

// Patch lbRender to respect LB_PG_OVERRIDE — redesigned to match Skills page aesthetic
const _origLbRender = lbRender;
window.lbRender = function() {
  const pg = LB_PG_OVERRIDE || LB_PG;
  const start = (lbPg - 1) * pg;
  const sl = lbFiltered.slice(start, start + pg);
  const tot = lbFiltered.length, pages = Math.ceil(tot / pg);
  if (!sl.length) {
    document.getElementById('lbMain').innerHTML = allTeams.length === 0
      ? '<div class="empty"><span class="spin"></span><br><br>Loading…</div>'
      : '<div class="empty">No teams match this filter.</div>';
    return;
  }
  const myTeam = (localStorage.getItem('os_my_team') || '').trim().toUpperCase();
  const rivals = (localStorage.getItem('os_rivals') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const medals = ['🥇','🥈','🥉'];
  const maxPins = Math.max(...sl.map(t => parseFloat(t.avg_pins)||0), 1);
  const sa = col => lbSortC === col ? (lbSortD === 1 ? ' ↓' : ' ↑') : '';
  const sc = col => lbSortC === col ? 'var(--amber)' : 'var(--ink3)';

  document.getElementById('lbMain').innerHTML = `
    <div class="lb-grid-wrap" style="border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface)">

      <!-- Header row -->
      <div class="lb-grid-head" style="display:grid;grid-template-columns:52px 1fr 72px 140px 140px 120px;background:var(--paper2);border-bottom:2px solid var(--border2)">
        <div style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);font-weight:600">#</div>
        <div onclick="lbSortBy('team')" style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${sc('team')};font-weight:600;cursor:pointer;user-select:none;transition:color .12s">Team${sa('team')}</div>
        <div onclick="lbSortBy('count')" style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${sc('count')};font-weight:600;cursor:pointer;user-select:none;transition:color .12s">Mtchs${sa('count')}</div>
        <div onclick="lbSortBy('avg_pins')" style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${sc('avg_pins')};font-weight:600;cursor:pointer;user-select:none;transition:color .12s">Avg Pins${sa('avg_pins')}</div>
        <div onclick="lbSortBy('awp_pct')" style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:${sc('awp_pct')};font-weight:600;cursor:pointer;user-select:none;transition:color .12s">AWP Rate${sa('awp_pct')}</div>
        <div style="padding:10px 14px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.8px;color:var(--ink3);font-weight:600">Robot</div>
      </div>

      <!-- Data rows -->
      ${sl.map((t, i) => {
        const rank = start + i + 1;
        const isMe = myTeam && t.team === myTeam;
        const isRival = rivals.includes(t.team);
        const avgPins = parseFloat(t.avg_pins) || 0;
        const awpPct  = parseFloat(t.awp_pct)  || 0;
        const pinPct  = Math.round(avgPins / maxPins * 100);
        const pinColor = avgPins >= 6 ? 'var(--green)' : avgPins >= 3 ? 'var(--amber)' : 'var(--red)';
        const awpColor = awpPct >= 50 ? 'var(--green)' : awpPct >= 20 ? 'var(--amber)' : 'var(--ink3)';
        const tsInfo = typeof tsGet === 'function' ? tsGet(t.team) : null;
        const leftBorder = isMe ? '3px solid var(--amber)' : isRival ? '3px solid var(--red)' : '3px solid transparent';
        const rowBg = isMe ? 'rgba(240,192,48,.05)' : isRival ? 'rgba(204,61,20,.05)' : 'transparent';
        const medal = rank <= 3 ? medals[rank-1] : `<span style="font-family:var(--mono);font-size:11px;color:var(--ink3)">${rank}</span>`;
        const teamEsc = t.team.replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const typesEsc = (t.types||'—').replace(/</g,'&lt;');
        return `<div class="lb-grid-row" data-team="${teamEsc}" onclick="openDetail('${t.team.replace(/'/g,"\\'")}')" style="display:grid;grid-template-columns:52px 1fr 72px 140px 140px 120px;border-bottom:1px solid var(--border);border-left:${leftBorder};background:${rowBg};cursor:pointer;transition:background .1s"
          onmouseover="this.style.background='var(--paper3)'" onmouseout="this.style.background='${rowBg}'">

          <!-- Rank -->
          <div class="lb-grid-rank" style="padding:14px 0;display:flex;align-items:center;justify-content:center;font-size:16px">${medal}</div>

          <!-- Team -->
          <div class="lb-grid-cell lb-grid-team" style="padding:12px 14px;display:flex;flex-direction:column;justify-content:center;gap:4px;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span class="lb-grid-team-num" style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--ink)">${teamEsc}</span>
              ${isMe ? '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 6px;border-radius:3px;background:rgba(240,192,48,.18);color:var(--amber);border:1px solid rgba(240,192,48,.35)">YOU</span>' : ''}
              ${isRival ? '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 6px;border-radius:3px;background:rgba(204,61,20,.15);color:var(--red);border:1px solid rgba(204,61,20,.3)">RIVAL</span>' : ''}
              ${tsInfo?.qualified ? '<span style="font-size:8px;font-weight:700;font-family:var(--mono);padding:1px 6px;border-radius:3px;background:rgba(61,189,110,.15);color:var(--green);border:1px solid rgba(61,189,110,.3)">✅ WQ</span>' : ''}
            </div>
            <div class="lb-grid-team-meta" style="font-size:10px;color:var(--ink3);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${typesEsc}</div>
          </div>

          <!-- Matches -->
          <div class="lb-grid-cell" style="padding:12px 14px;display:flex;align-items:center">
            <span class="lb-grid-value" style="font-family:var(--mono);font-size:13px;color:var(--ink2)">${t.count}</span>
          </div>

          <!-- Avg Pins -->
          <div class="lb-grid-cell" style="padding:12px 14px;display:flex;flex-direction:column;justify-content:center;gap:6px">
            <div style="display:flex;align-items:baseline;gap:5px">
              <span class="lb-grid-value" style="font-family:var(--mono);font-size:17px;font-weight:700;color:${pinColor};line-height:1">${avgPins.toFixed(1)}</span>
              <span class="lb-grid-unit" style="font-size:9px;font-family:var(--mono);color:var(--ink3)">pins</span>
            </div>
            <div class="lb-grid-bar" style="height:3px;width:80px;background:var(--border2);border-radius:2px;overflow:hidden">
              <div style="height:3px;width:${pinPct}%;background:${pinColor};border-radius:2px"></div>
            </div>
          </div>

          <!-- AWP Rate -->
          <div class="lb-grid-cell" style="padding:12px 14px;display:flex;flex-direction:column;justify-content:center;gap:6px">
            <span class="lb-grid-value" style="font-family:var(--mono);font-size:15px;font-weight:700;color:${awpColor};line-height:1">${awpPct.toFixed(0)}%</span>
            <div class="lb-grid-bar" style="height:3px;width:80px;background:var(--border2);border-radius:2px;overflow:hidden">
              <div style="height:3px;width:${Math.min(awpPct,100)}%;background:var(--green);border-radius:2px"></div>
            </div>
          </div>

          <!-- Robot type -->
          <div class="lb-grid-cell" style="padding:12px 14px;display:flex;align-items:center">
            <span class="lb-grid-robot" style="font-size:11px;color:var(--ink3);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${typesEsc}</span>
          </div>
        </div>`;
      }).join('')}
    </div>

    <!-- Mobile cards (unchanged, shown on small screens) -->
    <div class="lb-card-list">
      ${sl.map((t, i) => {
        const isMe = myTeam && t.team === myTeam;
        const isRival = rivals.includes(t.team);
        const cardClass = isMe ? 'lb-card lb-card-me' : isRival ? 'lb-card lb-card-rival' : 'lb-card';
        const awp = Math.min(parseFloat(t.awp_pct)||0, 100);
        const teamEsc = t.team.replace(/"/g,'&quot;').replace(/</g,'&lt;');
        return `<div class="${cardClass}" data-team="${teamEsc}" onclick="openDetail('${t.team.replace(/'/g,"\\'")}')">
          <div class="lb-card-rank">${start+i+1}</div>
          <div class="lb-card-body">
            <div class="lb-card-team">${teamEsc}${isMe?' 🏠':isRival?' ⚔':''}</div>
            <div class="lb-card-meta">${(t.types||'—').replace(/</g,'&lt;')}</div>
            <div class="lb-card-stats">
              <div class="lb-card-stat"><div class="lb-card-stat-v">${t.count}</div><div class="lb-card-stat-l">Matches</div></div>
              <div class="lb-card-stat"><div class="lb-card-stat-v">${parseFloat(t.avg_pins).toFixed(1)}</div><div class="lb-card-stat-l">Avg Pins</div></div>
              <div class="lb-card-stat">
                <div class="lb-card-awp">
                  <span class="lb-card-stat-v">${awp.toFixed(0)}%</span>
                  <div class="lb-card-awp-bar"><div class="lb-card-awp-fill" style="width:${awp}%"></div></div>
                </div>
                <div class="lb-card-stat-l">AWP Rate</div>
              </div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  const pgEl = document.getElementById('lbPager');
  if (pages > 1) {
    pgEl.style.display = 'flex';
    document.getElementById('lbPi').textContent = `Page ${lbPg} of ${pages} (${tot} teams)`;
    document.getElementById('lbPrev').disabled = lbPg === 1;
    document.getElementById('lbNext').disabled = lbPg === pages;
  } else pgEl.style.display = 'none';
};

// ── My team ──
function applyMyTeam(val) {
  val = val.trim().toUpperCase();
  try { localStorage.setItem('os_my_team', val); } catch(e) {}
  lbRender();
}

// ── Rivals ──
function applyRivals(val) {
  try { localStorage.setItem('os_rivals', val.toUpperCase()); } catch(e) {}
  lbRender();
}

// ── Auto-refresh ──
let _refreshTimer = null;
function applyRefreshInterval(val) {
  try { localStorage.setItem('os_refresh_interval', val); } catch(e) {}
  clearInterval(_refreshTimer);
  const secs = parseInt(val);
  if (secs > 0) {
    _refreshTimer = setInterval(() => {
      if (_refreshBannerEnabled) {
        // Just show banner — don't silently update
        showRefreshBanner();
      } else {
        loadData().then(() => {
          _lastSyncTime = Date.now();
          updateSyncTimeDisplay();
        });
      }
    }, secs * 1000);
  }
}

// ── Last synced time ──
let _lastSyncTime = Date.now();
let _syncTimeTimer = null;
function updateSyncTimeDisplay() {
  const show = localStorage.getItem('os_show_sync_time') !== '0';
  if (!show) return;
  const el = document.getElementById('syncTxt');
  if (!el) return;
  const secs = Math.round((Date.now() - _lastSyncTime) / 1000);
  const label = secs < 10 ? 'just now' : secs < 60 ? secs + 's ago' : Math.round(secs/60) + 'min ago';
  if (el.textContent && !el.textContent.includes('Loading')) {
    const base = el.textContent.split('·')[0].trim();
    el.textContent = base + ' · ' + label;
  }
}
function applyShowSyncTime(on) {
  try { localStorage.setItem('os_show_sync_time', on ? '1' : '0'); } catch(e) {}
  const t = document.getElementById('showSyncTimeToggle');
  if (t) t.checked = on;
  clearInterval(_syncTimeTimer);
  if (on) _syncTimeTimer = setInterval(updateSyncTimeDisplay, 10000);
}

// ── Clear cache ──
function clearLocalCache() {
  if (!confirm('Clear all local browser data for Override Scout? This cannot be undone.')) return;
  const keys = ['override_scout_v3','ul_changelog_v1','ts_cache','os_theme','os_compact','os_per_page','os_my_team','os_rivals','os_refresh_interval','os_show_sync_time','os_refresh_banner','os_remember_admin','os_admin_token','os_admin_exp','override_scout_re_token','os_qs_re_token'];
  keys.forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
  showToast('Local cache cleared — reloading…', 'ok', 2000);
  setTimeout(() => location.reload(), 2000);
}

// ── Reset all settings ──
function resetAllSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  applyTheme(false);
  applyCompactMode(false);
  applyPerPage('25');
  applyMyTeam('');
  applyRivals('');
  applyRefreshInterval('60');
  applyShowSyncTime(true);
  applyRefreshBanner(false);
  applyRememberAdmin(false);
  applyCalcSideBySide(false);
  saveRobotEventsToken('');
  try { localStorage.removeItem('os_qs_re_token'); } catch(e) {}
  loadSettingsFromStorage();
  showToast('Settings reset to defaults', 'ok', 2500);
}

// ── Export CSV ──
function exportCSV() {
  if (!allTeams.length) { showToast('No data to export yet', 'err', 2500); return; }
  const headers = ['rank','team','matches','avg_pins','awp_rate_pct','awp_count','success_pct','robot_types','routes','last_scouted'];
  const rows = allTeams.map((t, i) => [
    i + 1,
    t.team,
    t.count,
    parseFloat(t.avg_pins).toFixed(2),
    (parseFloat(t.awp_pct) || 0).toFixed(1),
    t.awp_count || 0,
    (parseFloat(t.success_pct) || 0).toFixed(1),
    '"' + (t.types || '').replace(/"/g, '""') + '"',
    '"' + (t.routes || '').replace(/"/g, '""') + '"',
    t.last ? new Date(t.last).toLocaleDateString() : ''
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  _downloadFile('override-scout-leaderboard.csv', 'text/csv', csv);
  showToast('CSV downloaded', 'ok', 2000);
}

// ── Export JSON ──
function exportJSON() {
  if (!allTeams.length) { showToast('No data to export yet', 'err', 2500); return; }
  const out = allTeams.map((t, i) => ({
    rank: i + 1,
    team: t.team,
    matches: t.count,
    avg_pins: parseFloat(t.avg_pins),
    awp_rate_pct: parseFloat(t.awp_pct) || 0,
    awp_count: t.awp_count || 0,
    success_pct: parseFloat(t.success_pct) || 0,
    robot_types: t.types || '',
    routes: t.routes || '',
    last_scouted: t.last || null
  }));
  _downloadFile('override-scout-leaderboard.json', 'application/json', JSON.stringify(out, null, 2));
  showToast('JSON downloaded', 'ok', 2000);
}

function _downloadFile(filename, type, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── Refresh banner ──
let _refreshBannerEnabled = false;
let _pendingRefreshData = null;

function applyRefreshBanner(on) {
  _refreshBannerEnabled = on;
  try { localStorage.setItem('os_refresh_banner', on ? '1' : '0'); } catch(e) {}
  const t = document.getElementById('refreshBannerToggle');
  if (t) t.checked = on;
  if (!on) document.getElementById('refreshBanner').style.display = 'none';
}

function showRefreshBanner() {
  if (!_refreshBannerEnabled) return;
  const banner = document.getElementById('refreshBanner');
  banner.style.display = 'flex';
}

function applyRefreshNow() {
  document.getElementById('refreshBanner').style.display = 'none';
  loadData();
}

// ── Remember admin session ──
function saveSettingsReToken() {
  saveRobotEventsToken(document.getElementById('settings-re-token')?.value || '');
}

function clearSettingsReToken() {
  saveRobotEventsToken('');
  try { localStorage.removeItem('os_qs_re_token'); } catch(e) {}
  if (typeof showToast === 'function') showToast('RobotEvents token cleared', 'ok', 1800);
}

function applyRememberAdmin(on) {
  // Remember admin feature removed for security — admin JWT stays in sessionStorage only
  try { localStorage.removeItem('os_remember_admin'); localStorage.removeItem('os_admin_token'); localStorage.removeItem('os_admin_exp'); } catch(e) {}
  const t = document.getElementById('rememberAdminToggle');
  if (t) { t.checked = false; t.disabled = true; }
}

// _persistAdminToken removed — admin JWT is sessionStorage only
function _persistAdminToken(token, exp) { /* no-op: localStorage persistence removed for security */ }
function loadSettingsFromStorage() {
  // Compact
  const compact = localStorage.getItem('os_compact') === '1';
  applyCompactMode(compact);

  // Per page
  const pp = localStorage.getItem('os_per_page') || '25';
  LB_PG_OVERRIDE = parseInt(pp);
  const ppSel = document.getElementById('perPageSelect');
  if (ppSel) ppSel.value = pp;

  // My team
  const myTeam = localStorage.getItem('os_my_team') || '';
  const myTeamEl = document.getElementById('myTeamInput');
  if (myTeamEl) myTeamEl.value = myTeam;

  // Rivals
  const rivals = localStorage.getItem('os_rivals') || '';
  const rivalsEl = document.getElementById('rivalsInput');
  if (rivalsEl) rivalsEl.value = rivals;

  // Auto-refresh
  const interval = localStorage.getItem('os_refresh_interval') ?? '60';
  const intSel = document.getElementById('refreshIntervalSelect');
  if (intSel) intSel.value = interval;
  applyRefreshInterval(interval);

  // Show sync time
  const showSync = localStorage.getItem('os_show_sync_time') !== '0';
  applyShowSyncTime(showSync);

  // Refresh banner
  const banner = localStorage.getItem('os_refresh_banner') === '1';
  applyRefreshBanner(banner);

  // RobotEvents API token
  loadReToken();

  // Auton calculator team numbers
  emRestoreTeams();

  // Side-by-side calculators
  const sideBySide = localStorage.getItem('os_calc_sidebyside') === '1';
  applyCalcSideBySide(sideBySide);
}

document.addEventListener('DOMContentLoaded', loadSettingsFromStorage);

/* ══════════════════════════════════════════════════════════════
   NEW FEATURES — UX + ANALYTICS
   1. Keyboard shortcuts
   2. Quick search overlay (T key)
   3. Search history
   4. Starred teams
   5. Team comparison modal
   6. Performance sparklines (injected into lbRender)
   7. OPR/DPR/CCWM computed from entry data (in search results)
   8. Prediction accuracy tracker
   9. Performance trend in team profile
══════════════════════════════════════════════════════════════ */

/* ─── 1. KEYBOARD SHORTCUTS ─────────────────────────────── */
document.addEventListener('keydown', function(e) {
  const tag = (document.activeElement || {}).tagName || '';
  const inInput = ['INPUT','TEXTAREA','SELECT'].includes(tag);

  // Always: Escape closes overlays
  if (e.key === 'Escape') {
    if (document.getElementById('quick-search-bar').classList.contains('open')) { closeQuickSearch(); return; }
    if (document.getElementById('kbd-overlay').style.display !== 'none') { closeKbdOverlay(); return; }
    if (document.getElementById('compare-modal-bg').classList.contains('open')) { closeCompareModal(); return; }
  }

  if (inInput) return; // below shortcuts don't fire inside inputs

  // ? → keyboard help
  if (e.key === '?') { openKbdOverlay(); return; }

  // T → quick search
  if (e.key === 't' || e.key === 'T') { openQuickSearch(); return; }

  // R → refresh
  if (e.key === 'r' || e.key === 'R') {
    if (typeof loadData === 'function') { loadData(); showToastNew('Refreshing…'); }
    return;
  }

  // C → compare modal
  if (e.key === 'c' || e.key === 'C') { openCompareModal(); return; }

  // L → leaderboard tab
  if (e.key === 'l' || e.key === 'L') {
    const lb = document.querySelector('[data-tab="leaderboard"]');
    if (lb) lb.click();
    return;
  }

  // 1-9 → switch tabs by position
  if (e.key >= '1' && e.key <= '9') {
    const tabs = Array.from(document.querySelectorAll('.tab:not([style*="display:none"]):not(.admin-only:not(.admin-visible))'));
    const idx = parseInt(e.key) - 1;
    if (tabs[idx]) tabs[idx].click();
  }
});

function openKbdOverlay() {
  document.getElementById('kbd-overlay').style.display = 'flex';
}
function closeKbdOverlay() {
  document.getElementById('kbd-overlay').style.display = 'none';
}

/* ─── 2. QUICK SEARCH OVERLAY ───────────────────────────── */
let qsSelectedIdx = -1;
function openQuickSearch() {
  const bar = document.getElementById('quick-search-bar');
  bar.classList.add('open');
  const inp = document.getElementById('quick-search-input');
  inp.value = '';
  document.getElementById('quick-search-results').innerHTML = '';
  inp.focus();
  qsSelectedIdx = -1;
}
function closeQuickSearch() {
  document.getElementById('quick-search-bar').classList.remove('open');
}
function qsSearch(q) {
  q = q.trim().toUpperCase();
  const res = document.getElementById('quick-search-results');
  if (!q || !window.allTeams) { res.innerHTML = ''; return; }
  const matches = allTeams.filter(t => t.team.toUpperCase().includes(q)).slice(0, 8);
  if (!matches.length) { res.innerHTML = '<div class="qs-result" style="cursor:default"><span class="qs-result-meta">No teams found</span></div>'; return; }
  res.innerHTML = matches.map((t, i) => `
    <div class="qs-result" data-team="${t.team}" onclick="qsGo('${t.team}')">
      <span class="qs-result-team">${t.team}</span>
      <span class="qs-result-meta">${parseFloat(t.avg_pins||0).toFixed(1)} avg pins · ${t.count} matches</span>
    </div>`).join('');
  qsSelectedIdx = -1;
}
function qsKey(e) {
  const items = document.querySelectorAll('.qs-result');
  if (e.key === 'ArrowDown') { qsSelectedIdx = Math.min(qsSelectedIdx+1, items.length-1); qsHighlight(items); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { qsSelectedIdx = Math.max(qsSelectedIdx-1, 0); qsHighlight(items); e.preventDefault(); }
  else if (e.key === 'Enter') {
    if (qsSelectedIdx >= 0 && items[qsSelectedIdx]) {
      qsGo(items[qsSelectedIdx].dataset.team);
    } else {
      const val = document.getElementById('quick-search-input').value.trim();
      if (val) qsGo(val);
    }
  } else if (e.key === 'Escape') { closeQuickSearch(); }
}
function qsHighlight(items) {
  items.forEach((el, i) => el.classList.toggle('qs-active', i === qsSelectedIdx));
}
function qsGo(team) {
  closeQuickSearch();
  // Switch to leaderboard tab (search bubble is embedded there)
  const tab = document.querySelector('[data-tab="leaderboard"]');
  if (tab) tab.click();
  setTimeout(() => {
    const inp = document.getElementById('pubSearch');
    if (inp) { inp.value = team; }
    if (typeof lbDoSearch === 'function') lbDoSearch();
    else if (typeof pubDoSearch === 'function') pubDoSearch();
  }, 80);
  shAddHistory(team);
}

/* ─── 3. SEARCH HISTORY ─────────────────────────────────── */
const SH_KEY = 'os_search_history';
function shGetHistory() {
  try { return JSON.parse(localStorage.getItem(SH_KEY) || '[]'); } catch(e) { return []; }
}
function shAddHistory(team) {
  team = (team||'').trim().toUpperCase();
  if (!team) return;
  let h = shGetHistory().filter(t => t !== team);
  h.unshift(team);
  h = h.slice(0, 12);
  try { localStorage.setItem(SH_KEY, JSON.stringify(h)); } catch(e) {}
}
function shShowDrop() {
  const h = shGetHistory();
  const drop = document.getElementById('search-history-drop');
  if (!drop) return;
  if (!h.length) { drop.style.display = 'none'; return; }
  drop.style.display = 'block';
  drop.innerHTML = h.map(t => `
    <div class="sh-item" onclick="shUse('${t}')">
      <span class="sh-item-icon">🕐</span>
      <span>${t}</span>
    </div>`).join('') +
    `<div class="sh-item" style="justify-content:center" onclick="shClearHistory()">
      <span style="font-size:10px;color:var(--ink3)">Clear history</span>
    </div>`;
}
function shHideDrop() {
  const drop = document.getElementById('search-history-drop');
  if (drop) drop.style.display = 'none';
}
function shInput(val) {
  if (val.trim()) { shHideDrop(); }
  else { shShowDrop(); }
}
function shUse(team) {
  const inp = document.getElementById('pubSearch');
  if (inp) inp.value = team;
  shHideDrop();
  if (typeof pubDoSearch === 'function') pubDoSearch();
}
function shClearHistory() {
  try { localStorage.removeItem(SH_KEY); } catch(e) {}
  shHideDrop();
}
// Hook into pubDoSearch to record searches
const _origPubDoSearch = window.pubDoSearch;
window.pubDoSearch = function() {
  const inp = document.getElementById('pubSearch');
  if (inp && inp.value.trim()) shAddHistory(inp.value.trim());
  if (typeof _origPubDoSearch === 'function') _origPubDoSearch.apply(this, arguments);
  // After a short delay, inject analytics extras
  setTimeout(() => injectSearchExtras(), 300);
};

/* ─── 4. STARRED TEAMS ──────────────────────────────────── */
const STAR_KEY = 'os_starred_teams';
function getStarred() {
  try { return JSON.parse(localStorage.getItem(STAR_KEY) || '[]'); } catch(e) { return []; }
}
function toggleStar(team) {
  let stars = getStarred();
  if (stars.includes(team)) {
    stars = stars.filter(t => t !== team);
    showToastNew('⭐ Unstarred ' + team);
  } else {
    stars.push(team);
    showToastNew('⭐ Starred ' + team);
  }
  try { localStorage.setItem(STAR_KEY, JSON.stringify(stars)); } catch(e) {}
  renderStarredSection();
  // Update all star buttons on page
  document.querySelectorAll('.star-btn').forEach(btn => {
    if (btn.dataset.team === team) btn.classList.toggle('starred', stars.includes(team));
  });
}
function renderStarredSection() {
  const stars = getStarred();
  const sec = document.getElementById('starred-section');
  const chips = document.getElementById('starred-chips');
  if (!sec || !chips) return;
  if (!stars.length) { sec.classList.remove('has-stars'); return; }
  sec.classList.add('has-stars');
  chips.innerHTML = stars.map(t => `
    <span class="starred-chip" onclick="gotoTeam('${t}')">
      ⭐ ${t}
      <span class="starred-chip-x" onclick="event.stopPropagation();toggleStar('${t}')" title="Remove">✕</span>
    </span>`).join('');
}
function gotoTeam(team) {
  const tab = document.querySelector('[data-tab="leaderboard"]');
  if (tab) tab.click();
  setTimeout(() => {
    const inp = document.getElementById('pubSearch');
    if (inp) inp.value = team;
    if (typeof pubDoSearch === 'function') pubDoSearch();
  }, 80);
}
// Initialise starred on load
document.addEventListener('DOMContentLoaded', renderStarredSection);
// Also render now (DOMContentLoaded may have already fired)
renderStarredSection();

/* Helper: small toast (separate from the existing showMsg) */
function showToastNew(msg, dur=2200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;background:var(--surface);border:1px solid var(--border2);padding:9px 16px;border-radius:var(--radius-lg);font-family:var(--mono);font-size:12px;color:var(--ink);box-shadow:0 4px 16px rgba(0,0,0,.4);animation:fadeIn .2s ease;pointer-events:none';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.style.cssText='',350); }, dur);
}

/* Patch lbRender to inject star buttons + sparklines + compare */
const _origLbRenderNew = window.lbRender;
window.lbRender = function() {
  _origLbRenderNew.apply(this, arguments);
  // After lbRender, inject star buttons + sparklines into every row
  setTimeout(() => {
    const stars = getStarred();
    document.querySelectorAll('#lbMain [data-team]').forEach(row => {
      const team = row.dataset.team;
      if (!team) return;
      // Star button — inject into the team name cell (2nd grid child)
      if (!row.querySelector('.star-btn')) {
        const teamCell = row.children[1]; // 2nd column = team info div
        if (teamCell) {
          const nameRow = teamCell.querySelector('div');
          if (nameRow) {
            const btn = document.createElement('button');
            btn.className = 'star-btn' + (stars.includes(team) ? ' starred' : '');
            btn.dataset.team = team;
            btn.title = 'Star this team';
            btn.textContent = '★';
            btn.onclick = function(e) { e.stopPropagation(); toggleStar(team); };
            nameRow.appendChild(btn);
          }
        }
      }
      // Sparkline — inject into the avg pins cell (4th grid child)
      if (!row.querySelector('.sparkline-canvas')) {
        const pinsCell = row.children[3]; // 4th column = avg pins
        if (pinsCell && window.allEntries) {
          const teamEntries = allEntries.filter(en => (en.team||'').toUpperCase() === team.toUpperCase());
          if (teamEntries.length >= 3) {
            const recent = [...teamEntries].sort((a,b)=>(b.ts||b.created_at||'').localeCompare(a.ts||a.created_at||'')).slice(0,10).reverse();
            const vals = recent.map(en => { const p=(en.pins||'0+0').split('+'); return (parseInt(p[0])||0)+(parseInt(p[1])||0); });
            const canvas = document.createElement('canvas');
            canvas.className = 'sparkline-canvas';
            canvas.width = 60; canvas.height = 16;
            drawSparkline(canvas, vals);
            pinsCell.appendChild(canvas);
          }
        }
      }
    });
  }, 0);
};

/* ─── SPARKLINE DRAWING ──────────────────────────────────── */
function drawSparkline(canvas, vals) {
  if (!vals || vals.length < 2) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => [i / (vals.length-1) * W, H - ((v-min)/range) * (H-4) - 2]);
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  pts.slice(1).forEach(([x,y]) => ctx.lineTo(x,y));
  const isUp = vals[vals.length-1] >= vals[0];
  ctx.strokeStyle = isUp ? '#3dbd6e' : '#cc3d14';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Last dot
  const last = pts[pts.length-1];
  ctx.beginPath();
  ctx.arc(last[0], last[1], 2.5, 0, Math.PI*2);
  ctx.fillStyle = isUp ? '#3dbd6e' : '#cc3d14';
  ctx.fill();
}

/* ─── 5. TEAM COMPARISON MODAL ──────────────────────────── */
function openCompareModal() {
  document.getElementById('compare-modal-bg').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('cmp-t1').focus(), 80);
}
function closeCompareModal() {
  document.getElementById('compare-modal-bg').classList.remove('open');
  document.body.style.overflow = '';
}

function runCompare() {
  const ids = ['cmp-t1','cmp-t2','cmp-t3','cmp-t4']
    .map(id => (document.getElementById(id)?.value||'').trim().toUpperCase())
    .filter(Boolean);

  const res = document.getElementById('cmp-result');
  if (!ids.length || !window.allTeams) {
    res.innerHTML = '<div style="font-size:12px;font-family:var(--mono);color:var(--ink3);text-align:center;padding:2rem">Enter team numbers above to compare.</div>';
    return;
  }

  const teams = ids.map(id => allTeams.find(t => t.team.toUpperCase() === id) || null);
  const found = teams.filter(Boolean);
  if (!found.length) {
    res.innerHTML = '<div style="font-size:12px;font-family:var(--mono);color:var(--red-text);text-align:center;padding:2rem">No matching teams found in database.</div>';
    return;
  }

  // Compute OPR-style stats from entries per team
  function teamStats(tObj) {
    if (!tObj) return null;
    const entries = (window.allEntries||[]).filter(e=>(e.team||'').toUpperCase()===tObj.team.toUpperCase());
    const pinsArr = entries.map(e=>{ const p=(e.pins||'0+0').split('+'); return (parseInt(p[0])||0)+(parseInt(p[1])||0); });
    const recent = [...entries].sort((a,b)=>(b.ts||b.created_at||'').localeCompare(a.ts||a.created_at||'')).slice(0,5);
    const recentAvg = recent.length ? recent.reduce((s,e)=>{ const p=(e.pins||'0+0').split('+'); return s+(parseInt(p[0])||0)+(parseInt(p[1])||0); },0)/recent.length : 0;
    const maxPins = pinsArr.length ? Math.max(...pinsArr) : 0;
    const consistency = pinsArr.length >= 2 ? (1 - stdDev(pinsArr)/Math.max(1,average(pinsArr))) : null;
    const awpPct = entries.length ? entries.filter(e=>e.awp==='Y').length/entries.length*100 : 0;
    const failPct = entries.length ? entries.filter(e=>e.failed==='Y').length/entries.length*100 : 0;
    const ts = window.TS_DB && window.tsGet ? tsGet(tObj.team) : null;
    return {
      team: tObj.team,
      count: tObj.count || entries.length,
      avg: parseFloat(tObj.avg_pins||0),
      recentAvg,
      maxPins,
      consistency,
      awpPct,
      failPct,
      tsRank: ts ? ts.ts_rank : null,
      tsScore: ts ? ts.ts : null,
      opr: ts ? ts.opr : null,
      entries: pinsArr,
    };
  }

  const stats = found.map(teamStats);

  const metrics = [
    { label:'Avg Pins',     key:'avg',         fmt:v=>v.toFixed(1),  higher:true },
    { label:'Recent Avg (5)',key:'recentAvg',   fmt:v=>v.toFixed(1),  higher:true },
    { label:'Best Match',   key:'maxPins',      fmt:v=>v,             higher:true },
    { label:'Matches',      key:'count',        fmt:v=>v,             higher:true },
    { label:'AWP Rate',     key:'awpPct',       fmt:v=>v.toFixed(0)+'%', higher:true },
    { label:'Fail Rate',    key:'failPct',      fmt:v=>v.toFixed(0)+'%', higher:false },
    { label:'Consistency',  key:'consistency',  fmt:v=>v!==null?(v*100).toFixed(0)+'%':'—', higher:true },
    { label:'TrueSkill Rank',key:'tsRank',      fmt:v=>v?'#'+Math.round(v):'—', higher:false },
    { label:'TrueSkill Score',key:'tsScore',    fmt:v=>v?v.toFixed(1):'—', higher:true },
    { label:'OPR',          key:'opr',          fmt:v=>v?v.toFixed(1):'—', higher:true },
  ];

  const colors = ['var(--blue)','var(--red)','var(--green)','var(--amber)'];

  let html = '<table class="cmp-table"><thead><tr>';
  html += '<th>Metric</th>';
  stats.forEach((s,i) => {
    html += `<th class="cmp-team-head" style="color:${colors[i]}">${s.team}</th>`;
  });
  html += '</tr></thead><tbody>';

  metrics.forEach(m => {
    const vals = stats.map(s => s[m.key]);
    const numVals = vals.map(v => typeof v === 'number' ? v : null).filter(v=>v!==null);
    const best = numVals.length ? (m.higher ? Math.max(...numVals) : Math.min(...numVals)) : null;
    const worst = numVals.length ? (m.higher ? Math.min(...numVals) : Math.max(...numVals)) : null;

    html += `<tr><td style="color:var(--ink3);font-family:var(--mono)">${m.label}</td>`;
    vals.forEach((v, i) => {
      const displayVal = m.fmt(v !== null ? v : 0);
      const numV = typeof v === 'number' ? v : null;
      let cls = '';
      if (numV !== null && best !== null && numV === best && numVals.length > 1) cls = 'cmp-best';
      else if (numV !== null && worst !== null && numV === worst && numVals.length > 1) cls = 'cmp-worst';
      // Bar
      let barHtml = '';
      if (numV !== null && best && best > 0) {
        const pct = Math.min(100, (numV/best)*100);
        barHtml = `<div class="cmp-bar-wrap"><div class="cmp-bar-fill" style="width:${pct}%;background:${colors[i]}"></div></div>`;
      }
      html += `<td class="${cls}"><div class="cmp-bar-cell"><span>${displayVal}</span>${barHtml}</div></td>`;
    });
    html += '</tr>';
  });

  // Sparkline row
  html += `<tr><td style="color:var(--ink3);font-family:var(--mono)">Trend</td>`;
  stats.forEach((s,i) => {
    const canvas_id = 'cmp-spark-' + i;
    html += `<td><canvas id="${canvas_id}" width="100" height="24" style="display:block"></canvas></td>`;
  });
  html += '</tr>';

  html += '</tbody></table>';
  res.innerHTML = html;

  // Draw sparklines
  stats.forEach((s, i) => {
    const canvas = document.getElementById('cmp-spark-' + i);
    if (canvas && s.entries.length >= 2) {
      canvas.style.width = '100px';
      drawSparkline(canvas, s.entries.slice(-10));
    }
  });
}

function average(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function stdDev(arr) {
  const avg = average(arr);
  return Math.sqrt(arr.reduce((s,v)=>s+(v-avg)**2,0)/arr.length);
}

/* ─── 6. OPR/DPR in search profile (injected into pubResult rendering) ── */
// Hook into the existing renderTeamCard-style flow
// We patch the pubResult innerHTML by observing when team result appears
// (pubDoSearch is already patched above to call injectSearchExtras)

function injectSearchExtras() {
  const res = document.getElementById('pubResult');
  if (!res) return;
  const teamEl = res.querySelector('.tn');
  if (!teamEl) return;
  const team = teamEl.textContent.trim().toUpperCase();
  if (!team || !window.allEntries) return;

  // Add star button if not already there
  if (!res.querySelector('.star-btn')) {
    const stars = getStarred();
    const btn = document.createElement('button');
    btn.className = 'star-btn' + (stars.includes(team) ? ' starred' : '');
    btn.dataset.team = team;
    btn.title = 'Star this team';
    btn.textContent = '★ ' + (stars.includes(team) ? 'Starred' : 'Star team');
    btn.style.cssText = 'margin:6px 0;font-size:13px;padding:4px 12px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--paper3);font-family:var(--mono);cursor:pointer;display:flex;align-items:center;gap:4px';
    btn.onclick = function() { toggleStar(team); btn.textContent = '★ ' + (getStarred().includes(team) ? 'Starred' : 'Star team'); btn.classList.toggle('starred', getStarred().includes(team)); };
    teamEl.closest('.card') && teamEl.closest('.card').insertAdjacentElement('afterbegin', btn);
    if (!teamEl.closest('.card')) res.insertAdjacentElement('afterbegin', btn);
  }

  // Compute and inject OPR grid
  if (!res.querySelector('.opr-grid')) {
    const entries = allEntries.filter(e=>(e.team||'').toUpperCase()===team);
    if (entries.length) {
      const pinsArr = entries.map(e=>{ const p=(e.pins||'0+0').split('+'); return (parseInt(p[0])||0)+(parseInt(p[1])||0); });
      const avg = average(pinsArr).toFixed(1);
      const best = Math.max(...pinsArr);
      const consistency = pinsArr.length >= 2 ? (1 - stdDev(pinsArr)/Math.max(1,average(pinsArr)))*100 : null;
      const awpPct = (entries.filter(e=>e.awp==='Y').length/entries.length*100).toFixed(0);
      const div = document.createElement('div');
      div.className = 'opr-grid';
      div.innerHTML = `
        <div class="opr-card"><div class="opr-card-l">Avg Pins</div><div class="opr-card-v" style="color:var(--blue)">${avg}</div></div>
        <div class="opr-card"><div class="opr-card-l">Best Match</div><div class="opr-card-v" style="color:var(--green)">${best}</div></div>
        <div class="opr-card"><div class="opr-card-l">Consistency</div><div class="opr-card-v">${consistency!==null?consistency.toFixed(0)+'%':'—'}</div></div>
        <div class="opr-card"><div class="opr-card-l">AWP Rate</div><div class="opr-card-v">${awpPct}%</div></div>
        <div class="opr-card"><div class="opr-card-l">Matches</div><div class="opr-card-v">${entries.length}</div></div>
        <div class="opr-card"><div class="opr-card-l">Fail Rate</div><div class="opr-card-v" style="color:var(--red-text)">${(entries.filter(e=>e.failed==='Y').length/entries.length*100).toFixed(0)}%</div></div>`;

      // Trend chart
      const trendDiv = document.createElement('div');
      trendDiv.className = 'trend-section';
      const recent = [...entries].sort((a,b)=>(b.ts||b.created_at||'').localeCompare(a.ts||a.created_at||'')).slice(0,15).reverse();
      const recentPins = recent.map(e=>{ const p=(e.pins||'0+0').split('+'); return (parseInt(p[0])||0)+(parseInt(p[1])||0); });
      const trendCanvas = document.createElement('canvas');
      trendCanvas.width = 240; trendCanvas.height = 36;
      trendCanvas.style.cssText = 'display:block;width:100%;max-width:300px';
      const isUp = recentPins.length>=2 && recentPins[recentPins.length-1] >= recentPins[0];
      const trendLabel = recentPins.length<2 ? '' : isUp ? '📈 Trending up' : '📉 Trending down';
      trendDiv.innerHTML = `<div class="trend-section-hd">📊 Recent Performance Trend <span style="margin-left:4px;font-size:10px;color:${isUp?'var(--green)':'var(--red-text)'}">${trendLabel}</span></div>`;
      trendDiv.appendChild(trendCanvas);
      setTimeout(() => { if(recentPins.length>=2) drawSparkline(trendCanvas, recentPins); }, 50);

      // Inject after the first card or at the start of pubResult
      const firstCard = res.querySelector('.card') || res.querySelector('.sbox') || res.firstElementChild;
      if (firstCard) {
        firstCard.after(div);
        div.after(trendDiv);
      } else {
        res.appendChild(div);
        res.appendChild(trendDiv);
      }
      // Add compare button
      const cmpBtn = document.createElement('button');
      cmpBtn.className = 'cmp-trigger';
      cmpBtn.textContent = '⚖️ Compare';
      cmpBtn.onclick = () => { openCompareModal(); setTimeout(()=>{ const inp=document.getElementById('cmp-t1'); if(inp){inp.value=team;runCompare();} },50); };
      res.insertAdjacentElement('afterbegin', cmpBtn);
    }
  }
  shAddHistory(team);
}

/* ─── 7. PREDICTION ACCURACY TRACKER ────────────────────── */
const PRED_HIST_KEY = 'os_pred_history';
function getPredHistory() {
  try { return JSON.parse(localStorage.getItem(PRED_HIST_KEY)||'[]'); } catch(e){ return []; }
}
function logPrediction(redPct, winner) {
  const h = getPredHistory();
  h.unshift({ ts: new Date().toISOString(), redPct, winner, correct: null });
  try { localStorage.setItem(PRED_HIST_KEY, JSON.stringify(h.slice(0,50))); } catch(e) {}
  renderPredHistory();
  showToastNew('📊 Prediction logged');
}
function resolvePrediction(idx, actualWinner) {
  const h = getPredHistory();
  if (!h[idx]) return;
  const pred = h[idx].redPct > 50 ? 'red' : 'blue';
  h[idx].correct = (pred === actualWinner);
  h[idx].actual = actualWinner;
  try { localStorage.setItem(PRED_HIST_KEY, JSON.stringify(h)); } catch(e) {}
  renderPredHistory();
}
function renderPredHistory() {
  const modal = document.getElementById('pred-hist-modal-bg');
  const body = document.getElementById('pred-hist-body');
  if (!body) return;
  const h = getPredHistory();
  if (!h.length) { body.innerHTML = '<div style="font-size:12px;font-family:var(--mono);color:var(--ink3);text-align:center;padding:2rem">No predictions logged yet.</div>'; return; }
  const resolved = h.filter(p=>p.correct!==null);
  const accuracy = resolved.length ? (resolved.filter(p=>p.correct).length/resolved.length*100).toFixed(0) : null;
  body.innerHTML = (accuracy !== null ? `
    <div style="margin-bottom:1rem;padding:12px;background:var(--paper2);border-radius:var(--radius-lg);border:1px solid var(--border);text-align:center">
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Prediction Accuracy (${resolved.length} resolved)</div>
      <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:${accuracy>=60?'var(--green)':accuracy>=40?'var(--amber)':'var(--red-text)'}">${accuracy}%</div>
      <div class="ph-accuracy-bar"><div class="ph-accuracy-fill" style="width:${accuracy}%"></div></div>
    </div>` : '') +
  h.map((p,i) => {
    const date = new Date(p.ts).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const predicted = p.redPct > 50 ? 'Red' : 'Blue';
    const confidence = p.redPct > 50 ? p.redPct : (100-p.redPct);
    let status = '';
    if (p.correct === true) status = '<span class="ph-correct">✓ Correct</span>';
    else if (p.correct === false) status = '<span class="ph-wrong">✗ Wrong ('+p.actual+' won)</span>';
    else status = `<select onchange="resolvePrediction(${i},this.value)" style="font-size:10px;font-family:var(--mono);padding:2px 5px;border-radius:3px;border:1px solid var(--border2);background:var(--paper);color:var(--ink)">
      <option value="">Log result…</option><option value="red">Red won</option><option value="blue">Blue won</option><option value="tie">Tie</option></select>`;
    return `<div class="ph-row">
      <span style="color:var(--ink3)">${date}</span>
      <span>Pred: <strong style="color:${predicted==='Red'?'var(--red)':'var(--blue)'}">${predicted}</strong> @ ${confidence.toFixed(0)}%</span>
      <span>${status}</span>
    </div>`;
  }).join('');
}

// Inject "Log Prediction" button into the Win Probability outcome detail
const _origShowOutcomeDetail = window.showOutcomeDetail;
window.showOutcomeDetail = function(o, clickedSeg, allOutcomes) {
  if (typeof _origShowOutcomeDetail === 'function') _origShowOutcomeDetail.apply(this, arguments);
  setTimeout(() => {
    const det = document.getElementById('outcomeDetail');
    if (!det || !det.style.display || det.style.display === 'none') return;
    if (det.querySelector('.log-pred-btn')) return;
    const totalProb = allOutcomes.reduce((s,x)=>s+x.probability,0)||1;
    const redPct = allOutcomes.filter(x=>x.winner==='Red wins').reduce((s,x)=>s+x.probability,0)/totalProb*100;
    const btn = document.createElement('button');
    btn.className = 'log-pred-btn btn-sm';
    btn.textContent = '📊 Log Prediction';
    btn.style.cssText = 'margin-top:.75rem;display:block;width:100%';
    btn.onclick = () => { logPrediction(redPct, null); };
    det.appendChild(btn);
    const histBtn = document.createElement('button');
    histBtn.className = 'btn-sm';
    histBtn.textContent = 'View History';
    histBtn.style.cssText = 'margin-top:4px;display:block;width:100%;color:var(--ink3)';
    histBtn.onclick = () => { renderPredHistory(); document.getElementById('pred-hist-modal-bg').style.display='flex'; };
    det.appendChild(histBtn);
  }, 100);
};

/* ─── Init all features on DOMContentLoaded ──────────────── */
document.addEventListener('DOMContentLoaded', function() {
  renderStarredSection();
  renderPredHistory();
});


/* ── Side-by-side calculator mode ── */
function applyCalcSideBySide(on) {
  try { localStorage.setItem('os_calc_sidebyside', on ? '1' : '0'); } catch(e) {}
  document.body.classList.toggle('calc-sidebyside', !!on);
  const t = document.getElementById('sideBySideToggle');
  if (t) t.checked = !!on;
  // When enabling, ensure the auton calc panel is open — but only if we're on the predict tab
  if (on) {
    const predictActive = document.getElementById('tab-predict')?.classList.contains('active');
    if (predictActive) {
      const p = document.getElementById('auton-calc-panel');
      const btn = document.getElementById('auton-calc-toggle-btn');
      const chev = document.getElementById('auton-calc-chevron');
      if (p) p.style.display = 'block';
      if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.style.borderColor = 'var(--red)'; btn.style.color = 'var(--ink)'; }
      if (chev) chev.style.transform = 'rotate(180deg)';
    }
  }
}

/* ── Unified team persistence + cross-calculator sync ── */
const TEAM_SLOT_MAP = { r1:'em-r1', r2:'em-r2', b1:'em-b1', b2:'em-b2' };
const TEAM_SLOT_MAP_REV = { 'em-r1':'r1', 'em-r2':'r2', 'em-b1':'b1', 'em-b2':'b2' };

function saveAllTeams() {
  try {
    const teams = {};
    ['r1','r2','b1','b2'].forEach(id => {
      teams[id] = document.getElementById(id)?.value || '';
    });
    localStorage.setItem('os_em_teams', JSON.stringify(teams));
  } catch(e) {}
}

function emSaveTeams() { saveAllTeams(); }

function emRestoreTeams() {
  try {
    const raw = localStorage.getItem('os_em_teams');
    if (!raw) return;
    const teams = JSON.parse(raw);
    const get = id => teams[id] || teams['em-'+id] || '';
    ['r1','r2','b1','b2'].forEach(id => {
      const val = get(id);
      if (!val) return;
      const wpEl = document.getElementById(id);
      if (wpEl) { wpEl.value = val; autoFill(id); }
      const emEl = document.getElementById('em-'+id);
      if (emEl) { emEl.value = val; emAutoFill('em-'+id); }
    });
  } catch(e) {}
}

function syncTeamSlot(srcId) {
  const isEm = srcId.startsWith('em-');
  const wpId  = isEm ? TEAM_SLOT_MAP_REV[srcId] : srcId;
  const emId  = isEm ? srcId : TEAM_SLOT_MAP[srcId];
  const val   = document.getElementById(srcId)?.value || '';
  const otherId = isEm ? wpId : emId;
  const otherEl = document.getElementById(otherId);
  if (otherEl && otherEl.value !== val) {
    otherEl.value = val;
    if (isEm) { autoFill(wpId); updateTsBadges(); }
    else       { emAutoFill(emId); }
  }
  saveAllTeams();
}

/* ═══════════════════════════════════════════════════════
   🇮🇱  DONATION POPUP
════════════════════════════════════════════════════════ */
(function() {
  const messages = [
    { emoji:'🤖', text:'Bot Go Brrr needs fuel!',        sub:'Donate to keep Bot Go Brrr going brrr.' },
    { emoji:'🏆', text:'Want us to win?',                sub:'Donations help cover registration & parts.' },
    { emoji:'⚙️', text:'Enjoying Override Scout?',       sub:'Consider supporting team 97230F with a small donation!' },
    { emoji:'🚀', text:'Help us reach Worlds!',          sub:'Every dollar keeps the robot spinning.' },
    { emoji:'🔧', text:"Parts don't pay for themselves!", sub:'Support 97230F and help us go brrr.' },
  ];
  let msgIdx = 0;
  let donationInterval = null;

  function createPopup() {
    if (document.getElementById('il-donate')) return;

    const el = document.createElement('div');
    el.id = 'il-donate';
    el.innerHTML = `
      <div id="il-donate-inner">
        <button id="il-donate-close" onclick="document.getElementById('il-donate')?.classList.remove('il-donate-show')" title="Close">✕</button>
        <div id="il-donate-emoji"></div>
        <div id="il-donate-text"></div>
        <div id="il-donate-sub"></div>
        <a id="il-donate-btn" href="https://www.gofundme.com/f/help-highvale-go-to-vex-worlds" target="_blank" rel="noopener">💚 Donate on GoFundMe</a>
      </div>`;
    document.body.appendChild(el);
  }

  function showDonation() {
    createPopup();
    const m = messages[msgIdx % messages.length];
    msgIdx++;
    document.getElementById('il-donate-emoji').textContent = m.emoji;
    document.getElementById('il-donate-text').textContent  = m.text;
    document.getElementById('il-donate-sub').textContent   = m.sub;
    const el = document.getElementById('il-donate');
    el.classList.remove('il-donate-show');
    void el.offsetWidth; // force reflow for re-animation
    el.classList.add('il-donate-show');
    // Auto-hide after 8s
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove('il-donate-show'), 8000);
  }

  // Donation popup is triggered after launchApp via window._startDonation()
  window._startDonation = function() {
    if (typeof isAdmin !== 'undefined' && isAdmin) return;
    if (donationInterval) return; // already running
    setTimeout(() => {
      showDonation();
      donationInterval = setInterval(showDonation, 30000);
    }, 5000);
  };
  if (document.getElementById('appShell')?.style.display !== 'none') {
    window._startDonation();
  }
})();

