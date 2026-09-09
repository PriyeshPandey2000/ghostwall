import {
  schema,
  table,
  t,
  SenderError,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';
import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb';

const GHOST_MICROS = 86_400_000_000n; // 24h window between expire and removal

const VALID_OBJECT_TYPES = new Set([
  'stroke',
  'text',
  'shape',
  'sticker',
  'image',
  'secret',
  'timecapsule',
]);

const ObjectData = t.object('ObjectData', {
  pathData: t.option(t.string()),
  color: t.option(t.string()),
  strokeWidth: t.option(t.number()),
  text: t.option(t.string()),
  fontSize: t.option(t.number()),
  emoji: t.option(t.string()),
  size: t.option(t.number()),
  secret: t.option(t.string()),
  unlockedAt: t.option(t.number()),
  radius: t.option(t.number()),
  locked: t.option(t.bool()),
  rotation: t.option(t.number()),
  src: t.option(t.string()),
  width: t.option(t.number()),
  height: t.option(t.number()),
  shapeType: t.option(t.string()),
  serializer: t.option(t.string()),
});

const user = table(
  { name: 'user', public: true },
  {
    identity: t.identity().primaryKey(),
    username: t.string().unique(),
    avatar: t.string(),
    bio: t.string(),
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
    online: t.bool().default(false),
    // A user's single saved spot ("Set home here" / "Find my corner").
    homeX: t.option(t.i32()).default(undefined),
    homeY: t.option(t.i32()).default(undefined),
  }
);

// One row per connected user, upserted on every cursor move. Ephemeral —
// there's no history/persistence value in a mouse position, so this is a
// ceiling-bounded (O(concurrent users)) live-presence table, not an
// append-only log. Row is deleted on disconnect so stale cursors don't linger.
const cursor = table(
  { name: 'cursor', public: true },
  {
    identity: t.identity().primaryKey(),
    x: t.i32(),
    y: t.i32(),
    updatedAt: t.timestamp(),
  }
);

// Wall-wide counters for the landing page. A client's canvas_object cache is
// range-limited to whatever's near its viewport (see subscribeCanvas on the
// client), so "marks on the wall" / "kept forever" can't be derived from a
// local row count — and "disappeared forever" can't be derived at all once
// rows are deleted. These are maintained transactionally by the reducers
// that create/remove objects.
const wall_stats = table(
  { name: 'wall_stats', public: true },
  {
    id: t.u32().primaryKey(),
    totalExpired: t.u64(),
    currentCount: t.u64().default(0n),
    keptForeverCount: t.u64().default(0n),
  }
);

const canvas_object = table(
  {
    name: 'canvas_object',
    public: true,
    indexes: [{ accessor: 'by_xy', algorithm: 'btree', columns: ['x', 'y'] }],
  },
  {
    id: t.string().primaryKey(),
    objectType: t.string(),
    x: t.i32(),
    y: t.i32(),
    rotation: t.i32(),
    scaleX: t.number(),
    scaleY: t.number(),
    width: t.i32(),
    height: t.i32(),
    data: ObjectData,
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    expiresAt: t.option(t.timestamp()),
    ghostUntil: t.option(t.timestamp()),
    keptForever: t.bool(),
    protected: t.bool(),
    revealed: t.bool(),
    authorName: t.option(t.string()),
    parentId: t.option(t.string()),
  }
);

const reaction = table(
  { name: 'reaction', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    userIdentity: t.identity(),
    reactionType: t.string(),
    createdAt: t.timestamp(),
  }
);

const comment = table(
  { name: 'comment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    userIdentity: t.identity(),
    text: t.string(),
    createdAt: t.timestamp(),
  }
);

const object_history = table(
  { name: 'object_history', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    userIdentity: t.identity(),
    action: t.string(),
    createdAt: t.timestamp(),
  }
);

const seed_state = table(
  { name: 'seed_state' },
  {
    id: t.u32().primaryKey(),
    seeded: t.bool(),
  }
);

const object_expiry = table(
  {
    name: 'object_expiry',
    scheduled: (): any => expireObject,
  },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    object_id: t.string(),
  }
);

