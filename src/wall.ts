import { CanvasEngine } from './canvas';
import { seedWallIfNeeded } from './seed';
import { isSpacetime, loadUserProfile, saveUserProfile, subscribeObjects, updateObject } from './storage';
import { formatTimeAgo, formatTimeLeft, getRandomUsername } from './utils';
import type { WallObject } from './types';

type Tool = 'select' | 'draw' | 'erase' | 'text' | 'rect' | 'circle' | 'sticker' | 'image' | 'secret' | 'timecapsule' | 'react';

// All tools live in one horizontal bar — no hidden submenu. The four verbs that
// matter on a first visit come first; the rest follow in the same row.
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'draw', icon: '✏️', label: 'Draw' },
  { id: 'text', icon: 'Aa', label: 'Text' },
  { id: 'erase', icon: '🧽', label: 'Erase' },
  { id: 'react', icon: '❤️', label: 'React' },
  { id: 'select', icon: '🖱️', label: 'Select & pan' },
  { id: 'sticker', icon: '🎨', label: 'Sticker' },
  { id: 'rect', icon: '▭', label: 'Rectangle' },
  { id: 'circle', icon: '◯', label: 'Circle' },
  { id: 'image', icon: '🖼️', label: 'Image' },
  { id: 'secret', icon: '🤫', label: 'Secret' },
  { id: 'timecapsule', icon: '🔒', label: 'Time capsule' },
];

const COLORS = [
  '#ff4d4d', '#4ecdc4', '#ffeaa7', '#85c1e9', '#bb8fce',
  '#f8c471', '#82e0aa', '#f1948a', '#ffa33c', '#7d6bff',
  '#2ecc71', '#ff6b9d', '#ffffff', '#f0f0f0', '#a0a0a0',
  '#ffde59', '#54a0ff', '#ee5a24', '#00d2d3', '#ff9f1a',
];

const EMOJI_REACTIONS = ['❤️', '😂', '⭐', '👍', '😮', '🪐'];

