import { CanvasEngine, CORRIDOR } from './canvas';
import { seedWallIfNeeded } from './seed';
import {
  addComment,
  addReaction,
  drawOverObject,
  getMyHome,
  hideComment,
  hideObject,
  isSpacetime,
  loadUserProfile,
  removeReaction,
  saveUserProfile,
  sendCursor,
  setHome,
  subscribeCursors,
  subscribeObjects,
  subscribeStats,
  updateObject,
} from './storage';
import { formatTimeAgo, formatTimeLeft, getRandomUsername } from './utils';
import type { WallObject } from './types';

type Tool = 'select' | 'draw' | 'erase' | 'text' | 'rect' | 'circle' | 'sticker' | 'image' | 'secret' | 'timecapsule' | 'confession' | 'react';

// All tools live in one horizontal bar — no hidden submenu. The four verbs that
// matter on a first visit come first; the rest follow in the same row.
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'select', icon: '✋', label: 'Pan & select' },
  { id: 'draw', icon: '✏️', label: 'Draw' },
  { id: 'text', icon: 'Aa', label: 'Text' },
  { id: 'erase', icon: '🧽', label: 'Erase' },
  { id: 'react', icon: '❤️', label: 'React' },
  { id: 'sticker', icon: '😀', label: 'Sticker' },
  { id: 'rect', icon: '▭', label: 'Rectangle' },
  { id: 'circle', icon: '◯', label: 'Circle' },
  { id: 'image', icon: '🖼️', label: 'Image' },
  { id: 'secret', icon: '🤫', label: 'Secret' },
  { id: 'timecapsule', icon: '🔒', label: 'Time capsule' },
  { id: 'confession', icon: '🕯️', label: 'Confession' },
];

const COLORS = [
  '#ff4d4d', '#4ecdc4', '#ffeaa7', '#85c1e9', '#bb8fce',
  '#f8c471', '#82e0aa', '#f1948a', '#ffa33c', '#7d6bff',
  '#2ecc71', '#ff6b9d', '#ffffff', '#f0f0f0', '#a0a0a0',
  '#ffde59', '#54a0ff', '#ee5a24', '#00d2d3', '#ff9f1a',
];

const EMOJI_REACTIONS = ['❤️', '😂', '⭐', '👍', '😮', '🪐'];

// Calmer palette for marks left in the Confession Corridor.
const CONFESSION_REACTIONS = ['🕯️', '❤️', '🫂', '💛', '🙏', '✨'];

// Named places users can jump to from the top bar. Deliberately a hardcoded
// client list (no DB table): the corridor earned a spot by existing.
const PLACES: { id: string; name: string; tip: string; x: number; y: number; zoom: number }[] = [
  { id: 'main', name: '🎨 Main Wall', tip: 'back at the main wall', x: 0, y: 0, zoom: 1 },
  { id: 'confession', name: '🕯️ Confession Corridor', tip: 'the Confession Corridor — everything here stays 🕯️', x: CORRIDOR.cx, y: CORRIDOR.cy, zoom: 0.8 },
];