const spacetimedb = schema({
  user,
  canvas_object,
  reaction,
  comment,
  object_history,
  seed_state,
  object_expiry,
  wall_stats,
  cursor,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function ensureUser(ctx: Ctx, identity: Identity) {
  const existing = ctx.db.user.identity.find(identity);
  if (existing) {
    ctx.db.user.identity.update({ ...existing, lastSeen: ctx.timestamp });
    return;
  }
  const hex = identity.toHexString();
  ctx.db.user.insert({
    identity,
    username: `guest_${hex.slice(hex.length - 6)}`,
    avatar: '👻',
    bio: '',
    createdAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
    online: false,
    homeX: undefined,
    homeY: undefined,
  });
}

function canonicalUsername(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (name.length < 1 || name.length > 20 || !/^[a-z0-9_-]+$/.test(name)) {
    throw new SenderError('username must be 1-20 chars of a-z, 0-9, _ or -');
  }
  return name;
}

function requireObject(ctx: Ctx, id: string) {
  const obj = ctx.db.canvas_object.id.find(id);
  if (!obj) throw new SenderError('object not found');
  return obj;
}

function touch(ctx: Ctx) {
  ensureUser(ctx, ctx.sender);
}

function scheduleExpiry(ctx: Ctx, objectId: string, ghostUntilMicros: bigint) {
  ctx.db.object_expiry.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(ghostUntilMicros),
    object_id: objectId,
  });
}

function unscheduleExpiry(ctx: Ctx, objectId: string) {
  for (const row of [...ctx.db.object_expiry.iter()].filter((r) => r.object_id === objectId)) {
    ctx.db.object_expiry.scheduled_id.delete(row.scheduled_id);
  }
}

function deleteObjectById(ctx: Ctx, id: string) {
  const obj = ctx.db.canvas_object.id.find(id);
  bumpRemoved(ctx, obj?.keptForever ?? false);
  for (const h of [...ctx.db.object_history.iter()].filter((r) => r.objectId === id)) {
    ctx.db.object_history.id.delete(h.id);
  }
  for (const r of [...ctx.db.reaction.objectId.filter(id)]) {
    ctx.db.reaction.id.delete(r.id);
  }
  for (const c of [...ctx.db.comment.objectId.filter(id)]) {
    ctx.db.comment.id.delete(c.id);
  }
  for (const child of [...ctx.db.canvas_object.iter()].filter((o) => o.parentId === id)) {
    deleteObjectById(ctx, child.id);
  }
  ctx.db.canvas_object.id.delete(id);
}

// currentCount/keptForeverCount track the WHOLE wall — a client's canvas_object
// cache is range-limited to its viewport (see subscribeCanvas in spacetime.ts),
// so counting local rows would undercount these on the landing page.
function bumpCreated(ctx: Ctx, keptForever: boolean) {
  const existing = ctx.db.wall_stats.id.find(1);
  if (existing) {
    ctx.db.wall_stats.id.update({
      ...existing,
      currentCount: existing.currentCount + 1n,
      keptForeverCount: existing.keptForeverCount + (keptForever ? 1n : 0n),
    });
  } else {
    ctx.db.wall_stats.insert({
      id: 1,
      totalExpired: 0n,
      currentCount: 1n,
      keptForeverCount: keptForever ? 1n : 0n,
    });
  }
}

function bumpKeptForeverDelta(ctx: Ctx, delta: 1n | -1n) {
  const existing = ctx.db.wall_stats.id.find(1);
  if (!existing) return;
  const next = existing.keptForeverCount + delta;
  ctx.db.wall_stats.id.update({ ...existing, keptForeverCount: next > 0n ? next : 0n });
}

function bumpRemoved(ctx: Ctx, keptForever: boolean) {
  const existing = ctx.db.wall_stats.id.find(1);
  if (existing) {
    ctx.db.wall_stats.id.update({
      ...existing,
      totalExpired: existing.totalExpired + 1n,
      currentCount: existing.currentCount > 0n ? existing.currentCount - 1n : 0n,
      keptForeverCount:
        keptForever && existing.keptForeverCount > 0n
          ? existing.keptForeverCount - 1n
          : existing.keptForeverCount,
    });
  } else {
    ctx.db.wall_stats.insert({ id: 1, totalExpired: 1n, currentCount: 0n, keptForeverCount: 0n });
  }
}

export const init = spacetimedb.init((_ctx) => {});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  ensureUser(ctx, ctx.sender);
  const row = ctx.db.user.identity.find(ctx.sender);
  if (row) ctx.db.user.identity.update({ ...row, online: true, lastSeen: ctx.timestamp });
});

