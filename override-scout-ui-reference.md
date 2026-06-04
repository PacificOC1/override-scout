# Override Scout — UI & Colour Reference
> V5RC 2026-27 · Team 97230F Bot Go Brrr

---

## Colour Palette

### Dark Mode (Default)

| Token | Value | Usage |
|---|---|---|
| `--ink` | `#e8e6e0` | Primary text |
| `--ink2` | `#a8a49c` | Secondary text |
| `--ink3` | `#5c5852` | Muted / label text |
| `--paper` | `#111210` | Page background |
| `--paper2` | `#191916` | Section backgrounds, header strips |
| `--paper3` | `#232320` | Hover states, subtle fills |
| `--surface` | `#1e1d1a` | Card / widget surfaces |
| `--surface2` | `#272522` | Elevated surface (hover cards) |
| `--border` | `#2e2c28` | Default borders |
| `--border2` | `#3a3834` | Stronger borders |

### Light Mode (`html.light`)

| Token | Value | Usage |
|---|---|---|
| `--ink` | `#1a1917` | Primary text |
| `--ink2` | `#4a4844` | Secondary text |
| `--ink3` | `#8a8680` | Muted text |
| `--paper` | `#f5f4f0` | Page background |
| `--paper2` | `#eceae5` | Section backgrounds |
| `--paper3` | `#e2e0da` | Hover states |
| `--surface` | `#ffffff` | Card surfaces |
| `--surface2` | `#f0eeea` | Elevated surfaces |
| `--border` | `#d4d1cb` | Default borders |
| `--border2` | `#c4c1bb` | Stronger borders |

### Accent Colours

| Token | Hex | Background Token | Dim Token |
|---|---|---|---|
| `--red` | `#f40219` | `rgba(244,2,25,.12)` | `#c40118` |
| `--blue` | `#3d8ef0` | `rgba(61,142,240,.12)` | `#2a6bc4` |
| `--green` | `#3dbd6e` | `rgba(61,189,110,.12)` | `#2a8f50` |
| `--amber` | `#f0c030` | `rgba(240,192,48,.12)` | `#c09820` |
| `--volt` | `#c8ff00` | `rgba(200,255,0,.08)` | — |

> **Note:** The `--red` hex was updated from `#cc3d14` to `#f40219` in the live codebase. The dim token `--red-dim` is `#c40118`.

**Light mode overrides for accents:**
- `--red-text` → `#d40016`
- All `-bg` tokens use slightly reduced opacity (`.10` instead of `.12`)

---

## Glow Effects

| Token | Value |
|---|---|
| `--glow-red` | `0 0 12px rgba(244,2,25,.25)` |
| `--glow-blue` | `0 0 12px rgba(61,142,240,.25)` |

---

## Typography

### Font Families

| Token | Stack |
|---|---|
| `--mono` | `'JetBrains Mono'`, Cascadia Code, Fira Code, Courier New, monospace |
| `--display` | `'Exo 2'`, -apple-system, BlinkMacSystemFont, sans-serif |
| `--sans` | `'Exo 2'`, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif |
| `--barlow` | `'Barlow Condensed'`, -apple-system, BlinkMacSystemFont, sans-serif |

### Google Fonts Loaded
- **Barlow Condensed** — weights 400, 600, 700, 800
- **Exo 2** — weights 400, 600, 700, 800, 900 (including italic 700)
- **JetBrains Mono** — weights 400, 500, 600, 700

### Typographic Roles

| Role | Font | Weight | Size | Notes |
|---|---|---|---|---|
| Page headline | `--barlow` | 800 | `clamp(28px, 6vw, 52px)` | Uppercase, letter-spacing 1.5px |
| Section / modal title | `--barlow` | 800 | 22–28px | Uppercase |
| Team number display | `--barlow` | 800 | `clamp(40px, 8vw, 72px)` | Uppercase |
| Stat value | `--mono` | 800 | 22–26px | — |
| Body / labels | `--sans` / `--display` | 600–700 | 13px | — |
| Mono labels & hints | `--mono` | 400–600 | 9–11px | Uppercase, letter-spacing |
| CTA buttons | `--display` | 800 | 11px | Uppercase, letter-spacing 1.2–1.5px |

