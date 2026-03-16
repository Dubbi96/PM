/**
 * FloorPlanRenderer — 2D Canvas renderer for room floor plans.
 *
 * Draws room boundaries, zone polygons (color-coded with Korean labels),
 * access-point symbols, ESP32 node markers, pulsing person-presence
 * indicators, an optional grid overlay, and an informational legend.
 *
 * Usage:
 *   import { FloorPlanRenderer } from './floorplan.js';
 *   const fp = new FloorPlanRenderer('floor-canvas', roomConfig);
 *   fp.render(locationData);
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARGIN = 40;                       // px padding for labels
const GRID_DASH = [2, 4];               // dotted grid pattern
const GRID_COLOR = 'rgba(255,255,255,0.08)';
const ROOM_BORDER_COLOR = 'rgba(200,210,220,0.6)';
const ROOM_FILL = 'rgba(15,20,30,0.35)';
const BADGE_RADIUS = 10;
const BADGE_FONT = 'bold 10px "JetBrains Mono", "Noto Sans KR", monospace';
const LABEL_FONT = '12px "Noto Sans KR", "JetBrains Mono", sans-serif';
const LEGEND_FONT = '10px "JetBrains Mono", "Noto Sans KR", monospace';
const LEGEND_TITLE_FONT = 'bold 10px "JetBrains Mono", monospace';

const NODE_STATUS_COLORS = {
  connected:    '#4CAF50',
  disconnected: '#9E9E9E',
  error:        '#F44336',
};

const PULSE_SPEED = 2.2;   // radians / sec
const PULSE_MIN   = 0.35;
const PULSE_MAX   = 1.0;

// ---------------------------------------------------------------------------
// Helper: parse hex color to rgba string
// ---------------------------------------------------------------------------

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Helper: compute polygon centroid
// ---------------------------------------------------------------------------

function polygonCentroid(polygon) {
  let cx = 0, cy = 0;
  for (const [x, y] of polygon) { cx += x; cy += y; }
  return [cx / polygon.length, cy / polygon.length];
}

// ---------------------------------------------------------------------------
// Helper: point-in-polygon (ray-casting)
// ---------------------------------------------------------------------------

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Helper: polygon bounding-box top-right (for badge placement)
// ---------------------------------------------------------------------------

function polygonTopRight(polygon) {
  let maxX = -Infinity, minY = Infinity;
  for (const [x, y] of polygon) {
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
  }
  return [maxX, minY];
}

// ---------------------------------------------------------------------------
// FloorPlanRenderer
// ---------------------------------------------------------------------------

class FloorPlanRenderer {
  /**
   * @param {string|HTMLCanvasElement} canvasOrId - DOM id string or canvas element
   * @param {object} roomConfig - Config object matching default-room.json schema
   */
  constructor(canvasOrId, roomConfig) {
    /** @type {HTMLCanvasElement} */
    if (typeof canvasOrId === 'string') {
      this._canvas = document.getElementById(canvasOrId);
      this._canvasId = canvasOrId;
    } else {
      this._canvas = canvasOrId;
      this._canvasId = canvasOrId ? canvasOrId.id : '';
    }
    if (!this._canvas) throw new Error('Canvas element not found');
    /** @type {CanvasRenderingContext2D} */
    this._ctx = this._canvas.getContext('2d');

    // Room model (will be populated by loadConfig)
    this._room = null;
    this._zones = [];
    this._accessPoints = [];
    this._nodes = [];
    this._settings = { showGrid: true, gridSize: 0.5 };

    // Rendering state
    this._scale = 1;          // world-units -> px
    this._offsetX = MARGIN;   // canvas px offset
    this._offsetY = MARGIN;
    this._dpr = window.devicePixelRatio || 1;

    // Occupancy overlay (zone-id -> { occupied, count })
    this._occupancy = {};

    // Animation
    this._animationId = null;
    this._startTime = performance.now();
    this._pulsePhases = {};   // zone-id -> random phase offset

    // Interaction
    this._zoneClickCb = null;
    this._highlightedZone = null;
    this._canvas.addEventListener('click', this._handleClick.bind(this));

    // Resize handling
    this._resizeObserver = new ResizeObserver(() => this.resize());
    const parent = this._canvas.parentElement;
    if (parent) this._resizeObserver.observe(parent);
    window.addEventListener('resize', () => this.resize());

    // Load config and perform initial sizing + render
    if (roomConfig) this.loadConfig(roomConfig);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Load (or reload) a room configuration.
   * @param {object} roomConfig
   */
  loadConfig(roomConfig) {
    this._room = roomConfig.room || { name: 'Room', width: 8, height: 6, unit: 'm' };
    this._zones = (roomConfig.zones || []).map(z => ({ ...z }));
    this._accessPoints = (roomConfig.accessPoints || []).map(a => ({ ...a }));
    this._nodes = (roomConfig.nodes || []).map(n => ({ ...n }));
    this._settings = { showGrid: true, gridSize: 0.5, ...(roomConfig.settings || {}) };

    // Assign random pulse-phase offsets per zone
    for (const z of this._zones) {
      if (!this._pulsePhases[z.id]) {
        this._pulsePhases[z.id] = Math.random() * Math.PI * 2;
      }
    }

    this.resize();
    this._startAnimation();
  }

  /**
   * Full re-render with live location data.
   *
   * @param {object} locationData
   *   locationData.zones   - Array of { id, occupied, count }
   *   locationData.nodes   - Array of { id, status }
   *   locationData.persons - Array of { x, y } (world coords) — optional
   */
  render(locationData) {
    if (locationData) {
      if (locationData.zones) this.updateOccupancy(locationData.zones);
      if (locationData.nodes) this.updateNodes(locationData.nodes);
      this._persons = locationData.persons || [];
    }
    this._draw();
  }

  /**
   * Update zone occupancy from LocationViewModel without full re-render.
   * @param {Array<{id:string, occupied:boolean, count:number}>} zones
   */
  updateOccupancy(zones) {
    for (const z of zones) {
      this._occupancy[z.id] = { occupied: z.occupied, count: z.count || 0 };
    }
  }

  /**
   * Update ESP32 node connection status.
   * @param {Array<{id:string, status:string}>} nodes
   */
  updateNodes(nodes) {
    for (const update of nodes) {
      const node = this._nodes.find(n => n.id === update.id);
      if (node) node.status = update.status;
    }
  }

  /** Recalculate canvas dimensions and scale to fit container. */
  resize() {
    const parent = this._canvas.parentElement;
    if (!parent) return;
    const parentW = parent.clientWidth || 640;
    const parentH = parent.clientHeight || 480;
    this._fitToSize(parentW, parentH);
    this._draw();
  }

  /**
   * Register a click handler for zone clicks.
   * @param {function({zone: object, occupied: boolean, count: number})} callback
   */
  onZoneClick(callback) {
    this._zoneClickCb = callback;
  }

  /**
   * Visually highlight a specific zone.
   * @param {string|null} zoneId - Pass null to clear highlight.
   */
  highlightZone(zoneId) {
    this._highlightedZone = zoneId;
  }

  /**
   * Update method expected by app.js — merges zone/node state and re-renders.
   * @param {object} data - { zones: [{id, occupied, confidence}], nodes: [{id, connected}], peopleCount }
   */
  update(data) {
    if (!data) return;
    if (Array.isArray(data.zones)) {
      this.updateOccupancy(data.zones.map(function(z) {
        return { id: z.id, occupied: !!z.occupied, count: z.count || (z.occupied ? 1 : 0) };
      }));
    }
    if (Array.isArray(data.nodes)) {
      this.updateNodes(data.nodes.map(function(n) {
        return { id: n.id, status: n.connected ? 'connected' : 'disconnected' };
      }));
    }
    if (data.persons) {
      this._persons = data.persons;
    }
  }

  /**
   * Single-frame render tick — called by app.js render loop via requestAnimationFrame.
   * The internal animation loop already does this, but this allows external control.
   */
  renderFrame() {
    this._draw();
  }

  /** Cleanup resources. */
  dispose() {
    if (this._animationId) cancelAnimationFrame(this._animationId);
    this._resizeObserver.disconnect();
    this._canvas.removeEventListener('click', this._handleClick.bind(this));
  }

  /** Alias for dispose — used by app.js */
  destroy() {
    this.dispose();
  }

  // -----------------------------------------------------------------------
  // Canvas sizing
  // -----------------------------------------------------------------------

  /** @private */
  _fitToSize(containerW, containerH) {
    if (!this._room) return;

    const roomW = this._room.width;
    const roomH = this._room.height;
    const drawW = containerW - MARGIN * 2;
    const drawH = containerH - MARGIN * 2;

    // Maintain room aspect ratio
    const scaleX = drawW / roomW;
    const scaleY = drawH / roomH;
    this._scale = Math.min(scaleX, scaleY);

    // Center the room in the available space
    const renderedW = roomW * this._scale;
    const renderedH = roomH * this._scale;
    this._offsetX = MARGIN + (drawW - renderedW) / 2;
    this._offsetY = MARGIN + (drawH - renderedH) / 2;

    // HiDPI scaling
    this._dpr = window.devicePixelRatio || 1;
    this._canvas.width = containerW * this._dpr;
    this._canvas.height = containerH * this._dpr;
    this._canvas.style.width = `${containerW}px`;
    this._canvas.style.height = `${containerH}px`;
    this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  // -----------------------------------------------------------------------
  // Coordinate transforms
  // -----------------------------------------------------------------------

  /** Convert room-world coords (meters) to canvas px. @private */
  _worldToCanvas(x, y) {
    return [
      this._offsetX + x * this._scale,
      this._offsetY + y * this._scale,
    ];
  }

  /** Convert canvas px to room-world coords. @private */
  _canvasToWorld(cx, cy) {
    return [
      (cx - this._offsetX) / this._scale,
      (cy - this._offsetY) / this._scale,
    ];
  }

  // -----------------------------------------------------------------------
  // Animation loop
  // -----------------------------------------------------------------------

  /** @private */
  _startAnimation() {
    if (this._animationId) return; // already running
    const tick = () => {
      this._draw();
      this._animationId = requestAnimationFrame(tick);
    };
    this._animationId = requestAnimationFrame(tick);
  }

  // -----------------------------------------------------------------------
  // Main draw pipeline
  // -----------------------------------------------------------------------

  /** @private */
  _draw() {
    const ctx = this._ctx;
    const w = this._canvas.width / this._dpr;
    const h = this._canvas.height / this._dpr;

    // Clear
    ctx.clearRect(0, 0, w, h);

    if (!this._room) return;

    // Background
    ctx.fillStyle = '#0a0e18';
    ctx.fillRect(0, 0, w, h);

    // Draw layers in order
    if (this._settings.showGrid) this._drawGrid();
    this._drawRoom();
    this._drawZones();
    this._drawPersonIndicators();
    this._drawAccessPoints();
    this._drawNodes();
    this._drawLegend();
  }

  // -----------------------------------------------------------------------
  // Grid
  // -----------------------------------------------------------------------

  /** @private */
  _drawGrid() {
    const ctx = this._ctx;
    const gridSize = this._settings.gridSize || 0.5;
    const roomW = this._room.width;
    const roomH = this._room.height;

    ctx.save();
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.setLineDash(GRID_DASH);

    // Vertical lines
    for (let x = 0; x <= roomW; x += gridSize) {
      const [cx1, cy1] = this._worldToCanvas(x, 0);
      const [cx2, cy2] = this._worldToCanvas(x, roomH);
      ctx.beginPath();
      ctx.moveTo(cx1, cy1);
      ctx.lineTo(cx2, cy2);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y <= roomH; y += gridSize) {
      const [cx1, cy1] = this._worldToCanvas(0, y);
      const [cx2, cy2] = this._worldToCanvas(roomW, y);
      ctx.beginPath();
      ctx.moveTo(cx1, cy1);
      ctx.lineTo(cx2, cy2);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Room boundary
  // -----------------------------------------------------------------------

  /** @private */
  _drawRoom() {
    const ctx = this._ctx;
    const [x0, y0] = this._worldToCanvas(0, 0);
    const [x1, y1] = this._worldToCanvas(this._room.width, this._room.height);
    const w = x1 - x0;
    const h = y1 - y0;

    // Fill
    ctx.fillStyle = ROOM_FILL;
    ctx.fillRect(x0, y0, w, h);

    // Border
    ctx.strokeStyle = ROOM_BORDER_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, w, h);

    // Room name + dimensions label above the room
    ctx.save();
    ctx.font = '13px "Noto Sans KR", "JetBrains Mono", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const unit = this._room.unit || 'm';
    const dimText = `${this._room.name}  (${this._room.width}${unit} x ${this._room.height}${unit})`;
    ctx.fillText(dimText, x0, y0 - 8);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Zones
  // -----------------------------------------------------------------------

  /** @private */
  _drawZones() {
    for (const zone of this._zones) {
      this._drawSingleZone(zone);
    }
  }

  /** @private */
  _drawSingleZone(zone) {
    const ctx = this._ctx;
    const polygon = zone.polygon;
    if (!polygon || polygon.length < 3) return;

    const occ = this._occupancy[zone.id] || { occupied: false, count: 0 };
    const isHighlighted = this._highlightedZone === zone.id;

    // Determine fill alpha
    let fillAlpha = 0.2;
    if (occ.occupied) fillAlpha = 0.4;
    if (isHighlighted) fillAlpha = Math.min(fillAlpha + 0.15, 0.6);

    // Build canvas path
    ctx.beginPath();
    const [sx, sy] = this._worldToCanvas(polygon[0][0], polygon[0][1]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < polygon.length; i++) {
      const [px, py] = this._worldToCanvas(polygon[i][0], polygon[i][1]);
      ctx.lineTo(px, py);
    }
    ctx.closePath();

    // Fill
    ctx.fillStyle = hexToRgba(zone.color, fillAlpha);
    ctx.fill();

    // Stroke
    ctx.strokeStyle = hexToRgba(zone.color, isHighlighted ? 0.9 : 0.6);
    ctx.lineWidth = isHighlighted ? 2.5 : 1.5;
    ctx.stroke();

    // Label
    this._drawZoneLabel(zone);

    // Occupancy badge
    if (occ.occupied) {
      this._drawOccupancyBadge(zone, occ.occupied, occ.count);
    }
  }

  /** Draw zone name centered in polygon. @private */
  _drawZoneLabel(zone) {
    const ctx = this._ctx;
    const [cx, cy] = polygonCentroid(zone.polygon);
    const [px, py] = this._worldToCanvas(cx, cy);

    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(zone.name, px, py);
    ctx.restore();
  }

  /** Draw person-count badge at top-right of zone polygon. @private */
  _drawOccupancyBadge(zone, occupied, count) {
    const ctx = this._ctx;
    const [trx, try_] = polygonTopRight(zone.polygon);
    const [bx, by] = this._worldToCanvas(trx, try_);

    // Offset badge slightly outside the polygon corner
    const ox = bx + 4;
    const oy = by - 4;

    // Background circle
    ctx.beginPath();
    ctx.arc(ox, oy, BADGE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = zone.color;
    ctx.fill();

    // White border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Count text
    ctx.save();
    ctx.font = BADGE_FONT;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), ox, oy + 0.5);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Access Points (WiFi router symbol)
  // -----------------------------------------------------------------------

  /** @private */
  _drawAccessPoints() {
    const ctx = this._ctx;

    for (const ap of this._accessPoints) {
      const [cx, cy] = this._worldToCanvas(ap.x, ap.y);

      // Draw WiFi-like arcs radiating from a base dot
      ctx.save();
      ctx.translate(cx, cy);

      // Base dot
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#00BCD4';
      ctx.fill();

      // Concentric arcs (WiFi signal symbol)
      ctx.strokeStyle = 'rgba(0,188,212,0.7)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      for (let i = 1; i <= 3; i++) {
        const r = 5 + i * 5;
        ctx.beginPath();
        ctx.arc(0, 0, r, -Math.PI * 0.35, -Math.PI * 0.65, true);
        ctx.globalAlpha = 1 - i * 0.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Label
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(0,188,212,0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(ap.name, 0, 22);

      ctx.restore();
    }
  }

  // -----------------------------------------------------------------------
  // ESP32 Nodes
  // -----------------------------------------------------------------------

  /** @private */
  _drawNodes() {
    const ctx = this._ctx;
    const nodeSize = 8;

    for (const node of this._nodes) {
      const [cx, cy] = this._worldToCanvas(node.x, node.y);
      const status = node.status || 'disconnected';
      const color = NODE_STATUS_COLORS[status] || NODE_STATUS_COLORS.disconnected;

      // Outer glow for connected nodes
      if (status === 'connected') {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.rect(cx - nodeSize / 2, cy - nodeSize / 2, nodeSize, nodeSize);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }

      // Square marker
      ctx.fillStyle = color;
      ctx.fillRect(cx - nodeSize / 2, cy - nodeSize / 2, nodeSize, nodeSize);

      // Inner lighter square
      ctx.fillStyle = hexToRgba(color, 0.3);
      const inner = nodeSize * 0.4;
      ctx.fillRect(cx - inner / 2, cy - inner / 2, inner, inner);

      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - nodeSize / 2, cy - nodeSize / 2, nodeSize, nodeSize);

      // Label
      ctx.save();
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.name, cx, cy + nodeSize / 2 + 4);
      ctx.restore();
    }
  }

  // -----------------------------------------------------------------------
  // Person presence indicators (pulsing circles)
  // -----------------------------------------------------------------------

  /** @private */
  _drawPersonIndicators() {
    const ctx = this._ctx;
    const elapsed = (performance.now() - this._startTime) / 1000;

    // Green Neon color for all person indicators
    const NEON = { r: 0, g: 255, b: 136 };  // #00ff88
    const neonRgba = (a) => `rgba(${NEON.r},${NEON.g},${NEON.b},${a})`;

    for (const zone of this._zones) {
      const occ = this._occupancy[zone.id];
      if (!occ || !occ.occupied || occ.count === 0) continue;

      const count = occ.count;
      const phaseOffset = this._pulsePhases[zone.id] || 0;

      // Green neon glow on occupied zone border
      ctx.save();
      ctx.shadowColor = '#00ff88';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      const poly = zone.polygon;
      const [sx, sy] = this._worldToCanvas(poly[0][0], poly[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < poly.length; i++) {
        const [px, py] = this._worldToCanvas(poly[i][0], poly[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = neonRgba(0.6);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Distribute presence dots across the zone polygon
      const [ccx, ccy] = polygonCentroid(zone.polygon);
      const positions = this._distributeInZone(zone.polygon, ccx, ccy, count);

      for (let i = 0; i < positions.length; i++) {
        const [wx, wy] = positions[i];
        const [px, py] = this._worldToCanvas(wx, wy);
        const perPhase = phaseOffset + i * 1.3;
        const p = PULSE_MIN + (PULSE_MAX - PULSE_MIN) *
          (0.5 + 0.5 * Math.sin(elapsed * PULSE_SPEED + perPhase));

        // Outer neon glow ring
        ctx.save();
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 15 * p;
        ctx.beginPath();
        ctx.arc(px, py, 12 + p * 6, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.04 * p);
        ctx.fill();
        ctx.restore();

        // Mid neon ring
        ctx.beginPath();
        ctx.arc(px, py, 8 + p * 3, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.12 * p);
        ctx.fill();

        // Inner neon ring
        ctx.beginPath();
        ctx.arc(px, py, 5 + p * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.25 * p);
        ctx.fill();

        // Core dot with neon glow
        ctx.save();
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.8 + 0.2 * p);
        ctx.fill();
        ctx.restore();

        // Bright center
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.7 + 0.3 * p})`;
        ctx.fill();
      }
    }

    // Also draw explicit person positions (from locationData.persons)
    if (this._persons && this._persons.length > 0) {
      for (let i = 0; i < this._persons.length; i++) {
        const person = this._persons[i];
        const [px, py] = this._worldToCanvas(person.x, person.y);
        const phaseOffset = i * 2.1;
        const p = PULSE_MIN + (PULSE_MAX - PULSE_MIN) *
          (0.5 + 0.5 * Math.sin(elapsed * PULSE_SPEED + phaseOffset));

        // Outer neon glow
        ctx.save();
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 20 * p;
        ctx.beginPath();
        ctx.arc(px, py, 14 + p * 6, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.05 * p);
        ctx.fill();
        ctx.restore();

        // Neon ring
        ctx.beginPath();
        ctx.arc(px, py, 8 + p * 3, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.15 * p);
        ctx.fill();

        // Core neon dot
        ctx.save();
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = neonRgba(0.85 + 0.15 * p);
        ctx.fill();
        ctx.restore();

        // White hot center
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.8 * p})`;
        ctx.fill();
      }
    }
  }

  /**
   * Deterministically distribute N points inside a polygon.
   * Uses centroid-offset pattern so dots spread naturally.
   * @private
   */
  _distributeInZone(polygon, cx, cy, count) {
    if (count === 0) return [];
    if (count === 1) return [[cx, cy]];

    // Compute polygon bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const positions = [];
    // Use golden-angle spiral around centroid, constrained to polygon
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const maxRadius = Math.min(maxX - minX, maxY - minY) * 0.35;
    let placed = 0;
    let attempt = 0;

    while (placed < count && attempt < count * 10) {
      const r = maxRadius * Math.sqrt((attempt + 1) / (count + 2)) * 0.8;
      const theta = attempt * goldenAngle;
      const px = cx + r * Math.cos(theta);
      const py = cy + r * Math.sin(theta);

      if (pointInPolygon(px, py, polygon)) {
        positions.push([px, py]);
        placed++;
      }
      attempt++;
    }

    // Fallback: if some could not be placed, stack at centroid
    while (positions.length < count) {
      positions.push([cx + (positions.length * 0.15), cy]);
    }

    return positions;
  }

  // -----------------------------------------------------------------------
  // Legend
  // -----------------------------------------------------------------------

  /** @private */
  _drawLegend() {
    const ctx = this._ctx;
    const canvasW = this._canvas.width / this._dpr;
    const canvasH = this._canvas.height / this._dpr;

    const entries = [];

    // Zone entries
    for (const z of this._zones) {
      entries.push({ type: 'zone', color: z.color, label: z.name });
    }

    // Node status entries
    entries.push({ type: 'divider' });
    entries.push({ type: 'nodeStatus', color: NODE_STATUS_COLORS.connected, label: 'Connected' });
    entries.push({ type: 'nodeStatus', color: NODE_STATUS_COLORS.disconnected, label: 'Disconnected' });
    entries.push({ type: 'nodeStatus', color: NODE_STATUS_COLORS.error, label: 'Error' });

    // Compute legend dimensions
    const lineH = 16;
    const padX = 12;
    const padY = 8;
    const titleH = 18;
    const legendW = 130;
    const legendH = padY * 2 + titleH + entries.length * lineH;

    const lx = canvasW - legendW - 12;
    const ly = canvasH - legendH - 12;

    // Background
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,24,0.85)';
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, lx, ly, legendW, legendH, 6);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font = LEGEND_TITLE_FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Legend', lx + padX, ly + padY);

    // Entries
    let ey = ly + padY + titleH;
    ctx.font = LEGEND_FONT;
    for (const entry of entries) {
      if (entry.type === 'divider') {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(lx + padX, ey + lineH / 2);
        ctx.lineTo(lx + legendW - padX, ey + lineH / 2);
        ctx.stroke();
        ey += lineH;
        continue;
      }

      if (entry.type === 'zone') {
        // Filled circle swatch
        ctx.beginPath();
        ctx.arc(lx + padX + 5, ey + 6, 4, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(entry.color, 0.6);
        ctx.fill();
        ctx.strokeStyle = entry.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (entry.type === 'nodeStatus') {
        // Small square swatch
        ctx.fillStyle = entry.color;
        ctx.fillRect(lx + padX + 1, ey + 2, 8, 8);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textBaseline = 'top';
      ctx.fillText(entry.label, lx + padX + 16, ey + 1);
      ey += lineH;
    }

    ctx.restore();
  }

  /** Helper: draw a rounded rectangle path. @private */
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------

  /** @private */
  _handleClick(event) {
    if (!this._zoneClickCb) return;

    const rect = this._canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const [wx, wy] = this._canvasToWorld(cx, cy);

    for (const zone of this._zones) {
      if (pointInPolygon(wx, wy, zone.polygon)) {
        const occ = this._occupancy[zone.id] || { occupied: false, count: 0 };
        this._zoneClickCb({
          zone,
          occupied: occ.occupied,
          count: occ.count,
        });
        return;
      }
    }
  }
}

// Expose to window for non-module script loading
window.FloorPlanRenderer = FloorPlanRenderer;