// One Identity can hold multiple connections (e.g. two tabs); closing one
// tab flips online=false even if another tab of the same identity is still
// open. Acceptable for a per-browser anonymous identity model — a stray
// re-open picks the count back up within a few seconds via onConnect.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const existing = ctx.db.user.identity.find(ctx.sender);
  if (existing) {
    ctx.db.user.identity.update({ ...existing, online: false, lastSeen: ctx.timestamp });
  }
  if (ctx.db.cursor.identity.find(ctx.sender)) {
    ctx.db.cursor.identity.delete(ctx.sender);
  }
});

export const updateCursor = spacetimedb.reducer(
  { x: t.i32(), y: t.i32() },
  (ctx, { x, y }) => {
    const existing = ctx.db.cursor.identity.find(ctx.sender);
    if (existing) {
      ctx.db.cursor.identity.update({ ...existing, x, y, updatedAt: ctx.timestamp });
    } else {
      ctx.db.cursor.insert({ identity: ctx.sender, x, y, updatedAt: ctx.timestamp });
    }
  }
);

export const setHome = spacetimedb.reducer(
  { x: t.i32(), y: t.i32() },
  (ctx, { x, y }) => {
    const existing = ctx.db.user.identity.find(ctx.sender);
    if (!existing) throw new SenderError('not connected');
    ctx.db.user.identity.update({ ...existing, homeX: x, homeY: y });
  }
);

const SeedPayload = t.object('SeedPayload', {
  id: t.string(),
  objectType: t.string(),
  x: t.i32(),
  y: t.i32(),
  rotation: t.i32(),
  scaleX: t.number(),
  scaleY: t.number(),
  width: t.i32(),
  height: t.i32(),
  data: ObjectData,
  authorName: t.option(t.string()),
  parentId: t.option(t.string()),
  protected: t.bool(),
  ttlMicros: t.u64(),
  ageMicros: t.u64(),
});

export const seedObjects = spacetimedb.reducer(
  { objects: t.array(SeedPayload) },
  (ctx, { objects }) => {
    const existing = ctx.db.seed_state.id.find(1);
    if (existing) return;
    ctx.db.seed_state.insert({ id: 1, seeded: true });

    for (const seed of objects) {
      if (!VALID_OBJECT_TYPES.has(seed.objectType)) {
        throw new SenderError('unknown object type');
      }
      const created = new Timestamp(ctx.timestamp.microsSinceUnixEpoch - seed.ageMicros);
      const ttl = seed.ttlMicros;
      const keptForever = ttl === 0n;
      if (!keptForever && ttl < 0n) {
        throw new SenderError('invalid ttl');
      }
      ctx.db.canvas_object.insert({
        id: seed.id,
        objectType: seed.objectType,
        x: seed.x,
        y: seed.y,
        rotation: seed.rotation,
        scaleX: seed.scaleX,
        scaleY: seed.scaleY,
        width: seed.width,
        height: seed.height,
        data: seed.data,
        createdBy: ctx.sender,
        createdAt: created,
        expiresAt: keptForever ? undefined : new Timestamp(created.microsSinceUnixEpoch + ttl),
        ghostUntil: undefined,
        keptForever,
        protected: seed.protected,
        revealed: false,
        authorName: seed.authorName,
        parentId: seed.parentId,
      });
      bumpCreated(ctx, keptForever);
    }
  }
);

