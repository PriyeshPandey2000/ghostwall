import Konva from 'konva';
import { getStroke } from 'perfect-freehand';
import { generateId } from './utils';
import { loadObjects, saveObjects, addObject, removeObject, updateObject, loadUserProfile } from './storage';
import type { WallObject } from './types';
import { DURATION_MS, GHOST_MS } from './types';

export type Tool = 'select' | 'draw' | 'erase' | 'text' | 'rect' | 'circle' | 'sticker' | 'image' | 'secret' | 'timecapsule' | 'confession' | 'react';

export interface CanvasEngineOptions {
  container: HTMLDivElement;
  onObjectSelected?: (obj: WallObject | null) => void;
  onToolChange?: (tool: Tool) => void;
  onZoomChange?: (zoom: number) => void;
  /** World-space pointer position, fired on every move regardless of tool/drawing state. */
  onCursorMove?: (x: number, y: number) => void;
}

export interface RemoteCursor {
  id: string;
  x: number;
  y: number;
  username: string;
  avatar: string;
}

/** Deterministic hue (0-360) from an identity string, so a remote cursor's
 *  color stays stable across renders instead of reassigning randomly. */
function hashToHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function getSvgPathFromStroke(stroke: number[][]): string {
  if (!stroke.length) return '';
  return 'M' + stroke.map(([x, y], i) => {
    if (i === 0) return `${x},${y}`;
    const [x0, y0] = stroke[i - 1];
    return `C ${x0},${y0} ${(x0 + x) / 2},${(y0 + y) / 2} ${x},${y}`;
  }).join(' ') + ' Z';
}

export function strokeToPathData(points: { x: number; y: number }[], size: number): string {
  if (points.length < 2) return '';
  const raw = points.map(p => [p.x, p.y]);
  const outline = getStroke(raw, {
    size,
    thinning: 0.65,
    smoothing: 0.5,
    streamline: 0.5,
  });
  return getSvgPathFromStroke(outline);
}

/** URL-encode an SVG into a CSS cursor value with a hotspot and a fallback. */
function svgCursor(svg: string, x: number, y: number, fallback: string = 'default'): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}

// Pencil cursor (tip points down, hotspot on the tip).
const PENCIL_CURSOR = svgCursor(`
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <defs><filter id="s" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.3" flood-color="#000" flood-opacity="0.45"/></filter></defs>
  <g filter="url(#s)">
    <rect x="10" y="5" width="12" height="4" rx="1" fill="#f26d92"/>
    <rect x="10" y="9" width="12" height="3" fill="#c9c9c9"/>
    <path d="M10 12 L22 12 L22 20 L10 20 Z" fill="#f6c85c"/>
    <path d="M10 20 L22 20 L15 28 Z" fill="#dda847"/>
    <path d="M13.4 22 L16.6 22 L15 28 Z" fill="#444"/>
  </g>
</svg>`, 15, 27, 'crosshair');

// Eraser cursor.
const ERASER_CURSOR = svgCursor(`
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
  <defs><filter id="s" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.3" flood-color="#000" flood-opacity="0.45"/></filter></defs>
  <g filter="url(#s)" transform="rotate(-15 15 15)">
    <rect x="5" y="7" width="20" height="16" rx="3" fill="#ff8fa3"/>
    <rect x="5" y="7" width="20" height="5" fill="#f65a83"/>
    <rect x="5" y="13" width="20" height="2.2" fill="#fff" opacity="0.55"/>
    <rect x="13" y="12.2" width="4" height="10.8" rx="1" fill="#c7f0ff"/>
    <path d="M6 23 L24 23 L21.5 27.5 L8.5 27.5 Z" fill="#e05a74"/>
  </g>
</svg>`, 15, 15);

/** World coords + footprint of the Confession Corridor region. Shared by the
 *  room's ambient background (drawCorridor), Places navigation in wall.ts, and
 *  the seed layout in seed.ts (which keeps its own copy of the center). */
export const CORRIDOR = {
  cx: 12000,
  cy: 12000,
  half: 600, // half-width of the ambient "room" drawn around the cluster
};

export class CanvasEngine {
  private stage: Konva.Stage;
  private mainLayer: Konva.Layer;
  private gridLayer: Konva.Layer;
  private uiLayer: Konva.Layer;
  private container: HTMLDivElement;
  private currentTool: Tool = 'select';
  private currentColor: string = '#ff4d4d';
  private strokeWidth: number = 3;
  private isDrawing: boolean = false;
  private currentPath: Konva.Path | null = null;
  private drawPoints: { x: number; y: number }[] = [];
  private objects: WallObject[] = [];
  private konvaObjects: Map<string, Konva.Node> = new Map();
  private selectedObjectId: string | null = null;
  private transformer: Konva.Transformer;
  private options: CanvasEngineOptions;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private shapeStart: { x: number; y: number } | null = null;
  private tempShape: Konva.Shape | null = null;
  private boundNodeMap = new WeakMap<Konva.Node, WallObject>();
  private remoteCursorNodes = new Map<string, Konva.Group>();
  /** Set when the current pointer gesture actually drew/moved, so the click
   *  handler doesn't open an info popup right after the user finishes drawing. */
  private gestureMoved = false;

  constructor(options: CanvasEngineOptions) {
    this.options = options;
    this.container = options.container;

    this.stage = new Konva.Stage({
      container: this.container,
      width: window.innerWidth,
      height: window.innerHeight,
    });

    this.gridLayer = new Konva.Layer();
    this.mainLayer = new Konva.Layer();
    this.uiLayer = new Konva.Layer();

    this.stage.add(this.gridLayer);
    this.stage.add(this.mainLayer);
    this.stage.add(this.uiLayer);

    this.transformer = new Konva.Transformer({
      keepRatio: true,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center'],
      anchorSize: 9,
      anchorCornerRadius: 2,
      anchorStroke: '#ff4d4d',
      anchorFill: '#1a1a1a',
      anchorStrokeWidth: 1.5,
      borderStroke: '#ff4d4d',
      borderStrokeWidth: 1,
      borderDash: [4, 3],
      rotateAnchorOffset: 22,
      rotationSnapTolerance: 0,
    });
    this.uiLayer.add(this.transformer);

    this.setupStage();
    this.setupEvents();
    this.loadSavedObjects();
    this.drawGrid();
    this.animateExpiredObjects();

    window.addEventListener('resize', this.handleResize);
  }

