export interface WallObject {
  id: string;
  type: 'stroke' | 'text' | 'shape' | 'sticker' | 'image' | 'secret' | 'timecapsule';
  x: number;
  y: number;
  data: Record<string, unknown>;
  author: string;
  createdAt: number;
  expiresAt: number | null;
  /** When the fade death-and-disappearance phase completes (object fully removed). Null/absent = stays as a ghost trace forever (historical seeds). */
  ghostUntil?: number | null;
  keptForever: boolean;
  reactions: Reaction[];
  comments: Comment[];
  parentId: string | null;
  modifiedBy: string[];
}

export interface Reaction {
  emoji: string;
  user: string;
  count: number;
}

export interface Comment {
  user: string;
  text: string;
  createdAt: number;
}

export interface UserProfile {
  username: string;
  avatar: string;
  bio: string;
  favorites: string[];
  createdAt: number;
}

export interface CanvasState {
  objects: WallObject[];
  viewport: { x: number; y: number; zoom: number };
}

export interface PricingTier {
  label: string;
  duration: string | null;
  price: number;
  priceLabel: string;
}

export const PRICING: PricingTier[] = [
  { label: '24 hours', duration: '24h', price: 0, priceLabel: 'Free' },
  { label: '7 days', duration: '7d', price: 5, priceLabel: '₹5' },
  { label: 'Forever', duration: null, price: 10, priceLabel: '₹10' },
];

export const DURATION_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** How long a mark lingers as a faint "ghost" after it expires, before it truly disappears. */
export const GHOST_MS = 24 * 60 * 60 * 1000;
