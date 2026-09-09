import { generateId, randomInRange } from './utils';
import { loadObjects, saveObjects } from './storage';
import type { WallObject } from './types';
import { DURATION_MS } from './types';
import { strokeToPathData } from './canvas';

const SEED_MARKER = 'thewall_seeded_v1';

function ms(ageDays: number, ageHours = 0): number {
  return Date.now() - ageDays * 24 * 60 * 60 * 1000 - ageHours * 60 * 60 * 1000;
}

/** Build a single smooth freehand stroke path from a set of control points. */
function stroke(points: [number, number][], _color: string, size = 4): string {
  return strokeToPathData(points.map(([x, y]) => ({ x, y })), size);
}

interface SeedSpec {
  kind: 'text' | 'stroke' | 'sticker' | 'secret' | 'timecapsule' | 'shape';
  ageDays: number;
  ageHours?: number;
  author: string;
  /** extra fields per kind */
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
  /** true = never fades (kept forever flavor) */
  permanent?: boolean;
  /** pre-seeded signs of social life — "modified by N people" */
  modifiedBy?: string[];
  /** pre-seeded reactions */
  reactions?: string[];
}

const BASE: SeedSpec[] = [
  // -- Brand new (a few minutes ago) --
  { kind: 'text', ageDays: 0, ageHours: 0.02, author: 'nova', text: 'who is reading this?', color: '#ffeaa7', fontSize: 22, permanent: true },
  { kind: 'sticker', ageDays: 0, ageHours: 0.1, author: 'mike', emoji: '🐸', stickerSize: 48 },
  { kind: 'text', ageDays: 0, ageHours: 0.3, author: 'sasha', text: '[alex] was here', color: '#85c1e9', fontSize: 18 },
  { kind: 'sticker', ageDays: 0, ageHours: 0.5, author: 'tone', emoji: '🚀', stickerSize: 52 },

  // -- A few hours old --
  { kind: 'text', ageDays: 0, ageHours: 3, author: 'fern', text: "don't erase this", color: '#ff6b6b', fontSize: 16 },
  { kind: 'stroke', ageDays: 0, ageHours: 4, author: 'pixel', color: '#4ecdc4', points: [[-120, 40], [-80, 20], [-40, 30], [0, 10], [40, 30]] },
  { kind: 'sticker', ageDays: 0, ageHours: 5, author: 'mango', emoji: '⭐', stickerSize: 40 },
  { kind: 'sticker', ageDays: 0, ageHours: 6, author: 'olive', emoji: '🧨', stickerSize: 56 },
  { kind: 'text', ageDays: 0, ageHours: 7.5, author: 'rio', text: 'behold my masterpiece', color: '#b8e986', fontSize: 10, rotation: -8, modifiedBy: ['mix', 'nyx'] },

  // -- ~a day old, half faded --
  { kind: 'text', ageDays: 0.9, ageHours: 18, author: 'quill', text: 'I found this at 2am', color: '#bb8fce', fontSize: 17 },
  { kind: 'sticker', ageDays: 0.95, ageHours: 20, author: 'riley', emoji: '👽', stickerSize: 44 },

  // -- almost gone --
  { kind: 'text', ageDays: 0.98, ageHours: 23, author: 'wren', text: 'this is fading...', color: '#888', fontSize: 15, permanent: false },
  { kind: 'sticker', ageDays: 0.99, ageHours: 23.5, author: 'fox', emoji: '💀', stickerSize: 42 },

  // -- medium age (3-5 days, in the fades slowly / gone state)
  { kind: 'text', ageDays: 3, author: 'oldcrow', text: 'i was here. trust me.', color: '#f8c471', fontSize: 16 },
  { kind: 'stroke', ageDays: 4, author: 'ancient', color: '#f1948a', points: [[-60, -20], [-30, -50], [0, -20], [30, -50], [60, -20]] },
  { kind: 'sticker', ageDays: 5, author: 'ghost', emoji: '🦄', stickerSize: 46 },

  // -- Large smiling face + mustache (the draw-over centerpiece) --
  {
    kind: 'stroke', ageDays: 2, author: 'robin',
    color: '#2ecc71', points: [[-150, 60], [-120, 100], [-70, 130], [0, 140], [70, 130], [120, 100], [150, 60]],
    permanent: true, modifiedBy: ['theo', 'mia', 'fern', 'sasha', 'nyx'],
  },
  {
    kind: 'stroke', ageDays: 1.5, author: 'theo', color: '#2b2b2b',
    points: [[-80, 50], [-40, 65], [0, 72], [40, 65], [80, 50]],
    permanent: true, modifiedBy: ['mia', 'fern'],
  },
  {
    kind: 'stroke', ageDays: 1.2, author: 'mia', color: '#7d6bff',
    points: [[-110, 85], [-95, 60], [-85, 40], [-70, 20], [-40, 5]],
    permanent: true, modifiedBy: ['nyx'],
  },

  // -- Secret --
  { kind: 'secret', ageDays: 1, author: 'luna', secretText: 'the void watches back', secretRadius: 16 },
  { kind: 'secret', ageDays: 6, author: 'echo', secretText: 'i was here first', secretRadius: 14 },

  // -- Time capsule (locked forever until far future) --
  {
    kind: 'timecapsule', ageDays: 7, author: 'orbit', locked: true,
    unlockAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    text: 'open in 1 year',
  },

  // -- Shapes --
  { kind: 'shape', ageDays: 0.5, author: 'grid', shape: { type: 'rect', x: 0, y: 0, w: 140, h: 90, strokeWidth: 3, color: '#ff6b6b' } },
  { kind: 'shape', ageDays: 2.5, author: 'circleman', shape: { type: 'circle', x: 0, y: 0, w: 80, h: 80, strokeWidth: 3, color: '#4ecdc4' } },

  // -- More human scribbles --
  { kind: 'text', ageDays: 0.4, author: 'dev', text: 'hello from 2026 👋', color: '#f8c471', fontSize: 15 },
  { kind: 'text', ageDays: 0.7, author: 'sol', text: '<3', color: '#ff6b6b', fontSize: 26 },
  { kind: 'text', ageDays: 1.9, author: 'kat', text: 'someone drew a mustache here', color: '#bb8fce', fontSize: 13, permanent: true, reactions: ['😂', '⭐', '😂'] },
  { kind: 'sticker', ageDays: 0.2, author: 'momo', emoji: '🎯', stickerSize: 36 },
  { kind: 'sticker', ageDays: 4.5, author: 'sprout', emoji: '🌈', stickerSize: 44 },
  { kind: 'text', ageDays: 8, author: 'moss', text: 'still here', color: '#82e0aa', fontSize: 14, permanent: true },

  // -- One weird discovery --
  { kind: 'text', ageDays: 365, author: '??', text: '🔒 something is hidden here', color: '#e8e8e8', fontSize: 15, permanent: true },

  // -- A hand-drawn heart --
  {
    kind: 'stroke', ageDays: 0.3, author: 'peach', color: '#ff6b9d',
    points: [[0, 40], [-30, 20], [-30, 0], [-15, -15], [0, -5], [15, -15], [30, 0], [30, 20], [0, 40]],
    reactions: ['❤️', '❤️', '⭐'],
  },

  // -- A little spiral / scribble --
  {
    kind: 'stroke', ageDays: 1.4, author: 'crumb', color: '#5454c9',
    points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 20], [20, 20], [20, 0], [20, -20]],
  },

  // -- Faded / almost-gone marks scattered far out, so "explore" finds decay --
  { kind: 'text', ageDays: 23, author: 'grey', text: 'someone left something here... once', color: '#6b6b6b', fontSize: 12 },
  { kind: 'sticker', ageDays: 26, author: 'dust', emoji: '🕸️', stickerSize: 52 },
  { kind: 'text', ageDays: 0.97, ageHours: 23, author: 'cede', text: 'gone soon', color: '#777', fontSize: 11, rotation: 5 },

  // -- A couple spectacular pieces (the wall's "wow" moments) --
  {
    kind: 'stroke', ageDays: 3, author: 'aster', color: '#ffde59', permanent: true, modifiedBy: ['nova', 'kite', 'wren'],
    points: [[0, 0], [14, -30], [6, -60], [30, -70], [52, -62], [46, -34], [60, -12], [46, 16], [30, 30], [10, 28], [-6, 48], [-22, 30], [-44, 40], [-50, 14], [-34, 2], [-46, -22], [-24, -40], [-8, -22], [-14, -2], [0, 0]],
  },
  {
    kind: 'stroke', ageDays: 1.1, author: 'comet', color: '#7d6bff',
    points: [[-30, 30], [-20, -10], [0, -30], [20, -40], [40, -30], [60, 0], [90, 60], [120, 90], [170, 100]],
    permanent: true,
  },
  { kind: 'text', ageDays: 0.6, author: 'century', text: 'seen by 1,000 eyes', color: '#9ad0ff', fontSize: 30, permanent: true, modifiedBy: ['grid', 'sol'] },
];

