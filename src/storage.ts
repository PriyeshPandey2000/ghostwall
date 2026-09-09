import type { WallObject, UserProfile } from './types';

/**
 * Persistence is a convenience, not a dependency.
 *
 * The source of truth for a session is the in-memory state held by the canvas
 * engine. localStorage here is OPTIONAL — it lets the same user refresh and
 * keep their own local wall. The product must work fine even if it's in
 * private mode, quota is full, or the store is cleared.
 *
 * There is NO account, cloud sync, or backend today. This file just wraps
 * localStorage in tiny helpers so callers don't touch the store directly.
 */
interface LocalStore {
  loadObjects(): WallObject[];
  saveObjects(objects: WallObject[]): void;
  loadUserProfile(): UserProfile | null;
  saveUserProfile(profile: UserProfile): void;
  loadViewport(): { x: number; y: number; zoom: number } | null;
  saveViewport(viewport: { x: number; y: number; zoom: number }): void;
}

const OBJECTS_KEY = 'thewall_objects';
const USER_KEY = 'thewall_user';
const VIEWPORT_KEY = 'thewall_viewport';

const localStore: LocalStore = {
  loadObjects(): WallObject[] {
    try {
      const raw = localStorage.getItem(OBJECTS_KEY);
      return raw ? (JSON.parse(raw) as WallObject[]) : [];
    } catch {
      return [];
    }
  },

  saveObjects(objects: WallObject[]): void {
    try {
      localStorage.setItem(OBJECTS_KEY, JSON.stringify(objects));
    } catch {
      /* quota / private mode — best effort only */
    }
  },

  loadUserProfile(): UserProfile | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as UserProfile) : null;
    } catch {
      return null;
    }
  },

  saveUserProfile(profile: UserProfile): void {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(profile));
    } catch {
      /* best effort */
    }
  },

  loadViewport(): { x: number; y: number; zoom: number } | null {
    try {
      const raw = localStorage.getItem(VIEWPORT_KEY);
      return raw ? (JSON.parse(raw) as { x: number; y: number; zoom: number }) : null;
    } catch {
      return null;
    }
  },

  saveViewport(viewport: { x: number; y: number; zoom: number }): void {
    try {
      localStorage.setItem(VIEWPORT_KEY, JSON.stringify(viewport));
    } catch {
      /* best effort */
    }
  },
};

// ---- Convenience helpers used across the app (delegate to localStore) ----

export function loadObjects(): WallObject[] {
  return localStore.loadObjects();
}

export function saveObjects(objects: WallObject[]): void {
  localStore.saveObjects(objects);
}

export function loadUserProfile(): UserProfile | null {
  return localStore.loadUserProfile();
}

export function saveUserProfile(profile: UserProfile): void {
  localStore.saveUserProfile(profile);
}

export function loadViewport(): { x: number; y: number; zoom: number } | null {
  return localStore.loadViewport();
}

export function saveViewport(viewport: { x: number; y: number; zoom: number }): void {
  localStore.saveViewport(viewport);
}

export function removeObject(id: string): void {
  localStore.saveObjects(localStore.loadObjects().filter(o => o.id !== id));
}

export function addObject(obj: WallObject): void {
  const objects = localStore.loadObjects();
  objects.push(obj);
  localStore.saveObjects(objects);
}

export function updateObject(id: string, updates: Partial<WallObject>): void {
  const objects = localStore.loadObjects();
  const idx = objects.findIndex(o => o.id === id);
  if (idx >= 0) {
    objects[idx] = { ...objects[idx], ...updates };
    localStore.saveObjects(objects);
  }
}
