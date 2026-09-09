import { DbConnection, tables } from './module_bindings';
import type { SubscriptionHandle } from './module_bindings';
import type {
  CanvasObject,
  Comment as CommentRow,
  Cursor as CursorRow,
  ObjectHistory as ObjectHistoryRow,
  ObjectPatch,
  Reaction as ReactionRow,
  SeedPayload,
  User as UserRow,
  WallStats as WallStatsRow,
} from './module_bindings/types';
import { objectDataToWallData, wallToObjectData } from './map';
import type { ConnectionState, LiveCursor, StorageBackend, WallLiveStats } from './storage';
import type { UserProfile, WallObject, Reaction } from './types';
import type { Timestamp } from 'spacetimedb';

const VIEWPORT_KEY = 'thewall_viewport';
const USER_KEY = 'thewall_user';

const MICROS_MS = 1000n;

function microsToMs(t: Timestamp): number {
  return Number(t.microsSinceUnixEpoch / MICROS_MS);
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface Range {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SpacetimeBackend implements StorageBackend {
  readonly kind = 'spacetime' as const;

  private readonly uri: string;
  private readonly db: string;
  private started = false;
  private disposed = false;
  private conn: DbConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  private state: ConnectionState = 'connecting';
  private myIdentityHex: string | null = localStorage.getItem('spacetime_identity');

  private canvasRows = new Map<string, CanvasObject>();
  private reactions = new Map<string, ReactionRow[]>();
  private comments = new Map<string, CommentRow[]>();
  private history = new Map<string, ObjectHistoryRow[]>();
  private usersById = new Map<string, UserRow>();
  private wallStatsRow: WallStatsRow | null = null;
  private cursorsById = new Map<string, CursorRow>();

  private objs = new Map<string, WallObject>();
  private pendingAdds = new Set<string>();

  private range: Range | null = null;
  private objectSub: SubscriptionHandle | null = null;
  private resubTimer: ReturnType<typeof setTimeout> | null = null;
  private baseApplied = false;
  private canvasApplied = false;
  private seededSent = false;

  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private objectCbs = new Set<(objects: WallObject[]) => void>();
  private stateCbs = new Set<(state: ConnectionState, detail?: string) => void>();
  private profileCbs = new Set<(profile: UserProfile) => void>();
  private statsCbs = new Set<(stats: WallLiveStats) => void>();
  private cursorCbs = new Set<(cursors: LiveCursor[]) => void>();

  constructor(uri: string, db: string) {
    this.uri = uri;
    this.db = db;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.setState('connecting');
    void this.connect();
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (state !== this.state) {
      this.state = state;
      this.stateCbs.forEach(cb => cb(state, detail));
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.started) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** this.attempts), 30000);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.conn) {
        try {
          this.conn.disconnect();
        } catch {
          /* ignore */
        }
        this.conn = null;
      }
    } catch {
      /* ignore */
    }

    const builder = DbConnection.builder().withUri(this.uri).withDatabaseName(this.db);
    const token = localStorage.getItem(this.tokenKey());
    if (token) builder.withToken(token);

    builder.onConnect((conn, identity, token) => {
      this.conn = conn;
      this.myIdentityHex = identity.toHexString();
      localStorage.setItem(this.tokenKey(), token);
      localStorage.setItem('spacetime_identity', this.myIdentityHex);
      this.attempts = 0;
      this.baseApplied = false;
      this.canvasApplied = false;
      this.setState('connected');
      this.attachTableCallbacks(conn);
      this.subscribeBase(conn);
      this.subscribeCanvas(conn);
    });

    builder.onConnectError((_ctx, error) => {
      this.setState('disconnected', error?.message || 'cannot reach server');
      this.scheduleReconnect();
    });

    builder.onDisconnect((_ctx, error) => {
      this.setState('disconnected', error?.message || 'disconnected');
      this.scheduleReconnect();
    });

    try {
      const conn = builder.build();
      this.conn = conn;
    } catch (error) {
      this.setState('disconnected', error instanceof Error ? error.message : 'failed to connect');
      this.scheduleReconnect();
    }
  }

  private tokenKey(): string {
    return `spacetime_token:${this.db}`;
  }

  private attachTableCallbacks(conn: DbConnection): void {
    const db = conn.db;

    db.canvasObject.onInsert((_ctx, row) => this.onCanvasUpsert(row));
    db.canvasObject.onUpdate((_ctx, _old, row) => this.onCanvasUpsert(row));
    db.canvasObject.onDelete((_ctx, row) => this.onCanvasDelete(row.id));

    db.reaction.onInsert((_ctx, row) => {
      this.pushRow(this.reactions, row.objectId, row);
      this.scheduleSync();
    });
    db.reaction.onUpdate((_ctx, _old, row) => this.onReactionUpsert(row));
    db.reaction.onDelete((_ctx, row) => {
      this.dropRow(this.reactions, row.objectId, row);
      this.scheduleSync();
    });

    db.comment.onInsert((_ctx, row) => {
      this.pushRow(this.comments, row.objectId, row);
      this.scheduleSync();
    });
    db.comment.onUpdate((_ctx, _old, row) => this.onCommentUpsert(row));
    db.comment.onDelete((_ctx, row) => {
      this.dropRow(this.comments, row.objectId, row);
      this.scheduleSync();
    });

    db.objectHistory.onInsert((_ctx, row) => {
      this.pushRow(this.history, row.objectId, row);
      this.scheduleSync();
    });
    db.objectHistory.onUpdate((_ctx, _old, row) => this.onHistoryUpsert(row));
    db.objectHistory.onDelete((_ctx, row) => {
      this.dropRow(this.history, row.objectId, row);
      this.scheduleSync();
    });

    db.user.onInsert((_ctx, row) => this.onUserUpsert(row));
    db.user.onUpdate((_ctx, _old, row) => this.onUserUpsert(row));
    db.user.onDelete((_ctx, row) => {
      this.usersById.delete(row.identity.toHexString());
      this.scheduleSync();
    });

    db.wallStats.onInsert((_ctx, row) => {
      this.wallStatsRow = row;
      this.scheduleSync();
    });
    db.wallStats.onUpdate((_ctx, _old, row) => {
      this.wallStatsRow = row;
      this.scheduleSync();
    });

    db.cursor.onInsert((_ctx, row) => {
      this.cursorsById.set(row.identity.toHexString(), row);
      this.scheduleCursorSync();
    });
    db.cursor.onUpdate((_ctx, _old, row) => {
      this.cursorsById.set(row.identity.toHexString(), row);
      this.scheduleCursorSync();
    });
    db.cursor.onDelete((_ctx, row) => {
      this.cursorsById.delete(row.identity.toHexString());
      this.scheduleCursorSync();
    });
  }

  private pushRow<T extends { id: bigint }>(map: Map<string, T[]>, key: string, row: T): void {
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }

  private dropRow<T extends { id: bigint }>(map: Map<string, T[]>, key: string, row: T): void {
    const list = (map.get(key) ?? []).filter(r => r.id !== row.id);
    if (list.length === 0) map.delete(key);
    else map.set(key, list);
  }

  private onReactionUpsert(row: ReactionRow): void {
    const list = (this.reactions.get(row.objectId) ?? []).filter(r => r.id !== row.id);
    list.push(row);
    if (list.length) this.reactions.set(row.objectId, list);
    this.scheduleSync();
  }

  private onCommentUpsert(row: CommentRow): void {
    const list = (this.comments.get(row.objectId) ?? []).filter(r => r.id !== row.id);
    list.push(row);
    if (list.length) this.comments.set(row.objectId, list);
    this.scheduleSync();
  }

  private onHistoryUpsert(row: ObjectHistoryRow): void {
    const list = (this.history.get(row.objectId) ?? []).filter(r => r.id !== row.id);
    list.push(row);
    if (list.length) this.history.set(row.objectId, list);
    this.scheduleSync();
  }

  private onUserUpsert(row: UserRow): void {
    this.usersById.set(row.identity.toHexString(), row);
    if (this.myIdentityHex && row.identity.toHexString() === this.myIdentityHex) {
      const profile: UserProfile = {
        username: row.username,
        avatar: row.avatar,
        bio: row.bio,
        favorites: [],
        createdAt: microsToMs(row.createdAt),
      };
      this.profileCbs.forEach(cb => cb(profile));
    }
    this.scheduleSync();
  }

  private onCanvasUpsert(row: CanvasObject): void {
    this.pendingAdds.delete(row.id);
    this.canvasRows.set(row.id, row);
    this.scheduleSync();
  }

  private onCanvasDelete(id: string): void {
    this.canvasRows.delete(id);
    this.objs.delete(id);
    this.pendingAdds.delete(id);
    this.reactions.delete(id);
    this.comments.delete(id);
    this.history.delete(id);
    this.scheduleSync();
  }

  private subscribeBase(conn: DbConnection): void {
    conn.subscriptionBuilder()
      .onApplied(() => {
        this.baseApplied = true;
        this.maybeSeed();
      })
      .subscribe([tables.user, tables.reaction, tables.comment, tables.objectHistory, tables.wallStats, tables.cursor]);
  }

  private subscribeCanvas(conn: DbConnection): void {
    let query: ReturnType<typeof tables.canvasObject.where>;
    if (this.range) {
      const r = this.range;
      query = tables.canvasObject.where(q =>
        q.x.gte(r.minX).and(q.x.lte(r.maxX)).and(q.y.gte(r.minY)).and(q.y.lte(r.maxY)),
      );
    } else {
      query = tables.canvasObject.where(() => true);
    }

    const previous = this.objectSub;
    const sub = conn.subscriptionBuilder()
      .onApplied(() => {
        this.canvasApplied = true;
        this.maybeSeed();
        if (previous) {
          try {
            previous.unsubscribe();
          } catch {
            /* ignore */
          }
        }
      })
      .subscribe(query);
    this.objectSub = sub;
  }

  private maybeSeed(): void {
    if (!this.baseApplied || !this.canvasApplied || this.seededSent || !this.conn) return;
    this.seededSent = true;
    // Dynamic import avoids a static cycle with seed.ts -> canvas.ts -> storage.ts.
    void import('./seed')
      .then((m) => this.sendSeeds(m.buildSeedPayloads))
      .catch(() => {});
  }

  private sendSeeds(buildSeedPayloads: () => SeedPayload[]): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.seedObjects({ objects: buildSeedPayloads() }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  private currentUserRows(): Map<string, UserRow> {
    return this.usersById;
  }

  private rowToWall(row: CanvasObject): WallObject {
    const type = row.objectType as WallObject['type'];
    const users = this.currentUserRows();
    const data = objectDataToWallData(type, row.data, { revealed: row.revealed, rotation: row.rotation });

    const counts = new Map<string, number>();
    for (const r of this.reactions.get(row.id) ?? []) {
      counts.set(r.reactionType, (counts.get(r.reactionType) ?? 0) + 1);
    }
    const reactions: Reaction[] = [];
    for (const [emoji, count] of counts) {
      const last = (this.reactions.get(row.id) ?? []).filter(r => r.reactionType === emoji).pop();
      const user = last ? users.get(last.userIdentity.toHexString())?.username ?? '' : '';
      reactions.push({ emoji, user, count });
    }

    const comments = (this.comments.get(row.id) ?? [])
      .slice()
      .sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch))
      .map(c => ({
        user: users.get(c.userIdentity.toHexString())?.username ?? 'guest',
        text: c.text,
        createdAt: microsToMs(c.createdAt),
      }));

    const modifiedBy: string[] = [];
    for (const h of this.history.get(row.id) ?? []) {
      const u = users.get(h.userIdentity.toHexString());
      if (u && !modifiedBy.includes(u.username)) modifiedBy.push(u.username);
    }

    const owner = users.get(row.createdBy.toHexString());
    return {
      id: row.id,
      type,
      x: row.x,
      y: row.y,
      data,
      author: row.authorName ?? owner?.username ?? 'guest',
      createdAt: microsToMs(row.createdAt),
      expiresAt: row.expiresAt ? microsToMs(row.expiresAt) : null,
      ghostUntil: row.ghostUntil ? microsToMs(row.ghostUntil) : undefined,
      keptForever: row.keptForever,
      reactions,
      comments,
      parentId: row.parentId ?? null,
      modifiedBy,
    };
  }

  private recompute(): void {
    const serverIds = new Set(this.canvasRows.keys());
    for (const id of [...this.objs.keys()]) {
      if (!serverIds.has(id) && !this.pendingAdds.has(id)) {
        this.objs.delete(id);
      }
    }
    for (const row of this.canvasRows.values()) {
      if (this.range && (row.x < this.range.minX || row.x > this.range.maxX || row.y < this.range.minY || row.y > this.range.maxY)) {
        continue;
      }
      this.objs.set(row.id, this.rowToWall(row));
    }
  }

  private computeStats(): WallLiveStats {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let onlineNow = 0;
    let visitorsToday = 0;
    for (const row of this.usersById.values()) {
      if (row.online) onlineNow++;
      if (now - microsToMs(row.lastSeen) < dayMs) visitorsToday++;
    }
    return {
      marksLeft: Number(this.wallStatsRow?.currentCount ?? 0n),
      keptForever: Number(this.wallStatsRow?.keptForeverCount ?? 0n),
      disappeared: Number(this.wallStatsRow?.totalExpired ?? 0n),
      onlineNow,
      visitorsToday,
    };
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.recompute();
      const objects = [...this.objs.values()].sort((a, b) => a.createdAt - b.createdAt);
      this.objectCbs.forEach(cb => cb(objects));
      const stats = this.computeStats();
      this.statsCbs.forEach(cb => cb(stats));
    }, 40);
  }

  private computeCursors(): LiveCursor[] {
    const cursors: LiveCursor[] = [];
    for (const [id, row] of this.cursorsById) {
      if (id === this.myIdentityHex) continue;
      const user = this.usersById.get(id);
      cursors.push({
        id,
        x: row.x,
        y: row.y,
        username: user?.username ?? 'guest',
        avatar: user?.avatar ?? '👻',
      });
    }
    return cursors;
  }

  // Decoupled from scheduleSync's 40ms debounce: cursor moves happen far more
  // often than object/stat changes and shouldn't force a full object recompute.
  private scheduleCursorSync(): void {
    if (this.cursorSyncTimer) return;
    this.cursorSyncTimer = setTimeout(() => {
      this.cursorSyncTimer = null;
      const cursors = this.computeCursors();
      this.cursorCbs.forEach(cb => cb(cursors));
    }, 60);
  }

  // ---- StorageBackend interface ----

  loadObjects(): WallObject[] {
    return [...this.objs.values()];
  }

  saveObjects(_objects: WallObject[]): void {
    // Undo/redo snapshots stay local; the live wall is the server's truth.
  }

  addObject(obj: WallObject): void {
    this.objs.set(obj.id, obj);
    this.scheduleSync();
    if (!this.conn) return;
    this.pendingAdds.add(obj.id);
    const ttlMicros = obj.expiresAt && obj.createdAt
      ? BigInt(obj.expiresAt - obj.createdAt) * 1000n
      : 0n;
    try {
      void this.conn.reducers.createObject({
        id: obj.id,
        objectType: obj.type,
        x: Math.round(obj.x),
        y: Math.round(obj.y),
        rotation: Math.round(typeof obj.data.rotation === 'number' ? obj.data.rotation : 0),
        scaleX: 1,
        scaleY: 1,
        width: 0,
        height: 0,
        data: wallToObjectData(obj.type, obj.data),
        parentId: obj.parentId ?? undefined,
        ttlMicros,
      }).catch(() => {
        this.objs.delete(obj.id);
        this.pendingAdds.delete(obj.id);
        this.scheduleSync();
      });
    } catch {
      this.objs.delete(obj.id);
      this.pendingAdds.delete(obj.id);
      this.scheduleSync();
    }
  }

  removeObject(id: string): void {
    const had = this.objs.get(id);
    this.objs.delete(id);
    this.pendingAdds.delete(id);
    this.scheduleSync();
    if (!this.conn) return;
    try {
      void this.conn.reducers.deleteObject({ id }).catch(() => {
        if (had && !this.canvasRows.has(id)) {
          this.objs.set(id, had);
          this.scheduleSync();
        }
      });
    } catch {
      if (had) {
        this.objs.set(id, had);
        this.scheduleSync();
      }
    }
  }

  private buildPatch(prev: WallObject, next: WallObject): ObjectPatch | null {
    const dataChanged = JSON.stringify(next.data) !== JSON.stringify(prev.data);
    const reveal =
      dataChanged &&
      (prev.data as { revealed?: boolean }).revealed !== true &&
      (next.data as { revealed?: boolean }).revealed === true;

    const patch: ObjectPatch = {
      x: next.x !== prev.x ? Math.round(next.x) : undefined,
      y: next.y !== prev.y ? Math.round(next.y) : undefined,
      rotation: undefined,
      scaleX: undefined,
      scaleY: undefined,
      width: undefined,
      height: undefined,
      data: dataChanged && !reveal ? wallToObjectData(next.type, next.data) : undefined,
      revealed: reveal ? true : undefined,
      keptForever: next.keptForever !== prev.keptForever ? next.keptForever : undefined,
      parentId: next.parentId !== prev.parentId ? (next.parentId ?? undefined) : undefined,
    };

    const hasChange =
      patch.x !== undefined ||
      patch.y !== undefined ||
      patch.rotation !== undefined ||
      patch.scaleX !== undefined ||
      patch.scaleY !== undefined ||
      patch.width !== undefined ||
      patch.height !== undefined ||
      patch.data !== undefined ||
      patch.revealed !== undefined ||
      patch.keptForever !== undefined ||
      patch.parentId !== undefined;

    return hasChange ? patch : null;
  }

  updateObject(id: string, updates: Partial<WallObject>): void {
    const prev = this.objs.get(id);
    if (!prev) return;
    const data = updates.data !== undefined ? { ...prev.data, ...updates.data } : prev.data;
    const next: WallObject = { ...prev, ...updates, data };
    this.objs.set(id, next);
    this.scheduleSync();
    if (!this.conn) return;
    const patch = this.buildPatch(prev, next);
    if (!patch) return;
    try {
      void this.conn.reducers.updateObject({ id, patch }).catch(() => {
        const row = this.canvasRows.get(id);
        if (row) {
          this.objs.set(id, this.rowToWall(row));
          this.scheduleSync();
        }
      });
    } catch {
      /* ignore */
    }
  }

  react(objectId: string, emoji: string): void {
    if (!this.conn) return;
    const mine = this.hasMyReaction(objectId, emoji);
    try {
      if (mine) {
        void this.conn.reducers.removeReaction({ objectId, reactionType: emoji }).catch(() => {});
      } else {
        void this.conn.reducers.addReaction({ objectId, reactionType: emoji }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  unreact(objectId: string, emoji: string): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.removeReaction({ objectId, reactionType: emoji }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  comment(objectId: string, text: string): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.addComment({ objectId, text }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  drawOver(objectId: string): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.drawOver({ id: objectId }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  hasMyReaction(objectId: string, emoji: string): boolean {
    if (!this.myIdentityHex) return false;
    return (this.reactions.get(objectId) ?? []).some(
      r => r.userIdentity.toHexString() === this.myIdentityHex && r.reactionType === emoji,
    );
  }

  loadUserProfile(): UserProfile | null {
    const cache = readJSON<UserProfile | null>(USER_KEY, null);
    if (this.myIdentityHex) {
      const row = this.usersById.get(this.myIdentityHex);
      if (row) {
        return {
          username: row.username,
          avatar: row.avatar,
          bio: row.bio,
          favorites: cache?.favorites ?? [],
          createdAt: microsToMs(row.createdAt),
        };
      }
    }
    return cache;
  }

  saveUserProfile(profile: UserProfile): void {
    writeJSON(USER_KEY, profile);
    if (this.conn) {
      try {
        void this.conn.reducers.setUsername({ username: profile.username, avatar: profile.avatar, bio: profile.bio }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    this.profileCbs.forEach(cb => cb(profile));
  }

  loadViewport(): { x: number; y: number; zoom: number } | null {
    return readJSON(VIEWPORT_KEY, null);
  }

  saveViewport(viewport: { x: number; y: number; zoom: number }): void {
    writeJSON(VIEWPORT_KEY, viewport);
    const zoom = viewport.zoom || 1;
    const margin = 1600;
    const minX = Math.floor((0 - viewport.x) / zoom) - margin;
    const maxX = Math.ceil((window.innerWidth - viewport.x) / zoom) + margin;
    const minY = Math.floor((0 - viewport.y) / zoom) - margin;
    const maxY = Math.ceil((window.innerHeight - viewport.y) / zoom) + margin;
    this.setRange({ minX, minY, maxX, maxY });
  }

  private setRange(range: Range): void {
    if (this.conn && this.range) {
      const span = Math.max(range.maxX - range.minX, range.maxY - range.minY, 1);
      const drift =
        Math.abs(range.minX - this.range.minX) +
        Math.abs(range.maxX - this.range.maxX) +
        Math.abs(range.minY - this.range.minY) +
        Math.abs(range.maxY - this.range.maxY);
      if (drift < span * 0.25) return;
    }
    this.range = range;
    if (this.conn) {
      if (this.resubTimer) clearTimeout(this.resubTimer);
      this.resubTimer = setTimeout(() => {
        this.resubTimer = null;
        this.canvasApplied = false;
        this.subscribeCanvas(this.conn!);
      }, 400);
    }
  }

  setViewportFromCamera(): void {
    const vp = this.loadViewport();
    if (vp) this.saveViewport(vp);
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

  onStatsChanged(cb: (stats: WallLiveStats) => void): void {
    this.statsCbs.add(cb);
  }

  sendCursor(x: number, y: number): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.updateCursor({ x: Math.round(x), y: Math.round(y) }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  onCursorsChanged(cb: (cursors: LiveCursor[]) => void): void {
    this.cursorCbs.add(cb);
  }

  setHome(x: number, y: number): void {
    if (!this.conn) return;
    try {
      void this.conn.reducers.setHome({ x: Math.round(x), y: Math.round(y) }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  getMyHome(): { x: number; y: number } | null {
    if (!this.myIdentityHex) return null;
    const row = this.usersById.get(this.myIdentityHex);
    if (!row || row.homeX == null || row.homeY == null) return null;
    return { x: row.homeX, y: row.homeY };
  }
}

export function createSpacetimeBackend(uri: string, db: string): SpacetimeBackend {
  return new SpacetimeBackend(uri, db);
}