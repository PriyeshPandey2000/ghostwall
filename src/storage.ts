import type { WallObject, UserProfile } from './types';

/**
 * Persistence backend abstraction.
 *
 * The canvas and UI never touch storage directly — they go through these
 * facades. Two implementations exist:
 *
 *  - LocalStorageBackend: the original single-user store (objects, profile,
 *    viewport all in localStorage). Source of truth = this browser.
 *  - SpacetimeBackend      : a shared SpacetimeDB wall. Objects/reacts/comments
 *    live server-side and stream in via subscriptions; the profile lives in the
 *    `user` table; only the viewport stays in localStorage.
 *
 * The active backend is chosen at boot (see activate* below) and swapped in as
 * the module's default export-facing functions are re-pointed to it.
 */

export type ConnectionState = 'local' | 'connecting' | 'connected' | 'disconnected';

/** Wall-wide live figures — only the shared (Spacetime) backend has real data for these. */
export interface WallLiveStats {
  marksLeft: number;
  onlineNow: number;
  visitorsToday: number;
  keptForever: number;
  disappeared: number;
}

/** A live pointer position for someone other than the current user. */
export interface LiveCursor {
  id: string;
  x: number;
  y: number;
  username: string;
  avatar: string;
}

export interface StorageBackend {
  readonly kind: 'local' | 'spacetime';
  start(): void;
  loadObjects(): WallObject[];
  saveObjects(objects: WallObject[]): void;
  addObject(obj: WallObject): void;
  removeObject(id: string): void;
  updateObject(id: string, updates: Partial<WallObject>): void;
  loadUserProfile(): UserProfile | null;
  saveUserProfile(profile: UserProfile): void;
  loadViewport(): { x: number; y: number; zoom: number } | null;
  saveViewport(viewport: { x: number; y: number; zoom: number }): void;
  react(objectId: string, emoji: string): void;
  unreact(objectId: string, emoji: string): void;
  comment(objectId: string, text: string): void;
  drawOver(objectId: string): void;
  onObjectsChanged(cb: (objects: WallObject[]) => void): void;
  onStateChanged(cb: (state: ConnectionState, detail?: string) => void): void;
  onProfileChanged(cb: (profile: UserProfile) => void): void;
  /** Only implemented by backends with real shared data (Spacetime). */
  onStatsChanged?(cb: (stats: WallLiveStats) => void): void;
  /** Broadcasts this user's pointer position. Throttle before calling. */
  sendCursor?(x: number, y: number): void;
  onCursorsChanged?(cb: (cursors: LiveCursor[]) => void): void;
  setHome?(x: number, y: number): void;
  getMyHome?(): { x: number; y: number } | null;
}

const OBJECTS_KEY = 'thewall_objects';
const USER_KEY = 'thewall_user';
const VIEWPORT_KEY = 'thewall_viewport';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — best effort only */
  }
}

export class LocalStorageBackend implements StorageBackend {
  readonly kind = 'local' as const;
  private objectCbs = new Set<(objects: WallObject[]) => void>();
  private stateCbs = new Set<(state: ConnectionState, detail?: string) => void>();
  private profileCbs = new Set<(profile: UserProfile) => void>();

  start(): void {
    this.stateCbs.forEach(cb => cb('local'));
  }

  loadObjects(): WallObject[] {
    return readJSON<WallObject[]>(OBJECTS_KEY, []);
  }

  saveObjects(objects: WallObject[]): void {
    writeJSON(OBJECTS_KEY, objects);
    this.objectCbs.forEach(cb => cb(objects));
  }

  addObject(obj: WallObject): void {
    const objects = this.loadObjects();
    objects.push(obj);
    this.saveObjects(objects);
  }

  removeObject(id: string): void {
    this.saveObjects(this.loadObjects().filter(o => o.id !== id));
  }

  updateObject(id: string, updates: Partial<WallObject>): void {
    const objects = this.loadObjects();
    const idx = objects.findIndex(o => o.id === id);
    if (idx >= 0) {
      objects[idx] = { ...objects[idx], ...updates };
      this.saveObjects(objects);
    }
  }

  loadUserProfile(): UserProfile | null {
    return readJSON<UserProfile | null>(USER_KEY, null);
  }

  saveUserProfile(profile: UserProfile): void {
    writeJSON(USER_KEY, profile);
    this.profileCbs.forEach(cb => cb(profile));
  }

  loadViewport(): { x: number; y: number; zoom: number } | null {
    return readJSON(VIEWPORT_KEY, null);
  }

  saveViewport(viewport: { x: number; y: number; zoom: number }): void {
    writeJSON(VIEWPORT_KEY, viewport);
  }