---

## Border Radius

| Token | Value |
|---|---|
| `--radius` | `5px` |
| `--radius-lg` | `8px` |

---

## Background

The page body uses subtle radial gradient glows in both modes:

**Dark:** `rgba(255,77,26,.04)` top-left, `rgba(61,142,240,.04)` bottom-right  
**Light:** `rgba(244,2,25,.035)` top-left, `rgba(61,142,240,.035)` bottom-right

> **Note:** Light mode glows use the updated red value `rgba(244,2,25,…)` not the older `rgba(255,77,26,…)`.

---

## Layout

### Sidebar

- **Width (collapsed):** 52px (icon-only rail)
- **Width (expanded):** 200px with sliding labels
- **Height:** 100vh, sticky on desktop
- **Mobile:** collapses to a horizontal top bar
- **Active indicator:** 3px left-border strip in `--red` (or `--blue` for team nav)
- **Brand logo block:** 36×36px, `--red` background (or `--blue` in team mode), `--barlow` 800

### Main Content (`#appShell`)

- `flex: 1`, `overflow-y: scroll`
- `scrollbar-gutter: stable`

### Responsive Breakpoints

| Breakpoint | Behaviour |
|---|---|
| `≤ 768px` | Sidebar becomes horizontal top bar; flex-direction column |
| `≤ 700px` | Settings grid collapses to single column |
| `≤ 900px` | Calculator side-by-side mode stacks vertically |

---

## Components

### Buttons

#### Primary (`.btn-p`)
- Background: `--red`
- Text: `#fff`, uppercase, `--display` 800, letter-spacing 1.5px
- Hover: `--red-dim`, slight upward translate, `--glow-red`

#### Secondary (`.btn`)
- Background: transparent
- Border: `--border2`
- Text: `--ink3`, `--mono`

#### Danger (`.btn-d`)
- Styled with red tones for destructive actions

#### Blue Submit (`.btn-signup-submit`)
- Background: `--blue`
- Hover: `--blue-dim`, `--glow-blue`

#### Small Variant (`.btn-sm`)
- Reduced padding; same colour rules

---

### Toggle Switch

- Track: `--border2` background (off) → `--blue` (on)
- Thumb: white circle, `box-shadow: 0 1px 3px rgba(0,0,0,.3)`
- Animation: `cubic-bezier(.34,1.56,.64,1)` spring

---

### Cards & Surfaces

#### Feature Card (`.intro-feat-card`)
- Background: `--surface`, border: `--border`, radius: `--radius-lg`
- Top accent strip: 2px, colour set via `--feat-accent` (defaults to `--red`)
- Hover: `--surface2`, border `--border2`, slight upward translate

#### Settings Section (`.settings-section`)
- Background: `--surface`, border: `--border`, radius: `--radius-lg`
- Section header: `--paper2` background with bottom border

#### Settings Row (`.settings-row`)
- Hover: `--paper3`
- Danger row hover: `--red-bg` background, label in `--red-text`

#### Leaderboard Table (`.lb-wrap`)
- Surface: `--surface`, border: `--border`, radius: `--radius-lg`
- Header: `--paper2`, text `--ink3` 10px mono uppercase
- Sorted column highlight: `--amber`
- "Me" row: `rgba(255,210,0,.06)` + `--amber` left border
- "Rival" row: `rgba(255,77,26,.05)` + `--red` left border

#### Stat Card (`.team-stat-card`)
- Background: `--surface`, border: `--border`
- Top accent strip: 2px in `--blue` at 50% opacity

---

### Modals

All modals share:
- Backdrop: `rgba(0,0,0,.75)` + `backdrop-filter: blur(6px)` (dark) / `rgba(100,95,88,.45)` + `blur(4px)` (light)
- Surface: `--surface`, border: `--border2`, radius: `--radius-lg`
- Entry animation: `modalIn` — scale from .95 + translateY(8px), `cubic-bezier(.34,1.56,.64,1)`
- Close button: `--paper3` bg, hover → `--red-bg`

