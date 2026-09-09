# Ghostwall — Dev Log

Reference doc for what's been built, how it works, and the decisions we've taken along the way. Keep this updated as we go.

- **Repo:** https://github.com/PriyeshPandey2000/ghostwall
- **Live:** https://ghostwall-two.vercel.app
- **Stack:** Vite + TypeScript + Konva.js + perfect-freehand. No backend. No DB. No auth.

---

## Product

**Ghostwall** (was "The Internet Wall") is an infinite canvas people can leave marks on: draw, write, erase, drop stickers/text/images, hide secrets, bury time capsules, and draw over each other's creations. Everything fades after 24 hours unless kept. No accounts, no payments, no moderation infra — persistence is in-memory with localStorage as optional convenience.

### The core loop we're optimizing (why we build this)
```
Enter wall
  → See something interesting
  → Explore
  → Draw something
  → Interact with someone else's thing
  → Come back later
  → See things changed / faded
```

The question V1/V1.1 is trying to answer: **"Is there a reason to open Ghostwall again tomorrow?"** We validate the *behavior* on a local/fake wall before adding any real multiplayer layer. If people don't instinctively press Random / draw a second thing / modify someone else's drawing / come back, a backend won't save it.

---

## Current version: V1.2 — "Place, not an editor"

User feedback drive (V1.2).Reduce the tool feeling → the wall should feel like a place you draw on, not an editor. Everything else (auth, backend, payments, profiles, comments, marketplace, more tools) stays deferred. The real validation is now 5–10 people using it unassisted and watching the five signals — especially "do they come back?".

### V1.2 work log

#### Toolbar: Draw · Text · Erase · React, everything else under More
- Primary toolbar is now **Draw · Text · Erase · React**. Select moved into **More** ("Select & pan") so the first screen has zero editor chrome.
- Default active tool is **Draw** (was Select). One-time hint pill "✏️ Draw anywhere" (marker `thewall_draw_hint`) auto-dismisses after 4s and disappears forever on first dismissal or first mark.
- New `react` tool + `getTool()` on the engine; cursors per tool (`getCursorForTool`).

#### Popup redesign: content first, then actions, metadata demoted
- New `.oi-*` popup: author → artwork preview (`node.toDataURL({pixelRatio:2})`) → reaction row → primary actions (**Draw over it**, **Share**) → muted meta line with a **live countdown** ("18h 22m left" → "fading away" → "Gone." via `formatTimeLeft`, ticking every 1s).
- Secret objects get their own reveal flow instead of the generic popup.
- **Bug found & fixed (real):** popups opened for marks near the screen bottom rendered off-viewport (the "Draw over it" button sat below the fold). The positioning code clamped with a fixed constant (`innerHeight - 260`) instead of measuring the popup. Now the popup is appended, measured, placed **above** the mark, falling back **below** it, then clamped so the whole card (all buttons) stays reachable. Preview `max-height` also trimmed 180→130px.

#### Discover: prominent 🎲 FAB + event-style reveal
- `#btn-random` was removed from the top bar; a prominent gradient **🎲 Find something weird** FAB lives bottom-right (label hides on mobile) and calls the same `doWeirdDiscovery()`.
- Reveal copy reads like an event: **"You found this."** → "Left 1d ago by @luna" → content + stats → **Go there / Keep wandering**. `.dr-eyebrow` + `fadeUp` entry.

#### Reactions: quick palette on the mark
- In React mode, clicking a mark pops a compact emoji palette pinned to it (`.quick-react`); picking one persists the reaction and shows a toast. Empty-space click (deselect) closes it.
- **Investigation flap:** the reaction appeared to vanish from storage. False alarm — the seeds include several `sticker`-type objects, and tests queried `.find(o => o.type === 'sticker')` (the *first* sticker = a seed) while the placed sticker is appended last. The write was always correct.

