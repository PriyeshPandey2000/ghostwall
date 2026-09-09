import { generateId, randomInRange } from './utils';
import { saveObjects } from './storage';
import type { WallObject } from './types';
import { DURATION_MS } from './types';
import { strokeToPathData } from './canvas';

const SEED_MARKER = 'thewall_seed_v2';

function ms(ageDays: number, ageHours = 0): number {
  return Date.now() - ageDays * 24 * 60 * 60 * 1000 - ageHours * 60 * 60 * 1000;
}

/** Build a single smooth freehand stroke path from a set of control points. */
function stroke(points: [number, number][], _color: string, size = 4): string {
  return strokeToPathData(points.map(([x, y]) => ({ x, y })), size);
}

/** Jitter a raw control-point stroke so each seeded piece isn't pixel-perfect identical. */
function jitter(points: [number, number][]): [number, number][] {
  return points.map(([x, y]) => [x + randomInRange(-1.5, 1.5), y + randomInRange(-1.5, 1.5)]);
}

interface SeedSpec {
  /** unique key used by place(); multiple pieces may share an author (characters) */
  key: string;
  author: string;
  kind: 'text' | 'stroke' | 'sticker' | 'secret' | 'timecapsule' | 'shape';
  ageDays: number;
  ageHours?: number;
  text?: string;
  color?: string;
  fontSize?: number;
  rotation?: number;
  points?: [number, number][];
  emoji?: string;
  stickerSize?: number;
  secretText?: string;
  secretRadius?: number;
  locked?: boolean;
  unlockAt?: number;
  shape?: { type: 'rect' | 'circle'; x: number; y: number; w: number; h: number; strokeWidth: number; color: string };
  /** true = never fades (kept forever flavor / historical anchor) */
  permanent?: boolean;
  /** pre-seeded signs of social life — "modified by N people" */
  modifiedBy?: string[];
  /** pre-seeded reactions */
  reactions?: string[];
}

/**
 * The V2-living wall: fewer pieces, each memorable. A few obvious characters
 * (robin's face has three contributors, milo draws several things and edits
 * other people's work, ghost keeps fading out, 404 haunts the far edge) so the
 * wall reads like a place populated by people — not a museum of 40 doodles.
 */
