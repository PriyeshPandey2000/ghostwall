# Ghostwall — Dev Log

Reference doc for what's been built, how it works, and the decisions we've taken along the way. Keep this updated as we go.

- **Repo:** https://github.com/PriyeshPandey2000/ghostwall
- **Live:** https://ghostwall-two.vercel.app
- **Stack:** Vite + TypeScript + Konva.js + perfect-freehand + **SpacetimeDB** (shared live backend, maincloud). No auth.

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

## Current version: V2 — SpacetimeDB backend (live, shared wall)

The wall stopped being single-browser/localStorage-only. There is now exactly **one shared database** — every visitor (dev or prod, local or deployed) reads and writes the same live wall.

### V2 work log

#### SpacetimeDB module + client wired end-to-end
- `spacetimedb/src/index.ts` — TypeScript server module: `canvasObject`, `reaction`, `comment`, `objectHistory`, `user` tables + reducers (`createObject`, `updateObject`, `deleteObject`, `drawOver`, `addReaction`, `removeReaction`, `addComment`, `setUsername`, `seedObjects`, `expireObject`). Was already written but sitting untracked/unpublished.
- Installed the `spacetime` CLI (official installer script), logged in with a real SpacetimeDB account (anonymous identity can connect/read but can't create a maincloud db), published the module as **`ghostwall`** on `maincloud` (dashboard: https://spacetimedb.com/ghostwall). Regenerated `src/module_bindings/` against the live schema.
- `src/spacetime.ts`'s `SpacetimeBackend` (implements the `StorageBackend` interface from `storage.ts`) existed fully coded but was never activated — `activeBackend` defaulted to `LocalStorageBackend` and nothing ever called `setBackend`/`createSpacetimeBackend`. Wired it in `main.ts`:
  ```ts
  const backend = createSpacetimeBackend('wss://maincloud.spacetimedb.com', 'ghostwall');
  setBackend(backend);
  backend.start();
  ```
- **Found a second orphaned piece**: `canvas.ts` had a fully-implemented `syncObjects(remote)` method (diffs remote object list against live Konva nodes, in-place update or re-render) that nothing called. `canvas.ts` only ever did `loadObjects()` once at construction — meaning even with the backend active, the canvas would've rendered empty forever (subscription data arrives async, after construction). Wired `wall.ts` to `subscribeObjects(objects => engine.syncObjects(objects))`.
- `seedWallIfNeeded()` (client-side, localStorage-only) is now gated behind `!isSpacetime()` — seeding for the shared wall happens server-side via `spacetime.ts`'s `maybeSeed()` → `seedObjects` reducer, once, the first time a client's subscriptions apply.
- **Verified round-trip independently of the client**: `spacetime sql ghostwall "SELECT count(*) AS n FROM canvas_object"` → 33 rows, matching what a fresh browser connection rendered via `syncObjects`.

#### Dev/prod database: intentionally shared (for now)
- Flagged that local dev and the deployed app point at the *same* `ghostwall` maincloud db — anything drawn while testing locally is real, public, and permanent (subject to the wall's own TTL/ghost rules). Offered to split into a local SpacetimeDB server for dev + maincloud for prod, or a second `ghostwall-dev` maincloud db.
- **Decision: leave it as-is.** Single-user testing right now, not worth the setup overhead yet. Revisit if/when more people start testing against it.
- Not yet done: connection-state UI (`connecting`/`disconnected`/`connected` — the backend already exposes `subscribeState` for this, nothing renders it).

#### Grid dots: added, tuned, then removed
- Tried replacing the grid-line background texture with a subtle dot grid (Figma/Excalidraw-editor feel → wanted something lighter, more "infinite space" than "document").
- First pass was invisible (opacity/radius tuned too subtle — verified via pixel-level canvas inspection, not just eyeballing).
- Second pass had a real bug: dots were computed in **screen space**, but `gridLayer` inherits the stage's pan/zoom transform like every other layer (same as marks, which use world coordinates via `(pointer - stage.xy) / scale`). Result: dots only painted in whatever quadrant the current pan offset happened to land in, not the whole canvas.
- Fixed the math (world-space placement), confirmed full coverage via pixel scan — then design call: **dots looked bad over the drawings, removed entirely.** `drawGrid()` is now a no-op; background stays the lifted `#111111` (up from `#0a0a0a`) from the same design pass.

---

## V1.2 — "Place, not an editor"

User feedback drive (V1.2).Reduce the tool feeling → the wall should feel like a place you draw on, not an editor. Everything else (auth, backend, payments, profiles, comments, marketplace, more tools) stays deferred. The real validation is now 5–10 people using it unassisted and watching the five signals — especially "do they come back?".

### V1.2 work log

#### Toolbar: Draw · Text · Erase · React, everything else under More
- Primary toolbar is now **Draw · Text · Erase · React**. Select moved into **More** ("Select & pan") so the first screen has zero editor chrome.
- Subsequent feedback removed the More submenu entirely: **all 11 tools now sit in the single horizontal bar** (draw, text, erase, react, select, sticker, rect, circle, image, secret, time capsule) — no "+" icon. The bar scrolls horizontally on narrow screens (`overflow-x:auto`, hidden scrollbar). Select/pan, Sticker, etc. are direct buttons again.
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
| `src/seed.ts` | Seeded content: `buildSeedObjects()` (33-piece narrative cast) + `buildSeedPayloads()` for the server `seedObjects` reducer. `seedWallIfNeeded()` (client/localStorage seeding) only runs when `!isSpacetime()` |
| `src/storage.ts` | `StorageBackend` interface + `LocalStorageBackend` implementation + `activeBackend` module state (`setBackend`/`getBackend`/`isSpacetime`) + convenience helpers that delegate to whichever backend is active |
| `src/spacetime.ts` | `SpacetimeBackend` — the active backend. Connects to SpacetimeDB, subscribes to tables, converts rows ↔ `WallObject`, calls reducers for every mutation, reconnects with backoff |
| `src/module_bindings/` | Generated by `spacetime generate` from `spacetimedb/src/index.ts` — tables, reducers, types. Regenerate after any server schema change |
| `src/map.ts` | `objectDataToWallData` / `wallToObjectData` — converts between the server's generic `ObjectData` and the client's typed `WallObject.data` per object type |
| `spacetimedb/src/index.ts` | The server module (tables + reducers), published as `ghostwall` on SpacetimeDB maincloud |
| `spacetime.json` / `spacetime.local.json` | CLI config: server (`maincloud`) + module path, and the published database name (`ghostwall`) |
| `src/landing.ts` | Landing page |
| `src/types.ts` | `WallObject`, `UserProfile`, `DURATION_MS` (24h/7d) |
| `src/utils.ts` | id/time/format helpers |
| `src/style.css` | All styling (dark theme, `--bg: #111111`) |
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

### Persistence philosophy (superseded by V2)
> V1 was **in-memory-first**: localStorage-only, no accounts, no sync, no cross-device truth. As of V2, `SpacetimeBackend` (`src/spacetime.ts`) is the active backend (`storage.ts`'s `activeBackend`) — objects/reactions/comments live server-side on the shared `ghostwall` maincloud db and stream to every client via subscriptions. `LocalStorageBackend` still exists and implements the same `StorageBackend` interface, but nothing currently activates it.

### Routing / share links
- `#/w?id=<id>` deep-links to an object: engine `teleportToObjectId(id)` centers + selects it when the object exists.
- `explore=true` param opens the discovery panel.
- Cross-device sharing now works for real (shared backend) as long as the linked object hasn't expired/faded server-side.

---

## V3 — presence: live cursors, home pin, real online/landing stats

A product pass ranked "what will make people come back", by impact: (1) real presence/stats — done first, see V2's stats work above; (2) an in-app "someone drew nearby" toast; (3) live cursors on the canvas; (4) a lightweight home pin. Two items had a scope fork the user chose explicitly: **in-app toast, not OS push** (no permission prompt/service worker/VAPID infra), and **a home pin, not a claim/defend territory system** (no ownership mechanic).

#### Live cursors
- New `cursor` table (server): one row per connected identity, upserted on every move, deleted on disconnect so stale cursors never linger. Deliberately not an append-only log — a mouse position has no history value, so it's a bounded (O(concurrent users)) live-presence table, same pattern as `wall_stats`.
- `updateCursor({x,y})` reducer. Client throttles to one call per 120ms (`canvas.ts`'s new always-on `onCursorMove` — separate from the existing gesture-only `handlePointerMove`, so hovering broadcasts position even without drawing).
- `CanvasEngine.renderRemoteCursors()` diffs against previous nodes (no destroy/recreate churn), colors each cursor by a deterministic hash of their identity, labels it `avatar username`.
- Verified: client→server persistence confirmed live (a real browser session's cursor row appeared and stayed correct via `spacetime sql`). Cross-*identity* rendering (does user A see user B's cursor) couldn't be visually verified in this session — the test tooling's multiple tabs share one browser profile/localStorage, so they resolve to the same SpacetimeDB identity, not two distinct ones. The code path mirrors the already-proven `wallStats`/`user` subscription pattern; flagging as unverified-live rather than claiming false confidence.

#### Home pin
- `user.homeX`/`homeY` (optional i32 columns, additive migration). `setHome({x,y})` reducer.
- Top-bar `🏠` button: no home set → "Set home here" (saves current camera center); home set → "Go home" (calls the existing `CanvasEngine.teleportTo`, no new engine method needed).
- Verified end-to-end live: set at camera (0,0), confirmed server-side via `spacetime sql`, panned away, clicked again, camera animated back to the saved point.

#### "Someone drew nearby" toast
- Reuses `subscribeObjects`' existing diff — skips the first (initial-load) callback, then on later inserts, toasts via the existing `showDiscoveryMessage` helper if the mark's author isn't you and it landed within 3000 world-units of the camera center at the moment it arrived. No new schema, no new UI component.

#### Not built (explicitly out of scope, see product-fork above)
Real OS-level push notifications (needs Notification permission UX, a service worker, and a push-signing server — reducers can't sign/send push themselves). Claim/defend territory (an actual game-design mechanic — claim size, contest/loss rules — not a UI add-on).

---

## Explicitly deferred (do NOT build yet)
Authentication (beyond SpacetimeDB's anonymous per-browser identity), profiles beyond a local username, payments, "keep forever" purchases, marketplace, moderation infrastructure, notifications, dev/prod database split (see V2 log — intentional, single shared db for now).

~~Supabase/Firebase, real-time WebSockets~~ — superseded: the wall now runs on SpacetimeDB (see V2).

---

## Open / next steps
- [x] Onboarding overlay: "Welcome to Ghostwall. Everything you leave here fades after 24 hours…" + Start exploring (marker `thewall_seen_intro`)
- [x] Share link button in object info popup (copy `#/w?id=…`)
- [x] Storage reframe comment cleanup (in-memory-first language)
- [x] SpacetimeDB backend published + wired end-to-end (V2, see above)
- [ ] Commit + push the V2 changes (currently uncommitted: `main.ts`, `wall.ts`, `canvas.ts`, `storage.ts`, `seed.ts`, `spacetime.ts`, `map.ts`, `module_bindings/`, `spacetimedb/`, `spacetime.json`) — nothing is live on Vercel/GitHub yet, this has only been running locally against the real maincloud db
- [ ] Connection-state UI — `subscribeState` exists on the backend, nothing renders `connecting`/`disconnected` to the user right now
- [ ] Empty-canvas-at-zoom-out problem — flagged during a design pass: at low zoom the wall is ~95% dead void, seed content clusters too tightly. Not yet fixed (seed placement spread + optional glow layer around dense clusters)
- [ ] Dev/prod database split — deliberately deferred (single-user testing right now); revisit once more people test against the live wall
- [ ] Ship V2 live, then *actually use it for a few days* and watch for the signals (did I press Random? did I draw a second thing? did I modify someone's drawing? did I come back? did I want to send a link?) — now meaningfully testable since marks persist across devices/sessions
- [x] Live cursors, home pin, "someone drew nearby" toast (V3, see above)
- [ ] Cross-identity verification of live cursor rendering — couldn't be tested with two real distinct identities in this session (tooling limitation, see V3 note); worth a manual two-device check before relying on it
- [ ] Named/ownable spaces beyond the home pin (claim/defend territory) — explicitly descoped this round, needs its own game-design pass first