export function renderWall(container: HTMLElement, initial: { explore?: boolean; deepLink?: string }): void {
  container.innerHTML = `
    <div class="canvas-page">
      <div class="canvas-container" id="canvas-container"></div>

      <div class="top-bar">
        <div class="top-bar-left">
          <button class="top-btn" id="btn-profile">👤 <span id="profile-name">Enter username</span></button>
        </div>
        <div class="top-bar-right">
          <div class="zoom-indicator" id="zoom-indicator">100%</div>
          <button class="top-btn accent" id="btn-explore">🔭 Explore</button>
        </div>
      </div>

      <div class="discover-fab" id="btn-discover" title="Take me somewhere weird">
        <span class="fab-die">🎲</span><span class="fab-label">Find something weird</span>
      </div>

      <div class="toolbar" id="toolbar">
        ${TOOLS.map(t => `
          <button class="tool-btn ${t.id === 'draw' ? 'active' : ''}" data-tool="${t.id}" data-tooltip="${t.label}">
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

  const engine = new CanvasEngine({
    container: canvasEl,
    onZoomChange: (zoom) => {
      const el = document.getElementById('zoom-indicator');
      if (el) el.textContent = `${Math.round(zoom * 100)}%`;
    },
    onObjectSelected: (obj) => handleObjectSelected(obj),
    onToolChange: () => {},
  });

  if (isSpacetime()) {
    subscribeObjects((objects) => engine.syncObjects(objects));
  }

  updateProfileDisplay(userProfile);

  setupToolbar(engine, userProfile);
  setupColorPicker();
  setupTopBar(engine, userProfile);
  setupKeyboard(engine);

  maybeShowOnboarding();
  maybeShowDrawHint();

  // Handle deep links
  if (initial.deepLink) {
    if (!engine.teleportToObjectId(initial.deepLink)) {
      showExplorerCTA();
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
  }

  /**
   * "Take me somewhere weird" — jump to an interesting mark and show a rich
   * reveal card (what it is, who left it, how long ago, how many people changed
   * it). This is the exploration hook that makes the wall feel alive.
   */
  function doWeirdDiscovery(engineRef: CanvasEngine): void {
    const all = engineRef.getObjects();
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

  /** One-time nudge that reveals the first action — you're already in Draw mode. */
  function maybeShowDrawHint(): void {
    if (localStorage.getItem('thewall_draw_hint')) return;
    localStorage.setItem('thewall_draw_hint', '1');
    const hint = document.createElement('div');
    hint.className = 'draw-hint';
    hint.innerHTML = '✏️ Draw anywhere';
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

    const popup = document.createElement('div');
    popup.className = 'object-info-popup';

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
        ${EMOJI_REACTIONS.map(r => `
          <button class="oi-react-btn" data-emoji="${r}">${r} <span class="oi-count">${getReactionCount(obj, r)}</span></button>
        `).join('')}
      </div>
      <div class="oi-actions">
        <button class="oi-action primary" id="btn-draw-over">✏️ Draw over it</button>
        <button class="oi-action primary" id="btn-share">🔗 Share</button>
        <button class="oi-action" id="btn-comment">💬</button>
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
        const reactions = [...obj.reactions];
        const existingReaction = reactions.find(r => r.emoji === emoji);
        if (existingReaction) {
          if (existingReaction.user === profile.username) {
            existingReaction.count = Math.max(0, existingReaction.count - 1);
          } else {
            existingReaction.count += 1;
            existingReaction.user = profile.username;
          }
        } else {
          reactions.push({ emoji, user: profile.username, count: 1 });
        }
        updateObject(obj.id, { reactions });
        const updated = engine.getObjects().find(o => o.id === obj.id);
        closePopup();
        handleObjectSelected(updated || obj);
      });
    });

    popup.querySelector('#btn-draw-over')?.addEventListener('click', () => {
      engine.setTool('draw');
      const myProfile = loadUserProfile() || userProfile;
      if (!obj.modifiedBy.includes(myProfile.username)) {
        updateObject(obj.id, { modifiedBy: [...obj.modifiedBy, myProfile.username] });
      }
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
    palette.innerHTML = `
      ${EMOJI_REACTIONS.map(r => `
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
        const reactions = [...obj.reactions];
        const existingReaction = reactions.find(r => r.emoji === emoji);
        if (existingReaction) {
          if (existingReaction.user === profile.username) {
            existingReaction.count = Math.max(0, existingReaction.count - 1);
          } else {
            existingReaction.count += 1;
            existingReaction.user = profile.username;
          }
        } else {
          reactions.push({ emoji, user: profile.username, count: 1 });
        }
updateObject(obj.id, { reactions });
        palette.remove();
        showDiscoveryMessage(`${profile.avatar || ''} @${profile.username} reacted ${emoji}`);
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
      case 'timecapsule': return obj.data.locked ? '🔒 locked time capsule' : `"${obj.data.text}"`;
      default: return 'something';
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

  function openComments(obj: WallObject): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>💬 Comments</h3>
        <div style="max-height:200px;overflow-y:auto;margin-bottom:12px" class="comments-list">
          ${(obj.comments || []).map(c => `
            <div style="padding:8px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:11px;color:var(--accent);font-family:var(--mono)">@${c.user}</span>
              <span style="font-size:12px;color:var(--text-dim);margin-left:6px">${c.text}</span>
              <div style="font-size:10px;color:var(--text-muted)">${formatTimeAgo(c.createdAt)}</div>
            </div>
          `).join('') || '<div style="font-size:12px;color:var(--text-muted)">no comments yet</div>'}
        </div>
        <input type="text" placeholder="leave a comment..." class="comment-input" style="width:100%;padding:10px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;font-family:var(--font)" />
        <button class="modal-close" style="margin-top:12px" id="send-comment">Send</button>
      </div>
    `;
    container.appendChild(overlay);

    const input = overlay.querySelector('.comment-input') as HTMLInputElement;
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      const profile = loadUserProfile() || userProfile;
      const comments = [...(obj.comments || []), { user: profile.username, text, createdAt: Date.now() }];
      updateObject(obj.id, { comments });
      input.value = '';
      overlay.remove();
      showDiscoveryMessage(`💬 @${profile.username} commented`);
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