#### Seeds: curated cast (marker `thewall_seed_v2`)
- Rewrote seed.ts into 33 memorable pieces with narrative characters: the **robin/theo/mia** face trio, the **aster/comet/century** spectacle, **milo×2** (🚀 rocket + "this corner is mine now 🚧" text, cross-modified by `moss`), **ghost×2** (twisted spire + fading 🕸️ trace), a **404** locked mystery far off near (±9800), plus a second neighborhood (pixel, orbit time capsule, sprout, ghost2 web) and loners (ancient + fourohfour).
- Placements keyed by unique `key` (author can repeat). Migration: if `thewall_seeded_v1` is present the store is wiped before re-seeding (pre-launch clean slate; seeds and user marks are indistinguishable once written).

#### Ghost lifecycle: fade → ghost → Gone
- New `ghostUntil` field + `GHOST_MS` (24h). Fade phases via `fadeOpacity`: solid 1→0.55 across a mark's life, then ghost 0.55→0.05 until `ghostUntil`; `animateExpiredObjects` (3s tick) destroys and persists removal once past `ghostUntil`.
- User-created marks get `ghostUntil = expiresAt + GHOST_MS` on every creation site (stroke, shape, text, sticker, secret, image). **Seeds get no `ghostUntil`** — they linger as faint fossil traces at 0.1 forever, so an empty wall is never truly empty (archaeology, not dead pixels).
- Verified: a synthetic mark past `ghostUntil` is removed within one tick; a mark inside its ghost window survives and keeps fading.

#### V1.2 verification (Playwright, fresh localStorage, zero console errors)
- ✅ Toolbar = 4 primary (draw/text/erase/react) + 7 more, starts in Draw, FAB present.
- ✅ Draw-mode click opens redesigned popup (preview img, author, 6 reactions, Draw-over + Share actions, live "23h 59m left · just now" meta) **and the card fits the viewport**.
- ✅ Share copies `#/w?id=<id>`.
- ✅ Draw over it → tool switches to Draw + `modifiedBy` recorded.
- ✅ React palette (6 emoji) → click persists reaction on the placed object, palette closes, empty-click deselect closes it.
- ✅ 🎲 FAB → "You found this. | a secret 🤫 | Left 1d ago by @luna" → overlay closes.
- ✅ Seed cast: 33 pieces, milo×2 / ghost×2 / 404×1 / robin×1, spread to ±9800.

---

## V1.1 — "The Living Wall" (shipped, commit 8b4b2f1)

Goals (in priority order):
1. Enter immediately
2. Explore interesting existing content
3. Create something in < 10 seconds
4. Modify someone else's creation
5. Discover random/weird areas
6. Watch things fade
7. Share a specific creation

### V1.1 work log

#### Toolbar simplification — 12 tools → 4 primary + "More"
- Primary toolbar now: **Select · Draw · Erase · Text · Sticker**
- Experimental/extra tools (**Rectangle, Circle, Image, Secret, Time capsule**) hidden under a **➕ More** submenu.
- `PRIMARY_TOOLS` / `MORE_TOOLS` arrays in `src/wall.ts`; `.more-tools-panel` CSS in `src/style.css`.
- Rationale: 12 tools was too much for a first experience; the wall should be instantly understandable.

#### Discovery reveal ("Take me somewhere weird")
- The 🎲 button and panel's "random"/"weird" actions now call `doWeirdDiscovery()`.
- It scores marks as "interesting" (secrets/time capsules/locked pieces score highest; permanents, stickers, things with reactions/modifications rank next) and jumps the camera to the best find at zoom 1.3.
- Shows a `.discovery-reveal` card: *"📍 You found something left 19h ago"*, the object's content/author, and stats like *"↑ modified by 5 people"* + reaction counts, with **Go there** (selects it, opens info popup) / **Keep wandering** (immediate next find).
- New public engine method `selectObjectId(id)` (selects + surfaces via `onObjectSelected`).