**Login modal** — red glow (`--glow-red`), input focus ring `rgba(244,2,25,.2)`  
**Signup modal** — blue glow (`--glow-blue`), top gradient strip `--blue → --red`, input focus `rgba(61,142,240,.2)`  
**Pit / Alliance modals** — same base styles; tabbed body

> **Note:** Light mode modal backdrops use `rgba(100,95,88,.45)` + `blur(4px)` instead of the dark mode values.

---

### Form Inputs

- Background: `--paper`, border: `--border2`, radius: `--radius`
- Font: `--mono`, 13px, colour: `--ink`
- Focus: border `--red` (login) or `--blue` (signup/general), `box-shadow: 0 0 0 2px` with matching rgba

### Labels (form)

- 10px, `--mono`, `--ink3`, uppercase, letter-spacing .6px

---

### Badges & Tags

| Type | Background | Border | Text colour |
|---|---|---|---|
| AWP badge | `rgba(61,189,110,.15)` | `rgba(61,189,110,.3)` | `--green` |
| Sig badge | `rgba(61,142,240,.12)` | `rgba(61,142,240,.25)` | `--blue` |
| Team badge (intro) | `--blue-bg` | `rgba(61,142,240,.3)` | `--blue` |
| Team user label | `--blue-bg` | `rgba(61,142,240,.3)` | `--blue` |
| Team mode indicator | `--blue-bg` | `rgba(61,142,240,.3)` | `--blue` |

---

### Notification / Donation Popup

- Fixed position: bottom-right (`bottom: 90px`, `right: 18px`)
- Background: `--paper2`, border: `--border2`, radius: `--radius-lg`
- Width: 230px
- Top accent strip: 5px gradient `--red → --blue → --red`
- Box shadow: `0 8px 28px rgba(0,0,0,.4)`
- Entry: `translateY(20px)` → `translateY(0)`, spring easing
- Donate button hover: `background: #002a90` (blue), `box-shadow: 0 4px 12px rgba(0,56,184,.3)`

---

### Scrollbar (Webkit)

- Track: `--paper2`
- Thumb (default): linear-gradient `#e84020 → #8b1a0a`
- Thumb (hover): `#ff5533 → #aa2510`
- Thumb (active): `#ff6644 → #cc3311`
- Firefox: `scrollbar-color: #5c0000 var(--paper2)`, `scrollbar-width: thin`

---

### Sidebar Tooltip

- Background: `--paper3`, border: `--border2`, colour: `--ink`
- Font: 11px `--mono`, radius: 5px
- Shown on hover (desktop only; hidden at ≤768px)

---

### Sidebar Auth Block

- Collapsed slot: 44px fixed height (prevents nav shift)
- Expanded: `max-height: 140px`, floats over rail with `box-shadow: 0 8px 24px rgba(0,0,0,.35)`
- Background: `--paper2`, border: `--border`, radius: `--radius`
- Transition: `max-height .3s linear`, `opacity .22s linear`

---

## Intro / Hero Section

- Background: `linear-gradient(160deg, --paper2 0%, --paper 55%)`
- Grid overlay: repeating lines in `rgba(244,2,25,.13)` (light) / similar dark variant
- Decorative glows: `rgba(204,61,20,.18)` top-left, `rgba(61,142,240,.12)` bottom-right
- Logo block: 72×72px, radius 18px, `--red` background, `--glow-red` shadow; animated `logoPulse` / `logoPulseLight`
- Headline: `--barlow` 800, uppercase, `clamp(28px, 6vw, 52px)`; accent word in `--red`
- Subheadline: 12px `--mono`, `--ink3`, uppercase, letter-spacing 1.5px
- Stats strip: `--surface` background, `--border` between cells, `--barlow` 800 26px values
- Hero animations pause via IntersectionObserver when scrolled off-screen (saves GPU)

---

## Team Hero Section

- Background: `linear-gradient(160deg, rgba(61,142,240,.08) 0%, --paper 60%)`
- Team number: `--barlow` 800, `clamp(40px, 8vw, 72px)`, `--blue`, `text-shadow: 0 0 40px rgba(61,142,240,.3)`

---

*Generated from `index.html` — Override Scout V5RC 2026-27*  
*Last updated to reflect live `index.html` values (red accent corrected to `#f40219`).*