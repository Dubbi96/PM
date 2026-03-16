/**
 * SignalMeshRenderer — 2D Canvas renderer for AP signal propagation mesh.
 *
 * Replaces room-based floor plan with signal propagation visualization.
 * Does NOT require a room definition — renders based on AP signal propagation,
 * Fresnel zones, and RSSI-based presence detection overlays.
 *
 * Usage:
 *   const sm = new SignalMeshRenderer('floorplan-canvas', signalMapConfig);
 *   sm.render(presenceData);
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var SM_MARGIN = 60;
var SM_GRID_DASH = [2, 4];
var SM_GRID_COLOR = 'rgba(255,255,255,0.06)';
var SM_BG_COLOR = '#0a0e18';

var SM_LABEL_FONT = '12px "Noto Sans KR", "JetBrains Mono", sans-serif';
var SM_SMALL_FONT = '10px "JetBrains Mono", "Noto Sans KR", monospace';
var SM_TINY_FONT = '9px "JetBrains Mono", monospace';
var SM_LEGEND_FONT = '10px "JetBrains Mono", "Noto Sans KR", monospace';
var SM_LEGEND_TITLE_FONT = 'bold 10px "JetBrains Mono", monospace';
var SM_STATUS_FONT = 'bold 11px "JetBrains Mono", "Noto Sans KR", monospace';
var SM_TRACKED_LABEL_FONT = '11px sans-serif';

var SM_AP_COLOR = '#00BCD4';
var SM_NEON_GREEN = '#00ff88';
var SM_NEON_R = 0;
var SM_NEON_G = 255;
var SM_NEON_B = 136;

var SM_NODE_STATUS_COLORS = {
  connected:    '#4CAF50',
  disconnected: '#9E9E9E',
  error:        '#F44336'
};

var SM_PC_NODE_COLORS = {
  connected:    '#00BCD4',   // cyan for connected PC monitors
  disconnected: '#607D8B'    // blue-grey for disconnected
};

// Contour color stops: maps RSSI dBm to [r,g,b]
// -30 bright cyan, -50 blue, -70 dark indigo, -80 nearly invisible
var SM_CONTOUR_COLORS = {
  '-30': [0, 255, 255],
  '-40': [0, 180, 230],
  '-50': [30, 100, 220],
  '-60': [40, 60, 180],
  '-70': [30, 30, 120],
  '-80': [20, 15, 60]
};

var SM_PULSE_SPEED_STILL = Math.PI;       // 2s full cycle
var SM_PULSE_SPEED_ACTIVE = Math.PI * 2;  // 1s full cycle

var MAX_TRAIL_POINTS = 60;

// Speed of light for Fresnel calculation
var SM_SPEED_OF_LIGHT = 299792458; // m/s

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function smHexToRgba(hex, alpha) {
  var h = hex.replace('#', '');
  var r = parseInt(h.substring(0, 2), 16);
  var g = parseInt(h.substring(2, 4), 16);
  var b = parseInt(h.substring(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function smNeonRgba(a) {
  return 'rgba(' + SM_NEON_R + ',' + SM_NEON_G + ',' + SM_NEON_B + ',' + a + ')';
}

function smLerp(a, b, t) {
  return a + (b - a) * t;
}

function smClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Interpolate contour color for a given RSSI level. */
function smContourColor(rssi, alpha) {
  var levels = [-30, -40, -50, -60, -70, -80];
  if (rssi >= levels[0]) {
    var c = SM_CONTOUR_COLORS['-30'];
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }
  if (rssi <= levels[levels.length - 1]) {
    var c2 = SM_CONTOUR_COLORS['-80'];
    return 'rgba(' + c2[0] + ',' + c2[1] + ',' + c2[2] + ',' + alpha + ')';
  }
  for (var i = 0; i < levels.length - 1; i++) {
    if (rssi <= levels[i] && rssi >= levels[i + 1]) {
      var t = (levels[i] - rssi) / (levels[i] - levels[i + 1]);
      var ca = SM_CONTOUR_COLORS[String(levels[i])];
      var cb = SM_CONTOUR_COLORS[String(levels[i + 1])];
      var r = Math.round(smLerp(ca[0], cb[0], t));
      var g = Math.round(smLerp(ca[1], cb[1], t));
      var b = Math.round(smLerp(ca[2], cb[2], t));
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }
  return 'rgba(20,15,60,' + alpha + ')';
}

/** Distance between two 2D points. */
function smDist(x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Parse hex color to {r,g,b}. */
function smHexToRgb(hex) {
  var h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}

// ---------------------------------------------------------------------------
// SignalMeshRenderer
// ---------------------------------------------------------------------------

var SignalMeshRenderer = (function() {

  /**
   * @param {string|HTMLCanvasElement} canvasOrId
   * @param {object} config - Config matching default-signal-map.json schema
   */
  function SignalMeshRenderer(canvasOrId, config) {
    // Canvas setup
    if (typeof canvasOrId === 'string') {
      this._canvas = document.getElementById(canvasOrId);
      this._canvasId = canvasOrId;
    } else {
      this._canvas = canvasOrId;
      this._canvasId = canvasOrId ? canvasOrId.id : '';
    }
    if (!this._canvas) throw new Error('SignalMeshRenderer: Canvas element not found');
    this._ctx = this._canvas.getContext('2d');

    // Config model
    this._signalMap = null;
    this._accessPoints = [];
    this._nodes = [];
    this._visualization = {};
    this._detection = {};

    // Rendering state
    this._scale = 1;
    this._offsetX = SM_MARGIN;
    this._offsetY = SM_MARGIN;
    this._dpr = window.devicePixelRatio || 1;
    this._viewCenterX = 0;
    this._viewCenterY = 0;
    this._viewRadius = 8;

    // Heatmap offscreen canvas (lazily computed)
    this._heatmapCanvas = null;
    this._heatmapDirty = true;

    // Presence data
    this._presence = {
      state: 'absent',     // 'absent' | 'present_still' | 'active'
      confidence: 0,
      motionScore: 0,
      rssi: { current: -50, baseline: -42, variance: 0.2, snr: 25 },
      spectral: { breathingPower: 0, motionPower: 0, dominantFreq: 0 }
    };

    // Tracked devices for multi-person visualization
    this._trackedDevices = [];

    // Smoothly interpolated render positions per device id
    this._deviceRenderPositions = {};

    // Smooth trail state: id -> [{x, y, t}] canvas-space trail points with timestamp
    this._deviceTrails = {};

    // Fade alpha per device id (0..1). Used for smooth appear/disappear.
    this._deviceFadeAlpha = {};

    // Snapshot of last known device data for devices that just disappeared,
    // so we can keep rendering them during fade-out.
    this._deviceLastKnown = {};

    // Animation
    this._animationId = null;
    this._startTime = performance.now();
    this._apRadiationPhase = 0; // for radiating circles anim

    // Smooth detection overlay state (lerped each frame)
    this._overlayAlpha = 0;        // current rendered alpha (smoothly interpolated)
    this._overlayTargetAlpha = 0;  // target alpha based on presence state
    this._overlayLabelAlpha = 0;   // smoothly interpolated label opacity

    // Interaction
    this._areaClickCb = null;
    this._boundClick = this._handleClick.bind(this);
    this._canvas.addEventListener('click', this._boundClick);

    // Resize handling
    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this.resize.bind(this));
      var parent = this._canvas.parentElement;
      if (parent) this._resizeObserver.observe(parent);
    }
    this._boundResize = this.resize.bind(this);
    window.addEventListener('resize', this._boundResize);

    // Load config and perform initial sizing + render
    if (config) this.loadConfig(config);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Load (or reload) a signal map configuration.
   * @param {object} config
   */
  SignalMeshRenderer.prototype.loadConfig = function(config) {
    this._signalMap = config.signalMap || {
      name: 'Signal Map',
      gridResolution: 0.25,
      pathLossExponent: 3.0,
      referenceRssi: -30,
      unit: 'm'
    };
    this._accessPoints = (config.accessPoints || []).map(function(a) { return Object.assign({}, a); });
    this._nodes = (config.nodes || []).map(function(n) { return Object.assign({}, n); });
    this._visualization = Object.assign({
      meshRadius: 8.0,
      meshOpacity: 0.6,
      showFresnelZone: true,
      showSignalContours: true,
      contourLevels: [-30, -40, -50, -60, -70, -80],
      neonColor: '#00ff88',
      showGrid: true,
      gridSize: 0.5
    }, config.visualization || {});
    this._detection = config.detection || {};

    // Compute view bounds: auto-center on centroid of all APs and nodes with padding
    this._computeViewBounds();
    this._heatmapDirty = true;

    this.resize();
    this._startAnimation();
  };

  /**
   * Full render with presence state.
   * @param {object} presenceData - see RSSI-MESH-DETECTION-PLAN.md state model
   */
  SignalMeshRenderer.prototype.render = function(presenceData) {
    if (presenceData) {
      this.updatePresence(presenceData);
    }
    this._draw();
  };

  /**
   * Update the detection/presence overlay data.
   * @param {object} data - { presence, confidence, motionScore, rssi, spectral, ... }
   */
  SignalMeshRenderer.prototype.updatePresence = function(data) {
    if (!data) return;
    if (data.presence !== undefined) this._presence.state = data.presence;
    if (data.confidence !== undefined) this._presence.confidence = data.confidence;
    if (data.motionScore !== undefined) this._presence.motionScore = data.motionScore;
    if (data.rssi) {
      Object.assign(this._presence.rssi, data.rssi);
    }
    if (data.spectral) {
      Object.assign(this._presence.spectral, data.spectral);
    }
  };

  /**
   * Update node connection status (ESP32 or PC-monitor).
   * @param {Array<{id:string, status:string, connected:boolean}>} nodes
   */
  SignalMeshRenderer.prototype.updateNodes = function(nodes) {
    if (!Array.isArray(nodes)) return;
    for (var i = 0; i < nodes.length; i++) {
      var update = nodes[i];
      var node = null;
      for (var j = 0; j < this._nodes.length; j++) {
        if (this._nodes[j].id === update.id) {
          node = this._nodes[j];
          break;
        }
      }
      if (node) {
        if (update.status !== undefined) node.status = update.status;
        if (update.connected !== undefined) node.status = update.connected ? 'connected' : 'disconnected';
      }
    }
  };

  /**
   * Update tracked devices for multi-person position visualization.
   * @param {Array<{id:string, name:string, position:{x:number,y:number}, confidence:number, errorRadius:number, color:string, history:Array<{x:number,y:number}>, rssiByNode:object}>} devices
   */
  SignalMeshRenderer.prototype.updateTrackedDevices = function(devices) {
    this._trackedDevices = devices || [];

    // Build set of currently active device ids
    var activeIds = {};
    for (var i = 0; i < this._trackedDevices.length; i++) {
      var dev = this._trackedDevices[i];
      if (dev.id) {
        activeIds[dev.id] = true;
        // Mark active devices to fade IN (target alpha = 1)
        if (this._deviceFadeAlpha[dev.id] === undefined) {
          this._deviceFadeAlpha[dev.id] = 0; // start from 0 for new devices
        }
        // Snapshot last known data
        this._deviceLastKnown[dev.id] = dev;
      }
    }

    // For devices that just disappeared: DON'T delete their render state.
    // Instead let the draw loop fade them out via _deviceFadeAlpha.
    // Only clean up once alpha reaches ~0 (handled in _drawTrackedDevices).
  };

  /** Recalculate canvas dimensions and scale to fit container. */
  SignalMeshRenderer.prototype.resize = function() {
    var parent = this._canvas.parentElement;
    if (!parent) return;
    var containerW = parent.clientWidth || 640;
    var containerH = parent.clientHeight || 480;
    this._fitToSize(containerW, containerH);
    this._heatmapDirty = true;
    this._draw();
  };

  /**
   * Register a click handler for area clicks.
   * @param {function({worldX:number, worldY:number, ap:object|null, node:object|null})} callback
   */
  SignalMeshRenderer.prototype.onAreaClick = function(callback) {
    this._areaClickCb = callback;
  };

  /** Cleanup resources. */
  SignalMeshRenderer.prototype.dispose = function() {
    if (this._animationId) cancelAnimationFrame(this._animationId);
    this._animationId = null;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    window.removeEventListener('resize', this._boundResize);
    this._canvas.removeEventListener('click', this._boundClick);
    this._heatmapCanvas = null;
  };

  // -- Aliases for app.js compatibility --

  /**
   * Update method expected by app.js.
   * Accepts both zone-style data and signal-mesh presence data.
   * @param {object} data
   */
  SignalMeshRenderer.prototype.update = function(data) {
    if (!data) return;
    // Handle signal-mesh presence data
    if (data.presence !== undefined || data.rssi !== undefined) {
      this.updatePresence(data);
    }
    // Handle zone-style data (compatibility)
    if (Array.isArray(data.zones)) {
      // Convert zone occupancy to a simple presence heuristic
      var anyOccupied = false;
      for (var i = 0; i < data.zones.length; i++) {
        if (data.zones[i].occupied) { anyOccupied = true; break; }
      }
      if (this._presence.state === 'absent' && anyOccupied) {
        this._presence.state = 'present_still';
        this._presence.confidence = 0.7;
      } else if (!anyOccupied) {
        this._presence.state = 'absent';
        this._presence.confidence = 0;
      }
    }
    // Handle node status updates
    if (Array.isArray(data.nodes)) {
      this.updateNodes(data.nodes);
    }
    // Handle tracked devices for multi-person visualization
    if (data.trackedDevices) {
      this.updateTrackedDevices(data.trackedDevices);
    }
  };

  /** Single-frame render tick for external requestAnimationFrame control. */
  SignalMeshRenderer.prototype.renderFrame = function() {
    this._draw();
  };

  /** Alias for dispose. */
  SignalMeshRenderer.prototype.destroy = function() {
    this.dispose();
  };

  // =========================================================================
  // View bounds computation
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._computeViewBounds = function() {
    var allX = [];
    var allY = [];
    for (var i = 0; i < this._accessPoints.length; i++) {
      allX.push(this._accessPoints[i].x);
      allY.push(this._accessPoints[i].y);
    }
    for (var j = 0; j < this._nodes.length; j++) {
      allX.push(this._nodes[j].x);
      allY.push(this._nodes[j].y);
    }
    if (allX.length === 0) {
      this._viewCenterX = 0;
      this._viewCenterY = 0;
      this._viewRadius = this._visualization.meshRadius || 8;
      return;
    }
    var sumX = 0, sumY = 0;
    for (var k = 0; k < allX.length; k++) { sumX += allX[k]; sumY += allY[k]; }
    this._viewCenterX = sumX / allX.length;
    this._viewCenterY = sumY / allY.length;

    // Find max distance from centroid to any point, add padding
    var maxDist = 0;
    for (var m = 0; m < allX.length; m++) {
      var d = smDist(this._viewCenterX, this._viewCenterY, allX[m], allY[m]);
      if (d > maxDist) maxDist = d;
    }
    var meshR = this._visualization.meshRadius || 8;
    this._viewRadius = Math.max(maxDist + 2, meshR);
  };

  // =========================================================================
  // Canvas sizing
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._fitToSize = function(containerW, containerH) {
    var drawW = containerW - SM_MARGIN * 2;
    var drawH = containerH - SM_MARGIN * 2;
    var viewDiam = this._viewRadius * 2;

    var scaleX = drawW / viewDiam;
    var scaleY = drawH / viewDiam;
    this._scale = Math.min(scaleX, scaleY);

    var renderedW = viewDiam * this._scale;
    var renderedH = viewDiam * this._scale;
    this._offsetX = SM_MARGIN + (drawW - renderedW) / 2;
    this._offsetY = SM_MARGIN + (drawH - renderedH) / 2;

    this._dpr = window.devicePixelRatio || 1;
    this._canvas.width = containerW * this._dpr;
    this._canvas.height = containerH * this._dpr;
    this._canvas.style.width = containerW + 'px';
    this._canvas.style.height = containerH + 'px';
    this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  };

  // =========================================================================
  // Coordinate transforms
  // =========================================================================

  /** Convert world coords to canvas px. @private */
  SignalMeshRenderer.prototype._worldToCanvas = function(x, y) {
    var cx = this._offsetX + (x - this._viewCenterX + this._viewRadius) * this._scale;
    var cy = this._offsetY + (y - this._viewCenterY + this._viewRadius) * this._scale;
    return [cx, cy];
  };

  /** Convert canvas px to world coords. @private */
  SignalMeshRenderer.prototype._canvasToWorld = function(cx, cy) {
    var x = (cx - this._offsetX) / this._scale - this._viewRadius + this._viewCenterX;
    var y = (cy - this._offsetY) / this._scale - this._viewRadius + this._viewCenterY;
    return [x, y];
  };

  // =========================================================================
  // Physics helpers
  // =========================================================================

  /**
   * RSSI at distance d from an AP using path loss model.
   * rssi = referenceRssi - 10 * n * log10(d)
   * @private
   */
  SignalMeshRenderer.prototype._rssiAtDistance = function(d) {
    if (d <= 0) d = 0.01;
    var n = this._signalMap.pathLossExponent || 3.0;
    var ref = this._signalMap.referenceRssi || -30;
    return ref - 10 * n * Math.log10(d);
  };

  /**
   * Distance from RSSI using inverse path loss model.
   * d = 10^((referenceRssi - rssiLevel) / (10 * n))
   * @private
   */
  SignalMeshRenderer.prototype._distanceFromRssi = function(rssi) {
    var n = this._signalMap.pathLossExponent || 3.0;
    var ref = this._signalMap.referenceRssi || -30;
    return Math.pow(10, (ref - rssi) / (10 * n));
  };

  /**
   * First Fresnel zone radius at a given point between AP and node.
   * r = sqrt(lambda * d1 * d2 / (d1 + d2))
   * @param {number} d1 - distance from AP to point
   * @param {number} d2 - distance from point to node
   * @param {number} freq - frequency in MHz
   * @returns {number} radius in meters
   * @private
   */
  SignalMeshRenderer.prototype._fresnelRadius = function(d1, d2, freq) {
    var freqHz = (freq || 2437) * 1e6;
    var lambda = SM_SPEED_OF_LIGHT / freqHz; // ~0.123m at 2437MHz
    if (d1 + d2 <= 0) return 0;
    return Math.sqrt(lambda * d1 * d2 / (d1 + d2));
  };

  // =========================================================================
  // Animation loop
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._startAnimation = function() {
    if (this._animationId) return;
    var self = this;
    var tick = function() {
      self._draw();
      self._animationId = requestAnimationFrame(tick);
    };
    this._animationId = requestAnimationFrame(tick);
  };

  // =========================================================================
  // Main draw pipeline
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._draw = function() {
    var ctx = this._ctx;
    var w = this._canvas.width / this._dpr;
    var h = this._canvas.height / this._dpr;

    ctx.clearRect(0, 0, w, h);

    if (!this._signalMap) return;

    // Background
    ctx.fillStyle = SM_BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    // Draw layers in order — CLEAN view: grid, contours (subtle), nodes, AP, people
    if (this._visualization.showGrid) this._drawGrid();
    // _drawSignalHeatmap() — REMOVED (visual noise)
    if (this._visualization.showSignalContours) this._drawSignalContours();
    // _drawFresnelZone() — REMOVED (overlapping ellipses obscure everything)
    // _drawDetectionOverlay() — REMOVED (green glow covers the whole area)
    this._drawNodes();
    this._drawAccessPoints();
    this._drawTrackedDevices();
    // _drawPersonIndicator() — REMOVED (redundant with tracked devices)
    this._drawLegend();
    this._drawStatusOverlay();
  };

  // =========================================================================
  // Layer: Grid
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawGrid = function() {
    var ctx = this._ctx;
    var gridSize = this._visualization.gridSize || 0.5;
    var r = this._viewRadius;
    var cx0 = this._viewCenterX;
    var cy0 = this._viewCenterY;
    var minX = cx0 - r;
    var maxX = cx0 + r;
    var minY = cy0 - r;
    var maxY = cy0 + r;

    // Snap grid lines to gridSize multiples
    var startX = Math.floor(minX / gridSize) * gridSize;
    var startY = Math.floor(minY / gridSize) * gridSize;

    ctx.save();
    ctx.strokeStyle = SM_GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.setLineDash(SM_GRID_DASH);

    // Vertical lines
    for (var x = startX; x <= maxX; x += gridSize) {
      var p1 = this._worldToCanvas(x, minY);
      var p2 = this._worldToCanvas(x, maxY);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    }

    // Horizontal lines
    for (var y = startY; y <= maxY; y += gridSize) {
      var q1 = this._worldToCanvas(minX, y);
      var q2 = this._worldToCanvas(maxX, y);
      ctx.beginPath();
      ctx.moveTo(q1[0], q1[1]);
      ctx.lineTo(q2[0], q2[1]);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // Axis labels (every 2 meters)
    ctx.font = SM_TINY_FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var labelStep = gridSize < 1 ? 1 : gridSize * 2;
    for (var lx = Math.ceil(minX / labelStep) * labelStep; lx <= maxX; lx += labelStep) {
      var lp = this._worldToCanvas(lx, maxY);
      ctx.fillText(lx.toFixed(0) + 'm', lp[0], lp[1] + 4);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var ly = Math.ceil(minY / labelStep) * labelStep; ly <= maxY; ly += labelStep) {
      var lq = this._worldToCanvas(minX, ly);
      ctx.fillText(ly.toFixed(0) + 'm', lq[0] - 4, lq[1]);
    }

    ctx.restore();
  };

  // =========================================================================
  // Layer: Signal Contours
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawSignalContours = function() {
    var ctx = this._ctx;
    // Only draw -40 and -60 dBm contours — minimal reference circles
    var levels = [-40, -60];

    ctx.save();

    for (var a = 0; a < this._accessPoints.length; a++) {
      var ap = this._accessPoints[a];
      var apCanvas = this._worldToCanvas(ap.x, ap.y);
      var apCx = apCanvas[0];
      var apCy = apCanvas[1];

      for (var i = 0; i < levels.length; i++) {
        var level = levels[i];
        var dist = this._distanceFromRssi(level);
        var radiusPx = dist * this._scale;

        // Don't draw contours larger than view
        if (radiusPx > this._viewRadius * this._scale * 2) continue;

        // Very subtle contour — alpha 0.06 max
        var color = smContourColor(level, 0.06);

        // Thin dashed circle
        ctx.beginPath();
        ctx.arc(apCx, apCy, radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Subtle label
        var labelAngle = -Math.PI * 0.25;
        var labelX = apCx + radiusPx * Math.cos(labelAngle);
        var labelY = apCy + radiusPx * Math.sin(labelAngle);
        ctx.font = SM_TINY_FONT;
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(level + ' dBm', labelX + 3, labelY - 2);
      }
    }

    ctx.restore();
  };

  // =========================================================================
  // Layer: Fresnel Zone (multi-node pair support)
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawFresnelZone = function() {
    var ctx = this._ctx;

    ctx.save();

    // Collect connected nodes for multi-Fresnel zone support
    var connectedNodes = [];
    for (var cn = 0; cn < this._nodes.length; cn++) {
      if (this._nodes[cn].status === 'connected') {
        connectedNodes.push(this._nodes[cn]);
      }
    }

    // 1. Primary Fresnel zones: AP <-> each node (original behavior)
    for (var a = 0; a < this._accessPoints.length; a++) {
      var ap = this._accessPoints[a];

      for (var n = 0; n < this._nodes.length; n++) {
        var node = this._nodes[n];
        this._drawSingleFresnelZone(ctx, ap, node, 0.08, 0.3, 'Fresnel Zone');
      }
    }

    // 2. Secondary Fresnel zones: between connected node pairs (node-to-node)
    if (connectedNodes.length >= 2) {
      for (var i = 0; i < connectedNodes.length; i++) {
        for (var j = i + 1; j < connectedNodes.length; j++) {
          var nodeA = connectedNodes[i];
          var nodeB = connectedNodes[j];
          // Use the first AP's frequency or default
          var freq = (this._accessPoints.length > 0) ? this._accessPoints[0].frequency : 2437;
          this._drawSingleFresnelZone(ctx, nodeA, nodeB, 0.04, 0.15, 'N-N Fresnel', freq);
        }
      }
    }

    ctx.restore();
  };

  /**
   * Draw a single Fresnel zone ellipse between two points.
   * @private
   */
  SignalMeshRenderer.prototype._drawSingleFresnelZone = function(ctx, pointA, pointB, fillAlpha, strokeAlpha, labelText, freq) {
    var totalDist = smDist(pointA.x, pointA.y, pointB.x, pointB.y);
    if (totalDist < 0.01) return;

    var halfDist = totalDist / 2;
    var frequency = freq || pointA.frequency || 2437;
    var maxR = this._fresnelRadius(halfDist, halfDist, frequency);

    var aC = this._worldToCanvas(pointA.x, pointA.y);
    var bC = this._worldToCanvas(pointB.x, pointB.y);

    var midCx = (aC[0] + bC[0]) / 2;
    var midCy = (aC[1] + bC[1]) / 2;

    var angle = Math.atan2(bC[1] - aC[1], bC[0] - aC[0]);

    var majorPx = (totalDist / 2) * this._scale;
    var minorPx = maxR * this._scale;

    // Draw ellipse
    ctx.beginPath();
    ctx.ellipse(midCx, midCy, majorPx, minorPx, angle, 0, Math.PI * 2);

    // Semi-transparent fill
    ctx.fillStyle = 'rgba(0,188,212,' + fillAlpha + ')';
    ctx.fill();

    // Cyan border
    ctx.strokeStyle = 'rgba(0,188,212,' + strokeAlpha + ')';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label at midpoint
    ctx.font = SM_TINY_FONT;
    ctx.fillStyle = 'rgba(0,188,212,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(labelText || 'Fresnel Zone', midCx, midCy - minorPx - 4);
  };

  // =========================================================================
  // Layer: Signal Heatmap
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawSignalHeatmap = function() {
    if (this._accessPoints.length === 0) return;

    var meshR = this._visualization.meshRadius || 8;
    var gridRes = this._signalMap.gridResolution || 0.25;

    // Build offscreen heatmap if dirty
    if (this._heatmapDirty || !this._heatmapCanvas) {
      this._buildHeatmapCanvas(meshR, gridRes);
      this._heatmapDirty = false;
    }

    // Draw the offscreen canvas onto the main canvas
    if (this._heatmapCanvas) {
      var ctx = this._ctx;
      // Compute where the heatmap world-space rect maps to
      var topLeft = this._worldToCanvas(
        this._viewCenterX - this._viewRadius,
        this._viewCenterY - this._viewRadius
      );
      var botRight = this._worldToCanvas(
        this._viewCenterX + this._viewRadius,
        this._viewCenterY + this._viewRadius
      );
      var dw = botRight[0] - topLeft[0];
      var dh = botRight[1] - topLeft[1];

      ctx.save();
      ctx.globalAlpha = this._visualization.meshOpacity || 0.6;
      ctx.drawImage(this._heatmapCanvas, topLeft[0], topLeft[1], dw, dh);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  };

  /** Build the offscreen heatmap canvas. @private */
  SignalMeshRenderer.prototype._buildHeatmapCanvas = function(meshR, gridRes) {
    var r = this._viewRadius;
    var cx0 = this._viewCenterX;
    var cy0 = this._viewCenterY;

    // Determine grid dimensions in cells
    var worldW = r * 2;
    var worldH = r * 2;
    var cellsX = Math.ceil(worldW / gridRes);
    var cellsY = Math.ceil(worldH / gridRes);

    // Limit resolution to prevent performance issues
    var maxCells = 200;
    if (cellsX > maxCells) { cellsX = maxCells; gridRes = worldW / maxCells; }
    if (cellsY > maxCells) { cellsY = maxCells; }

    var offCanvas = document.createElement('canvas');
    offCanvas.width = cellsX;
    offCanvas.height = cellsY;
    var offCtx = offCanvas.getContext('2d');
    var imgData = offCtx.createImageData(cellsX, cellsY);
    var pixels = imgData.data;

    for (var gy = 0; gy < cellsY; gy++) {
      for (var gx = 0; gx < cellsX; gx++) {
        var wx = cx0 - r + (gx + 0.5) * (worldW / cellsX);
        var wy = cy0 - r + (gy + 0.5) * (worldH / cellsY);

        // Find best RSSI from any AP
        var bestRssi = -999;
        for (var a = 0; a < this._accessPoints.length; a++) {
          var ap = this._accessPoints[a];
          var dist = smDist(wx, wy, ap.x, ap.y);
          var rssi = this._rssiAtDistance(dist);
          if (rssi > bestRssi) bestRssi = rssi;
        }

        // Check if within meshRadius of any AP
        var withinMesh = false;
        for (var b = 0; b < this._accessPoints.length; b++) {
          if (smDist(wx, wy, this._accessPoints[b].x, this._accessPoints[b].y) <= meshR) {
            withinMesh = true;
            break;
          }
        }

        var idx = (gy * cellsX + gx) * 4;
        if (!withinMesh) {
          pixels[idx] = 0;
          pixels[idx + 1] = 0;
          pixels[idx + 2] = 0;
          pixels[idx + 3] = 0;
          continue;
        }

        // Map RSSI to color: strong signal = transparent, weak = dark overlay
        // Range: -30 (strong) to -80 (weak)
        var t = smClamp((bestRssi - (-80)) / (-30 - (-80)), 0, 1); // 0=weak, 1=strong

        // Strong signal: almost transparent cyan tint
        // Weak signal: dark blue overlay
        var cR = Math.round(smLerp(8, 0, t));
        var cG = Math.round(smLerp(12, 40, t));
        var cB = Math.round(smLerp(40, 60, t));
        var cA = Math.round(smLerp(180, 10, t)); // strong=transparent, weak=opaque

        pixels[idx] = cR;
        pixels[idx + 1] = cG;
        pixels[idx + 2] = cB;
        pixels[idx + 3] = cA;
      }
    }

    offCtx.putImageData(imgData, 0, 0);
    this._heatmapCanvas = offCanvas;
  };

  // =========================================================================
  // Layer: Detection Overlay (THE KEY FEATURE)
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawDetectionOverlay = function() {
    var state = this._presence.state;
    var ctx = this._ctx;
    var elapsed = (performance.now() - this._startTime) / 1000;

    // --- Determine target alpha based on presence state ---
    var targetAlpha;
    var targetLabelAlpha;
    if (state === 'active') {
      targetAlpha = 0.25;
      targetLabelAlpha = 0.85;
    } else if (state === 'present_still') {
      targetAlpha = 0.12;
      targetLabelAlpha = 0.65;
    } else {
      targetAlpha = 0;
      targetLabelAlpha = 0;
    }

    // --- Smooth transition (lerp towards target each frame) ---
    this._overlayAlpha += (targetAlpha - this._overlayAlpha) * 0.05;
    this._overlayLabelAlpha += (targetLabelAlpha - this._overlayLabelAlpha) * 0.05;

    // Clamp near-zero to zero to avoid sub-pixel rendering waste
    if (this._overlayAlpha < 0.003) {
      this._overlayAlpha = 0;
      this._overlayLabelAlpha = 0;
    }

    // Nothing to draw if fully faded out
    if (this._overlayAlpha < 0.005) return;

    // --- Subtle breathing — NOT aggressive pulse ---
    // +/- 10% variation at a slow 1.2 rad/s cycle
    var breathe = 1.0 + 0.1 * Math.sin(elapsed * 1.2);
    var finalAlpha = this._overlayAlpha * breathe;
    var finalLabelAlpha = this._overlayLabelAlpha * breathe;

    var isActive = (state === 'active');

    ctx.save();

    // For each AP-node pair, glow the Fresnel zone area
    for (var a = 0; a < this._accessPoints.length; a++) {
      var ap = this._accessPoints[a];

      for (var n = 0; n < this._nodes.length; n++) {
        var node = this._nodes[n];
        var totalDist = smDist(ap.x, ap.y, node.x, node.y);
        if (totalDist < 0.01) continue;

        var halfDist = totalDist / 2;
        var maxR = this._fresnelRadius(halfDist, halfDist, ap.frequency);

        var apC = this._worldToCanvas(ap.x, ap.y);
        var nodeC = this._worldToCanvas(node.x, node.y);
        var midCx = (apC[0] + nodeC[0]) / 2;
        var midCy = (apC[1] + nodeC[1]) / 2;
        var angle = Math.atan2(nodeC[1] - apC[1], nodeC[0] - apC[0]);
        var majorPx = (totalDist / 2) * this._scale;
        var minorPx = maxR * this._scale;

        // Smooth green glow fill over Fresnel zone
        ctx.save();
        ctx.shadowColor = SM_NEON_GREEN;
        ctx.shadowBlur = isActive ? 18 : 10;

        ctx.beginPath();
        ctx.ellipse(midCx, midCy, majorPx, minorPx, angle, 0, Math.PI * 2);
        ctx.fillStyle = smNeonRgba(finalAlpha.toFixed(3));
        ctx.fill();

        // Subtle glow border
        ctx.strokeStyle = smNeonRgba((finalAlpha * 1.5).toFixed(3));
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        // Gentle ripple for ACTIVE state only (slower, fewer, lower alpha)
        if (isActive && this._overlayAlpha > 0.1) {
          var numRipples = 2;
          for (var ri = 0; ri < numRipples; ri++) {
            var ripplePhase = (elapsed * 0.6 + ri * 0.5) % 1.0;
            var rippleScale = 0.7 + ripplePhase * 0.5;
            var rippleAlpha = (1 - ripplePhase) * 0.08 * (this._overlayAlpha / 0.25);

            ctx.beginPath();
            ctx.ellipse(
              midCx, midCy,
              majorPx * rippleScale, minorPx * rippleScale,
              angle, 0, Math.PI * 2
            );
            ctx.strokeStyle = smNeonRgba(rippleAlpha.toFixed(3));
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // Detection label — fades smoothly with the overlay
        if (finalLabelAlpha > 0.01) {
          var labelText = isActive ? '\uAC10\uC9C0\uB428 \u2014 \uD65C\uB3D9 \uC911' : '\uAC10\uC9C0\uB428 \u2014 \uC815\uC9C0 \uC911';
          ctx.font = SM_SMALL_FONT;
          ctx.fillStyle = smNeonRgba(finalLabelAlpha.toFixed(3));
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(labelText, midCx, midCy + minorPx + 8);
        }
      }
    }

    ctx.restore();
  };

  // =========================================================================
  // Layer: Tracked Devices (multi-person position visualization)
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawTrackedDevices = function() {
    var ctx = this._ctx;
    var PERSON_COLOR_R = 239, PERSON_COLOR_G = 68, PERSON_COLOR_B = 68; // #ef4444
    var PERSON_COLOR = '#ef4444';
    var TRAIL_MAX_POINTS = 40;
    var TRAIL_MAX_AGE_MS = 3000; // trail points older than 3s are pruned
    var LERP_FACTOR = 0.07;      // 7% per frame — smooth natural movement
    var FADE_IN_SPEED = 0.05;    // alpha increase per frame (~1s to full at 60fps)
    var FADE_OUT_SPEED = 0.02;   // alpha decrease per frame (~0.8s to gone at 60fps)

    // Build set of currently active device ids
    var activeIds = {};
    for (var i = 0; i < this._trackedDevices.length; i++) {
      if (this._trackedDevices[i].id) activeIds[this._trackedDevices[i].id] = true;
    }

    // Collect all device ids that need rendering (active + fading out)
    var renderIds = {};
    for (var ai in activeIds) {
      if (activeIds.hasOwnProperty(ai)) renderIds[ai] = true;
    }
    for (var fi in this._deviceFadeAlpha) {
      if (this._deviceFadeAlpha.hasOwnProperty(fi) && this._deviceFadeAlpha[fi] > 0.01) {
        renderIds[fi] = true;
      }
    }

    // Nothing to render at all
    var hasAny = false;
    for (var chk in renderIds) { if (renderIds.hasOwnProperty(chk)) { hasAny = true; break; } }
    if (!hasAny) return;

    ctx.save();
    var now = performance.now();

    for (var devId in renderIds) {
      if (!renderIds.hasOwnProperty(devId)) continue;

      var isActive = !!activeIds[devId];

      // --- Fade alpha management ---
      if (this._deviceFadeAlpha[devId] === undefined) {
        this._deviceFadeAlpha[devId] = 0;
      }
      if (isActive) {
        // Fade in
        this._deviceFadeAlpha[devId] = Math.min(1.0, this._deviceFadeAlpha[devId] + FADE_IN_SPEED);
      } else {
        // Fade out
        this._deviceFadeAlpha[devId] = Math.max(0, this._deviceFadeAlpha[devId] - FADE_OUT_SPEED);
      }
      var alpha = this._deviceFadeAlpha[devId];

      // If fully faded out, clean up all state for this device
      if (alpha < 0.01) {
        delete this._deviceFadeAlpha[devId];
        delete this._deviceRenderPositions[devId];
        delete this._deviceTrails[devId];
        delete this._deviceLastKnown[devId];
        continue;
      }

      // --- Resolve device data (active or last-known for fading) ---
      var device = null;
      if (isActive) {
        for (var si = 0; si < this._trackedDevices.length; si++) {
          if (this._trackedDevices[si].id === devId) { device = this._trackedDevices[si]; break; }
        }
      }
      if (!device) device = this._deviceLastKnown[devId];
      if (!device || !device.position) continue;

      // --- Position interpolation (lerp) for smooth movement ---
      var targetPos = this._worldToCanvas(device.position.x, device.position.y);
      var targetX = targetPos[0];
      var targetY = targetPos[1];

      if (!this._deviceRenderPositions[devId]) {
        this._deviceRenderPositions[devId] = { x: targetX, y: targetY };
      }
      var rp = this._deviceRenderPositions[devId];
      // Only lerp toward target if device is active; if fading, hold position
      if (isActive) {
        rp.x += (targetX - rp.x) * LERP_FACTOR;
        rp.y += (targetY - rp.y) * LERP_FACTOR;
      }
      var px = rp.x;
      var py = rp.y;

      // --- Trail: record and draw ---
      if (!this._deviceTrails[devId]) {
        this._deviceTrails[devId] = [];
      }
      var trail = this._deviceTrails[devId];

      // Add trail point from lerped position (only if active and moving)
      if (isActive) {
        var addPoint = true;
        if (trail.length > 0) {
          var last = trail[trail.length - 1];
          var dx = px - last.x;
          var dy = py - last.y;
          // Only add if moved at least 1px (avoid clumping)
          if (dx * dx + dy * dy < 1) addPoint = false;
        }
        if (addPoint) {
          trail.push({ x: px, y: py, t: now });
        }
      }

      // Prune old trail points
      while (trail.length > TRAIL_MAX_POINTS) trail.shift();
      while (trail.length > 0 && (now - trail[0].t) > TRAIL_MAX_AGE_MS) trail.shift();

      // Draw trail BEFORE dot (so dot renders on top)
      if (trail.length > 1) {
        for (var ti = 1; ti < trail.length; ti++) {
          var age0 = 1 - ((now - trail[ti - 1].t) / TRAIL_MAX_AGE_MS);
          var age1 = 1 - ((now - trail[ti].t) / TRAIL_MAX_AGE_MS);
          if (age0 < 0) age0 = 0;
          if (age1 < 0) age1 = 0;
          var segAlpha = Math.min(age0, age1) * 0.4 * alpha; // fade with device alpha too
          if (segAlpha < 0.01) continue;

          ctx.beginPath();
          ctx.moveTo(trail[ti - 1].x, trail[ti - 1].y);
          ctx.lineTo(trail[ti].x, trail[ti].y);
          ctx.strokeStyle = 'rgba(' + PERSON_COLOR_R + ',' + PERSON_COLOR_G + ',' + PERSON_COLOR_B + ',' + segAlpha + ')';
          ctx.lineWidth = 2.5 * segAlpha + 0.5;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }

      // --- PERSON DOT — RED, large, with glow ---
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = PERSON_COLOR;
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.fillStyle = PERSON_COLOR;
      ctx.fill();
      ctx.restore();

      // White center
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.restore();

      // "Person" label below the dot (uses lerped position)
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 12px "Inter", sans-serif';
      ctx.fillStyle = PERSON_COLOR;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(device.name || 'Person', px, py + 16);
      ctx.restore();
    }

    ctx.restore();
  };

  // =========================================================================
  // Layer: Access Point markers
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawAccessPoints = function() {
    var ctx = this._ctx;
    var AP_COLOR = '#f59e0b'; // amber/orange — distinct from cyan nodes and red people

    for (var a = 0; a < this._accessPoints.length; a++) {
      var ap = this._accessPoints[a];
      var c = this._worldToCanvas(ap.x, ap.y);
      var cx = c[0];
      var cy = c[1];

      ctx.save();
      ctx.translate(cx, cy);

      // Outer glow
      ctx.shadowColor = AP_COLOR;
      ctx.shadowBlur = 16;

      // Base filled circle — LARGER
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = AP_COLOR;
      ctx.fill();

      ctx.shadowBlur = 0;

      // Inner bright dot
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();

      // WiFi arcs — LARGER, more visible
      ctx.strokeStyle = 'rgba(245,158,11,0.7)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (var i = 1; i <= 3; i++) {
        var r = 10 + i * 7;
        ctx.beginPath();
        ctx.arc(0, -3, r, -Math.PI * 0.7, -Math.PI * 0.3);
        ctx.globalAlpha = 1 - i * 0.25;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Label: AP name + channel — bold and clear
      ctx.font = 'bold 12px "Inter", sans-serif';
      ctx.fillStyle = AP_COLOR;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var label = ap.name || ap.id;
      if (ap.channel) label += ' (CH' + ap.channel + ')';
      ctx.fillText(label, 0, 34);

      ctx.restore();
    }
  };

  // =========================================================================
  // Layer: Node markers — ESP32 + PC Monitor (with trilateration indicator)
  // =========================================================================

  /**
   * Draw a small laptop/monitor icon for pc-monitor type nodes.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx - center x on canvas
   * @param {number} cy - center y on canvas
   * @param {string} color - fill color
   * @param {boolean} isConnected
   */
  SignalMeshRenderer.prototype._drawPcMonitorIcon = function(ctx, cx, cy, color, isConnected) {
    ctx.save();
    ctx.translate(cx, cy);

    // Outer glow for connected
    if (isConnected) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
    }

    // Screen body (rectangle with rounded top)
    var sw = 16;  // screen width
    var sh = 11;  // screen height
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-sw / 2 + 2, -sh / 2);
    ctx.lineTo(sw / 2 - 2, -sh / 2);
    ctx.quadraticCurveTo(sw / 2, -sh / 2, sw / 2, -sh / 2 + 2);
    ctx.lineTo(sw / 2, sh / 2);
    ctx.lineTo(-sw / 2, sh / 2);
    ctx.lineTo(-sw / 2, -sh / 2 + 2);
    ctx.quadraticCurveTo(-sw / 2, -sh / 2, -sw / 2 + 2, -sh / 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Inner screen (dark inset)
    var inset = 2;
    ctx.fillStyle = isConnected ? 'rgba(0,20,30,0.7)' : 'rgba(30,30,30,0.6)';
    ctx.fillRect(-sw / 2 + inset, -sh / 2 + inset, sw - inset * 2, sh - inset * 2 - 1);

    // Screen content indicator (small bars for connected)
    if (isConnected) {
      ctx.fillStyle = smHexToRgba(color, 0.5);
      ctx.fillRect(-3, -sh / 2 + inset + 1, 6, 2);
      ctx.fillRect(-2, -sh / 2 + inset + 4, 4, 1);
    }

    // Stand/base
    ctx.fillStyle = color;
    ctx.fillRect(-3, sh / 2, 6, 2);
    ctx.fillRect(-5, sh / 2 + 2, 10, 2);

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);

    ctx.restore();
  };

  /**
   * Draw a standard ESP32 square marker.
   * @private
   */
  SignalMeshRenderer.prototype._drawEsp32Icon = function(ctx, cx, cy, color, isConnected) {
    var nodeSize = 10;

    // Outer glow for connected
    if (isConnected) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
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
    ctx.fillStyle = smHexToRgba(color, 0.3);
    var inner = nodeSize * 0.4;
    ctx.fillRect(cx - inner / 2, cy - inner / 2, inner, inner);

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - nodeSize / 2, cy - nodeSize / 2, nodeSize, nodeSize);
  };

  /** @private */
  SignalMeshRenderer.prototype._drawNodes = function() {
    var ctx = this._ctx;

    for (var n = 0; n < this._nodes.length; n++) {
      var node = this._nodes[n];
      var c = this._worldToCanvas(node.x, node.y);
      var cx = c[0];
      var cy = c[1];
      var status = node.status || 'disconnected';
      var connected = (status === 'connected');

      // PC Node — simple, clear
      var size = 12;
      var fillColor = connected ? '#06b6d4' : '#4b5563';
      var strokeColor = connected ? '#22d3ee' : '#6b7280';
      var labelColor = connected ? '#22d3ee' : '#6b7280';

      // Glow for connected
      if (connected) {
        ctx.save();
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = 10;
        ctx.fillStyle = fillColor;
        ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
        ctx.restore();
      }

      // Filled square
      ctx.fillStyle = fillColor;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);

      // Border
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);

      // Label
      ctx.font = 'bold 11px "Inter", sans-serif';
      ctx.fillStyle = labelColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.name || node.id, cx, cy + size / 2 + 6);
    }
  };

  // =========================================================================
  // Layer: Person Indicator (neon pulse at Fresnel zone center)
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawPersonIndicator = function() {
    var state = this._presence.state;
    if (state === 'absent') return;

    var ctx = this._ctx;
    var elapsed = (performance.now() - this._startTime) / 1000;
    var isActive = (state === 'active');
    var pulseSpeed = isActive ? SM_PULSE_SPEED_ACTIVE : SM_PULSE_SPEED_STILL;
    var p = 0.5 + 0.5 * Math.sin(elapsed * pulseSpeed);

    // Use motion dominant frequency for pulse speed if available
    var domFreq = this._presence.spectral.dominantFreq;
    if (domFreq > 0) {
      p = 0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2 * domFreq);
    }

    for (var a = 0; a < this._accessPoints.length; a++) {
      var ap = this._accessPoints[a];

      for (var n = 0; n < this._nodes.length; n++) {
        var node = this._nodes[n];

        // Midpoint between AP and node (center of Fresnel zone)
        var midX = (ap.x + node.x) / 2;
        var midY = (ap.y + node.y) / 2;
        var mc = this._worldToCanvas(midX, midY);
        var px = mc[0];
        var py = mc[1];

        ctx.save();

        // Multiple concentric rings expanding outward
        var numRings = isActive ? 4 : 3;
        for (var ri = 0; ri < numRings; ri++) {
          var ringPhase = ((elapsed * (isActive ? 1.2 : 0.6) + ri * (1 / numRings)) % 1.0);
          var ringR = 6 + ringPhase * (isActive ? 30 : 20);
          var ringAlpha = (1 - ringPhase) * (isActive ? 0.35 : 0.2);

          ctx.beginPath();
          ctx.arc(px, py, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = smNeonRgba(ringAlpha);
          ctx.lineWidth = isActive ? 2 : 1.5;
          ctx.stroke();
        }

        // Outer neon glow
        ctx.shadowColor = SM_NEON_GREEN;
        ctx.shadowBlur = 20 * p;
        ctx.beginPath();
        ctx.arc(px, py, 14 + p * 6, 0, Math.PI * 2);
        ctx.fillStyle = smNeonRgba(0.05 * p);
        ctx.fill();

        // Mid ring
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, 8 + p * 3, 0, Math.PI * 2);
        ctx.fillStyle = smNeonRgba(0.15 * p);
        ctx.fill();

        // Inner ring
        ctx.beginPath();
        ctx.arc(px, py, 5 + p * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = smNeonRgba(isActive ? 0.35 * p : 0.25 * p);
        ctx.fill();

        // Core neon dot
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(px, py, isActive ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = smNeonRgba(0.85 + 0.15 * p);
        ctx.fill();

        // White hot center
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (0.7 + 0.3 * p) + ')';
        ctx.fill();

        ctx.restore();
      }
    }
  };

  // =========================================================================
  // Layer: Legend
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawLegend = function() {
    var ctx = this._ctx;
    var canvasW = this._canvas.width / this._dpr;
    var canvasH = this._canvas.height / this._dpr;

    var padX = 12;
    var padY = 8;
    var lineH = 18;
    var titleH = 20;
    var legendW = 180;

    // Simplified legend: 4 items only
    var numEntries = 4;
    var legendH = padY * 2 + titleH + numEntries * lineH;

    var lx = canvasW - legendW - 12;
    var ly = canvasH - legendH - 12;

    // Background
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,24,0.88)';
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, lx, ly, legendW, legendH, 6);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font = 'bold 11px "Inter", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('\uBC94\uB840', lx + padX, ly + padY);

    var ey = ly + padY + titleH;
    ctx.font = '11px "Inter", sans-serif';

    // 1. Red dot: "사람 감지"
    ctx.save();
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(lx + padX + 6, ey + 8, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textBaseline = 'middle';
    ctx.fillText('\uC0AC\uB78C \uAC10\uC9C0', lx + padX + 18, ey + 8);
    ey += lineH;

    // 2. Cyan square: "PC Observer (연결)"
    ctx.fillStyle = '#06b6d4';
    ctx.fillRect(lx + padX + 1, ey + 3, 10, 10);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + padX + 1, ey + 3, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textBaseline = 'middle';
    ctx.fillText('PC Observer (\uC5F0\uACB0)', lx + padX + 18, ey + 8);
    ey += lineH;

    // 3. Gray square: "PC Observer (미연결)"
    ctx.fillStyle = '#4b5563';
    ctx.fillRect(lx + padX + 1, ey + 3, 10, 10);
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + padX + 1, ey + 3, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textBaseline = 'middle';
    ctx.fillText('PC Observer (\uBBF8\uC5F0\uACB0)', lx + padX + 18, ey + 8);
    ey += lineH;

    // 4. WiFi icon: "AP (라우터)"
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx + padX + 6, ey + 8, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    // Mini WiFi arc
    ctx.strokeStyle = 'rgba(245,158,11,0.6)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(lx + padX + 6, ey + 6, 7, -Math.PI * 0.7, -Math.PI * 0.3);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textBaseline = 'middle';
    ctx.fillText('AP (\uB77C\uC6B0\uD130)', lx + padX + 18, ey + 8);

    ctx.restore();
  };

  // =========================================================================
  // Layer: Status Overlay (top-left corner)
  // =========================================================================

  /** @private */
  SignalMeshRenderer.prototype._drawStatusOverlay = function() {
    var ctx = this._ctx;
    var x = 12;
    var y = 12;
    var lineH = 20;

    ctx.save();

    // Mode badge
    var modeText = '';
    var modeColor = '';
    var source = this._presence.state !== undefined ? 'signal-mesh' : 'unknown';
    // Derive mode from connected nodes
    var connectedCount = 0;
    for (var i = 0; i < this._nodes.length; i++) {
      if (this._nodes[i].status === 'connected') connectedCount++;
    }

    if (connectedCount === 0) {
      modeText = 'SIMULATION';
      modeColor = '#FF9800';
    } else if (connectedCount === 1) {
      modeText = 'SINGLE NODE';
      modeColor = '#2196F3';
    } else {
      modeText = 'MULTI NODE';
      modeColor = '#4CAF50';
    }

    // Mode badge background
    ctx.font = SM_STATUS_FONT;
    var modeW = ctx.measureText(modeText).width + 16;
    ctx.fillStyle = 'rgba(10,14,24,0.8)';
    ctx.strokeStyle = modeColor;
    ctx.lineWidth = 1;
    this._roundRect(ctx, x, y, modeW, 22, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = modeColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(modeText, x + 8, y + 11);

    y += lineH + 6;

    // Presence state badge
    var presState = this._presence.state;
    var presText = '';
    var presColor = '';
    if (presState === 'absent') {
      presText = '\uBBF8\uAC10\uC9C0 (ABSENT)';
      presColor = '#9E9E9E';
    } else if (presState === 'present_still') {
      presText = '\uC815\uC9C0 \uAC10\uC9C0 (STILL)';
      presColor = SM_NEON_GREEN;
    } else if (presState === 'active') {
      presText = '\uD65C\uB3D9 \uAC10\uC9C0 (ACTIVE)';
      presColor = SM_NEON_GREEN;
    } else {
      presText = String(presState);
      presColor = '#9E9E9E';
    }

    var presW = ctx.measureText(presText).width + 16;
    ctx.fillStyle = 'rgba(10,14,24,0.8)';
    ctx.strokeStyle = presColor;
    ctx.lineWidth = 1;
    this._roundRect(ctx, x, y, presW, 22, 4);
    ctx.fill();
    ctx.stroke();

    // Glow for active states
    if (presState === 'present_still' || presState === 'active') {
      ctx.shadowColor = SM_NEON_GREEN;
      ctx.shadowBlur = presState === 'active' ? 8 : 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = presColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(presText, x + 8, y + 11);

    y += lineH + 4;

    // Confidence percentage
    var conf = Math.round((this._presence.confidence || 0) * 100);
    ctx.font = SM_SMALL_FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('\uC2E0\uB8B0\uB3C4: ' + conf + '%', x + 2, y);

    y += lineH - 4;

    // RSSI reading
    var rssiVal = this._presence.rssi.current;
    if (rssiVal !== undefined && rssiVal !== null) {
      ctx.fillText('RSSI: ' + Math.round(rssiVal) + ' dBm', x + 2, y);
    }

    ctx.restore();
  };

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Helper: draw a rounded rectangle path. @private */
  SignalMeshRenderer.prototype._roundRect = function(ctx, x, y, w, h, r) {
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
  };

  /** @private */
  SignalMeshRenderer.prototype._handleClick = function(event) {
    if (!this._areaClickCb) return;

    var rect = this._canvas.getBoundingClientRect();
    var cx = event.clientX - rect.left;
    var cy = event.clientY - rect.top;
    var wc = this._canvasToWorld(cx, cy);
    var wx = wc[0];
    var wy = wc[1];

    // Check if clicked near an AP
    var clickedAp = null;
    for (var a = 0; a < this._accessPoints.length; a++) {
      if (smDist(wx, wy, this._accessPoints[a].x, this._accessPoints[a].y) < 0.5) {
        clickedAp = this._accessPoints[a];
        break;
      }
    }

    // Check if clicked near a node
    var clickedNode = null;
    for (var n = 0; n < this._nodes.length; n++) {
      if (smDist(wx, wy, this._nodes[n].x, this._nodes[n].y) < 0.5) {
        clickedNode = this._nodes[n];
        break;
      }
    }

    this._areaClickCb({
      worldX: wx,
      worldY: wy,
      ap: clickedAp,
      node: clickedNode
    });
  };

  return SignalMeshRenderer;
})();

// Expose to window for non-module script loading
window.SignalMeshRenderer = SignalMeshRenderer;