  react(objectId: string, emoji: string): void {
    const objects = this.loadObjects();
    const obj = objects.find(o => o.id === objectId);
    if (!obj) return;
    const reactions = [...obj.reactions];
    const existing = reactions.find(r => r.emoji === emoji);
    if (existing) {
      existing.count += 1;
      existing.user = this.loadUserProfile()?.username || existing.user;
    } else {
      reactions.push({ emoji, user: this.loadUserProfile()?.username || 'guest', count: 1 });
    }
    this.updateObject(objectId, { reactions });
  }

  unreact(objectId: string, emoji: string): void {
    const objects = this.loadObjects();
    const obj = objects.find(o => o.id === objectId);
    if (!obj) return;
    const reactions = [...obj.reactions];
    const existing = reactions.find(r => r.emoji === emoji);
    if (existing) {
      existing.count = Math.max(0, existing.count - 1);
      if (existing.count === 0) {
        const idx = reactions.findIndex(r => r.emoji === emoji);
        reactions.splice(idx, 1);
      }
    }
    this.updateObject(objectId, { reactions });
  }

  comment(objectId: string, text: string): void {
    const objects = this.loadObjects();
    const obj = objects.find(o => o.id === objectId);
    if (!obj) return;
    const profile = this.loadUserProfile();
    const comments = [...(obj.comments || []), { user: profile?.username || 'guest', text, createdAt: Date.now() }];
    this.updateObject(objectId, { comments });
  }

  drawOver(objectId: string): void {
    const objects = this.loadObjects();
    const obj = objects.find(o => o.id === objectId);
    if (!obj) return;
    const profile = this.loadUserProfile();
    if (profile && !obj.modifiedBy.includes(profile.username)) {
      this.updateObject(objectId, { modifiedBy: [...obj.modifiedBy, profile.username] });
    }
  }

  onObjectsChanged(cb: (objects: WallObject[]) => void): void {
    this.objectCbs.add(cb);
  }

  onStateChanged(cb: (state: ConnectionState, detail?: string) => void): void {
    this.stateCbs.add(cb);
  }

  onProfileChanged(cb: (profile: UserProfile) => void): void {
    this.profileCbs.add(cb);
  }
}

let activeBackend: StorageBackend = new LocalStorageBackend();

export function setBackend(backend: StorageBackend): void {
  activeBackend = backend;
}

export function getBackend(): StorageBackend {
  return activeBackend;
}

export function isSpacetime(): boolean {
  return activeBackend.kind === 'spacetime';
}

// ---- Convenience helpers used across the app (delegate to active backend) ----

export function loadObjects(): WallObject[] {
  return activeBackend.loadObjects();
}

export function saveObjects(objects: WallObject[]): void {
  activeBackend.saveObjects(objects);
}

export function addObject(obj: WallObject): void {
  activeBackend.addObject(obj);
}

export function removeObject(id: string): void {
  activeBackend.removeObject(id);
}

export function updateObject(id: string, updates: Partial<WallObject>): void {
  activeBackend.updateObject(id, updates);
}

export function addReaction(objectId: string, emoji: string): void {
  activeBackend.react(objectId, emoji);
}

export function removeReaction(objectId: string, emoji: string): void {
  activeBackend.unreact(objectId, emoji);
}

export function addComment(objectId: string, text: string): void {
  activeBackend.comment(objectId, text);
}

export function drawOverObject(objectId: string): void {
  activeBackend.drawOver(objectId);
}

export function loadUserProfile(): UserProfile | null {
  return activeBackend.loadUserProfile();
}

export function saveUserProfile(profile: UserProfile): void {
  activeBackend.saveUserProfile(profile);
}

export function loadViewport(): { x: number; y: number; zoom: number } | null {
  return activeBackend.loadViewport();
}

export function saveViewport(viewport: { x: number; y: number; zoom: number }): void {
  activeBackend.saveViewport(viewport);
}

export function subscribeObjects(cb: (objects: WallObject[]) => void): void {
  activeBackend.onObjectsChanged(cb);
}

export function subscribeState(cb: (state: ConnectionState, detail?: string) => void): void {
  activeBackend.onStateChanged(cb);
}

export function subscribeProfile(cb: (profile: UserProfile) => void): void {
  activeBackend.onProfileChanged(cb);
}

/** No-op on backends without real shared data (e.g. LocalStorageBackend). */
export function subscribeStats(cb: (stats: WallLiveStats) => void): void {
  activeBackend.onStatsChanged?.(cb);
}

export function sendCursor(x: number, y: number): void {
  activeBackend.sendCursor?.(x, y);
}

export function subscribeCursors(cb: (cursors: LiveCursor[]) => void): void {
  activeBackend.onCursorsChanged?.(cb);
}

export function setHome(x: number, y: number): void {
  activeBackend.setHome?.(x, y);
}

export function getMyHome(): { x: number; y: number } | null {
  return activeBackend.getMyHome?.() ?? null;
}