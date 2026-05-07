# Override Scout 🤖

**V5RC 2026–27 Scouting & Match Prediction Tool**  
*Developed by Team 97230F — Bot Go Brrr*

A single-file web app for VEX V5 Robotics Competition teams. Log autonomous performance data, analyse team stats, predict match outcomes, and manage signature event schedules — all from one page, backed by a live Supabase database.

---

## Features

### 📋 Scouting Database
- Log autonomous runs for any team: route taken, G1/G2 pins scored, AWP achieved, failure status, and free-text notes
- Supports **Normal** and **⚡ SAWP** auton modes (SAWP mode adds own-quadrant and teammate-quadrant pin inputs)
- Search any team to view their full scouting history and summary stats
- Leaderboard of all scouted teams ranked by average pins, filterable by event period, AWP, or top pins
- Delete individual entries from the scout log; paginated view (10 entries per page)
- CSV export and import for data backup and sharing between devices

### 📊 Win Probability Calculator
- Enter up to 4 robots (2 Red, 2 Blue) with average pin counts, failure rate, and AWP contribution rate
- Calculates all **16 possible robot success/failure combinations** and their probabilities
- Displays a colour-coded segmented bar — red = Red wins, blue = Blue wins, amber = tie
- Hover a segment to see the outcome and probability; click to open the full detail panel
- The most likely outcome is auto-opened on load and marked with a ⭐

### 🔍 Outcome Detail Panel
- Side-by-side Red and Blue alliance stat columns
- Per-robot breakdown: G1 pins, G2 pins, fail rate, AWP contribution
- Final scores, pin points, AWP probability, and auto bonus breakdown
- Winning alliance displays **WIN 👑**; ties show **TIE**
- ← → arrow navigation to step through all 16 scenarios in probability order or bar order

### 🗓️ Events / Sig Calendar
- List upcoming, live, and past Signature events with dates and location
- Filter the leaderboard to only teams scouted within an event's date range
- Admins can add events manually or sync directly from the **RobotEvents API** (paste your Bearer token, preview results, and import selected events)
- Events include optional Google Maps links (shown as **📍 View on Google Maps** for all users)

### 🗺️ Routes Reference
- Named route library with notation guide (e.g. `g1`, `g2`, `mp`, `up`, `lp`, `uc`)
- AWP criteria reference for the 2026–27 season
- Auto bonus and Signature event rule notes

### 📐 Formulas Reference
Quick reference for all scoring and probability formulas used in the Win Probability calculator:

```
Alliance Score  = (T1_G1 + T1_G2 + T2_G1 + T2_G2) × 5
Consistency     = (1 - T1_FailRate + 1 - T2_FailRate) / 2
Expected Pts    = Alliance Score × Consistency
Auto Bonus      = +12 pts to higher-scoring alliance (or +6 each if tied, per SC7)
AWP Probability = R1_awp × R2_awp × Consistency × 100
```

---

## Access Levels

| Feature | Public | Admin |
|---|:---:|:---:|
| Leaderboard | ✅ | ✅ |
| Search | ✅ | ✅ |
| Events list + filter leaderboard | ✅ | ✅ |
| Routes reference | ✅ | ✅ |
| About | ✅ | ✅ |
| Add / delete scouting entries | ❌ | ✅ |
| Scout log + CSV export/import | ❌ | ✅ |
| Win Probability calculator | ❌ | ✅ |
| Add / delete events | ❌ | ✅ |
| RobotEvents API sync | ❌ | ✅ |
| Formulas reference | ❌ | ✅ |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript — zero frameworks, single file |
| Database | [Supabase](https://supabase.com) (PostgreSQL + REST API) |
| Auth | Supabase Auth (JWT) |
| Hosting | Any static host — no build step required |

---

## Setup

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com) and create a new project.

### 2. Create the required tables

Run the following in your Supabase **SQL Editor**:

```sql
-- Scouting entries table
create table if not exists entries (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now()
  -- add your own columns here
);

-- Robot types table
create table if not exists robot_types (
  id   serial primary key,
  name text not null unique
);

alter table robot_types enable row level security;
create policy "public read"  on robot_types for select using (true);
create policy "admin insert" on robot_types for insert with check (auth.role() = 'authenticated');

insert into robot_types (name) values ('Claw Bot') on conflict do nothing;

-- Signature events table
create table if not exists sig_events (
  id         serial primary key,
  start_date date
  -- add event fields as needed
);
```

### 3. Add your Supabase credentials

Open `index.html` and update the config at the top of the `<script>` block:

```js
const SB_URL = 'https://your-project-id.supabase.co';
const SB_KEY = 'your-anon-key-here';
```

Find these in: **Supabase Dashboard → Project Settings → API**

> **Note on key types:**  
> If you're using the newer `sb_publishable_...` key, you **must** add your site's domain to the allowlist under **Project Settings → API → Publishable key allowlist**. Without this, all API requests will be blocked and the page will appear blank.

### 4. Create an admin user

Go to **Supabase Dashboard → Authentication → Users** and create an account. Use these credentials to log in via the admin panel in the app sidebar.

### 5. Deploy

Since everything is a single `index.html` file, you can host it anywhere:

- **GitHub Pages** — push to a repo and enable Pages in Settings
- **Netlify / Vercel** — drag and drop the file
- **Locally** — open directly in a browser (add `localhost` to your Supabase allowlist if using a publishable key)

---

## Usage

### Logging a Scout Entry
1. Log in as admin, then go to **Add Entry**
2. Enter team number, match identifier, auton type (Normal or SAWP), route, pins per goal, AWP status, and failure status
3. Click **Save Entry** — it appears immediately in the Scout Log and leaderboard

### Running a Match Prediction
1. Go to **Win Probability**
2. Enter team numbers for each robot — stats auto-fill from the database if the team has been scouted
3. Adjust pin averages, failure rate, and AWP contribution as needed
4. Click any segment on the outcome bar to view that scenario's full breakdown
5. Use the ← → arrows to step through all 16 scenarios

### Importing Events from RobotEvents
1. Go to **Events** (admin)
2. Click **Sync from RobotEvents** and paste your Bearer token
3. Select which events to import and click **Import selected**

### Exporting / Importing Scout Data
- Go to **Scout Log**
- Use **Export CSV** to download all entries
- Use **Import CSV** to bulk-load a previously exported file

---

## Data Notes

- Pin data is stored as a `+`-delimited string (e.g. `3+2` = G1+G2; SAWP entries use 4 values)
- The `failed` field (Y/N) was added in a recent update — older entries will not contribute to the Success % calculation
- All writes require admin authentication; the public anon Supabase key is read-only by default
- The RobotEvents API token and admin credentials are never stored in the database
- AWP significance criteria tightens on **September 3, 2026** per game rules (SC7)

---

## Project Structure

```
index.html   ← the entire app (HTML + CSS + JS, single file)
README.md    ← this file
```

---

## Team

**97230F — Bot Go Brrr**  
V5RC 2026–27  
Find us [@97230f](https://instagram.com/97230f) on Instagram.