export function renderWall(container: HTMLElement, initial: { explore?: boolean; deepLink?: string; place?: string }): void {
  container.innerHTML = `
    <div class="canvas-page">
      <div class="canvas-container" id="canvas-container"></div>

      <div class="top-bar">
        <div class="top-bar-left">
          <button class="top-btn" id="btn-profile">👤 <span id="profile-name">Enter username</span></button>
          <button class="top-btn" id="btn-home" data-tooltip="Set home here" style="display:none">🏠</button>
        </div>
        <div class="top-bar-right">
          <div class="online-indicator" id="online-indicator" style="display:none">
            <span class="online-dot"></span><span id="online-count">0</span> online
          </div>
          <div class="zoom-indicator" id="zoom-indicator">100%</div>
          <div class="places-wrap">
            <button class="top-btn" id="btn-places">🗺️ Places</button>
            <div class="places-menu" id="places-menu" style="display:none">
              ${PLACES.map(p => `<button class="places-option" data-place="${p.id}">${p.name}</button>`).join('')}
            </div>
          </div>
          <button class="top-btn accent" id="btn-explore">🔭 Explore</button>
        </div>
      </div>

      <div class="discover-fab" id="btn-discover" title="Take me somewhere weird">
        <span class="fab-die">🎲</span><span class="fab-label">Find something weird</span>
      </div>

      <div class="toolbar" id="toolbar">
        ${TOOLS.map(t => `
          <button class="tool-btn ${t.id === 'select' ? 'active' : ''}" data-tool="${t.id}" data-tooltip="${t.label}">
            <span>${t.icon}</span>
          </button>
        `).join('')}
        <div class="toolbar-divider"></div>
        <div class="color-picker-wrapper" id="color-picker">
          <div class="color-swatch" id="color-swatch" style="background:${COLORS[0]}"></div>
          <div class="color-palette" id="color-palette">
            ${COLORS.map(c => `<button class="color-palette-btn ${c === COLORS[0] ? 'active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="toolbar-divider"></div>
        <button class="tool-btn" id="btn-undo" data-tooltip="Undo">↩️</button>
        <button class="tool-btn" id="btn-redo" data-tooltip="Redo">↪️</button>
      </div>
    </div>
  `;

  const canvasEl = document.getElementById('canvas-container') as HTMLDivElement;
  const userProfile = loadUserProfile() || createDefaultProfile();
  // The Spacetime backend seeds server-side (see spacetime.ts's maybeSeed());
  // local seeding is only for the single-user localStorage backend.
  if (!isSpacetime()) seedWallIfNeeded();

  let lastCursorSentAt = 0;
  const CURSOR_THROTTLE_MS = 120;

  const engine = new CanvasEngine({
    container: canvasEl,
    onZoomChange: (zoom) => {
      const el = document.getElementById('zoom-indicator');
      if (el) el.textContent = `${Math.round(zoom * 100)}%`;
    },
    onObjectSelected: (obj) => handleObjectSelected(obj),
    onToolChange: () => {},
    onCursorMove: (x, y) => {
      if (!isSpacetime()) return;
      const now = Date.now();
      if (now - lastCursorSentAt < CURSOR_THROTTLE_MS) return;
      lastCursorSentAt = now;
      sendCursor(x, y);
    },
  });

  if (isSpacetime()) {
    // "someone drew nearby" — skip the initial full snapshot (that's just
    // existing marks loading, not new activity), then toast on later inserts
    // by someone else within range of wherever the camera currently is.
    let knownIds: Set<string> | null = null;
    const NEARBY_RADIUS = 3000;
    subscribeObjects((objects) => {
      engine.syncObjects(objects);
      patchOpenCounts(objects);
      if (knownIds === null) {
        knownIds = new Set(objects.map(o => o.id));
        return;
      }
      const center = engine.getCameraCenter();
      for (const obj of objects) {
        if (knownIds.has(obj.id)) continue;
        knownIds.add(obj.id);
        if (obj.author === userProfile.username) continue;
        const dist = Math.hypot(obj.x - center.x, obj.y - center.y);
        if (dist <= NEARBY_RADIUS) {
          showDiscoveryMessage(`🎨 @${obj.author} drew something nearby`);
        }
      }
    });

    subscribeCursors((cursors) => engine.renderRemoteCursors(cursors));
    subscribeStats((stats) => {
      const wrap = document.getElementById('online-indicator');
      const countEl = document.getElementById('online-count');
      if (wrap) wrap.style.display = '';
      if (countEl) countEl.textContent = String(stats.onlineNow);
      refreshHomeButton();
    });

    const homeBtn = document.getElementById('btn-home') as HTMLButtonElement | null;
    if (homeBtn) homeBtn.style.display = '';
    function refreshHomeButton(): void {
      if (!homeBtn) return;
      const home = getMyHome();
      homeBtn.dataset.tooltip = home ? 'Go home' : 'Set home here';
    }
    homeBtn?.addEventListener('click', () => {
      const home = getMyHome();
      if (home) {
        engine.teleportTo(home.x, home.y, 1);
      } else {
        const center = engine.getCameraCenter();
        setHome(center.x, center.y);
        showDiscoveryMessage('🏠 home set here — find it anytime from the top bar');
        setTimeout(refreshHomeButton, 300);
      }
    });
  }

  updateProfileDisplay(userProfile);

  setupToolbar(engine, userProfile);
  setupColorPicker();
  setupTopBar(engine, userProfile);
  setupKeyboard(engine);

  maybeShowOnboarding();
  maybeShowDrawHint();

  // Handle deep links and named places
  if (initial.deepLink) {
    if (!engine.teleportToObjectId(initial.deepLink)) {
      showExplorerCTA();
    }
  } else if (initial.place) {
    const place = PLACES.find(p => p.id === initial.place);
    if (place) {
      engine.teleportTo(place.x, place.y, place.zoom, true);
      showDiscoveryMessage(place.tip);
    }
  } else if (initial.explore) {
    openDiscoveryPanel();
  }

  function createDefaultProfile() {
    const profile = {
      username: getRandomUsername(),
      avatar: '🦊',
      bio: '',
      favorites: [] as string[],
      createdAt: Date.now(),
    };
    saveUserProfile(profile);
    return profile;
  }

  function updateProfileDisplay(p: typeof userProfile): void {
    const btn = document.getElementById('btn-profile');
    if (btn) {
      const avatar = p.avatar || '🦊';
      btn.innerHTML = `${avatar} @${p.username}`;
    }
  }

  function setupToolbar(engineRef: CanvasEngine, _profile: typeof userProfile): void {
    const allToolButtons = document.querySelectorAll('.tool-btn[data-tool]');

    allToolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = (btn as HTMLElement).dataset.tool as Tool;
        if (tool === 'image') {
          // image uses a file picker rather than a simple tool switch
          document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
          (btn as HTMLElement).classList.add('active');
          engineRef.setTool('image');
          handleImageUpload();
          return;
        }
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        (btn as HTMLElement).classList.add('active');
        engineRef.setTool(tool);
      });
    });

    document.getElementById('btn-undo')?.addEventListener('click', () => engineRef.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => engineRef.redo());
  }

  function setupColorPicker(): void {
    const swatch = document.getElementById('color-swatch') as HTMLElement;
    const palette = document.getElementById('color-palette') as HTMLElement;

    let open = false;
    swatch.addEventListener('click', () => {
      open = !open;
      palette.classList.toggle('open', open);
    });

    palette.querySelectorAll('.color-palette-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = (btn as HTMLElement).dataset.color!;
        swatch.style.background = color;
        const buttons = palette.querySelectorAll('.color-palette-btn');
        buttons.forEach(b => b.classList.remove('active'));
        (btn as HTMLElement).classList.add('active');
        engine.setColor(color);
        open = false;
        palette.classList.remove('open');
      });
    });

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('color-picker')!;
      if (!wrapper.contains(e.target as Node)) {
        open = false;
        palette.classList.remove('open');
      }
    });
  }

  function setupTopBar(engineRef: CanvasEngine, profile: typeof userProfile): void {
    document.getElementById('btn-profile')?.addEventListener('click', () => openProfilePanel(engineRef, profile));
    document.getElementById('btn-explore')?.addEventListener('click', openDiscoveryPanel);
    document.getElementById('btn-discover')?.addEventListener('click', () => doWeirdDiscovery(engineRef));

    const placesWrap = document.querySelector('.places-wrap');
    const placesMenu = document.getElementById('places-menu');
    document.getElementById('btn-places')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!placesMenu) return;
      closePanels();
      placesMenu.style.display = placesMenu.style.display === 'none' ? '' : 'none';
    });
    placesMenu?.querySelectorAll('.places-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.place!;
        const place = PLACES.find(p => p.id === id);
        if (place) {
          engineRef.teleportTo(place.x, place.y, place.zoom);
          showDiscoveryMessage(place.tip);
        }
        if (placesMenu) placesMenu.style.display = 'none';
      });
    });
    document.addEventListener('click', (e) => {
      if (placesMenu && placesWrap && !placesWrap.contains(e.target as Node)) {
        placesMenu.style.display = 'none';
      }
    });
  }

  /**
   * "Take me somewhere weird" — jump to an interesting mark and show a rich
   * reveal card (what it is, who left it, how long ago, how many people changed
   * it). This is the exploration hook that makes the wall feel alive.
   */
  function doWeirdDiscovery(engineRef: CanvasEngine): void {
    // The Confession Corridor is a place you arrive at on purpose — weird
    // discovery jumps everywhere on the wall except there.
    const all = engineRef.getObjects().filter(o => o.type !== 'confession');
    if (all.length === 0) {
      showDiscoveryMessage('nothing here yet... go make the first mark');
      return;
    }

    // Score marks: mysteries, hearts/drawings, permanents, and things people
    // already interacted with rank highest — the "wait, what is this?" finds.
    const scored = all.map(o => {
      let s = Math.random();
      if (o.type === 'secret' || o.type === 'timecapsule') s += 6;
      if (o.type === 'sticker') s += 2;
      if (o.keptForever) s += 2.5;
      if ((o.reactions || []).some(r => r.count > 0)) s += 2;
      if ((o.modifiedBy || []).length > 0) s += 3;
      return { o, s };
    }).sort((a, b) => b.s - a.s);

    const pick = scored[0].o;
    const node = engineRef.getMainLayer().getChildren().find(c => c.id() === pick.id);
    if (!node) { engineRef.teleportRandom(); return; }
    const rect = node.getClientRect();
    engineRef.teleportTo(rect.x + rect.width / 2, rect.y + rect.height / 2, 1.3);

    showDiscoveryReveal(pick);
  }

  function showDiscoveryReveal(obj: WallObject): void {
    closePanels();
    const existing = document.querySelector('.discovery-reveal');
    if (existing) existing.remove();

    const modifiedCount = (obj.modifiedBy || []).length;
    const reactedCount = (obj.reactions || []).reduce((sum, r) => sum + (r.count || 0), 0);

    const reveal = document.createElement('div');
    reveal.className = 'discovery-reveal';
    reveal.innerHTML = `
      <div class="dr-eyebrow">You found this.</div>
      <div class="dr-body">
        <div class="dr-line">${getObjPreview(obj)}</div>
        <div class="dr-author">Left ${formatTimeAgo(obj.createdAt)} by ${obj.type === 'sticker' ? (String(obj.data.emoji) || '') + ' ' : ''}@${obj.author}</div>
        <div class="dr-stats">
          ${modifiedCount > 0 ? `<span>↑ modified by ${modifiedCount} person${modifiedCount > 1 ? 's' : ''}</span>` : ''}
          ${reactedCount > 0 ? `<span>❤️ × ${reactedCount}</span>` : ''}
        </div>
      </div>
      <div class="dr-actions">
        <button class="dr-go" id="dr-go">Go there</button>
        <button class="dr-skip" id="dr-skip">Keep wandering</button>
      </div>
    `;
    document.body.appendChild(reveal);

    const close = () => reveal.remove();
    reveal.querySelector('#dr-go')?.addEventListener('click', () => {
      close();
      engine.selectObjectId(obj.id);
    });
    reveal.querySelector('#dr-skip')?.addEventListener('click', () => {
      close();
      doWeirdDiscovery(engine);
    });
    // Swallow clicks so a stray tap doesn't deselect
    reveal.addEventListener('click', (e) => { e.stopPropagation(); });
  }

  function setupKeyboard(engineRef: CanvasEngine): void {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) engineRef.redo();
        else engineRef.undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault();
        engineRef.redo();
      }
      if (e.key === 'Escape') {
        engineRef.deselectAll();
        closePanels();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (engineRef.getSelectedObject()) {
          engineRef.deleteSelected();
        }
      }
    });
  }

  function closePanels(): void {
    document.querySelectorAll('.discovery-panel, .profile-panel').forEach(el => el.remove());
  }

  function showDiscoveryMessage(msg: string): void {
    const existing = document.querySelector('.discovery-msg');
    if (existing) existing.remove();
    const panel = document.querySelector('.discovery-panel');
    if (panel) {
      const msgEl = document.createElement('div');
      msgEl.className = 'discovery-msg';
      msgEl.textContent = msg;
      panel.appendChild(msgEl);
      setTimeout(() => msgEl.remove(), 4000);
    } else {
      const flash = document.createElement('div');
      flash.className = 'discovery-panel';
      flash.style.left = '16px';
      flash.style.right = 'auto';
      flash.innerHTML = `<div class="discovery-msg">${msg}</div>`;
      container.appendChild(flash);
      setTimeout(() => flash.remove(), 4000);
    }
  }

  function openDiscoveryPanel(): void {
    closePanels();
    const panel = document.createElement('div');
    panel.className = 'discovery-panel';
    panel.innerHTML = `
      <h3>🔭 Explore</h3>
      <button class="discovery-btn"><span class="emoji">🌍</span> Explore nearby</button>
      <button class="discovery-btn"><span class="emoji">🎲</span> Take me somewhere random</button>
      <button class="discovery-btn"><span class="emoji">🕵️</span> Find something weird</button>
      <button class="discovery-btn"><span class="emoji">🔍</span> Search username</button>
    `;
    container.appendChild(panel);

    panel.querySelectorAll('.discovery-btn').forEach(btn => {
      btn.addEventListener('click', () => handleDiscoveryAction(btn as HTMLElement, panel, engine));
    });
  }

  function handleDiscoveryAction(btn: HTMLElement, _panel: HTMLElement, engineRef: CanvasEngine): void {
    const action = btn.textContent || '';

    if (action.includes('nearby')) {
      const zoom = engineRef.getZoom();
      const offsets = [
        [800, 800], [-800, 800], [800, -800], [-800, -800],
        [2000, 500], [-2000, -500], [500, 2000], [-500, -2000],
      ];
      const [dx, dy] = offsets[Math.floor(Math.random() * offsets.length)];
      const stage = engineRef.getStage();
      const x = (stage.x() + dx) / zoom;
      const y = (stage.y() + dy) / zoom;
      engineRef.teleportTo(x, y, zoom);
      showDiscoveryMessage('exploring nearby...');
    } else if (action.includes('random')) {
      doWeirdDiscovery(engineRef);
    } else if (action.includes('weird')) {
      doWeirdDiscovery(engineRef);
    } else if (action.includes('Search')) {
      showUsernameSearch(engineRef);
    }
  }

  function showUsernameSearch(engineRef: CanvasEngine): void {
    const existing = document.querySelector('.search-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = 'discovery-panel search-panel';
    panel.innerHTML = `
      <h3>🔍 Find a username</h3>
      <input type="text" placeholder="@username" class="search-input" />
    `;
    const inputStyle = document.createElement('style');
    inputStyle.textContent = `
      .search-input {
        width: 100%;
        padding: 10px 14px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        font-family: var(--mono);
        font-size: 13px;
        outline: none;
      }
      .search-input:focus { border-color: var(--accent); }
      .search-result {
        margin-top: 10px;
        padding: 8px 12px;
        background: rgba(255,255,255,0.03);
        border-radius: 6px;
        font-size: 12px;
        color: var(--text-dim);
        font-family: var(--mono);
        cursor: pointer;
      }
      .search-result:hover { background: rgba(255,255,255,0.06); }
    `;
    document.head.appendChild(inputStyle);
    panel.appendChild(inputStyle);
    document.querySelector('.discovery-panel')?.remove();
    container.appendChild(panel);

    const input = panel.querySelector('.search-input') as HTMLInputElement;
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const query = input.value.trim().toLowerCase().replace(/^@/, '');
        if (!query) return;
        const matches = engineRef.getObjects().filter(o => o.author.toLowerCase().includes(query));
        if (matches.length === 0) {
          input.value = '';
          input.placeholder = 'no one found 😅';
        } else {
          const obj = matches[Math.floor(Math.random() * matches.length)];
          engineRef.teleportToObjectId(obj.id);
          showDiscoveryMessage(`found ${matches.length} mark${matches.length > 1 ? 's' : ''} by @${query}`);
          panel.remove();
        }
      }
    });
  }

  function showExplorerCTA(): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="text-align:center">
        <h3>That mark is gone forever</h3>
        <p style="margin:8px 0 24px">It disappeared before you could see it. The wall moves on.</p>
        <button class="modal-close" id="explore-cta">Explore instead →</button>
      </div>
    `;
    container.appendChild(overlay);
    overlay.querySelector('#explore-cta')?.addEventListener('click', () => {
      overlay.remove();
      openDiscoveryPanel();
    });
  }

  function maybeShowOnboarding(): void {
    if (localStorage.getItem('thewall_seen_intro')) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal onboarding-modal">
        <div class="ob-title">Welcome to Ghostwall.</div>
        <p class="ob-line">Everything you leave here fades after 24 hours.</p>
        <p class="ob-line">Find something. Change it. Leave something of your own.</p>
        <button class="modal-close" id="start-exploring">Start exploring →</button>
      </div>
    `;
    container.appendChild(overlay);
    overlay.querySelector('#start-exploring')?.addEventListener('click', () => {
      localStorage.setItem('thewall_seen_intro', '1');
      overlay.remove();
    });
  }

  /** One-time nudge that reveals the first actions — panning is on by default. */
  function maybeShowDrawHint(): void {
    if (localStorage.getItem('thewall_draw_hint')) return;
    localStorage.setItem('thewall_draw_hint', '1');
    const hint = document.createElement('div');
    hint.className = 'draw-hint';
    hint.innerHTML = '✋ Drag to explore the wall · ✏️ pick a tool to leave a mark';
    container.appendChild(hint);
    const dismiss = () => hint.remove();
    window.setTimeout(dismiss, 4000);
    hint.addEventListener('click', dismiss);
    // Any first mark hides it too (listener stays attached; the handler is idempotent).
    engine.getStage().on('mouseup touchend', dismiss);
  }

  function openProfilePanel(_engineRef: CanvasEngine, profile: typeof userProfile): void {
    closePanels();
    const panel = document.createElement('div');
    panel.className = 'profile-panel';
    panel.innerHTML = `
      <div class="profile-avatar-large">${profile.avatar || '🦊'}</div>
      <div class="profile-name">@${profile.username}</div>
      <div class="profile-handle">yours forever · ${new Date(profile.createdAt).toLocaleDateString()}</div>
      <textarea class="profile-bio-input" placeholder="A tiny bio (optional)">${profile.bio || ''}</textarea>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        ${['🦊', '🐼', '🦄', '👾', '🤖', '🧸', '🐙', '🦋'].map(a => `
          <span class="avatar-option ${a === profile.avatar ? 'selected' : ''}" data-avatar="${a}"
            style="cursor:pointer;font-size:20px;padding:4px;border-radius:6px;border:1px solid ${a === profile.avatar ? 'var(--accent)' : 'var(--border)'}">${a}</span>
        `).join('')}
      </div>
      <button class="profile-save-btn">Save</button>
    `;
    container.appendChild(panel);

    panel.querySelectorAll('.avatar-option').forEach(opt => {
      opt.addEventListener('click', () => {
        panel.querySelectorAll('.avatar-option').forEach(o => {
          (o as HTMLElement).style.borderColor = 'var(--border)';
        });
        (opt as HTMLElement).style.borderColor = 'var(--accent)';
      });
    });

    panel.querySelector('.profile-save-btn')?.addEventListener('click', () => {
      const bio = (panel.querySelector('.profile-bio-input') as HTMLTextAreaElement).value;
      const clickedAvatar = Array.from(panel.querySelectorAll('.avatar-option')).find(o =>
        (o as HTMLElement).style.borderColor === 'rgb(255, 77, 77)'
      );
      const avatar = clickedAvatar?.getAttribute('data-avatar') || profile.avatar;

      const updated = { ...profile, bio, avatar };
      saveUserProfile(updated);
      updateProfileDisplay(updated);
      panel.remove();
      showDiscoveryMessage('profile saved ✓');
    });
  }

  function removeQuickReact(): void {
    document.querySelector('.quick-react')?.remove();
  }

  function handleObjectSelected(obj: WallObject | null): void {
    removeQuickReact();
    const existing = document.querySelector('.object-info-popup');
    if (existing) existing.remove();
    if (!obj) return;

    // In React mode a mark responds with a quick emoji palette — no popup.
    if (engine.getTool() === 'react') {
      quickReact(obj);
      return;
    }

    if (obj.type === 'secret') {
      handleSecretNear(obj);
      return;
    }

    const node = engine.getMainLayer().getChildren().find(c => c.id() === obj.id);
    if (!node) return;
    const rect = node.getClientRect();
    const screenX = rect.x + rect.width / 2;
    const screenY = rect.y - 20;

    const isPermanent = obj.keptForever;
    const myObj = obj.id === findMyObject(obj);
    const isConfession = obj.type === 'confession';
    const reactionPool = isConfession ? CONFESSION_REACTIONS : EMOJI_REACTIONS;

    const popup = document.createElement('div');
    popup.className = 'object-info-popup';
    popup.dataset.objectId = obj.id;

    let previewSrc = '';
    try { previewSrc = (node as unknown as { toDataURL: (o: object) => string }).toDataURL({ pixelRatio: 2 }); } catch { /* noop */ }

    popup.innerHTML = `
      <div class="oi-author">
        <span class="oi-avatar">🦊</span>
        <span class="oi-name">@${obj.author}</span>
        ${isPermanent ? '<span class="permanent-badge">∞</span>' : ''}
      </div>
      ${previewSrc ? `<img class="oi-preview" alt="" src="${previewSrc}" />` : `<div class="oi-preview">${getObjPreview(obj)}</div>`}
      <div class="oi-reactions">
        ${reactionPool.map(r => `
          <button class="oi-react-btn" data-emoji="${r}">${r} <span class="oi-count">${getReactionCount(obj, r)}</span></button>
        `).join('')}
      </div>
      <div class="oi-actions">
        <button class="oi-action primary" id="btn-draw-over">✏️ Draw over it</button>
        ${isConfession ? '<button class="oi-action primary" id="btn-reply">💬 Reply</button>' : ''}
        <button class="oi-action primary" id="btn-share">🔗 Share</button>
        <button class="oi-action" id="btn-comment">💬</button>
        ${isConfession ? '<button class="oi-action danger" id="btn-hide">🚩 Hide</button>' : ''}
        ${myObj ? `<button class="oi-action" id="btn-delete">🗑️</button>` : ''}
      </div>
      <div class="oi-meta">
        <span id="oi-timer">${isPermanent ? 'kept forever' : formatTimeLeft(obj.expiresAt)}</span>
        ${obj.modifiedBy.length > 0 ? `<span class="oi-dot">·</span><span>modified by ${obj.modifiedBy.length}</span>` : ''}
        <span class="oi-dot">·</span><span>${formatTimeAgo(obj.createdAt)}</span>
      </div>
    `;

    const popupX = Math.min(Math.max(screenX - 110, 10), Math.max(window.innerWidth - 320, 10));
    const popupY = Math.min(Math.max(screenY - 10, 10), Math.max(window.innerHeight - 480, 10));
    popup.style.left = `${popupX}px`;
    popup.style.top = `${popupY}px`;
    container.appendChild(popup);

    // Fit the whole popup inside the viewport: prefer above the mark, fall back
    // below it, and clamp so every action button stays reachable.
    const ph = popup.offsetHeight;
    const pw = popup.offsetWidth;
    const left = Math.min(Math.max(screenX - pw / 2, 10), Math.max(window.innerWidth - pw - 10, 10));
    const above = screenY - ph - 12;
    const belowMark = rect.y + rect.height + 12;
    let top = above >= 10 ? above : Math.max(10, belowMark);
    top = Math.min(Math.max(top, 10), Math.max(window.innerHeight - ph - 10, 10));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;

    const popupEls = popup; // alias for closures below
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => { if (timer) clearInterval(timer); timer = null; };
    const closePopup = () => { stopTimer(); popupEls.remove(); };

    if (!isPermanent && obj.expiresAt) {
      const exp = obj.expiresAt;
      const tick = () => {
        const timerEl = popupEls.querySelector('#oi-timer');
        if (!timerEl) { stopTimer(); return; }
        const now = Date.now();
        if (now >= exp) {
          timerEl.textContent = 'fading away';
          timerEl.classList.add('gone');
        } else {
          timerEl.textContent = formatTimeLeft(exp);
        }
      };
      tick();
      timer = setInterval(tick, 1000);
    }

    popup.addEventListener('click', (e) => e.stopPropagation());

    popup.querySelectorAll('.oi-react-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = (btn as HTMLElement).dataset.emoji!;
        const profile = loadUserProfile() || userProfile;
        const current = obj.reactions?.find(r => r.emoji === emoji);
        const removing = current?.user === profile.username;
        if (removing) removeReaction(obj.id, emoji);
        else addReaction(obj.id, emoji);
        // Optimistic count; the next sync lands a moment later and corrects it.
        const nextCount = Math.max(0, (current?.count ?? 0) + (removing ? -1 : 1));
        const countEl = btn.querySelector('.oi-count');
        if (countEl) countEl.textContent = String(nextCount);
      });
    });

    popup.querySelector('#btn-draw-over')?.addEventListener('click', () => {
      engine.setTool('draw');
      drawOverObject(obj.id);
      closePopup();
      showDiscoveryMessage('Draw over it. Be the next artist.');
      // Give the toolbar's Draw button the active state.
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      document.querySelector('.tool-btn[data-tool="draw"]')?.classList.add('active');
    });

    popup.querySelector('#btn-comment')?.addEventListener('click', () => {
      closePopup();
      openComments(obj);
    });
    // 💬 Reply is the confession's primary verb; it maps onto the same panel but
    // reads as a reply to the corridor instead of a comment on the wall.
    popup.querySelector('#btn-reply')?.addEventListener('click', () => {
      closePopup();
      openComments(obj, true);
    });

    popup.querySelector('#btn-hide')?.addEventListener('click', () => {
      closePopup();
      hideObject(obj.id);
      showDiscoveryMessage('confession hidden from the corridor 🕯️');
    });

    popup.querySelector('#btn-share')?.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}#/w?id=${obj.id}`;
      const copyText = (): void => {
        showDiscoveryMessage('🔗 link copied');
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(copyText).catch(() => {
          prompt('Copy this link to share this mark:', url);
        });
      } else {
        prompt('Copy this link to share this mark:', url);
      }
    });

    popup.querySelector('#btn-delete')?.addEventListener('click', () => {
      closePopup();
      engine.deleteSelected();
    });

    // Track selection by author for delete check
    (engine as unknown as { _selectedWallObjForDelete: WallObject })._selectedWallObjForDelete = obj;
  }

  /** React mode: a compact palette of emoji reactions pinned next to the mark. */
  function quickReact(obj: WallObject): void {
    const node = engine.getMainLayer().getChildren().find(c => c.id() === obj.id);
    if (!node) return;
    const rect = node.getClientRect();
    const palette = document.createElement('div');
    palette.className = 'quick-react';
    palette.dataset.objectId = obj.id;
    const pool = obj.type === 'confession' ? CONFESSION_REACTIONS : EMOJI_REACTIONS;
    palette.innerHTML = `
      ${pool.map(r => `
        <button class="qr-btn" data-emoji="${r}" data-count="${getReactionCount(obj, r)}">
          ${r}<span class="qr-count">${getReactionCount(obj, r) || ''}</span>
        </button>
      `).join('')}
    `;
    let x = rect.x + rect.width / 2 - 120;
    let y = rect.y - 52;
    x = Math.min(Math.max(x, 10), window.innerWidth - 260);
    y = Math.max(y, 10);
    palette.style.left = `${x}px`;
    palette.style.top = `${y}px`;
    document.body.appendChild(palette);

    palette.addEventListener('click', (e) => e.stopPropagation());

    palette.querySelectorAll('.qr-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = (btn as HTMLElement).dataset.emoji!;
        const profile = loadUserProfile() || userProfile;
        const current = obj.reactions?.find(r => r.emoji === emoji);
        const removing = current?.user === profile.username;
        if (removing) removeReaction(obj.id, emoji);
        else addReaction(obj.id, emoji);
        palette.remove();
        showDiscoveryMessage(`${profile.avatar || ''} @${profile.username} ${removing ? `unreacted ${emoji}` : `reacted ${emoji}`}`);
      });
    });
  }

  function findMyObject(obj: WallObject): string | null {
    const p = loadUserProfile();
    if (!p) return null;
    const selected = obj;
    return selected && selected.author === p.username ? selected.id : null;
  }

  function getObjPreview(obj: WallObject): string {
    switch (obj.type) {
      case 'text': return `"${obj.data.text}"`;
      case 'sticker': return `sticker ${obj.data.emoji}`;
      case 'shape': return 'a shape';
      case 'stroke': return 'a drawing';
      case 'secret': return 'a secret 🤫';
      case 'confession': return `"${obj.data.text}"`;
      case 'timecapsule': return obj.data.locked ? '🔒 locked time capsule' : `"${obj.data.text}"`;
      default: return 'something';
    }
  }

  /** Live-patch an open popup / quick-react palette with freshly synced counts. */
  function patchOpenCounts(objects: WallObject[]): void {
    const popupEl = document.querySelector('.object-info-popup') as HTMLElement | null;
    const openId = popupEl?.dataset.objectId;
    if (!openId) return;
    const openObj = objects.find(o => o.id === openId);
    if (!openObj) return;
    popupEl.querySelectorAll('.oi-react-btn').forEach(btn => {
      const emoji = (btn as HTMLElement).dataset.emoji!;
      const el = btn.querySelector('.oi-count');
      if (el) el.textContent = String(getReactionCount(openObj, emoji));
    });
    const qp = document.querySelector('.quick-react') as HTMLElement | null;
    if (qp && qp.dataset.objectId === openId) {
      qp.querySelectorAll('.qr-btn').forEach(btn => {
        const emoji = (btn as HTMLElement).dataset.emoji!;
        const el = btn.querySelector('.qr-count');
        if (el) el.textContent = getReactionCount(openObj, emoji) ? String(getReactionCount(openObj, emoji)) : '';
      });
    }
  }

  function getReactionCount(obj: WallObject, emoji: string): number {
    const r = obj.reactions?.find(rr => rr.emoji === emoji);
    return r ? r.count : 0;
  }

  function handleSecretNear(obj: WallObject): void {
    if (obj.data.revealed) {
      const popup = document.createElement('div');
      popup.className = 'object-info-popup';
      popup.style.left = '50%';
      popup.style.top = '50%';
      popup.style.transform = 'translate(-50%,-50%)';
      popup.innerHTML = `
        <div style="text-align:center;padding:8px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">a secret left by @${obj.author}</div>
          <div style="font-size:16px;font-family:var(--mono)">"${obj.data.text}"</div>
        </div>
      `;
      container.appendChild(popup);
      setTimeout(() => popup.remove(), 3000);
    } else {
      // Reveal secret when clicked
      const popup = document.createElement('div');
      popup.className = 'object-info-popup';
      popup.style.left = '50%';
      popup.style.top = '60%';
      popup.style.transform = 'translate(-50%,-50%)';
      popup.innerHTML = `
        <div style="font-size:13px;color:var(--accent);margin-bottom:8px">🤫 A secret is hidden here</div>
        <p style="font-size:12px;color:var(--text-dim);margin:8px 0">Move close to reveal it...</p>
        <button style="width:100%;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:var(--font);font-size:13px" id="reveal-btn">Reveal</button>
      `;
      container.appendChild(popup);
      popup.querySelector('#reveal-btn')?.addEventListener('click', () => {
        updateObject(obj.id, { data: { ...obj.data, revealed: true } });
        popup.remove();
        handleObjectSelected({ ...obj, data: { ...obj.data, revealed: true } });
      });
    }
  }

  function openComments(obj: WallObject, fromConfession = false): void {
    // The corridor frames the same panel as replies to a confession.
    const isConfession = fromConfession || obj.type === 'confession';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>${isConfession ? '💬 Replies' : '💬 Comments'}</h3>
        <div style="max-height:200px;overflow-y:auto;margin-bottom:12px" class="comments-list">
          ${(obj.comments || []).map(c => `
            <div style="padding:8px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:11px;color:var(--accent);font-family:var(--mono)">@${c.user}</span>
              <span style="font-size:12px;color:var(--text-dim);margin-left:6px">${c.text}</span>
              ${isConfession ? `<span class="comment-hide" data-id="${c.id}" title="hide this reply">🚩</span>` : ''}
              <div style="font-size:10px;color:var(--text-muted)">${formatTimeAgo(c.createdAt)}</div>
            </div>
          `).join('') || `<div style="font-size:12px;color:var(--text-muted)">${isConfession ? 'no replies yet — be the first to hold this one' : 'no comments yet'}</div>`}
        </div>
        <input type="text" placeholder="${isConfession ? 'leave a reply...' : 'leave a comment...'}" class="comment-input" style="width:100%;padding:10px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;font-family:var(--font)" />
        <button class="modal-close" style="margin-top:12px" id="send-comment">${isConfession ? 'Reply' : 'Send'}</button>
      </div>
    `;
    container.appendChild(overlay);

    // One-click floor for abusive replies to a confession (scoped to the corridor).
    overlay.querySelectorAll('.comment-hide').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id!;
        hideComment(id);
        (el.closest('div') as HTMLElement | null)?.remove();
        showDiscoveryMessage('reply hidden 🕯️');
      });
    });

    const input = overlay.querySelector('.comment-input') as HTMLInputElement;
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      const profile = loadUserProfile() || userProfile;
      addComment(obj.id, text);
      input.value = '';
      overlay.remove();
      showDiscoveryMessage(`💬 @${profile.username} ${isConfession ? 'replied' : 'commented'}`);
    };

    overlay.querySelector('#send-comment')?.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  function handleImageUpload(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          engine.addImageObject(img);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }
}