  private handleResize = (): void => {
    this.stage.width(window.innerWidth);
    this.stage.height(window.innerHeight);
    this.drawGrid();
  };

  private setupStage(): void {
    const saved = localStorage.getItem('thewall_viewport');
    if (saved) {
      const vp = JSON.parse(saved);
      this.stage.scale({ x: vp.zoom, y: vp.zoom });
      this.stage.position({ x: vp.x, y: vp.y });
    } else {
      // Center the world origin so first-time visitors land right in the
      // middle of the lived-in cluster (the smiley face at ~0,0) instead of
      // a corner full of empty grid.
      this.stage.scale({ x: 1, y: 1 });
      this.stage.position({ x: this.stage.width() / 2, y: this.stage.height() / 2 });
    }

    // Default to the Pan & select tool, so the canvas is draggable from the
    // first frame; the toolbar switches into the drawing tools.
    this.stage.draggable(this.currentTool === 'select');
    this.stage.container().style.cursor = this.getCursorForTool(this.currentTool);

    this.stage.on('dragstart', () => {
      if (this.currentTool === 'select') this.stage.container().style.cursor = 'grabbing';
    });
    this.stage.on('dragmove', () => {
      this.drawGrid();
      this.options.onZoomChange?.(this.stage.scaleX());
    });
    this.stage.on('dragend', () => {
      if (this.currentTool === 'select') this.stage.container().style.cursor = 'grab';
      this.saveViewport();
    });
    this.stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const oldScale = this.stage.scaleX();
      const pointer = this.stage.getPointerPosition()!;
      const mousePointTo = {
        x: (pointer.x - this.stage.x()) / oldScale,
        y: (pointer.y - this.stage.y()) / oldScale,
      };
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const scaleBy = 1.08;
      const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
      const clampedScale = Math.min(Math.max(newScale, 0.1), 10);
      this.stage.scale({ x: clampedScale, y: clampedScale });
      this.stage.position({
        x: pointer.x - mousePointTo.x * clampedScale,
        y: pointer.y - mousePointTo.y * clampedScale,
      });
      this.saveViewport();
      this.options.onZoomChange?.(clampedScale);
      this.drawGrid();
    });
  }

  private makeObjectsDraggable(node: Konva.Node, obj: WallObject): void {
    node.setAttr('draggable', true);
    this.boundNodeMap.set(node, obj);
    node.on('dragend', () => this.onObjectDragged(node, obj));
    node.on('transformend', () => this.onObjectTransformed(node, obj));
  }

  private onObjectDragged(node: Konva.Node, obj: WallObject): void {
    if (['text', 'sticker', 'image', 'shape', 'timecapsule', 'secret'].includes(obj.type)) {
      const snap = node.getPosition();
      if (node instanceof Konva.Text) {
        this.updateObjectField(obj.id, { x: snap.x, y: snap.y, data: { ...obj.data, x: snap.x, y: snap.y } });
      } else {
        this.updateObjectField(obj.id, { x: snap.x, y: snap.y });
      }
      // Refresh the node's persisted position
      const storedNode = this.konvaObjects.get(obj.id);
      if (storedNode) {
        this.updateObjectField(obj.id, { x: snap.x, y: snap.y });
      }
    }
    this.saveUndoState();
  }

  private onObjectTransformed(node: Konva.Node, obj: WallObject): void {
    this.saveUndoState();
    // Persist the transform for shapes/images via serialized state
    if (obj.type === 'image') {
      const img = node as Konva.Image;
      this.updateObjectField(obj.id, {
        x: img.x(),
        y: img.y(),
        data: {
          ...obj.data,
          x: img.x(),
          y: img.y(),
          width: img.width() * img.scaleX(),
          height: img.height() * img.scaleY(),
          rotation: img.rotation(),
        },
      });
    }
  }

  private updateObjectField(id: string, updates: Partial<WallObject>): void {
    const obj = this.objects.find(o => o.id === id);
    if (!obj) return;
    const merged = { ...obj, ...updates };
    Object.assign(obj, merged);
    updateObject(id, merged);
  }

  private setupEvents(): void {
    this.stage.on('mousedown touchstart', (e) => {
      const target = e.target;
      if (target === this.stage || target.getLayer() === this.gridLayer) {
        if (this.currentTool === 'select' || this.currentTool === 'react') {
          this.deselectAll();
          this.options.onObjectSelected?.(null);
        }
      }
    });

    this.stage.on('mousedown touchstart', (e) => this.handlePointerDown(e));
    this.stage.on('mousemove touchmove', (e) => this.handlePointerMove(e));
    this.stage.on('mouseup touchend', (e) => this.handlePointerUp(e));

    // Independent of tool/drawing state — fires on every hover so remote
    // viewers can see this cursor moving, not just while actively drawing.
    this.stage.on('mousemove touchmove', () => {
      if (!this.options.onCursorMove) return;
      const pos = this.getPointerPos();
      this.options.onCursorMove(pos.x, pos.y);
    });

    this.stage.on('click tap', (e) => {
      // Select, React, and Draw all let you tap an existing mark to inspect it.
      if (this.currentTool !== 'select' && this.currentTool !== 'react' && this.currentTool !== 'draw') return;
      // Don't open a popup immediately after the user just drew something.
      if (this.gestureMoved) return;
      const target = e.target;
      if (target === this.stage) return;

      let node: Konva.Node | null = target as Konva.Node;
      while (node && node !== (this.mainLayer as unknown as Konva.Node)) {
        const nodeId = node.id();
        const wallObj = this.boundNodeMap.get(node) || (nodeId ? this.objects.find(o => o.id === nodeId) : undefined);
        if (wallObj) {
          this.selectObject(wallObj.id);
          this.options.onObjectSelected?.(wallObj);
          return;
        }
        node = node.getParent();
      }
    });
  }

  private getPointerPos(): { x: number; y: number } {
    const pointer = this.stage.getPointerPosition()!;
    const scale = this.stage.scaleX();
    return {
      x: (pointer.x - this.stage.x()) / scale,
      y: (pointer.y - this.stage.y()) / scale,
    };
  }

  private handlePointerDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    const pos = this.getPointerPos();
    this.gestureMoved = false;
    if (this.currentTool === 'select' || this.currentTool === 'react') return;
    // Prevent the browser from moving focus away from a newly created text
    // input overlay (otherwise the overlay blurs + auto-closes immediately).
    if (this.currentTool === 'text' || this.currentTool === 'secret' || this.currentTool === 'confession') {
      e.evt.preventDefault();
    }

    switch (this.currentTool) {
      case 'draw':
        this.isDrawing = true;
        this.drawPoints = [{ ...pos }];
        break;

      case 'erase':
        this.isDrawing = true;
        this.eraseAt(pos);
        break;

      case 'text':
        this.placeText(pos);
        break;

      case 'confession':
        this.placeConfession(pos);
        break;

      case 'rect':
      case 'circle':
        this.shapeStart = { ...pos };
        this.isDrawing = true;
        break;

      case 'sticker':
        this.placeSticker(pos);
        break;

      case 'secret':
        this.placeSecret(pos);
        break;

      case 'timecapsule':
        this.placeTimeCapsule(pos);
        break;
    }
  }

  private handlePointerMove(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (!this.isDrawing) return;
    this.gestureMoved = true;
    const pos = this.getPointerPos();

    switch (this.currentTool) {
      case 'draw':
        this.drawPoints.push({ ...pos });
        if (this.drawPoints.length >= 2) {
          const size = this.strokeWidth * 1.5;
          const data = strokeToPathData(this.drawPoints, size);
          if (data) {
            if (!this.currentPath) {
              this.currentPath = new Konva.Path({
                data,
                fill: this.currentColor,
                stroke: this.currentColor,
                strokeWidth: 0.5,
                lineJoin: 'round',
                lineCap: 'round',
              });
              this.mainLayer.add(this.currentPath);
            } else {
              this.currentPath.data(data);
            }
            this.mainLayer.batchDraw();
          }
        }
        break;

      case 'erase':
        this.eraseAt(pos);
        break;

      case 'rect':
      case 'circle':
        if (this.shapeStart) {
          this.drawTempShape(pos);
        }
        break;
    }
  }

  private handlePointerUp(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    switch (this.currentTool) {
      case 'draw':
        if (this.currentPath && this.drawPoints.length > 2) {
          this.saveUndoState();
          const data = this.currentPath.data();
          const bounds = this.currentPath.getClientRect();
          const wallObj: WallObject = {
            id: generateId(),
            type: 'stroke',
            x: bounds.x,
            y: bounds.y,
            data: { pathData: data, color: this.currentColor, strokeWidth: this.strokeWidth },
            author: loadUserProfile()?.username || 'anonymous',
            createdAt: Date.now(),
            expiresAt: Date.now() + DURATION_MS['24h'],
            ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
            keptForever: false,
            reactions: [],
            comments: [],
            parentId: null,
            modifiedBy: [],
          };
          const id = wallObj.id;
          this.currentPath.id(id);
          this.konvaObjects.set(id, this.currentPath);
          this.boundNodeMap.set(this.currentPath as unknown as Konva.Node, wallObj);
          addObject(wallObj);
          this.objects.push(wallObj);
        }
        this.currentPath = null;
        this.drawPoints = [];
        break;

      case 'erase':
        break;

      case 'rect':
      case 'circle':
        if (this.tempShape) {
          this.finishShape();
        }
        this.shapeStart = null;
        this.tempShape = null;
        break;
    }
  }

  private drawTempShape(pos: { x: number; y: number }): void {
    if (this.tempShape) {
      this.tempShape.destroy();
    }

    if (!this.shapeStart) return;

    const x = Math.min(this.shapeStart.x, pos.x);
    const y = Math.min(this.shapeStart.y, pos.y);
    const w = Math.abs(pos.x - this.shapeStart.x);
    const h = Math.abs(pos.y - this.shapeStart.y);

    if (this.currentTool === 'rect') {
      this.tempShape = new Konva.Rect({
        x, y, width: w, height: h,
        stroke: this.currentColor,
        strokeWidth: this.strokeWidth,
        fill: 'transparent',
      });
    } else {
      this.tempShape = new Konva.Ellipse({
        x: x + w / 2,
        y: y + h / 2,
        radiusX: w / 2,
        radiusY: h / 2,
        stroke: this.currentColor,
        strokeWidth: this.strokeWidth,
        fill: 'transparent',
      });
    }

    this.tempShape.id('__shapedraft__');
    this.mainLayer.add(this.tempShape);
  }

  private finishShape(): void {
    if (!this.tempShape) return;
    this.saveUndoState();
    const shapeNode = this.tempShape;
    const serializer = this.serializeShape(shapeNode);

    const wallObj: WallObject = {
      id: generateId(),
      type: 'shape',
      x: shapeNode.x(),
      y: shapeNode.y(),
      data: { shapeType: this.currentTool, serializer, color: this.currentColor },
      author: loadUserProfile()?.username || 'anonymous',
      createdAt: Date.now(),
      expiresAt: Date.now() + DURATION_MS['24h'],
      ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
      keptForever: false,
      reactions: [],
      comments: [],
      parentId: null,
      modifiedBy: [],
    };
    const id = wallObj.id;
    shapeNode.id(id);
    shapeNode.setAttr('draggable', true);
    this.konvaObjects.set(id, shapeNode as unknown as Konva.Node);
    this.boundNodeMap.set(shapeNode as unknown as Konva.Node, wallObj);
    addObject(wallObj);
    this.objects.push(wallObj);
  }

  private serializeShape(shape: Konva.Shape): Record<string, unknown> {
    const type = shape.getClassName().toLowerCase();
    const pos = shape.position();
    if (type === 'rect') {
      const r = shape as Konva.Rect;
      return { type: 'rect', x: pos.x, y: pos.y, w: r.width(), h: r.height(), s: r.strokeWidth(), color: r.stroke() };
    }
    if (type === 'ellipse') {
      const e = shape as Konva.Ellipse;
      return { type: 'circle', x: pos.x, y: pos.y, rx: e.radiusX(), ry: e.radiusY(), s: e.strokeWidth(), color: e.stroke() };
    }
    return { type };
  }

  private eraseAt(pos: { x: number; y: number }): void {
    const threshold = 20 / this.stage.scaleX();
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      const node = this.konvaObjects.get(obj.id);
      if (!node) continue;

      const bounds = node.getClientRect();
      if (
        pos.x >= bounds.x - threshold &&
        pos.x <= bounds.x + bounds.width + threshold &&
        pos.y >= bounds.y - threshold &&
        pos.y <= bounds.y + bounds.height + threshold
      ) {
        this.saveUndoState();
        node.destroy();
        this.konvaObjects.delete(obj.id);
        this.boundNodeMap.delete(node);
        this.objects.splice(i, 1);
        removeObject(obj.id);
        break;
      }
    }
  }

  private placeText(pos: { x: number; y: number }): void {
    const scale = this.stage.scaleX();
    const overlay = document.createElement('div');
    overlay.className = 'text-input-overlay';
    overlay.style.left = `${(pos.x * scale) + this.stage.x()}px`;
    overlay.style.top = `${(pos.y * scale) + this.stage.y()}px`;

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type something...';
    textarea.style.color = this.currentColor;
    textarea.style.fontSize = `${18 / scale}px`;
    overlay.appendChild(textarea);
    document.body.appendChild(overlay);

    textarea.focus();

    const commit = () => {
      const text = textarea.value.trim();
      if (text) {
        this.saveUndoState();
        const id = generateId();
        const wallObj: WallObject = {
          id,
          type: 'text',
          x: pos.x,
          y: pos.y,
          data: { text, color: this.currentColor, fontSize: 18 / scale },
          author: loadUserProfile()?.username || 'anonymous',
          createdAt: Date.now(),
          expiresAt: Date.now() + DURATION_MS['24h'],
          ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
          keptForever: false,
          reactions: [],
          comments: [],
          parentId: null,
          modifiedBy: [],
        };

        const konvaText = new Konva.Text({
          x: pos.x,
          y: pos.y,
          text,
          fontSize: 18 / scale,
          fontFamily: 'Space Mono, monospace',
          fill: this.currentColor,
          id,
        });
        this.mainLayer.add(konvaText);
        this.konvaObjects.set(id, konvaText);
        this.boundNodeMap.set(konvaText as unknown as Konva.Node, wallObj);
        this.makeObjectsDraggable(konvaText as unknown as Konva.Node, wallObj);
        addObject(wallObj);
        this.objects.push(wallObj);
      }
      overlay.remove();
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textarea.blur();
      }
      if (e.key === 'Escape') {
        textarea.value = '';
        textarea.blur();
      }
    });
  }

  private placeConfession(pos: { x: number; y: number }): void {
    const scale = this.stage.scaleX();
    const overlay = document.createElement('div');
    overlay.className = 'text-input-overlay confession-input';
    overlay.style.left = `${(pos.x * scale) + this.stage.x()}px`;
    overlay.style.top = `${(pos.y * scale) + this.stage.y()}px`;

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Write what you can’t say anywhere else...';
    textarea.style.color = '#cfc3ec';
    textarea.style.borderColor = 'rgba(190, 160, 240, 0.45)';
    textarea.style.fontSize = `${16 / scale}px`;
    overlay.appendChild(textarea);
    document.body.appendChild(overlay);

    textarea.focus();

    const commit = () => {
      const text = textarea.value.trim();
      if (text) {
        this.saveUndoState();
        const id = generateId();
        const wallObj: WallObject = {
          id,
          type: 'confession',
          x: pos.x,
          y: pos.y,
          data: { text, color: '#cfc3ec', fontSize: 16 / scale },
          author: loadUserProfile()?.username || 'anonymous',
          createdAt: Date.now(),
          // Confessions stay forever — the corridor is the one place on the
          // wall where something meant to be held onto doesn't fade.
          expiresAt: null,
          ghostUntil: null,
          keptForever: true,
          reactions: [],
          comments: [],
          parentId: null,
          modifiedBy: [],
        };

        const konvaText = new Konva.Text({
          x: pos.x,
          y: pos.y,
          text,
          fontSize: 16 / scale,
          fontFamily: 'Space Mono, monospace',
          fill: '#cfc3ec',
          id,
        });
        this.mainLayer.add(konvaText);
        this.konvaObjects.set(id, konvaText);
        this.boundNodeMap.set(konvaText as unknown as Konva.Node, wallObj);
        this.makeObjectsDraggable(konvaText as unknown as Konva.Node, wallObj);
        addObject(wallObj);
        this.objects.push(wallObj);
      }
      overlay.remove();
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textarea.blur();
      }
      if (e.key === 'Escape') {
        textarea.value = '';
        textarea.blur();
      }
    });
  }

  private placeSticker(pos: { x: number; y: number }): void {
    const stickers = ['🐸', '🚀', '💀', '👽', '🔥', '⭐', '❤️', '🎨', '🌈', '👾', '🎯', '🔮', '🎪', '🦄', '🍕', '⚡'];
    const sticker = stickers[Math.floor(Math.random() * stickers.length)];

    this.saveUndoState();
    const id = generateId();
    const wallObj: WallObject = {
      id,
      type: 'sticker',
      x: pos.x,
      y: pos.y,
      data: { emoji: sticker, size: 44 },
      author: loadUserProfile()?.username || 'anonymous',
      createdAt: Date.now(),
      expiresAt: Date.now() + DURATION_MS['24h'],
      ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
      keptForever: false,
      reactions: [],
      comments: [],
      parentId: null,
      modifiedBy: [],
    };

    const konvaText = new Konva.Text({
      x: pos.x - 22,
      y: pos.y - 22,
      text: sticker,
      fontSize: 44,
      id,
    });

    this.mainLayer.add(konvaText);
    this.konvaObjects.set(id, konvaText);
    this.boundNodeMap.set(konvaText as unknown as Konva.Node, wallObj);
    this.makeObjectsDraggable(konvaText as unknown as Konva.Node, wallObj);
    addObject(wallObj);
    this.objects.push(wallObj);
  }

  private placeSecret(pos: { x: number; y: number }): void {
    const scale = this.stage.scaleX();
    const overlay = document.createElement('div');
    overlay.className = 'text-input-overlay';
    overlay.style.left = `${(pos.x * scale) + this.stage.x()}px`;
    overlay.style.top = `${(pos.y * scale) + this.stage.y()}px`;

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Leave a secret message...';
    textarea.style.color = '#ff4d4d';
    textarea.style.borderColor = 'rgba(255,77,77,0.5)';
    textarea.style.fontSize = `${16 / scale}px`;
    overlay.appendChild(textarea);
    document.body.appendChild(overlay);
    textarea.focus();

    const commit = () => {
      const text = textarea.value.trim();
      if (text) {
        this.saveUndoState();
        const id = generateId();
        const wallObj: WallObject = {
          id,
          type: 'secret',
          x: pos.x,
          y: pos.y,
          data: { text, revealed: false, radius: 14 },
          author: loadUserProfile()?.username || 'anonymous',
          createdAt: Date.now(),
          expiresAt: Date.now() + DURATION_MS['24h'],
          ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
          keptForever: false,
          reactions: [],
          comments: [],
          parentId: null,
          modifiedBy: [],
        };

        const hint = new Konva.Circle({
          x: pos.x,
          y: pos.y,
          radius: 14,
          fill: 'rgba(255, 77, 77, 0.12)',
          stroke: 'rgba(255, 77, 77, 0.35)',
          strokeWidth: 1.5,
          dash: [4, 4],
          id,
        });

        this.mainLayer.add(hint);
        this.konvaObjects.set(id, hint as unknown as Konva.Node);
        this.boundNodeMap.set(hint as unknown as Konva.Node, wallObj);
        addObject(wallObj);
        this.objects.push(wallObj);
      }
      overlay.remove();
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
      if (e.key === 'Escape') { textarea.value = ''; textarea.blur(); }
    });
  }

  private placeTimeCapsule(pos: { x: number; y: number }): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>🔒 Lock a time capsule</h3>
        <p>Choose when this message unlocks.</p>
        <div class="pricing-options">
          <div class="pricing-option" data-unlock="1h">Open in 1 hour</div>
          <div class="pricing-option" data-unlock="24h" style="margin-bottom:0">Open in 24 hours</div>
        </div>
        <div style="margin:12px 0;font-size:12px;color:var(--text-muted);font-family:var(--mono)">more coming soon...</div>
        <button class="modal-close" id="tc-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.pricing-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const unlock = (opt as HTMLElement).dataset.unlock!;
        const textarea = document.createElement('textarea');
        textarea.placeholder = 'Write your time capsule message...';
        textarea.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:600;width:400px;max-width:90vw;padding:16px;background:#1a1a1a;border:2px solid #ff4d4d;border-radius:12px;color:#f0f0f0;font-family:Space Mono,monospace;font-size:16px;resize:none;outline:none;`;
        overlay.remove();
        document.body.appendChild(textarea);
        textarea.focus();

        const commit = () => {
          const text = textarea.value.trim();
          if (text) {
            const durations: Record<string, number> = {
              '1h': 3600000,
              '24h': 86400000,
            };
            this.saveUndoState();
            const id = generateId();
            const wallObj: WallObject = {
              id,
              type: 'timecapsule',
              x: pos.x,
              y: pos.y,
              data: { text, unlockAt: Date.now() + (durations[unlock] || 86400000), locked: true },
              author: loadUserProfile()?.username || 'anonymous',
              createdAt: Date.now(),
              expiresAt: null,
              keptForever: true,
              reactions: [],
              comments: [],
              parentId: null,
              modifiedBy: [],
            };

            const marker = new Konva.Text({
              x: pos.x - 14,
              y: pos.y - 14,
              text: '🔒',
              fontSize: 28,
              id,
            });

            this.mainLayer.add(marker);
            this.konvaObjects.set(id, marker as unknown as Konva.Node);
            this.boundNodeMap.set(marker as unknown as Konva.Node, wallObj);
            this.makeObjectsDraggable(marker as unknown as Konva.Node, wallObj);
            addObject(wallObj);
            this.objects.push(wallObj);
          }
          textarea.remove();
        };

        textarea.addEventListener('blur', commit);
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
          if (e.key === 'Escape') { textarea.value = ''; textarea.blur(); }
        });
      });
    });

    overlay.querySelector('#tc-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  private selectObject(id: string): void {
    this.deselectAll();
    const node = this.konvaObjects.get(id);
    if (node && node instanceof Konva.Shape) {
      this.transformer.nodes([node as Konva.Shape]);
      this.uiLayer.batchDraw();
      this.selectedObjectId = id;
    }
  }

  deselectAll(): void {
    this.transformer.nodes([]);
    this.uiLayer.batchDraw();
    this.selectedObjectId = null;
  }

  /** Select a mark by id and surface it via onObjectSelected (e.g. to open its info popup). */
  selectObjectId(id: string): void {
    const wallObj = this.objects.find(o => o.id === id);
    if (!wallObj) return;
    this.selectObject(id);
    this.options.onObjectSelected?.(wallObj);
  }

  private drawGrid(): void {
    this.gridLayer.destroyChildren();
    this.drawCorridor();
    this.gridLayer.batchDraw();
  }

  /** The Confession Corridor's ambient floor: a faint, candlelit room drawn in
   *  world space on the layer underneath the marks, so it pans and zooms with
   *  the wall. Listening is off everywhere — this is scenery, never a target. */
  private drawCorridor(): void {
    const { cx, cy, half } = CORRIDOR;
    const x = cx - half;
    const y = cy - half;
    const w = half * 2;
    const h = half * 2;

    const floor = new Konva.Rect({
      x,
      y,
      width: w,
      height: h,
      listening: false,
      fillRadialGradient: {
        x: cx,
        y: cy,
        innerRadius: 0,
        outerRadius: half * 1.5,
        colorStops: [
          0, 'rgba(120, 90, 180, 0.18)',
          0.55, 'rgba(120, 90, 180, 0.09)',
          1, 'rgba(120, 90, 180, 0.0)',
        ],
      },
    });
    const border = new Konva.Rect({
      x: x + 90,
      y: y + 90,
      width: w - 180,
      height: h - 180,
      listening: false,
      stroke: 'rgba(190, 160, 240, 0.22)',
      strokeWidth: 2,
      dash: [6, 8],
      cornerRadius: 24,
    });
    const title = new Konva.Text({
      x: x + 110,
      y: y + 34,
      text: '🕯️ Confession Corridor',
      fontSize: 30,
      fontFamily: 'Space Mono, monospace',
      fill: 'rgba(205, 185, 245, 0.55)',
      listening: false,
    });
    const sub = new Konva.Text({
      x: x + 114,
      y: y + 78,
      text: 'say what you never could. it stays.',
      fontSize: 16,
      fontFamily: 'Space Mono, monospace',
      fill: 'rgba(205, 185, 245, 0.35)',
      listening: false,
    });
    this.gridLayer.add(floor, border, title, sub);
  }

  private loadSavedObjects(): void {
    this.objects = loadObjects();
    this.objects.forEach(obj => this.renderObject(obj));
    this.mainLayer.batchDraw();
  }

  private renderObject(obj: WallObject): void {
    let node: Konva.Node | null = null;

    switch (obj.type) {
      case 'stroke': {
        const d = (obj.data as { pathData: string }).pathData;
        const color = (obj.data as { color: string }).color;
        const shape = new Konva.Path({ data: d, fill: color, id: obj.id });
        node = shape;
        break;
      }
      case 'text': {
        const td = obj.data as { text: string; color: string; fontSize: number };
        const text = new Konva.Text({
          x: obj.x,
          y: obj.y,
          text: td.text,
          fontSize: td.fontSize,
          fontFamily: 'Space Mono, monospace',
          fill: td.color,
          id: obj.id,
        });
        node = text;
        break;
      }
      case 'confession': {
        const cd = obj.data as { text: string; color: string; fontSize: number };
        node = new Konva.Text({
          x: obj.x,
          y: obj.y,
          text: cd.text,
          fontSize: cd.fontSize,
          fontFamily: 'Space Mono, monospace',
          fill: cd.color || '#cfc3ec',
          id: obj.id,
        });
        break;
      }
      case 'shape': {
        const sd = obj.data as { serializer?: Record<string, unknown>; konvaJson?: string; shapeType?: string };
        if (sd.serializer) {
          const s = sd.serializer as Record<string, unknown>;
          if (s.type === 'rect') {
            node = new Konva.Rect({
              x: s.x as number, y: s.y as number, width: s.w as number, height: s.h as number,
              stroke: s.color as string, strokeWidth: s.s as number, fill: 'transparent', id: obj.id,
            });
          } else if (s.type === 'circle') {
            node = new Konva.Ellipse({
              x: s.x as number, y: s.y as number, radiusX: s.rx as number, radiusY: s.ry as number,
              stroke: s.color as string, strokeWidth: s.s as number, fill: 'transparent', id: obj.id,
            });
          }
        } else if (sd.konvaJson) {
          try {
            const tempStage = Konva.Node.create(sd.konvaJson);
            if (tempStage) {
              const child = tempStage.findOne('Rect, Ellipse, Line, Path') as Konva.Shape | undefined;
              if (child) {
                node = child;
                node.id(obj.id);
              }
            }
          } catch { /* skip */ }
        }
        break;
      }
      case 'sticker': {
        const ed = obj.data as { emoji: string; size: number };
        node = new Konva.Text({
          x: obj.x - ed.size / 2,
          y: obj.y - ed.size / 2,
          text: ed.emoji,
          fontSize: ed.size,
          id: obj.id,
        });
        break;
      }
      case 'secret': {
        const secretData = obj.data as { radius?: number };
        node = new Konva.Circle({
          x: obj.x,
          y: obj.y,
          radius: secretData.radius || 14,
          fill: 'rgba(255, 77, 77, 0.12)',
          stroke: 'rgba(255, 77, 77, 0.35)',
          strokeWidth: 1.5,
          dash: [4, 4],
          id: obj.id,
        });
        break;
      }
      case 'timecapsule': {
        node = new Konva.Text({
          x: obj.x - 14,
          y: obj.y - 14,
          text: '🔒',
          fontSize: 28,
          id: obj.id,
        });
        break;
      }
      case 'image': {
        const idata = obj.data as { src: string; width: number; height: number; rotation?: number };
        const imageElement = new Image();
        imageElement.onload = () => {
          const img = new Konva.Image({
            x: obj.x,
            y: obj.y,
            width: idata.width,
            height: idata.height,
            image: imageElement,
            id: obj.id,
            rotation: idata.rotation || 0,
          });
          this.mainLayer.add(img);
          this.konvaObjects.set(obj.id, img as unknown as Konva.Node);
          this.boundNodeMap.set(img as unknown as Konva.Node, obj);
          this.makeObjectsDraggable(img as unknown as Konva.Node, obj);
          this.mainLayer.batchDraw();
        };
        imageElement.src = idata.src;
        return;
      }
    }

    if (node) {
      // Apply seeded / persisted rotation if present
      const rotation = (obj.data as { rotation?: number }).rotation;
      if (rotation && typeof rotation === 'number') {
        node.rotation(rotation);
      }
      // Fade out based on how close to expiry (if not kept forever)
      if (obj.expiresAt && !obj.keptForever) {
        const fade = this.fadeOpacity(obj);
        if (fade < 1) node.opacity(fade);
      }
      this.mainLayer.add(node as Konva.Shape);
      this.konvaObjects.set(obj.id, node);
      this.boundNodeMap.set(node, obj);
      this.makeObjectsDraggable(node, obj);
    }
  }

  /**
   * Merge a fresh object list from the active backend into the live canvas.
   * Used by the shared (Spacetime) backend to stream remote creates/moves/
   * deletes; safe to call repeatedly. Never touches the undo stack.
   */
  syncObjects(remote: WallObject[]): void {
    const selected = this.selectedObjectId;
    const remoteIds = new Set(remote.map(o => o.id));

    // Remove nodes for objects that no longer exist remotely.
    for (const id of [...this.konvaObjects.keys()]) {
      if (!remoteIds.has(id)) {
        const node = this.konvaObjects.get(id);
        if (node) {
          node.destroy();
          this.konvaObjects.delete(id);
          this.boundNodeMap.delete(node);
        }
      }
    }

    this.objects = remote;

    for (const obj of remote) {
      const existing = this.konvaObjects.get(obj.id);
      if (existing) {
        // Cheap in-place update; re-render only if the shape fundamentally changed.
        if (!this.syncExistingNode(existing, obj)) {
          existing.destroy();
          this.konvaObjects.delete(obj.id);
          this.renderObject(obj);
        }
      } else {
        this.renderObject(obj);
      }
    }

    if (selected && this.konvaObjects.has(selected)) {
      this.selectedObjectId = selected;
      const selNode = this.konvaObjects.get(selected);
      if (selNode && selNode instanceof Konva.Shape) {
        this.transformer.nodes([selNode as Konva.Shape]);
      }
    }
    this.mainLayer.add(this.transformer);
    this.mainLayer.batchDraw();
  }

  /** Update a live node's position/rotation/content from a changed WallObject. */
  private syncExistingNode(node: Konva.Node, obj: WallObject): boolean {
    const prev = this.boundNodeMap.get(node);
    if (prev && prev.type !== obj.type) return false;

    if (node instanceof Konva.Image) {
      const prevSrc = prev ? (prev.data as { src?: string }).src : undefined;
      const nextSrc = (obj.data as { src?: string }).src;
      if (nextSrc !== undefined && prevSrc !== nextSrc) return false;
      node.x(obj.x);
      node.y(obj.y);
      const rotation = (obj.data as { rotation?: number }).rotation;
      if (typeof rotation === 'number') node.rotation(rotation);
      const idata = obj.data as { width?: number; height?: number };
      if (typeof idata.width === 'number') node.width(idata.width);
      if (typeof idata.height === 'number') node.height(idata.height);
      this.boundNodeMap.set(node, obj);
      return true;
    }

    node.x(obj.x);
    node.y(obj.y);
    const rotation = (obj.data as { rotation?: number }).rotation;
    if (typeof rotation === 'number') node.rotation(rotation);
    if (node instanceof Konva.Text) {
      const td = obj.data as { text?: string };
      if (td.text !== undefined && node.text() !== td.text) node.text(td.text);
    }
    if (!obj.keptForever && obj.expiresAt) {
      const fade = this.fadeOpacity(obj);
      if (Math.abs(node.opacity() - fade) > 0.02) node.opacity(fade);
    }
    this.boundNodeMap.set(node, obj);
    return true;
  }

  /**
   * The life-death curve. A mark stays nearly solid and fades very subtly
   * across its whole life (1 → 0.55), then keeps fading as a ghost trace
   * (0.55 → ~0.05) until ghostUntil, when it is removed for good.
   */
  private fadeOpacity(obj: WallObject): number {
    if (!obj.expiresAt) return 1;
    const now = Date.now();
    const life = obj.expiresAt - obj.createdAt;
    if (life <= 0) return 0.4;

    const expiry = obj.expiresAt;
    if (now < expiry) {
      // Living: 1 → 0.55 across the whole life, getting gently sparser.
      const t = (now - obj.createdAt) / life;
      return 1 - t * 0.45;
    }

    // Expired → ghost trace. If an explicit ghostUntil is set, fade toward
    // nothing until it passes. Historical seeds without ghostUntil linger as
    // faint traces forever (the wall keeps its archaeology).
    if (!obj.ghostUntil) return 0.1;
    const ghostTotal = obj.ghostUntil - obj.expiresAt;
    if (ghostTotal <= 0) return 0.05;
    const t = Math.min(1, (now - obj.expiresAt) / ghostTotal);
    return Math.max(0.05, 0.55 - t * 0.5);
  }

  private animateExpiredObjects(): void {
    setInterval(() => {
      const now = Date.now();
      const toRemove: string[] = [];
      this.objects.forEach(obj => {
        if (!obj.expiresAt || obj.keptForever) return;
        const node = this.konvaObjects.get(obj.id);
        if (!node) return;

        // Ghost finished dying → it truly disappears.
        if (obj.ghostUntil && obj.expiresAt <= now && now >= obj.ghostUntil) {
          toRemove.push(obj.id);
          return;
        }

        const fade = this.fadeOpacity(obj);
        if (Math.abs(node.opacity() - fade) > 0.02) {
          node.opacity(fade);
          this.mainLayer.batchDraw();
        }
      });

      if (toRemove.length) {
        toRemove.forEach(id => {
          const node = this.konvaObjects.get(id);
          if (node) node.destroy();
          this.konvaObjects.delete(id);
        });
        this.objects = this.objects.filter(o => !toRemove.includes(o.id));
        saveObjects(this.objects);
        this.mainLayer.batchDraw();
      }
    }, 3000);
  }

  private saveViewport(): void {
    const pos = this.stage.position();
    const scale = this.stage.scaleX();
    localStorage.setItem('thewall_viewport', JSON.stringify({ x: pos.x, y: pos.y, zoom: scale }));
    this.options.onZoomChange?.(scale);
  }

  private saveUndoState(): void {
    const state = JSON.stringify(this.objects);
    this.undoStack.push(state);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    if (this.undoStack.length === 0) return;
    const current = JSON.stringify(this.objects);
    this.redoStack.push(current);
    const prev = JSON.parse(this.undoStack.pop()!) as WallObject[];
    this.replaceObjects(prev);
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    const current = JSON.stringify(this.objects);
    this.undoStack.push(current);
    const next = JSON.parse(this.redoStack.pop()!) as WallObject[];
    this.replaceObjects(next);
  }

  private replaceObjects(objs: WallObject[]): void {
    this.mainLayer.destroyChildren();
    this.konvaObjects.clear();
    this.boundNodeMap = new WeakMap();
    this.objects = objs;
    saveObjects(objs);
    this.objects.forEach(o => this.renderObject(o));
    this.mainLayer.add(this.transformer);
    this.mainLayer.batchDraw();
  }

  teleportTo(x: number, y: number, zoom: number = 1, instant = false): void {
    const stageWidth = this.stage.width();
    const stageHeight = this.stage.height();
    const targetX = stageWidth / 2 - x * zoom;
    const targetY = stageHeight / 2 - y * zoom;
    if (instant || document.hidden) {
      // Instant arrivals must not depend on requestAnimationFrame: an occluded
      // or background tab freezes it and would leave a tween forever unfinished
      // (e.g. a deep link opened in a new background tab).
      this.stage.position({ x: targetX, y: targetY });
      this.stage.scale({ x: zoom, y: zoom });
      this.options.onZoomChange?.(zoom);
      this.drawGrid();
      this.saveViewport();
      return;
    }
    this.stage.to({
      x: targetX,
      y: targetY,
      scaleX: zoom,
      scaleY: zoom,
      duration: 0.8,
      easing: Konva.Easings.EaseInOut,
      onFinish: () => {
        this.options.onZoomChange?.(zoom);
        this.drawGrid();
      },
    });
    setTimeout(() => this.saveViewport(), 900);
  }

  teleportRandom(): { obj: WallObject | undefined; found: boolean } {
    // The Confession Corridor is deliberately excluded from random discovery —
    // its marks are found by choosing to go there, never stumble-upon.
    const pool = this.objects.filter(o => o.type !== 'confession');
    if (pool.length === 0) {
      const x = (Math.random() - 0.5) * 12000;
      const y = (Math.random() - 0.5) * 12000;
      this.teleportTo(x, y, 0.6);
      return { obj: undefined, found: false };
    }
    const obj = pool[Math.floor(Math.random() * pool.length)];
    const node = this.konvaObjects.get(obj.id);
    if (node) {
      const bounds = node.getClientRect();
      this.teleportTo(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 1.3);
    }
    return { obj, found: true };
  }

  teleportToObjectId(id: string): boolean {
    const node = this.konvaObjects.get(id);
    if (!node) return false;
    const bounds = node.getClientRect();
    this.teleportTo(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 1.5);
    this.selectObject(id);
    const wallObj = this.objects.find(o => o.id === id);
    if (wallObj) this.options.onObjectSelected?.(wallObj);
    return true;
  }

  setTool(tool: Tool): void {
    this.currentTool = tool;
    // Only in select mode the stage itself is draggable so the user can pan the
    // infinite canvas by dragging empty space (drag on a piece moves that piece).
    // React taps are kept drag-free so quick reactions don't accidentally pan.
    this.stage.draggable(tool === 'select');
    this.stage.container().style.cursor = this.getCursorForTool(tool);
    if (tool !== 'select') this.deselectAll();
    this.options.onToolChange?.(tool);
  }

  getTool(): Tool {
    return this.currentTool;
  }

  setColor(color: string): void {
    this.currentColor = color;
  }

  setStrokeWidth(width: number): void {
    this.strokeWidth = width;
  }

  private getCursorForTool(tool: Tool): string {
    switch (tool) {
      case 'draw': return PENCIL_CURSOR;
      case 'erase': return ERASER_CURSOR;
      case 'text':
      case 'confession': return 'text';
      case 'react': return 'pointer';
      case 'select': return 'grab';
      case 'rect':
      case 'circle': return 'crosshair';
      case 'sticker':
      case 'image':
      case 'secret':
      case 'timecapsule': return 'copy';
      default: return 'default';
    }
  }

  deleteSelected(): void {
    if (!this.selectedObjectId) return;
    this.saveUndoState();
    const node = this.konvaObjects.get(this.selectedObjectId);
    if (node) node.destroy();
    this.konvaObjects.delete(this.selectedObjectId);
    const removedId = this.selectedObjectId;
    this.objects = this.objects.filter(o => o.id !== removedId);
    removeObject(removedId);
    this.deselectAll();
    this.options.onObjectSelected?.(null);
  }

  getSelectedObject(): WallObject | null {
    if (!this.selectedObjectId) return null;
    return this.objects.find(o => o.id === this.selectedObjectId) || null;
  }

  getObjects(): WallObject[] {
    return this.objects;
  }

  getZoom(): number {
    return this.stage.scaleX();
  }

  /** World-space point currently at the center of the viewport. */
  getCameraCenter(): { x: number; y: number } {
    const scale = this.stage.scaleX();
    return {
      x: (this.stage.width() / 2 - this.stage.x()) / scale,
      y: (this.stage.height() / 2 - this.stage.y()) / scale,
    };
  }

  /** Renders other users' live cursors on the ui layer. Diffs against the
   *  previous set so idle cursors don't get destroyed/recreated every tick. */
  renderRemoteCursors(cursors: RemoteCursor[]): void {
    const seen = new Set<string>();
    for (const c of cursors) {
      seen.add(c.id);
      let group = this.remoteCursorNodes.get(c.id);
      if (!group) {
        const hue = hashToHue(c.id);
        const color = `hsl(${hue}, 75%, 60%)`;
        group = new Konva.Group({ x: c.x, y: c.y, listening: false });
        group.add(new Konva.Circle({ radius: 5, fill: color, stroke: '#0a0a0a', strokeWidth: 1.5 }));
        group.add(new Konva.Text({
          x: 10, y: -8,
          text: `${c.avatar} ${c.username}`,
          fontSize: 12,
          fontFamily: 'Space Mono, monospace',
          fill: color,
          shadowColor: '#000', shadowBlur: 4, shadowOpacity: 0.8,
        }));
        this.uiLayer.add(group);
        this.remoteCursorNodes.set(c.id, group);
      } else {
        group.to({ x: c.x, y: c.y, duration: 0.12 });
      }
    }
    for (const [id, group] of [...this.remoteCursorNodes]) {
      if (!seen.has(id)) {
        group.destroy();
        this.remoteCursorNodes.delete(id);
      }
    }
    this.uiLayer.batchDraw();
  }

  getStage(): Konva.Stage {
    return this.stage;
  }

  getMainLayer(): Konva.Layer {
    return this.mainLayer;
  }

  addImageObject(img: HTMLImageElement): void {
    const stage = this.stage;
    const scale = stage.scaleX();
    const pos = stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 };
    const canvasX = (pos.x - stage.x()) / scale;
    const canvasY = (pos.y - stage.y()) / scale;

    const maxDim = 400;
    const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
    const targetWidth = img.width * ratio;
    const targetHeight = img.height * ratio;

    this.saveUndoState();
    const id = generateId();
    const wallObj: WallObject = {
      id,
      type: 'image',
      x: canvasX - targetWidth / 2,
      y: canvasY - targetHeight / 2,
      data: { src: img.src, width: targetWidth, height: targetHeight, rotation: 0 },
      author: loadUserProfile()?.username || 'anonymous',
      createdAt: Date.now(),
      expiresAt: Date.now() + DURATION_MS['24h'],
      ghostUntil: Date.now() + DURATION_MS['24h'] + GHOST_MS,
      keptForever: false,
      reactions: [],
      comments: [],
      parentId: null,
      modifiedBy: [],
    };

    const konvaImg = new Konva.Image({
      x: canvasX - targetWidth / 2,
      y: canvasY - targetHeight / 2,
      width: targetWidth,
      height: targetHeight,
      image: img,
      id,
    });

    this.mainLayer.add(konvaImg);
    this.konvaObjects.set(id, konvaImg as unknown as Konva.Node);
    this.boundNodeMap.set(konvaImg as unknown as Konva.Node, wallObj);
    this.makeObjectsDraggable(konvaImg as unknown as Konva.Node, wallObj);
    addObject(wallObj);
    this.objects.push(wallObj);
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    this.stage.destroy();
  }
}
