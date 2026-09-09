import type { WallObject, UserProfile } from './types';

/**
 * Storage backend interface.
 *
 * The rest of the app talks to this interface, NOT to a specific store.
 * Swap `LocalStorageBackend` for an API-backed backend later (Postgres/S3 +
 * websocket) without touching canvas.ts / wall.ts.
 */
export interface StorageBackend {
  loadObjects(): WallObject[];
  saveObjects(objects: WallObject[]): void;
  loadUserProfile(): UserProfile | null;
  saveUserProfile(profile: UserProfile): void;
  loadViewport(): { x: number; y: number; zoom: number } | null;
  saveViewport(viewport: { x: number; y: number; zoom: number }): void;
  // Async bridge for future backend (no-op today, full in API backend).
  init?(): Promise<void>;
}

const OBJECTS_KEY = 'thewall_objects';
const USER_KEY = 'thewall_user';
const VIEWPORT_KEY = 'thewall_viewport';

class LocalStorageBackend implements StorageBackend {
  private safeGet<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private safeSet(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota/private-mode — fail silently for now */
    }
  }

  loadObjects(): WallObject[] {
    return this.safeGet<WallObject[]>(OBJECTS_KEY, []);
  }

  saveObjects(objects: WallObject[]): void {
    this.safeSet(OBJECTS_KEY, objects);
  }

  loadUserProfile(): UserProfile | null {
    return this.safeGet<UserProfile | null>(USER_KEY, null);
  }

  saveUserProfile(profile: UserProfile): void {
    this.safeSet(USER_KEY, profile);
  }

  loadViewport(): { x: number; y: number; zoom: number } | null {
    return this.safeGet<{ x: number; y: number; zoom: number } | null>(VIEWPORT_KEY, null);
  }

  saveViewport(viewport: { x: number; y: number; zoom: number }): void {
    this.safeSet(VIEWPORT_KEY, viewport);
  }
}

/** The active backend. Point this at an API cloud backend later. */
export const backend: StorageBackend = new LocalStorageBackend();

// ---- Convenience helpers used across the app (delegate to `backend`) ----

export function loadObjects(): WallObject[] {
  return backend.loadObjects();
}

export function saveObjects(objects: WallObject[]): void {
  backend.saveObjects(objects);
}

export function loadUserProfile(): UserProfile | null {
  return backend.loadUserProfile();
}

export function saveUserProfile(profile: UserProfile): void {
  backend.saveUserProfile(profile);
}

export function loadViewport(): { x: number; y: number; zoom: number } | null {
  return backend.loadViewport();
}

export function saveViewport(viewport: { x: number; y: number; zoom: number }): void {
  backend.saveViewport(viewport);
}

export function removeObject(id: string): void {
  backend.saveObjects(backend.loadObjects().filter(o => o.id !== id));
}

export function addObject(obj: WallObject): void {
  const objects = backend.loadObjects();
  objects.push(obj);
  backend.saveObjects(objects);
}

export function updateObject(id: string, updates: Partial<WallObject>): void {
  const objects = backend.loadObjects();
  const idx = objects.findIndex(o => o.id === id);
  if (idx >= 0) {
    objects[idx] = { ...objects[idx], ...updates };
    backend.saveObjects(objects);
  }
}
