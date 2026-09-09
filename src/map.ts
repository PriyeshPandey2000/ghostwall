import type { ObjectData } from './module_bindings/types';
import type { WallObject } from './types';

type WallType = WallObject['type'];

function num(data: Record<string, unknown>, key: string): number | undefined {
  return typeof data[key] === 'number' ? (data[key] as number) : undefined;
}

function str(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === 'string' ? (data[key] as string) : undefined;
}

function bool(data: Record<string, unknown>, key: string): boolean | undefined {
  return typeof data[key] === 'boolean' ? (data[key] as boolean) : undefined;
}

/**
 * WallObject.data -> the module bindings `ObjectData` column type.
 * Secrets keep their message in `data.text` client-side but map to
 * `data.secret` on the wire; `revealed` is a row column, not data.
 */
export function wallToObjectData(type: WallType, data: Record<string, unknown>): ObjectData {
  const d: ObjectData = {
    pathData: undefined,
    color: undefined,
    strokeWidth: undefined,
    text: undefined,
    fontSize: undefined,
    emoji: undefined,
    size: undefined,
    secret: undefined,
    unlockedAt: undefined,
    radius: undefined,
    locked: undefined,
    rotation: undefined,
    src: undefined,
    width: undefined,
    height: undefined,
    shapeType: undefined,
    serializer: undefined,
  };

  if (type === 'secret') {
    d.secret = str(data, 'text') ?? '';
    d.radius = num(data, 'radius');
    d.unlockedAt = num(data, 'unlockedAt');
    return d;
  }

  if (type === 'timecapsule') {
    d.text = str(data, 'text');
    d.unlockedAt = num(data, 'unlockAt');
    d.locked = bool(data, 'locked');
    return d;
  }

  d.pathData = str(data, 'pathData');
  d.color = str(data, 'color');
  d.strokeWidth = num(data, 'strokeWidth');
  d.text = str(data, 'text');
  d.fontSize = num(data, 'fontSize');
  d.emoji = str(data, 'emoji');
  d.size = num(data, 'size');
  d.rotation = num(data, 'rotation');
  d.src = str(data, 'src');
  d.width = num(data, 'width');
  d.height = num(data, 'height');
  d.shapeType = str(data, 'shapeType');
  d.radius = num(data, 'radius');
  d.locked = bool(data, 'locked');
  d.unlockedAt = num(data, 'unlockedAt');

  const serializer = data.serializer;
  if (serializer && typeof serializer === 'object') {
    d.serializer = JSON.stringify(serializer);
  } else if (typeof serializer === 'string') {
    d.serializer = serializer;
  }

  return d;
}

/**
 * Inverse of `wallToObjectData`: (column ObjectData + row fields) -> WallObject.data.
 * `revealed` (a canvas_object column) is folded back in for secrets.
 */
export function objectDataToWallData(
  type: WallType,
  od: ObjectData,
  row: { revealed: boolean; rotation: number },
): Record<string, unknown> {
  const d: Record<string, unknown> = {};

  if (type === 'secret') {
    d.text = od.secret ?? '';
    d.radius = od.radius;
    d.revealed = row.revealed;
    return d;
  }

  if (type === 'timecapsule') {
    d.text = od.text;
    d.unlockedAt = od.unlockedAt;
    d.locked = od.locked ?? true;
    return d;
  }

  if (od.pathData !== undefined) d.pathData = od.pathData;
  if (od.color !== undefined) d.color = od.color;
  if (od.strokeWidth !== undefined) d.strokeWidth = od.strokeWidth;
  if (od.text !== undefined) d.text = od.text;
  if (od.fontSize !== undefined) d.fontSize = od.fontSize;
  if (od.emoji !== undefined) d.emoji = od.emoji;
  if (od.size !== undefined) d.size = od.size;
  if (od.radius !== undefined) d.radius = od.radius;
  if (od.src !== undefined) d.src = od.src;
  if (od.width !== undefined) d.width = od.width;
  if (od.height !== undefined) d.height = od.height;
  if (od.shapeType !== undefined) d.shapeType = od.shapeType;
  if (od.serializer !== undefined) {
    try {
      d.serializer = JSON.parse(od.serializer);
    } catch {
      d.serializer = od.serializer;
    }
  }
  d.rotation = od.rotation ?? row.rotation;

  return d;
}