const BASE: SeedSpec[] = [
  // -- The face (draw-over centerpiece, three contributors) --
  {
    key: 'smiley', author: 'robin', kind: 'stroke', ageDays: 2,
    color: '#2ecc71', points: [[-150, 60], [-120, 100], [-70, 130], [0, 140], [70, 130], [120, 100], [150, 60]],
    permanent: true, modifiedBy: ['theo', 'mia', 'milo', 'sasha', 'nyx'],
  },
  {
    key: 'mustache', author: 'theo', kind: 'stroke', ageDays: 1.5,
    color: '#2b2b2b', points: [[-80, 50], [-40, 65], [0, 72], [40, 65], [80, 50]],
    permanent: true, modifiedBy: ['mia'],
  },
  {
    key: 'shades', author: 'mia', kind: 'stroke', ageDays: 1.2,
    color: '#7d6bff', points: [[-110, 85], [-95, 60], [-85, 40], [-70, 20], [-40, 5]],
    permanent: true, modifiedBy: ['nyx'],
  },
  // -- The spectacle (the wall's "wow" moments) --
  {
    key: 'aster', author: 'aster', kind: 'stroke', ageDays: 3,
    color: '#ffde59', permanent: true, modifiedBy: ['milo', 'wren'],
    points: [[0, 0], [14, -30], [6, -60], [30, -70], [52, -62], [46, -34], [60, -12], [46, 16], [30, 30], [10, 28], [-6, 48], [-22, 30], [-44, 40], [-50, 14], [-34, 2], [-46, -22], [-24, -40], [-8, -22], [-14, -2], [0, 0]],
  },
  {
    key: 'comet', author: 'comet', kind: 'stroke', ageDays: 1.1,
    color: '#7d6bff', permanent: true,
    points: [[-30, 30], [-20, -10], [0, -30], [20, -40], [40, -30], [60, 0], [90, 60], [120, 90], [170, 100]],
  },
  {
    key: 'century', author: 'century', kind: 'text', ageDays: 0.6,
    text: 'seen by 1,000 eyes', color: '#9ad0ff', fontSize: 30, permanent: true, modifiedBy: ['grid', 'sol'],
  },

  // -- Characters: the new voice that's everywhere --
  { key: 'milo1', author: 'milo', kind: 'sticker', ageDays: 0, ageHours: 0.5, emoji: '🚀', stickerSize: 52 },
  { key: 'milo2', author: 'milo', kind: 'text', ageDays: 0, ageHours: 5, text: 'this corner is mine now 🚧', color: '#54a0ff', fontSize: 16 },

  // -- Characters: ghost keeps fading --
  { key: 'ghost1', author: 'ghost', kind: 'text', ageDays: 0.99, ageHours: 23.8, text: 'i was here once… i think', color: '#6b6b6b', fontSize: 14 },
  { key: 'ghost2', author: 'ghost', kind: 'sticker', ageDays: 26, emoji: '🕸️', stickerSize: 52 },

  // -- The locked mystery (the weird find) --
  {
    key: 'fourohfour', author: '404', kind: 'text', ageDays: 365,
    text: '🔒 this is NOT a room', color: '#e8e8e8', fontSize: 15, permanent: true,
  },

  // -- Secrets (the haunting ones) --
  { key: 'luna', author: 'luna', kind: 'secret', ageDays: 1, secretText: 'the void watches back', secretRadius: 16, reactions: ['👻'] },
  { key: 'echo', author: 'echo', kind: 'secret', ageDays: 6, secretText: 'i was here first', secretRadius: 14 },

  // -- Recent marks (the alive, fresh part of the wall) --
  { key: 'nova', author: 'nova', kind: 'text', ageDays: 0, ageHours: 0.02, text: 'who is reading this?', color: '#ffeaa7', fontSize: 22, permanent: true },
  { key: 'sasha', author: 'sasha', kind: 'text', ageDays: 0, ageHours: 0.3, text: '[alex] was here', color: '#85c1e9', fontSize: 18 },
  { key: 'fern', author: 'fern', kind: 'text', ageDays: 0, ageHours: 3, text: "don't erase this", color: '#ff6b6b', fontSize: 16 },
  { key: 'rio', author: 'rio', kind: 'text', ageDays: 0, ageHours: 7.5, text: 'behold my masterpiece', color: '#b8e986', fontSize: 10, rotation: -8, modifiedBy: ['mix', 'nyx'] },
  { key: 'dev', author: 'dev', kind: 'text', ageDays: 0.4, text: 'hello from 2026 👋', color: '#f8c471', fontSize: 15 },

  // -- Hearts & doodles people actually drew --
  {
    key: 'peach', author: 'peach', kind: 'stroke', ageDays: 0.3, color: '#ff6b9d',
    points: [[0, 40], [-30, 20], [-30, 0], [-15, -15], [0, -5], [15, -15], [30, 0], [30, 20], [0, 40]],
    reactions: ['❤️', '❤️', '⭐'],
  },
  {
    key: 'crumb', author: 'crumb', kind: 'stroke', ageDays: 1.4, color: '#5454c9',
    points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 20], [20, 20], [20, 0], [20, -20]],
  },
  {
    key: 'pixel', author: 'pixel', kind: 'stroke', ageDays: 0, ageHours: 4, color: '#4ecdc4',
    points: [[-120, 40], [-80, 20], [-40, 30], [0, 10], [40, 30]],
  },

  // -- Shapes --
  { key: 'grid', author: 'grid', kind: 'shape', ageDays: 0.5, shape: { type: 'rect', x: 0, y: 0, w: 140, h: 90, strokeWidth: 3, color: '#ff6b6b' } },
  { key: 'circleman', author: 'circleman', kind: 'shape', ageDays: 2.5, shape: { type: 'circle', x: 0, y: 0, w: 80, h: 80, strokeWidth: 3, color: '#4ecdc4' } },

  // -- Time capsule —
  {
    key: 'orbit', author: 'orbit', kind: 'timecapsule', ageDays: 7, locked: true,
    unlockAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    text: 'open in 1 year',
  },

  // -- The story pieces (meta-commentary on the wall) --
  {
    key: 'kat', author: 'kat', kind: 'text', ageDays: 1.9, text: 'someone drew a mustache here', color: '#bb8fce', fontSize: 13, permanent: true, reactions: ['😂', '⭐', '😂'],
  },
  {
    key: 'moss', author: 'moss', kind: 'text', ageDays: 8, text: 'still here', color: '#82e0aa', fontSize: 14, permanent: true,
  },

  // -- The aging & disappearing (the wall's signature) --
  { key: 'quill', author: 'quill', kind: 'text', ageDays: 0.9, ageHours: 18, text: 'I found this at 2am', color: '#bb8fce', fontSize: 17 },
  { key: 'oldcrow', author: 'oldcrow', kind: 'text', ageDays: 3, text: 'i was here. trust me.', color: '#f8c471', fontSize: 16 },
  { key: 'wren', author: 'wren', kind: 'text', ageDays: 0.98, ageHours: 23, text: 'this is fading...', color: '#888', fontSize: 15 },
  { key: 'fox', author: 'fox', kind: 'sticker', ageDays: 0.99, ageHours: 23.5, emoji: '💀', stickerSize: 42 },
  { key: 'grey', author: 'grey', kind: 'text', ageDays: 23, text: 'someone left something here... once', color: '#6b6b6b', fontSize: 12 },
  {
    key: 'ancient', author: 'ancient', kind: 'stroke', ageDays: 30, color: '#f1948a',
    points: [[-60, -20], [-30, -50], [0, -20], [30, -50], [60, -20]],
  },

  // -- The last friendly sticker —
  { key: 'sprout', author: 'sprout', kind: 'sticker', ageDays: 4.5, emoji: '🌈', stickerSize: 44 },
];