#### Living wall seeding
- Added interaction signs to seeded pieces: `modifiedBy` arrays (e.g. the smiley-face draw-over centerpiece is "modified by 5 people") and pre-seeded `reactions`.
- More size variety (tiny 10px `rio` piece → 30px `century` piece, 56px sticker).
- Faded/decayed marks (23-26 days old).
- Spectacular pieces: golden starfield stroke (`aster`, permanent), comet trail (`comet`), "seen by 1,000 eyes".
- **Refactor:** placements are now keyed by *unique author* (`place('robin', 0, 0)`) instead of fragile array indices, so reordering/new seeds never break the layout. Every seeded author must be unique (we renamed a piece's author to `century` to avoid a duplicate `echo`).

#### Onboarding overlay
- First visit shows a one-time modal: *"Welcome to Ghostwall. Everything you leave here fades after 24 hours…"* + **Start exploring** button. Marker `thewall_seen_intro`; no overlay on subsequent visits.

#### Share link
- Object info popup has a **🔗 share** button that copies `location.origin + pathname + #/w?id=<objectId>` via clipboard API (prompt fallback). Local-only: opens the object if it exists on this device.

#### Storage reframe (in-memory-first)
- `src/storage.ts` rewritten: removed the `StorageBackend` interface + `backend` export; now exposes a `localStore` object + convenience helpers (`loadObjects`/`saveObjects`/`addObject`/`updateObject`/`removeObject`, profile+viewport load/save). Persistence is explicitly "optional convenience" — the wall must work in private mode / after quota issues.

#### Default camera centers the cluster
- First-time viewport is now the stage centered on the world origin (`stage.position = width/2, height/2`) instead of `(0,0)`, so visitors land in the middle of the lived-in cluster (smiley draw-over ~0,0) rather than an empty corner.

#### V1.1 verification (Playwright, fresh localStorage)
- ✅ Select seeded object by direct click → full info popup (author, "3d ago", kept-forever "∞", "modified by 3 people", reactions, 🔗).
- ✅ Share button copies correct `#/w?id=<id>` link.
- ✅ Draw (10→11 strokes); toolbar (5 primary + 5 more, panel hidden); discovery reveal "You found something left 1d/6d ago" → Go there opens popup; zero console errors.

#### Investigation flap worth remembering
- Symptom: "clicking a seeded object never opens the popup." **Not a regression.** Three compounding false leads: (1) the default camera put the seed cluster in the top-left corner, so probing screen-center hit empty grid; (2) perfect-freehand strokes are *thin bands*, not solid shapes — the smiley face's bounding box is mostly empty fill, so clicks inside its bbox missed it; (3) a temporary debug `console.log` calling `e.target.className()` (a property, not a method in Konva 10) threw on every mousedown and masked event handling entirely. Real, useful fix that fell out: the default-camera-centering above.
- Takeaway for future tests: never guess where seeds render — hit-test Konva (`stage.getIntersection`) or probe a real pixel before asserting click behavior.

---

## Version history & decisions

### V1 (shipped) — The Internet Wall
- Landing page + infinite canvas (Konva) + full toolbar + info popups + discovery/profile panels + reactions + comments + secrets + time capsules + seeded content.
- **Deployed:** pushed to GitHub master, connected to Vercel (auto-deploy on push), live alias `ghostwall-two.vercel.app`.

#### Locked-in product decisions (V1)
- **No monetization** — removed all pricing/₹/payment code and UI.
- **localStorage-only persistence** behind a `StorageBackend` interface for a future cloud swap.
- **24h fade** — objects are solid until the last ~20% of life then ease to 0.35 opacity; expired objects animate out every 3s.
- **"Keep forever" is flavor only** — seeded permanent items exist, no purchase button.
- **Seed marker** `thewall_seeded_v1` lays 31 pieces once.
- **Base default** for users: every visitor gets a random username + avatar (🦊 etc.), stored locally.

#### Bugs found & fixed
- **Text/secret overlay auto-closed instantly on click.** Root cause: browser moves focus away from the freshly-created textarea right after `mousedown`, firing `blur` → `commit()` with empty text → overlay removed. Fix: `e.evt.preventDefault()` on `mousedown` for text/secret tools (`src/canvas.ts` `handlePointerDown`).
- **Canvas wasn't draggable.** Stage was never set `draggable`. Fix: stage is draggable in Select mode (grab/grabbing cursor, live grid redraw, viewport persists via `dragend`); disabled for all drawing/placement tools so they don't pan while drawing. Verified: empty-drag pans, draw tool doesn't pan, single click still selects.

#### Verification approach
- Playwright scripts (`verify*.mjs`, temp) drive the real dev server: landing renders, 31+ seeded objects, draw/text/secret/sticker/shape placement, info popup (expiry timer + reactions + draw-over), random teleport, profile panel, zero console errors. Mobile viewport (390×844, touch) verified.
- The collaborative-browser preview (`t3-code_preview_*`) was flaky/unavailable at times; Playwright-from-terminal became the reliable path.

---

## Architecture notes (so future-us doesn't have to re-derive it)

### Files
| File | Role |
|---|---|
| `src/main.ts` | Hash router: `#/wall`, `#/w?id=<objectId>`, `#/landing` (default) |
| `src/canvas.ts` | Konva engine: stage, layers, pan/zoom, tools, Transformer, undo/redo, grid, **ghost lifecycle** (`ghostUntil`, `fadeOpacity`, `animateExpiredObjects`), teleports, `drawRef` helpers |
| `src/wall.ts` | Wall page: toolbar (**Draw·Text·Erase·React** + More), top-bar, redesigned `.oi-*` popup, 🎲 discover FAB + reveal, **quick-react palette**, `maybeShowDrawHint`, profile panel, onboarding, share/copy-link |
| `src/seed.ts` | One-time seeded content (marker `thewall_seed_v2`, key-based `place()`, narrative cast) |
| `src/storage.ts` | In-memory-first persistence: `localStore` object + load/save helpers (localStorage optional) |
| `src/landing.ts` | Landing page |
| `src/types.ts` | `WallObject`, `UserProfile`, `DURATION_MS` (24h/7d) |
| `src/utils.ts` | id/time/format helpers |
| `src/style.css` | All styling (dark theme) |
| `devlog.md` | This doc |

### WallObject shape
```ts
{
  id, type ('stroke'|'text'|'shape'|'sticker'|'image'|'secret'|'timecapsule'),
  x, y, data, author, createdAt, expiresAt (null = forever),
  keptForever, reactions: [{emoji,user,count}], comments,
  parentId, modifiedBy: string[]
}
```

### Persistence philosophy (repeated per decision)
> V1 is **in-memory-first**. localStorage is an optional convenience so a user can refresh and keep their own local wall. The product must NOT depend on persistence working across devices/users. No accounts, no sync, no Supabase/Firebase. Backend work is deferred until the core loop is proven.

### Routing / share links
- `#/w?id=<id>` deep-links to an object: engine `teleportToObjectId(id)` centers + selects it when the object exists locally.
- `explore=true` param opens the discovery panel.
- True cross-device sharing is deferred (a link only works when the object is available locally).

---

## Explicitly deferred (do NOT build yet)
Supabase/Firebase, real-time WebSockets, authentication, profiles beyond a local username, payments, "keep forever" purchases, marketplace, complex comments, moderation infrastructure, notifications.

---

## Open / next steps
- [x] Onboarding overlay: "Welcome to Ghostwall. Everything you leave here fades after 24 hours…" + Start exploring (marker `thewall_seen_intro`)
- [x] Share link button in object info popup (copy `#/w?id=…`)
- [x] Storage reframe comment cleanup (in-memory-first language)
- [ ] Ship V1.2 live, then *actually use it for a few days* and watch for the signals (did I press Random? did I draw a second thing? did I modify someone's drawing? did I come back? did I want to send a link?)