/** Jitter a raw control-point stroke so each seeded piece isn't pixel-perfect identical. */
function jitter(points: [number, number][]): [number, number][] {
  return points.map(([x, y]) => [x + randomInRange(-1.5, 1.5), y + randomInRange(-1.5, 1.5)]);
}

/**
 * Lay the seeded wall once. Lays clusters around the origin and a few spread-out
 * areas so "explore nearby / random" has something to find.
 */
export function seedWallIfNeeded(): void {
  const marker = localStorage.getItem(SEED_MARKER);
  if (marker) return;

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

  // Placements are keyed by unique author so reordering/new seeds never break
  // the layout. Each seed spec carries its own coordinates below.
  const place = (author: string, x: number, y: number, rotation = 0) => {
    const spec = BASE.find(s => s.author === author);
    if (spec) add(spec, x, y, rotation);
  };

  // Central cluster (the busy, alive area at the origin)
  place('nova', -60, -40);            // "who is reading this?"
  place('mike', 40, 30);              // 🐸
  place('sasha', -140, 60);           // [alex] was here
  place('tone', 150, -40);            // 🚀
  place('fern', -220, -120);          // don't erase this
  place('mango', 220, 120);           // ⭐
  place('olive', 300, 200);           // 🧨
  place('rio', -190, 90, -8);         // "behold my masterpiece"
  place('riley', -40, 90);            // 👽
  place('robin', 0, 0);               // big smiley face (draw-over centerpiece)
  place('theo', 0, 0);                // mustache on the face
  place('mia', 0, 0);                 // sunglasses on the face
  place('luna', 30, -120);            // secret "the void watches back"
  place('grid', -30, 200);            // rect shape
  place('circleman', 90, -90);        // circle
  place('dev', -260, 160);            // hello from 2026
  place('sol', 200, -160);            // <3
  place('kat', -100, -130);           // someone drew a mustache here
  place('momo', 330, 90);             // 🎯
  place('moss', -330, -200);          // still here
  place('peach', 120, 140);           // hand-drawn heart
  place('crumb', -200, 0);            // spiral scribble
  place('aster', 80, -260);           // spectacular golden starfield
  place('comet', -360, -120);         // spectacular comet trail
  place('echo', 260, -260);           // "seen by 1,000 eyes"

  // Second cluster (a bit further out) — feels like another neighborhood
  place('pixel', 4000, 3000);         // wavy stroke
  place('quill', 4050, 3050);         // I found this at 2am
  place('wren', 3980, 2970);          // this is fading...
  place('fox', 4100, 3100);           // 💀
  place('echo', 3900, 2920);          // secret "i was here first"
  place('orbit', 4200, 3200);         // time capsule (open in 1 year)
  place('sprout', 3950, 3080);        // 🌈
  place('ghost', 4080, 2990);         // 🦄
  place('grey', 3800, 2850);          // ~23 days old, fading
  place('cede', 4150, 2950);          // "gone soon"
  place('ancient', 3900, 2780);       // ancient stroke scribble
  place('??', 4300, 2900);            // 🔒 something is hidden here (weird find)

  // A couple loners way out (random / explore destinations)
  place('wren', -8200, 5500);         // this is fading (far loner)
  place('moss', 9800, -4200);         // still here (far loner)
  place('dev', -5000, -7000);         // hello from 2026 (far loner)
  place('dust', 7600, 8800);          // 🕸️ far-off faded
  place('comet', -9800, -6200);       // comet trail (far weird find)

  saveObjects(objects.concat(loadObjects()));
  localStorage.setItem(SEED_MARKER, '1');
}

/** Return an approximate camera position for the initial view (looks at the cluster). */
export function seedViewport(): { x: number; y: number; zoom: number } {
  return { x: 0, y: 0, zoom: 1 };
}