export const createObject = spacetimedb.reducer(
  {
    id: t.string(),
    objectType: t.string(),
    x: t.i32(),
    y: t.i32(),
    rotation: t.i32(),
    scaleX: t.number(),
    scaleY: t.number(),
    width: t.i32(),
    height: t.i32(),
    data: ObjectData,
    parentId: t.option(t.string()),
    ttlMicros: t.u64(),
  },
  (ctx, args) => {
    if (!VALID_OBJECT_TYPES.has(args.objectType)) {
      throw new SenderError('unknown object type');
    }
    touch(ctx);
    const created = ctx.timestamp;
    const ttl = args.ttlMicros;
    const keptForever = ttl === 0n;
    if (!keptForever && ttl < 0n) {
      throw new SenderError('invalid ttl');
    }
    ctx.db.canvas_object.insert({
      id: args.id,
      objectType: args.objectType,
      x: args.x,
      y: args.y,
      rotation: args.rotation,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      width: args.width,
      height: args.height,
      data: args.data,
      createdBy: ctx.sender,
      createdAt: created,
      expiresAt: keptForever ? undefined : new Timestamp(created.microsSinceUnixEpoch + ttl),
      ghostUntil: keptForever ? undefined : new Timestamp(created.microsSinceUnixEpoch + ttl + GHOST_MICROS),
      keptForever,
      protected: false,
      revealed: false,
      authorName: undefined,
      parentId: args.parentId,
    });
    bumpCreated(ctx, keptForever);
    if (!keptForever) {
      scheduleExpiry(ctx, args.id, created.microsSinceUnixEpoch + ttl + GHOST_MICROS);
    }
  }
);

const ObjectPatch = t.object('ObjectPatch', {
  x: t.option(t.i32()),
  y: t.option(t.i32()),
  rotation: t.option(t.i32()),
  scaleX: t.option(t.number()),
  scaleY: t.option(t.number()),
  width: t.option(t.i32()),
  height: t.option(t.i32()),
  data: t.option(ObjectData),
  revealed: t.option(t.bool()),
  keptForever: t.option(t.bool()),
  parentId: t.option(t.string()),
});

export const updateObject = spacetimedb.reducer(
  { id: t.string(), patch: ObjectPatch },
  (ctx, { id, patch }) => {
    const obj = requireObject(ctx, id);

    const geometryChanged =
      patch.x !== undefined ||
      patch.y !== undefined ||
      patch.rotation !== undefined ||
      patch.scaleX !== undefined ||
      patch.scaleY !== undefined ||
      patch.width !== undefined ||
      patch.height !== undefined ||
      patch.data !== undefined ||
      patch.parentId !== undefined ||
      patch.keptForever !== undefined;

    if (obj.protected && geometryChanged) {
      throw new SenderError('seeded objects cannot be edited');
    }

    if (patch.revealed !== undefined) {
      const isOwner = obj.createdBy.equals(ctx.sender);
      if (patch.revealed && !obj.revealed) {
        if (obj.objectType !== 'secret' && obj.objectType !== 'timecapsule') {
          throw new SenderError('only secrets can be revealed');
        }
      } else if (!patch.revealed && !isOwner) {
        throw new SenderError('only the author can re-hide a secret');
      }
    }

    if (geometryChanged && !obj.createdBy.equals(ctx.sender)) {
      throw new SenderError('only the author can modify an object');
    }

    touch(ctx);
    const wasForever = obj.keptForever;
    const nextForever = patch.keptForever === undefined ? obj.keptForever : patch.keptForever;

    let next = {
      ...obj,
      ...(patch.x !== undefined ? { x: patch.x } : {}),
      ...(patch.y !== undefined ? { y: patch.y } : {}),
      ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
      ...(patch.scaleX !== undefined ? { scaleX: patch.scaleX } : {}),
      ...(patch.scaleY !== undefined ? { scaleY: patch.scaleY } : {}),
      ...(patch.width !== undefined ? { width: patch.width } : {}),
      ...(patch.height !== undefined ? { height: patch.height } : {}),
      ...(patch.data !== undefined ? { data: patch.data } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      keptForever: nextForever,
      revealed: patch.revealed ?? obj.revealed,
      protected: obj.protected || (patch.revealed ?? obj.revealed) || obj.revealed,
    };

    if (wasForever && !nextForever) {
      const t0 = ctx.timestamp.microsSinceUnixEpoch;
      next = {
        ...next,
        expiresAt: new Timestamp(t0 + GHOST_MICROS),
        ghostUntil: new Timestamp(t0 + 2n * GHOST_MICROS),
      };
    }

    ctx.db.canvas_object.id.update(next);

    if (wasForever !== nextForever) {
      bumpKeptForeverDelta(ctx, nextForever ? 1n : -1n);
    }
    if (wasForever && !nextForever) {
      scheduleExpiry(ctx, obj.id, next.ghostUntil!.microsSinceUnixEpoch);
    }
    if (!wasForever && nextForever) {
      unscheduleExpiry(ctx, obj.id);
    }
  }
);

export const deleteObject = spacetimedb.reducer({ id: t.string() }, (ctx, { id }) => {
  const obj = requireObject(ctx, id);
  if (obj.protected) throw new SenderError('seeded objects cannot be deleted');
  if (!obj.createdBy.equals(ctx.sender)) {
    throw new SenderError('only the author can delete an object');
  }
  deleteObjectById(ctx, id);
});

export const drawOver = spacetimedb.reducer({ id: t.string() }, (ctx, { id }) => {
  requireObject(ctx, id);
  touch(ctx);
  ctx.db.object_history.insert({
    id: 0n,
    objectId: id,
    userIdentity: ctx.sender,
    action: 'draw_over',
    createdAt: ctx.timestamp,
  });
});

export const addReaction = spacetimedb.reducer(
  { objectId: t.string(), reactionType: t.string() },
  (ctx, { objectId, reactionType }) => {
    requireObject(ctx, objectId);
    touch(ctx);
    if (reactionType.length < 1 || reactionType.length > 32) {
      throw new SenderError('invalid reaction');
    }
    const already = [...ctx.db.reaction.objectId.filter(objectId)].some(
      (r) => r.userIdentity.equals(ctx.sender) && r.reactionType === reactionType
    );
    if (already) throw new SenderError('already reacted');
    ctx.db.reaction.insert({
      id: 0n,
      objectId,
      userIdentity: ctx.sender,
      reactionType,
      createdAt: ctx.timestamp,
    });
  }
);

export const removeReaction = spacetimedb.reducer(
  { objectId: t.string(), reactionType: t.string() },
  (ctx, { objectId, reactionType }) => {
    for (const r of [...ctx.db.reaction.objectId.filter(objectId)]) {
      if (r.userIdentity.equals(ctx.sender) && r.reactionType === reactionType) {
        ctx.db.reaction.id.delete(r.id);
      }
    }
  }
);

export const addComment = spacetimedb.reducer(
  { objectId: t.string(), text: t.string() },
  (ctx, { objectId, text }) => {
    requireObject(ctx, objectId);
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      throw new SenderError('comment must be 1-500 chars');
    }
    touch(ctx);
    ctx.db.comment.insert({
      id: 0n,
      objectId,
      userIdentity: ctx.sender,
      text: trimmed,
      createdAt: ctx.timestamp,
    });
  }
);