/**
 * Lay the seeded wall once. Lays a lively central cluster around the origin,
 * a second neighborhood further out, and a couple of loners so random/explore
 * has places to take the visitor.
 */
export function seedWallIfNeeded(): void {
  const marker = localStorage.getItem(SEED_MARKER);
  if (marker) return;

  // Migrate away from the V1 seed wall. We can't distinguish seeded objects
  // from real marks in the store, so clearing the old seed era wholesale is the
  // only way to lay the curated V2 layout without duplicate ghosts on top.
  if (localStorage.getItem('thewall_seeded_v1')) {
    localStorage.removeItem('thewall_objects');
  }

  const objects: WallObject[] = [];

  const add = (spec: SeedSpec, offsetX: number, offsetY: number, rotation = spec.rotation ?? 0) => {
    const createdAt = ms(spec.ageDays, spec.ageHours || 0);
    const lifespanMs = DURATION_MS['24h'];
    const baseExpires = createdAt + lifespanMs;
    const permanent = spec.permanent === true;

    const base: Partial<WallObject> = {
      id: generateId(),
      author: spec.author,
      createdAt,
      expiresAt: permanent ? null : baseExpires,
      keptForever: permanent,
      reactions: (spec.reactions || []).map(emoji => ({ emoji, user: spec.author, count: 1 })),
      comments: [],
      parentId: null,
      modifiedBy: spec.modifiedBy || [],
    };

    switch (spec.kind) {
      case 'text':
        objects.push({
          ...base as WallObject,
          type: 'text',
          x: offsetX,
          y: offsetY,
          data: { text: spec.text!, color: spec.color || '#e8e8e8', fontSize: spec.fontSize || 18, rotation: rotation || 0 },
        });
        break;
      case 'sticker':
        objects.push({
          ...base as WallObject,
          type: 'sticker',
          x: offsetX,
          y: offsetY,
          data: { emoji: spec.emoji!, size: spec.stickerSize || 44, rotation: rotation || 0 },
        });
        break;
      case 'stroke': {
        const pts = jitter(spec.points || []);
        const d = stroke(pts, spec.color || '#fff');
        objects.push({
          ...base as WallObject,
          type: 'stroke',
          x: offsetX,
          y: offsetY,
          data: { pathData: d, color: spec.color || '#fff', strokeWidth: 4, rotation: rotation || 0 },
        });
        break;
      }
      case 'secret':
        objects.push({
          ...base as WallObject,
          type: 'secret',
          x: offsetX,
          y: offsetY,
          data: { text: spec.secretText || '', revealed: false, radius: spec.secretRadius || 16 },
        });
        break;
      case 'timecapsule':
        objects.push({
          ...base as WallObject,
          type: 'timecapsule',
          x: offsetX,
          y: offsetY,
          data: { text: spec.text || 'open later', unlockAt: spec.unlockAt!, locked: true },
        });
        break;
      case 'shape':
        if (spec.shape) {
          const sh = spec.shape;
          objects.push({
            ...base as WallObject,
            type: 'shape',
            x: offsetX + sh.x,
            y: offsetY + sh.y,
            data: {
              serializer: { type: sh.type, x: offsetX + sh.x, y: offsetY + sh.y, w: sh.w, h: sh.h, s: sh.strokeWidth, color: sh.color },
            },
          });
        }
        break;
    }
  };

  // Placements keyed by unique spec key so reorders/new pieces never break layout.
  const place = (key: string, x: number, y: number, rotation = 0) => {
    const spec = BASE.find(s => s.key === key);
    if (spec) add(spec, x, y, rotation);
  };

  // Central cluster (the busy, alive area at the origin)
  place('smiley', 0, 0);            // the draw-over centerpiece
  place('mustache', 0, 0);          // on the face
  place('shades', 0, 0);            // on the face
  place('nova', -60, -40);          // "who is reading this?"
  place('sasha', -140, 60);         // [alex] was here
  place('fern', -220, -120);        // don't erase this
  place('rio', -190, 90, -8);       // "behold my masterpiece"
  place('dev', -260, 160);          // hello from 2026
  place('milo1', 150, -40);         // 🚀
  place('milo2', 220, 120);         // "this corner is mine now"
  place('aster', 80, -260);         // spectacular golden starfield
  place('comet', -360, -120);       // comet trail
  place('century', 260, -260);      // "seen by 1,000 eyes"
  place('kat', -100, -130);         // "someone drew a mustache here"
  place('moss', -330, -200);        // "still here"
  place('luna', 30, -120);          // secret "the void watches back"
  place('echo', 300, 200);          // secret "i was here first"
  place('peach', 120, 140);         // hand-drawn heart
  place('crumb', -200, 0);          // spiral scribble
  place('grid', -30, 200);          // rect shape
  place('circleman', 90, -90);      // circle
  place('quill', 40, 90);           // "I found this at 2am"
  place('oldcrow', 190, -140);      // "i was here. trust me."
  place('wren', -40, 90);           // "this is fading..."
  place('ghost1', 260, -310);       // "i was here once… i think"
  place('fox', 330, 90);            // 💀
  place('grey', 380, -190);         // "someone left something here... once"

  // Second neighborhood (a bit further out)
  place('pixel', 4000, 3000);       // wavy stroke
  place('orbit', 4200, 3200);       // time capsule (open in 1 year)
  place('sprout', 3950, 3080);      // 🌈
  place('ghost2', 4080, 2990);      // 🕸️ 26-day-old cobweb

  // Loners (random / explore destinations)
  place('fourohfour', 4300, 2900);  // 🔒 "this is NOT a room"
  place('ancient', 9800, -4200);    // 30-day-old scribble, far away

  saveObjects(objects);
  localStorage.setItem(SEED_MARKER, '1');
}

/** Return an approximate camera position for the initial view (looks at the cluster). */
export function seedViewport(): { x: number; y: number; zoom: number } {
  return { x: 0, y: 0, zoom: 1 };
}