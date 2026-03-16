/**
 * ObserverSimulator — Simulates multiple PC observer nodes for development/demo
 * without any actual PC observers connected.
 *
 * Simulates:
 *  - Multiple PC observer nodes measuring RSSI from a single AP
 *  - Baseline calibration (auto, first 10 seconds)
 *  - Person disturbance via Fresnel zone line-of-sight model
 *  - Multi-person random walk movement
 *  - Per-observer delta/variance/disturbed detection
 *  - Zone inference from observer pair co-fluctuation
 *
 * Output format matches the server API (/api/observers/fusion).
 * Vanilla JavaScript, no external dependencies.
 * Attach to window.ObserverSimulator for global access.
 */

(function () {
  'use strict';

  // ── Utility helpers ──────────────────────────────────────────────────

  /** Box-Muller transform — returns a sample from N(0, 1). */
  function gaussianRandom() {
    var u1 = Math.random();
    var u2 = Math.random();
    while (u1 === 0) u1 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /** Uniform random float in [lo, hi). */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /**
   * Point-to-line-segment distance.
   * Returns the distance from point (px, py) to the closest point on segment (ax,ay)-(bx,by).
   */
  function pointToLineDistance(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    var projX = ax + t * dx;
    var projY = ay + t * dy;
    return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
  }

  /** Euclidean distance between two points. */
  function dist2d(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Compute mean of a numeric array. */
  function mean(arr) {
    if (arr.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  /** Compute variance of a numeric array. */
  function variance(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    var sumSq = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      sumSq += d * d;
    }
    return sumSq / arr.length;
  }

  // ── ObserverSimulator ────────────────────────────────────────────────

  /**
   * @param {Object} [config]  Optional configuration overrides.
   */
  function ObserverSimulator(config) {
    this.config = config || {};
    this.running = false;
    this.listeners = [];
    this.tickRate = 2;        // 2 Hz (matches real observer scan interval)
    this.tick = 0;
    this._intervalId = null;
    this._positionIntervalId = null;  // 10 Hz internal position update

    // ── Signal model parameters ──────────────────────────────────────
    var sm = (config && config.signalMap) || {};
    this.referenceRssi = sm.referenceRssi || -30;        // RSSI at 1 m from AP
    this.pathLossExponent = sm.pathLossExponent || 2.8;   // indoor path-loss exponent
    this.noiseStdDev = 0.3;                               // Gaussian noise std dev (dBm)
    this.fresnelRadius = 1.5;                             // meters: Fresnel zone radius for body disturbance
    this.maxBodyDrop = 6;                                 // max RSSI drop from body blockage (dBm)
    this.minBodyDrop = 2;                                 // min RSSI drop from body blockage (dBm)

    // ── Simulated observers ──────────────────────────────────────────
    this.observers = [
      { id: 'sim-pc-1', name: 'PC Node 1', x: -2, y: 0, platform: 'darwin' },
      { id: 'sim-pc-2', name: 'PC Node 2', x: 4, y: -1, platform: 'windows' },
      { id: 'sim-pc-3', name: 'PC Node 3', x: 1, y: 4, platform: 'linux' }
    ];

    // ── AP info ──────────────────────────────────────────────────────
    this.ap = { bssid: 'AA:BB:CC:DD:EE:FF', ssid: 'PM-Router', channel: 6, x: 0, y: 0 };

    // ── Per-observer state ───────────────────────────────────────────
    // baselines[id] = computed baseline RSSI (set after calibration)
    this.baselines = {};
    // rssiBuffers[id] = ring buffer of recent RSSI values (max 120 = 60 seconds at 2 Hz)
    this.rssiBuffers = {};
    // rssiTrends[id] = last 60 values for diagnostics
    this.maxTrendLen = 60;
    this.maxBufferLen = 120;

    for (var i = 0; i < this.observers.length; i++) {
      var obs = this.observers[i];
      this.baselines[obs.id] = 0;
      this.rssiBuffers[obs.id] = [];
    }

    // ── Calibration ──────────────────────────────────────────────────
    this.calibrated = false;
    this.calibrationBuffer = {};   // id -> [rssi values during calibration]
    this.calibrationTicks = 0;
    this.calibrationDuration = 20; // ticks = 10 seconds at 2 Hz

    // ── Simulated persons (for disturbance) ──────────────────────────
    this.persons = [];
    this._maxPersons = 3;
    this._nextPersonAddTime = 0;
    this._personIdCounter = 0;

    // ── Zone definitions ─────────────────────────────────────────────
    // Built dynamically from observer pairs
    this._zones = null;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Start generating data at tickRate Hz. */
  ObserverSimulator.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.tick = 0;
    this.calibrated = false;
    this.calibrationTicks = 0;
    this.calibrationBuffer = {};
    this.persons = [];
    this._personIdCounter = 0;

    // Reset buffers
    for (var i = 0; i < this.observers.length; i++) {
      var id = this.observers[i].id;
      this.rssiBuffers[id] = [];
      this.baselines[id] = 0;
      this.calibrationBuffer[id] = [];
    }

    // Build zones from observer pairs
    this._buildZones();

    // Schedule first person addition after calibration
    this._nextPersonAddTime = this.calibrationDuration + 4; // a few ticks after calibration

    var self = this;
    var intervalMs = Math.round(1000 / this.tickRate);
    this._intervalId = setInterval(function () {
      self._tick();
    }, intervalMs);

    // Internal 10 Hz position update for smoother person movement
    // (RSSI data still emitted at 2 Hz via _tick)
    this._positionIntervalId = setInterval(function () {
      if (self.calibrated) {
        self._updatePersons(0.1);
      }
    }, 100);
  };

  /** Stop generating data. */
  ObserverSimulator.prototype.stop = function () {
    if (!this.running) return;
    this.running = false;
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._positionIntervalId !== null) {
      clearInterval(this._positionIntervalId);
      this._positionIntervalId = null;
    }
  };

  /** Register a listener that receives each tick's state snapshot. */
  ObserverSimulator.prototype.onData = function (callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  };

  /** Remove a previously registered listener. */
  ObserverSimulator.prototype.offData = function (callback) {
    this.listeners = this.listeners.filter(function (cb) {
      return cb !== callback;
    });
  };

  /**
   * Return a full state snapshot matching the server API format.
   */
  ObserverSimulator.prototype.getState = function () {
    var observerStates = {};
    var disturbedList = [];
    var activeCount = 0;

    for (var i = 0; i < this.observers.length; i++) {
      var obs = this.observers[i];
      var buf = this.rssiBuffers[obs.id] || [];
      var baseline = this.baselines[obs.id] || -42;

      // Compute delta from last 5 RSSI samples (10 = 5 seconds at 2Hz, but spec says 5 samples)
      var recentSlice = buf.slice(Math.max(0, buf.length - 5));
      var delta = recentSlice.length > 0 ? mean(recentSlice) - baseline : 0;

      // Compute variance from last 15 RSSI samples
      var varianceSlice = buf.slice(Math.max(0, buf.length - 15));
      var rssiVariance = variance(varianceSlice);

      // Current RSSI = latest sample
      var currentRssi = buf.length > 0 ? buf[buf.length - 1] : baseline;

      // Disturbed check
      var disturbed = Math.abs(delta) > 2 || rssiVariance > 0.5;
      if (disturbed) {
        disturbedList.push(obs.id);
      }

      // RSSI trend (last 60 values)
      var trend = buf.slice(Math.max(0, buf.length - this.maxTrendLen));

      observerStates[obs.id] = {
        id: obs.id,
        platform: obs.platform,
        connected: true,
        rssi: Math.round(currentRssi * 100) / 100,
        baseline: Math.round(baseline * 100) / 100,
        delta: Math.round(delta * 100) / 100,
        variance: Math.round(rssiVariance * 1000) / 1000,
        disturbed: disturbed,
        rssiTrend: trend.map(function (v) { return Math.round(v * 100) / 100; })
      };
      activeCount++;
    }

    // Fusion: zone inference
    var fusionResult = this._inferZones(disturbedList);

    // Person ground truth positions
    var personList = [];
    for (var p = 0; p < this.persons.length; p++) {
      var person = this.persons[p];
      personList.push({
        id: person.id,
        x: Math.round(person.x * 100) / 100,
        y: Math.round(person.y * 100) / 100,
        vx: person.vx || 0,
        vy: person.vy || 0,
        state: person.state,
        color: person.color
      });
    }

    return {
      observers: observerStates,
      fusion: fusionResult,
      persons: personList,
      calibrated: this.calibrated,
      activeObservers: activeCount
    };
  };

  // ── Internal: tick (one sample period) ─────────────────────────────

  ObserverSimulator.prototype._tick = function () {
    this.tick++;

    // Person positions are updated at 10 Hz by _positionIntervalId.
    // This tick only generates RSSI readings at 2 Hz.

    // Generate RSSI for each observer
    for (var i = 0; i < this.observers.length; i++) {
      var obs = this.observers[i];
      var rssi = this._generateObserverRssi(obs);
      this._pushBuffer(this.rssiBuffers[obs.id], rssi, this.maxBufferLen);
    }

    // Handle calibration phase
    if (!this.calibrated) {
      this.calibrationTicks++;
      for (var j = 0; j < this.observers.length; j++) {
        var obsId = this.observers[j].id;
        var buf = this.rssiBuffers[obsId];
        if (!this.calibrationBuffer[obsId]) {
          this.calibrationBuffer[obsId] = [];
        }
        if (buf.length > 0) {
          this.calibrationBuffer[obsId].push(buf[buf.length - 1]);
        }
      }

      if (this.calibrationTicks >= this.calibrationDuration) {
        // Calibration complete: set baselines
        for (var k = 0; k < this.observers.length; k++) {
          var oId = this.observers[k].id;
          var calBuf = this.calibrationBuffer[oId];
          if (calBuf && calBuf.length > 0) {
            this.baselines[oId] = mean(calBuf);
          }
        }
        this.calibrated = true;
      }
    }

    // Notify listeners
    var state = this.getState();
    for (var l = 0; l < this.listeners.length; l++) {
      try { this.listeners[l](state); } catch (e) { /* swallow */ }
    }
  };

  // ── Baseline RSSI computation ──────────────────────────────────────

  /**
   * Compute the baseline RSSI an observer at (ox, oy) would see from the AP
   * using log-distance path-loss model.
   *
   * @param {number} observerX  Observer x coordinate (meters)
   * @param {number} observerY  Observer y coordinate (meters)
   * @returns {number}          Baseline RSSI in dBm
   */
  ObserverSimulator.prototype._computeBaselineRssi = function (observerX, observerY) {
    var distance = dist2d(observerX, observerY, this.ap.x, this.ap.y);
    if (distance < 0.1) distance = 0.1;
    return this.referenceRssi - 10 * this.pathLossExponent * Math.log10(distance);
  };

  // ── Observer RSSI generation ───────────────────────────────────────

  /**
   * Generate one RSSI reading for an observer.
   * Includes baseline + noise + person disturbance.
   *
   * @param {Object} observer  Observer descriptor { id, x, y, ... }
   * @returns {number}         RSSI in dBm
   */
  ObserverSimulator.prototype._generateObserverRssi = function (observer) {
    // Start with baseline RSSI from path-loss model
    var baseRssi = this._computeBaselineRssi(observer.x, observer.y);

    // Add Gaussian noise
    var noise = gaussianRandom() * this.noiseStdDev;
    var rssi = baseRssi + noise;

    // Apply disturbance from each person
    for (var i = 0; i < this.persons.length; i++) {
      rssi = this._applyPersonDisturbance(rssi, observer, this.persons[i]);
    }

    return rssi;
  };

  // ── Person disturbance model ───────────────────────────────────────

  /**
   * Apply disturbance to RSSI when a person is near the line-of-sight
   * between the observer and the AP.
   *
   * Uses Fresnel zone approximation: if person is within fresnelRadius (1.5m)
   * of the AP-observer line, RSSI drops proportionally.
   *
   * @param {number} baseRssi   Current RSSI before this person's effect
   * @param {Object} observer   Observer { x, y, ... }
   * @param {Object} person     Person { x, y, ... }
   * @returns {number}          Modified RSSI in dBm
   */
  ObserverSimulator.prototype._applyPersonDisturbance = function (baseRssi, observer, person) {
    // Distance from person to the AP-observer line segment
    var losDistance = pointToLineDistance(
      person.x, person.y,
      this.ap.x, this.ap.y,
      observer.x, observer.y
    );

    // Only apply disturbance if within Fresnel zone
    if (losDistance >= this.fresnelRadius) {
      return baseRssi;
    }

    // Disturbance proportional to proximity to line-of-sight
    // Closer to line = more blockage
    var disturbanceFactor = (this.fresnelRadius - losDistance) / this.fresnelRadius;

    // Scale between minBodyDrop and maxBodyDrop
    var drop = this.minBodyDrop + disturbanceFactor * (this.maxBodyDrop - this.minBodyDrop);

    // Add some variance increase (random jitter when person is blocking)
    var jitter = gaussianRandom() * (0.3 + disturbanceFactor * 0.8);

    return baseRssi - drop + jitter;
  };

  // ── Person movement simulation ─────────────────────────────────────

  /**
   * Update all simulated persons' positions and manage person lifecycle.
   *
   * @param {number} dt  Time step in seconds
   */
  ObserverSimulator.prototype._updatePersons = function (dt) {
    // Add persons over time
    if (this.persons.length < this._maxPersons && this.tick >= this._nextPersonAddTime) {
      this._addPerson();
      // Schedule next person addition (20-60 seconds later)
      this._nextPersonAddTime = this.tick + Math.round(randRange(40, 120)); // in ticks (at 2Hz)
    }

    // Movement bounds (room dimensions)
    var boundsMinX = -3;
    var boundsMaxX = 6;
    var boundsMinY = -2;
    var boundsMaxY = 5;

    for (var i = 0; i < this.persons.length; i++) {
      var person = this.persons[i];

      switch (person.state) {
        case 'idle':
          // Pick a random target and start walking
          person.targetX = randRange(boundsMinX + 0.5, boundsMaxX - 0.5);
          person.targetY = randRange(boundsMinY + 0.5, boundsMaxY - 0.5);
          person.speed = randRange(0.3, 0.8);
          person.state = 'walking';
          break;

        case 'walking':
          var dx = person.targetX - person.x;
          var dy = person.targetY - person.y;
          var d = Math.sqrt(dx * dx + dy * dy);

          if (d < 0.15) {
            // Arrived at target, pause
            person.vx = 0;
            person.vy = 0;
            person.state = 'stationary';
            person.pauseTimer = randRange(3, 10);
          } else {
            // Move toward target
            person.vx = (dx / d) * person.speed;
            person.vy = (dy / d) * person.speed;

            // Slight random drift for natural movement (reduced for smoother paths)
            person.vx += gaussianRandom() * 0.02;
            person.vy += gaussianRandom() * 0.02;

            person.x += person.vx * dt;
            person.y += person.vy * dt;

            // Clamp to bounds
            person.x = Math.max(boundsMinX, Math.min(boundsMaxX, person.x));
            person.y = Math.max(boundsMinY, Math.min(boundsMaxY, person.y));
          }
          break;

        case 'stationary':
          // Very small idle drift (reduced for smoother output)
          person.x += gaussianRandom() * 0.001;
          person.y += gaussianRandom() * 0.001;

          person.pauseTimer -= dt;
          if (person.pauseTimer <= 0) {
            person.state = 'idle';
          }
          break;
      }
    }
  };

  /**
   * Add a new simulated person to the scene.
   */
  ObserverSimulator.prototype._addPerson = function () {
    this._personIdCounter++;
    var id = this._personIdCounter;
    var colors = ['#00ff88', '#3b82f6', '#f59e0b', '#ef4444'];
    this.persons.push({
      id: 'sim-person-' + id,
      x: randRange(-1, 3),
      y: randRange(-1, 3),
      vx: 0,
      vy: 0,
      targetX: randRange(-1, 4),
      targetY: randRange(-1, 4),
      speed: randRange(0.3, 0.8),
      state: 'idle',
      pauseTimer: 0,
      color: colors[(id - 1) % colors.length]
    });
  };

  // ── Zone building and inference ────────────────────────────────────

  /**
   * Build zone definitions from observer pairs.
   * Each pair of observers defines a zone along the AP-observer line.
   * An additional "cross" zone covers the intersection region.
   */
  ObserverSimulator.prototype._buildZones = function () {
    this._zones = {};
    var observers = this.observers;

    // Per-observer zones (the AP-observer corridor)
    for (var i = 0; i < observers.length; i++) {
      var obs = observers[i];
      var zoneId = 'zone-' + obs.id.replace('sim-', '') + '-ap';
      this._zones[zoneId] = {
        name: obs.name + '-AP \uad6c\uac04',  // "구간"
        observers: [obs.id],
        occupied: false,
        confidence: 0
      };
    }

    // Cross-zone: when multiple observers are disturbed simultaneously
    if (observers.length >= 2) {
      this._zones['zone-cross'] = {
        name: '\uad50\ucc28 \uc601\uc5ed',    // "교차 영역"
        observers: observers.map(function (o) { return o.id; }),
        occupied: false,
        confidence: 0
      };
    }
  };

  /**
   * Run zone inference based on which observers are currently disturbed.
   *
   * @param {string[]} disturbedList  Array of disturbed observer IDs
   * @returns {Object}               Fusion result
   */
  ObserverSimulator.prototype._inferZones = function (disturbedList) {
    var zones = {};
    var disturbedSet = {};
    for (var d = 0; d < disturbedList.length; d++) {
      disturbedSet[disturbedList[d]] = true;
    }

    // Determine presence type
    var presence = 'absent';
    var overallConfidence = 0;

    if (disturbedList.length > 0) {
      // Check if persons are moving or stationary by looking at variance patterns
      var hasMoving = false;
      for (var p = 0; p < this.persons.length; p++) {
        if (this.persons[p].state === 'walking') {
          hasMoving = true;
          break;
        }
      }
      presence = hasMoving ? 'active' : 'present_still';

      // Confidence based on mean absolute delta
      var totalAbsDelta = 0;
      for (var i = 0; i < this.observers.length; i++) {
        var obs = this.observers[i];
        var buf = this.rssiBuffers[obs.id] || [];
        var baseline = this.baselines[obs.id] || -42;
        var recent = buf.slice(Math.max(0, buf.length - 5));
        if (recent.length > 0) {
          totalAbsDelta += Math.abs(mean(recent) - baseline);
        }
      }
      overallConfidence = Math.min(1.0, totalAbsDelta / (disturbedList.length * 5.0));
      overallConfidence = Math.max(0.1, overallConfidence);
    }

    // Evaluate each zone
    if (this._zones) {
      var zoneKeys = Object.keys(this._zones);
      for (var z = 0; z < zoneKeys.length; z++) {
        var zoneId = zoneKeys[z];
        var zoneDef = this._zones[zoneId];

        if (zoneId === 'zone-cross') {
          // Cross zone: occupied when 2+ observers are disturbed
          var crossCount = 0;
          for (var c = 0; c < zoneDef.observers.length; c++) {
            if (disturbedSet[zoneDef.observers[c]]) crossCount++;
          }
          var crossOccupied = crossCount >= 2;
          var crossConfidence = crossOccupied
            ? Math.min(1.0, crossCount / zoneDef.observers.length * overallConfidence * 1.2)
            : Math.max(0, 0.05 * crossCount);

          zones[zoneId] = {
            name: zoneDef.name,
            occupied: crossOccupied,
            confidence: Math.round(crossConfidence * 100) / 100
          };
        } else {
          // Per-observer zone: occupied when that observer is disturbed
          // but NOT if it is better explained by the cross zone
          var zoneObsId = zoneDef.observers[0];
          var isDisturbed = !!disturbedSet[zoneObsId];

          // If this observer is disturbed and others are too, cross zone takes priority
          var othersDisturbed = false;
          for (var o = 0; o < disturbedList.length; o++) {
            if (disturbedList[o] !== zoneObsId) {
              othersDisturbed = true;
              break;
            }
          }

          // Zone is occupied if observer is disturbed (single-observer zone still reports)
          var zoneConfidence = 0;
          if (isDisturbed) {
            // Compute this observer's individual confidence
            var obsBuf = this.rssiBuffers[zoneObsId] || [];
            var obsBaseline = this.baselines[zoneObsId] || -42;
            var obsRecent = obsBuf.slice(Math.max(0, obsBuf.length - 5));
            var obsDelta = obsRecent.length > 0 ? Math.abs(mean(obsRecent) - obsBaseline) : 0;
            zoneConfidence = Math.min(1.0, obsDelta / 5.0);
            // Reduce confidence if cross zone is dominant
            if (othersDisturbed) {
              zoneConfidence *= 0.6;
            }
            zoneConfidence = Math.max(0.1, zoneConfidence);
          } else {
            zoneConfidence = Math.max(0, Math.random() * 0.08);
          }

          zones[zoneId] = {
            name: zoneDef.name,
            occupied: isDisturbed,
            confidence: Math.round(zoneConfidence * 100) / 100
          };
        }
      }
    }

    // Determine accuracy based on observer count
    var accuracy = 'none';
    if (this.observers.length >= 3) {
      accuracy = 'approximate';
    } else if (this.observers.length === 2) {
      accuracy = 'coarse';
    } else if (this.observers.length === 1) {
      accuracy = 'minimal';
    }

    return {
      presence: presence,
      confidence: Math.round(overallConfidence * 100) / 100,
      disturbedObservers: disturbedList.slice(),
      zones: zones,
      activeObservers: this.observers.length,
      accuracy: accuracy
    };
  };

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Push a value onto a ring buffer array, evicting oldest if over maxLen.
   */
  ObserverSimulator.prototype._pushBuffer = function (arr, value, maxLen) {
    arr.push(value);
    if (arr.length > maxLen) {
      arr.shift();
    }
  };

  // ── Expose globally ────────────────────────────────────────────────
  window.ObserverSimulator = ObserverSimulator;

})();