export const setUsername = spacetimedb.reducer(
  { username: t.string(), avatar: t.option(t.string()), bio: t.option(t.string()) },
  (ctx, { username, avatar, bio }) => {
    const existing = ctx.db.user.identity.find(ctx.sender);
    const name = canonicalUsername(username);
    if ((existing === null || existing.username !== name) && [...ctx.db.user.iter()].some((u) => u.username === name)) {
      throw new SenderError('username already taken');
    }
    const row = {
      identity: ctx.sender,
      username: name,
      avatar: avatar ?? existing?.avatar ?? '👻',
      bio: bio ?? existing?.bio ?? '',
      createdAt: existing?.createdAt ?? ctx.timestamp,
      lastSeen: ctx.timestamp,
      online: existing?.online ?? true,
      homeX: existing?.homeX,
      homeY: existing?.homeY,
    };
    if (existing) {
      ctx.db.user.identity.update(row);
    } else {
      ctx.db.user.insert(row);
    }
  }
);

// Recomputes wall_stats.currentCount/keptForeverCount from the actual
// canvas_object rows. Not called by anything client-side — a manual escape
// hatch (`spacetime call ghostwall recomputeWallStats`) for the day these
// counters drift from reality, and to backfill after adding the columns.
export const recomputeWallStats = spacetimedb.reducer((ctx) => {
  const rows = [...ctx.db.canvas_object.iter()];
  const currentCount = BigInt(rows.length);
  const keptForeverCount = BigInt(rows.filter((r) => r.keptForever).length);
  const existing = ctx.db.wall_stats.id.find(1);
  if (existing) {
    ctx.db.wall_stats.id.update({ ...existing, currentCount, keptForeverCount });
  } else {
    ctx.db.wall_stats.insert({ id: 1, totalExpired: 0n, currentCount, keptForeverCount });
  }
});

export const expireObject = spacetimedb.reducer(
  { timer: object_expiry.rowType },
  (ctx, { timer }) => {
    deleteObjectById(ctx, timer.object_id);
  }
);