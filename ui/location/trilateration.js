/**
 * TrilaterationEngine
 *
 * Estimates XY positions of tracked devices using RSSI measurements
 * from multiple nodes (AP, ESP32, PC monitors).
 *
 * Algorithm: Weighted Least-Squares trilateration with path-loss
 * distance model and exponential moving average smoothing.
 */
(function () {
  'use strict';

  // ── Color palette for tracked persons ──────────────────────────
  var PERSON_COLORS = [
    '#00ff88', '#3b82f6', '#f59e0b', '#ef4444',
    '#a855f7', '#14b8a6', '#ec4899', '#84cc16'
  ];

  var HISTORY_LENGTH = 10;
  var MIN_ERROR_RADIUS = 0.5;   // metres
  var MAX_ERROR_RADIUS = 5.0;   // metres
  var DEVICE_TIMEOUT_MS = 30000; // 30 s before a device is considered stale

  // ── Constructor ────────────────────────────────────────────────

  function TrilaterationEngine(config) {
    config = config || {};

    var tri = config.trilateration || config.signalMap || {};

    this.pathLossExponent  = tri.pathLossExponent  || 3.0;
    this.referenceDistance  = tri.referenceDistance  || 1.0;   // metres
    this.referenceRssi     = tri.referenceRssi     || -30;    // dBm at referenceDistance
    this.positionSmoothing = (tri.positionSmoothing !== undefined)
                               ? tri.positionSmoothing
                               : 0.4;

    this.config = config;

    // All known nodes keyed by id
    this.nodesById = {};
    // Ordered array mirroring nodesById
    this.nodes = [];

    // Tracked device states keyed by deviceId
    this.trackedDevices = {};

    // Counter for auto-naming
    this._personCounter = 0;

    // Seed with config-provided access-points and nodes
    if (config.accessPoints || config.nodes) {
      this.loadNodes(config.accessPoints, config.nodes);
    }
  }

  // ── Node management ────────────────────────────────────────────

  /**
   * Load / replace all known node positions.
   * accessPoints: [{ id, x, y, ... }]
   * nodes:        [{ id, x, y, type, status, ... }]
   */
  TrilaterationEngine.prototype.loadNodes = function (accessPoints, nodes) {
    this.nodesById = {};
    this.nodes = [];

    var self = this;

    (accessPoints || []).forEach(function (ap) {
      var node = {
        id:     ap.id,
        x:      ap.x,
        y:      ap.y,
        type:   'ap',
        status: ap.status || 'connected',
        name:   ap.name || ap.id
      };
      self.nodesById[node.id] = node;
      self.nodes.push(node);
    });

    (nodes || []).forEach(function (n) {
      var node = {
        id:     n.id,
        x:      n.x,
        y:      n.y,
        type:   n.type || 'unknown',
        status: n.status || 'disconnected',
        name:   n.name || n.id
      };
      self.nodesById[node.id] = node;
      self.nodes.push(node);
    });
  };

  /**
   * Update the connection status of a single node.
   */
  TrilaterationEngine.prototype.updateNodeStatus = function (nodeId, status) {
    var node = this.nodesById[nodeId];
    if (node) {
      node.status = status;
    }
  };

  /**
   * Return only nodes whose status is 'connected'.
   */
  TrilaterationEngine.prototype.getActiveNodes = function () {
    return this.nodes.filter(function (n) {
      return n.status === 'connected';
    });
  };

  // ── RSSI  ->  Distance (path-loss model) ──────────────────────

  /**
   * d = referenceDistance * 10^((referenceRssi - rssi) / (10 * n))
   */
  TrilaterationEngine.prototype._rssiToDistance = function (rssi) {
    var exponent = (this.referenceRssi - rssi) / (10 * this.pathLossExponent);
    return this.referenceDistance * Math.pow(10, exponent);
  };

  // ── Core trilateration ─────────────────────────────────────────

  /**
   * Estimate a position from RSSI measurements.
   *
   * @param {Object} rssiByNode  { 'node-id': rssiValue, ... }
   * @returns {{ x, y, confidence, accuracy, error_radius }}
   */
  TrilaterationEngine.prototype.estimatePosition = function (rssiByNode) {
    // Build measurements array: [{ x, y, distance }]
    var measurements = [];
    var self = this;

    Object.keys(rssiByNode).forEach(function (nodeId) {
      var node = self.nodesById[nodeId];
      if (!node) return;
      var d = self._rssiToDistance(rssiByNode[nodeId]);
      if (d > 0 && isFinite(d)) {
        measurements.push({ x: node.x, y: node.y, distance: d, nodeId: nodeId });
      }
    });

    if (measurements.length === 0) {
      return { x: 0, y: 0, confidence: 0, accuracy: 'none', error_radius: MAX_ERROR_RADIUS };
    }

    var position = this._trilaterate(measurements);
    var confidence = this._calculateConfidence(measurements, position);
    var errorRadius = this._calculateErrorRadius(measurements, position);
    var accuracy = this._getAccuracyFromNodeCount(measurements.length);

    return {
      x:            position.x,
      y:            position.y,
      confidence:   confidence,
      accuracy:     accuracy,
      error_radius: errorRadius
    };
  };

  /**
   * Weighted Least-Squares trilateration.
   *
   * N >= 3  : full WLS solve
   * N == 2  : weighted projection along the line between the two nodes
   * N == 1  : return the node position itself (presence only)
   *
   * @param {Array} measurements  [{ x, y, distance }, ...]
   * @returns {{ x, y }}
   */
  TrilaterationEngine.prototype._trilaterate = function (measurements) {
    var N = measurements.length;

    // ── N == 1: return node position ──
    if (N === 1) {
      return { x: measurements[0].x, y: measurements[0].y };
    }

    // ── N == 2: weighted midpoint along line between nodes ──
    if (N === 2) {
      var m0 = measurements[0];
      var m1 = measurements[1];
      var d0 = Math.max(m0.distance, 0.01);
      var d1 = Math.max(m1.distance, 0.01);
      // Weight: inversely proportional to distance
      var w0 = 1 / d0;
      var w1 = 1 / d1;
      var wSum = w0 + w1;
      return {
        x: (m0.x * w0 + m1.x * w1) / wSum,
        y: (m0.y * w0 + m1.y * w1) / wSum
      };
    }

    // ── N >= 3: Weighted Least-Squares ──
    // Use the last measurement as the reference row (index N-1)
    var ref = measurements[N - 1];
    var xN = ref.x;
    var yN = ref.y;
    var dN = ref.distance;

    // Build A (rows x 2) and b (rows x 1) and weights
    var rows = N - 1;
    var A  = [];  // each element: [a1, a2]
    var b  = [];  // each element: scalar
    var w  = [];  // weights per row

    for (var i = 0; i < rows; i++) {
      var mi = measurements[i];
      var xi = mi.x;
      var yi = mi.y;
      var di = mi.distance;

      A.push([
        2 * (xN - xi),
        2 * (yN - yi)
      ]);

      b.push(
        di * di - dN * dN
        - xi * xi + xN * xN
        - yi * yi + yN * yN
      );

      // Weight: closer nodes contribute more (1 / di^2)
      var dClamp = Math.max(di, 0.01);
      w.push(1 / (dClamp * dClamp));
    }

    // Solve  (A^T W A) p = A^T W b
    // A^T W A  is 2x2,  A^T W b  is 2x1  → direct inversion
    var ata = [[0, 0], [0, 0]];
    var atb = [0, 0];

    for (var r = 0; r < rows; r++) {
      var wr = w[r];
      for (var c1 = 0; c1 < 2; c1++) {
        atb[c1] += A[r][c1] * wr * b[r];
        for (var c2 = 0; c2 < 2; c2++) {
          ata[c1][c2] += A[r][c1] * wr * A[r][c2];
        }
      }
    }

    // Invert 2x2 matrix
    var det = ata[0][0] * ata[1][1] - ata[0][1] * ata[1][0];
    if (Math.abs(det) < 1e-12) {
      // Degenerate geometry (all nodes collinear?) – fall back to weighted centroid
      return this._weightedCentroid(measurements);
    }

    var invDet = 1 / det;
    var inv = [
      [ ata[1][1] * invDet, -ata[0][1] * invDet],
      [-ata[1][0] * invDet,  ata[0][0] * invDet]
    ];

    var px = inv[0][0] * atb[0] + inv[0][1] * atb[1];
    var py = inv[1][0] * atb[0] + inv[1][1] * atb[1];

    return { x: px, y: py };
  };

  /**
   * Fallback: distance-weighted centroid when the WLS matrix is singular.
   */
  TrilaterationEngine.prototype._weightedCentroid = function (measurements) {
    var wx = 0, wy = 0, wTotal = 0;
    for (var i = 0; i < measurements.length; i++) {
      var d = Math.max(measurements[i].distance, 0.01);
      var wi = 1 / (d * d);
      wx += measurements[i].x * wi;
      wy += measurements[i].y * wi;
      wTotal += wi;
    }
    return { x: wx / wTotal, y: wy / wTotal };
  };

  // ── Confidence & error helpers ─────────────────────────────────

  /**
   * Confidence based on GDOP (Geometric Dilution of Precision).
   *
   * GDOP measures how the geometry of the nodes amplifies
   * measurement errors. Lower GDOP = better geometry.
   */
  TrilaterationEngine.prototype._calculateConfidence = function (measurements, position) {
    if (measurements.length < 2) return 0.1;

    // Compute direction unit vectors from estimated position to each node
    var H = [];
    for (var i = 0; i < measurements.length; i++) {
      var dx = measurements[i].x - position.x;
      var dy = measurements[i].y - position.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) dist = 0.001;
      H.push([dx / dist, dy / dist]);
    }

    // H^T H  (2x2)
    var hth = [[0, 0], [0, 0]];
    for (var j = 0; j < H.length; j++) {
      hth[0][0] += H[j][0] * H[j][0];
      hth[0][1] += H[j][0] * H[j][1];
      hth[1][0] += H[j][1] * H[j][0];
      hth[1][1] += H[j][1] * H[j][1];
    }

    // Invert 2x2
    var det = hth[0][0] * hth[1][1] - hth[0][1] * hth[1][0];
    if (Math.abs(det) < 1e-12) return 0.1;

    var invDet = 1 / det;
    var inv00 = hth[1][1] * invDet;
    var inv11 = hth[0][0] * invDet;

    // GDOP = sqrt(trace of (H^T H)^-1)
    var gdop = Math.sqrt(Math.abs(inv00) + Math.abs(inv11));

    // Map GDOP to confidence [0, 1]
    var confidence = 1 / (1 + gdop * 0.2);

    return Math.max(0, Math.min(1, confidence));
  };

  /**
   * Error radius estimate in metres.
   * error_radius = mean(di) * 0.3 / sqrt(N)
   * Clamped to [MIN_ERROR_RADIUS, MAX_ERROR_RADIUS].
   */
  TrilaterationEngine.prototype._calculateErrorRadius = function (measurements, position) {
    if (measurements.length === 0) return MAX_ERROR_RADIUS;

    var sumD = 0;
    for (var i = 0; i < measurements.length; i++) {
      sumD += measurements[i].distance;
    }
    var meanD = sumD / measurements.length;

    var errorRadius = (meanD * 0.3) / Math.sqrt(measurements.length);

    return Math.max(MIN_ERROR_RADIUS, Math.min(MAX_ERROR_RADIUS, errorRadius));
  };

  /**
   * Map active node count to an accuracy label.
   */
  TrilaterationEngine.prototype._getAccuracyFromNodeCount = function (count) {
    if (count <= 0) return 'none';
    if (count === 1) return 'presence';
    if (count === 2) return 'direction';
    if (count === 3) return 'approximate';
    return 'precise';
  };

  // ── Position smoothing ─────────────────────────────────────────

  /**
   * Exponential moving average with velocity-based prediction.
   *
   * Instead of smoothing between the raw measurement and the previous position,
   * we smooth between the measurement and a velocity-predicted position.
   * This reduces lag for moving targets while keeping stationary targets smooth.
   *
   * predicted = prev + velocity * dt
   * new_pos   = alpha * measured + (1 - alpha) * predicted
   *
   * @param {Object} prev     Previous position { x, y }
   * @param {Object} curr     New measured position { x, y }
   * @param {number} factor   Smoothing factor (alpha): 0 = all prediction, 1 = all measurement
   * @param {Object} [velocity]  Optional { vx, vy } in units/second
   * @param {number} [dt]     Optional time delta in seconds since last update
   */
  TrilaterationEngine.prototype._smoothPosition = function (prev, curr, factor, velocity, dt) {
    if (!prev) return curr;
    var alpha = factor;

    // Velocity-based prediction: extrapolate from previous position
    var predictedX = prev.x;
    var predictedY = prev.y;
    if (velocity && dt && dt > 0 && dt < 10) {
      predictedX += velocity.vx * dt;
      predictedY += velocity.vy * dt;
    }

    return {
      x: alpha * curr.x + (1 - alpha) * predictedX,
      y: alpha * curr.y + (1 - alpha) * predictedY
    };
  };

  // ── Device tracking ────────────────────────────────────────────

  /**
   * Track a specific device over time.
   *
   * @param {string} deviceId   Unique device identifier (e.g. MAC)
   * @param {Object} rssiByNode { 'node-id': rssiValue, ... }
   * @param {Object} metadata   Optional { name, mac, ... }
   * @returns {Object}          Updated device tracking state
   */
  TrilaterationEngine.prototype.trackDevice = function (deviceId, rssiByNode, metadata) {
    metadata = metadata || {};

    var estimate = this.estimatePosition(rssiByNode);
    var now = Date.now();

    var existing = this.trackedDevices[deviceId];

    if (!existing) {
      // New device
      this._personCounter++;
      var colorIdx = (this._personCounter - 1) % PERSON_COLORS.length;

      existing = {
        id:          deviceId,
        name:        metadata.name || ('Person ' + this._personCounter),
        position:    { x: estimate.x, y: estimate.y },
        confidence:  estimate.confidence,
        errorRadius: estimate.error_radius,
        accuracy:    estimate.accuracy,
        lastSeen:    now,
        color:       PERSON_COLORS[colorIdx],
        rssiByNode:  {},
        history:     [],
        velocity:    { vx: 0, vy: 0 }
      };

      this.trackedDevices[deviceId] = existing;
    }

    // Compute time delta for velocity prediction
    var dt = (now - existing.lastSeen) / 1000;

    // Apply smoothing with velocity-based prediction
    var prevPos = existing.position;
    var smoothed = this._smoothPosition(prevPos, estimate, this.positionSmoothing, existing.velocity, dt);
    var vx = 0, vy = 0;
    if (dt > 0 && dt < 10) {
      vx = (smoothed.x - prevPos.x) / dt;
      vy = (smoothed.y - prevPos.y) / dt;
    }

    // Push previous position to history (keep last N)
    existing.history.push({ x: prevPos.x, y: prevPos.y, t: existing.lastSeen });
    if (existing.history.length > HISTORY_LENGTH) {
      existing.history.shift();
    }

    // Update state
    existing.position    = { x: smoothed.x, y: smoothed.y };
    existing.confidence  = estimate.confidence;
    existing.errorRadius = estimate.error_radius;
    existing.accuracy    = estimate.accuracy;
    existing.lastSeen    = now;
    existing.rssiByNode  = rssiByNode;
    existing.velocity    = { vx: vx, vy: vy };

    // Allow overriding the name via metadata
    if (metadata.name) {
      existing.name = metadata.name;
    }

    return existing;
  };

  /**
   * Return all currently tracked devices (as an object keyed by id).
   */
  TrilaterationEngine.prototype.getTrackedDevices = function () {
    return this.trackedDevices;
  };

  /**
   * Remove a device from tracking.
   */
  TrilaterationEngine.prototype.removeDevice = function (deviceId) {
    delete this.trackedDevices[deviceId];
  };

  /**
   * Purge devices that have not been seen within the timeout window.
   * Returns the list of purged device ids.
   */
  TrilaterationEngine.prototype.purgeStaleDevices = function (timeoutMs) {
    timeoutMs = timeoutMs || DEVICE_TIMEOUT_MS;
    var now = Date.now();
    var purged = [];
    var self = this;

    Object.keys(this.trackedDevices).forEach(function (id) {
      if (now - self.trackedDevices[id].lastSeen > timeoutMs) {
        purged.push(id);
        delete self.trackedDevices[id];
      }
    });

    return purged;
  };

  // ── System accuracy ────────────────────────────────────────────

  /**
   * Get the overall system accuracy level based on the number
   * of currently active (connected) nodes.
   *
   * @returns {'none'|'presence'|'direction'|'approximate'|'precise'}
   */
  TrilaterationEngine.prototype.getAccuracyLevel = function () {
    var activeCount = this.getActiveNodes().length;
    return this._getAccuracyFromNodeCount(activeCount);
  };

  // ── Expose globally ────────────────────────────────────────────

  window.TrilaterationEngine = TrilaterationEngine;

})();
