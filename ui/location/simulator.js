/**
 * RSSISimulator — Realistic RSSI behavior simulation for development without hardware.
 *
 * Simulates:
 *  - Baseline RSSI with Gaussian noise
 *  - Person entry/exit events with body absorption effects
 *  - Breathing modulation (0.1-0.5 Hz band)
 *  - Motion modulation (0.5-3.0 Hz band)
 *  - CUSUM change-point detection
 *  - Sliding-window variance
 *  - Simplified DFT for spectral band analysis
 *  - Multi-node RSSI generation (per-node independent readings)
 *  - Multi-person movement simulation with path-loss model
 *
 * Vanilla JavaScript, no external dependencies.
 * Attach to window.RSSISimulator for global access.
 */

(function () {
  'use strict';

  // ── Utility helpers ──────────────────────────────────────────────────

  /** Box-Muller transform — returns a sample from N(0, 1). */
  function gaussianRandom() {
    var u1 = Math.random();
    var u2 = Math.random();
    // Avoid log(0)
    while (u1 === 0) u1 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /** Uniform random float in [lo, hi). */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /** Uniform random integer in [lo, hi] inclusive. */
  function randInt(lo, hi) {
    return Math.floor(randRange(lo, hi + 1));
  }

  /** Hann window coefficient for index k out of N samples. */
  function hann(k, N) {
    return 0.5 * (1.0 - Math.cos((2.0 * Math.PI * k) / (N - 1)));
  }

  // ── RSSISimulator ────────────────────────────────────────────────────

  /**
   * @param {Object} config  Parsed contents of default-signal-map.json.
   */
  function RSSISimulator(config) {
    this.config = config || {};
    this.running = false;
    this.listeners = [];
    this._intervalId = null;

    // Detection thresholds from config (with defaults)
    var det = (config && config.detection) || {};
    this.presenceVarianceThreshold = det.presenceVarianceThreshold || 0.5;
    this.motionEnergyThreshold    = det.motionEnergyThreshold    || 0.1;
    this.breathingBandHz          = det.breathingBandHz           || [0.1, 0.5];
    this.motionBandHz             = det.motionBandHz              || [0.5, 3.0];
    this.smoothingFactor          = det.smoothingFactor           || 0.85;
    this.windowSeconds            = det.windowSeconds             || 15;
    this.cusumThreshold           = det.cusumThreshold            || 3.0;

    // ── State ──────────────────────────────────────────────────────────
    this.baselineRssi  = -42;       // dBm, nobody present
    this.currentRssi   = -42;
    this.noiseStdDev   = 0.3;       // dBm Gaussian noise

    // Ring buffers (max 600 samples = 60 s at 10 Hz)
    this.maxHistory       = 600;
    this.rssiHistory      = [];
    this.varianceHistory  = [];
    this.motionHistory    = [];
    this.breathingHistory = [];

    // Presence simulation FSM
    this.presenceState   = 'absent'; // absent | present_still | active
    this.presenceTimer   = null;
    this.nextEventTime   = 0;        // timestamp (ms) of next scheduled event
    this._pendingTransition = null;  // scheduled transition type

    // Signal generation
    this.sampleRate    = 10;    // Hz
    this.t             = 0;     // accumulated time (s)
    this.breathingFreq = 0.25;  // Hz (15 breaths/min)
    this.motionFreq    = 1.2;   // Hz

    // Presence effect accumulators (smooth transitions)
    this._rssiOffset       = 0;   // current body-absorption offset (dBm)
    this._targetRssiOffset = 0;
    this._motionAmplitude  = 0;
    this._targetMotionAmp  = 0;
    this._breathingAmp     = 0;
    this._targetBreathAmp  = 0;

    // CUSUM state
    this._cusumPos   = 0;
    this._cusumNeg   = 0;
    this._cusumDrift = 0.5; // sigma units

    // Events ring buffer (last 20)
    this.events     = [];
    this.maxEvents  = 20;

    // Smoothed outputs
    this._smoothedVariance  = 0;
    this._smoothedMotion    = 0;
    this._smoothedBreathing = 0;
    this._confidence        = 0;
    this._motionScore       = 0;

    // ── Multi-node state ───────────────────────────────────────────────
    this._allNodes = this._buildNodeList();
    this._simPersons = [];
    this._personSimInitialized = false;
    this._nextPersonAddTime = 0;
    this._maxSimPersons = 3;

    // Schedule the first presence event
    this._schedulePresenceEvent();
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Start generating data at sampleRate Hz. */
  RSSISimulator.prototype.start = function () {
    if (this.running) return;
    this.running = true;

    // Initialize multi-person simulation if we have multiple nodes
    if (this._allNodes.length >= 2 && !this._personSimInitialized) {
      this._initPersonSimulation();
    }

    var self = this;
    var intervalMs = Math.round(1000 / this.sampleRate);
    this._intervalId = setInterval(function () {
      self._tick();
    }, intervalMs);
  };

  /** Stop generating data. */
  RSSISimulator.prototype.stop = function () {
    if (!this.running) return;
    this.running = false;
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  };

  /** Register a listener that receives each sample's state snapshot. */
  RSSISimulator.prototype.onData = function (callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  };

  /** Remove a previously registered listener. */
  RSSISimulator.prototype.offData = function (callback) {
    this.listeners = this.listeners.filter(function (cb) {
      return cb !== callback;
    });
  };

  /** Return a full state snapshot (same shape as plan section 5). */
  RSSISimulator.prototype.getState = function () {
    var varianceWindow = this._computeVariance(this.windowSeconds * this.sampleRate);
    var spectral       = this._computeSpectralBands(this.rssiHistory);

    return {
      mode: 'simulation',
      source: 'simulated',
      connected: this.running,

      presence:    this.presenceState,
      confidence:  this._confidence,
      motionScore: this._motionScore,

      rssi: {
        current:  Math.round(this.currentRssi * 100) / 100,
        baseline: this.baselineRssi,
        variance: Math.round(varianceWindow * 1000) / 1000,
        snr:      Math.round((this.currentRssi - (-90)) * 100) / 100  // noise floor ~ -90 dBm
      },

      spectral: {
        breathingPower: Math.round(spectral.breathingPower * 10000) / 10000,
        motionPower:    Math.round(spectral.motionPower * 10000) / 10000,
        dominantFreq:   Math.round(spectral.dominantFreq * 100) / 100,
        changePoints:   spectral.changePoints
      },

      events: this.events.slice(),

      diagnostics: {
        rssiTrend:      this._recentTrend(this.rssiHistory, 60),
        varianceTrend:  this._recentTrend(this.varianceHistory, 60),
        motionTrend:    this._recentTrend(this.motionHistory, 60),
        breathingTrend: this._recentTrend(this.breathingHistory, 60)
      }
    };
  };

  /**
   * Return extended state with multi-node readings and tracked persons.
   * Includes everything from getState() plus per-node RSSI and person data.
   */
  RSSISimulator.prototype.getMultiNodeState = function () {
    var baseState = this.getState();
    var nodes = this._allNodes;
    var nodeReadings = {};
    var trackedDevices = [];
    var activeNodeCount = 0;

    // Build per-node RSSI readings (ambient readings reflecting presence state)
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var nodeRssi = this._generateNodeAmbientRssi(node);
      var nodeVariance = Math.abs(gaussianRandom() * 0.5) + 0.1;
      var snr = Math.round((nodeRssi - (-90)) * 100) / 100;
      nodeReadings[node.id] = {
        rssi: Math.round(nodeRssi * 100) / 100,
        variance: Math.round(nodeVariance * 1000) / 1000,
        snr: snr
      };
      activeNodeCount++;
    }

    // Build tracked device entries from simulated persons
    for (var p = 0; p < this._simPersons.length; p++) {
      var person = this._simPersons[p];
      var rssiByNode = {};
      for (var n = 0; n < nodes.length; n++) {
        var nd = nodes[n];
        rssiByNode[nd.id] = Math.round(
          this._calculatePersonRssi(person, nd.x, nd.y) * 100
        ) / 100;
      }
      trackedDevices.push({
        id: person.id,
        name: person.name,
        rssiByNode: rssiByNode,
        truePosition: { x: Math.round(person.x * 100) / 100, y: Math.round(person.y * 100) / 100 },
        vx: person.vx || 0,
        vy: person.vy || 0,
        color: person.color,
        state: person.state
      });
    }

    // Merge into base state
    baseState.nodeReadings = nodeReadings;
    baseState.trackedDevices = trackedDevices;
    baseState.activeNodes = activeNodeCount;
    baseState.trilaterationReady = activeNodeCount >= 3;

    return baseState;
  };

  // ── Internal: tick (one sample) ──────────────────────────────────────

  RSSISimulator.prototype._tick = function () {
    var dt = 1.0 / this.sampleRate;
    this.t += dt;

    // Check for scheduled presence events
    var now = Date.now();
    if (now >= this.nextEventTime && this._pendingTransition) {
      this._executeTransition(this._pendingTransition);
      this._pendingTransition = null;
      this._schedulePresenceEvent();
    }

    // Smoothly interpolate effect parameters toward targets
    var alpha = 1.0 - Math.pow(0.05, dt); // ~exponential approach
    this._rssiOffset      += (this._targetRssiOffset - this._rssiOffset) * alpha;
    this._motionAmplitude += (this._targetMotionAmp - this._motionAmplitude) * alpha;
    this._breathingAmp    += (this._targetBreathAmp - this._breathingAmp) * alpha;

    // Generate raw RSSI
    this.currentRssi = this._generateRssi();

    // Push to ring buffer
    this._pushRing(this.rssiHistory, this.currentRssi);

    // Compute sliding-window variance
    var variance = this._computeVariance(this.windowSeconds * this.sampleRate);
    this._smoothedVariance = this._smoothedVariance * this.smoothingFactor
                           + variance * (1.0 - this.smoothingFactor);
    this._pushRing(this.varianceHistory, this._smoothedVariance);

    // Spectral analysis (every tick is fine at 10 Hz)
    var spectral = this._computeSpectralBands(this.rssiHistory);
    this._smoothedBreathing = this._smoothedBreathing * this.smoothingFactor
                            + spectral.breathingPower * (1.0 - this.smoothingFactor);
    this._smoothedMotion    = this._smoothedMotion * this.smoothingFactor
                            + spectral.motionPower * (1.0 - this.smoothingFactor);
    this._pushRing(this.breathingHistory, this._smoothedBreathing);
    this._pushRing(this.motionHistory, this._smoothedMotion);

    // CUSUM change-point detection
    this._updateCusum(this.currentRssi);

    // Derive confidence & motionScore
    this._updateDerivedMetrics();

    // Update multi-person simulation (if initialized)
    if (this._personSimInitialized) {
      this._updatePersons(dt);
    }

    // Notify listeners
    var state = this.getState();
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](state); } catch (e) { /* swallow */ }
    }
  };

  // ── RSSI generation ──────────────────────────────────────────────────

  RSSISimulator.prototype._generateRssi = function () {
    // Base RSSI + Gaussian noise
    var noise = gaussianRandom() * this.noiseStdDev;
    var rssi  = this.baselineRssi + noise;

    // Body absorption offset (negative = signal drops when person present)
    rssi += this._rssiOffset;

    // Breathing component (sinusoidal in breathing band)
    if (this._breathingAmp > 0.001) {
      rssi += this._breathingAmp * Math.sin(2.0 * Math.PI * this.breathingFreq * this.t);
    }

    // Motion component (composite of motion frequency + harmonics)
    if (this._motionAmplitude > 0.001) {
      rssi += this._motionAmplitude * Math.sin(2.0 * Math.PI * this.motionFreq * this.t);
      rssi += (this._motionAmplitude * 0.3) * Math.sin(2.0 * Math.PI * (this.motionFreq * 2.1) * this.t);
      // Add some randomness to motion
      rssi += this._motionAmplitude * 0.5 * gaussianRandom();
    }

    return rssi;
  };

  // ── Variance ─────────────────────────────────────────────────────────

  /**
   * Sliding-window variance of the last `windowLen` RSSI samples.
   */
  RSSISimulator.prototype._computeVariance = function (windowLen) {
    var data = this.rssiHistory;
    var n    = Math.min(data.length, windowLen);
    if (n < 2) return 0;

    var start = data.length - n;
    var sum   = 0;
    var sumSq = 0;
    for (var i = start; i < data.length; i++) {
      sum   += data[i];
      sumSq += data[i] * data[i];
    }
    var mean     = sum / n;
    var variance = (sumSq / n) - (mean * mean);
    return Math.max(0, variance);
  };

  // ── Spectral analysis (simplified DFT) ───────────────────────────────

  /**
   * Compute power in breathing and motion frequency bands.
   * Uses the last 128 samples (12.8 s at 10 Hz) with a Hann window.
   */
  RSSISimulator.prototype._computeSpectralBands = function (history) {
    var N = 128;
    var result = {
      breathingPower: 0,
      motionPower: 0,
      dominantFreq: 0,
      changePoints: this._countRecentChangePoints()
    };

    if (history.length < N) return result;

    // Extract last N samples
    var start   = history.length - N;
    var samples = new Array(N);
    var mean    = 0;
    for (var i = 0; i < N; i++) {
      samples[i] = history[start + i];
      mean += samples[i];
    }
    mean /= N;

    // Remove DC offset and apply Hann window
    for (var i = 0; i < N; i++) {
      samples[i] = (samples[i] - mean) * hann(i, N);
    }

    // DFT — only compute bins we care about
    // Frequency resolution: df = sampleRate / N
    var df          = this.sampleRate / N;
    var maxBin      = Math.ceil(this.motionBandHz[1] / df) + 1; // up to ~3 Hz
    var minBin      = Math.max(1, Math.floor(this.breathingBandHz[0] / df));
    var breathLo    = this.breathingBandHz[0];
    var breathHi    = this.breathingBandHz[1];
    var motionLo    = this.motionBandHz[0];
    var motionHi    = this.motionBandHz[1];
    var peakMag     = 0;
    var peakBin     = 0;

    for (var k = minBin; k <= maxBin && k < N / 2; k++) {
      // DFT bin k
      var re = 0, im = 0;
      for (var n = 0; n < N; n++) {
        var angle = (2.0 * Math.PI * k * n) / N;
        re += samples[n] * Math.cos(angle);
        im -= samples[n] * Math.sin(angle);
      }
      var mag = (re * re + im * im) / (N * N);
      var freq = k * df;

      if (freq >= breathLo && freq <= breathHi) {
        result.breathingPower += mag;
      }
      if (freq >= motionLo && freq <= motionHi) {
        result.motionPower += mag;
      }
      if (mag > peakMag) {
        peakMag = mag;
        peakBin = k;
      }
    }

    result.dominantFreq = peakBin * df;
    return result;
  };

  // ── CUSUM change-point detection ─────────────────────────────────────

  RSSISimulator.prototype._updateCusum = function (rssi) {
    var deviation = rssi - this.baselineRssi;
    var drift     = this._cusumDrift * this.noiseStdDev;

    this._cusumPos = Math.max(0, this._cusumPos + deviation - drift);
    this._cusumNeg = Math.max(0, this._cusumNeg - deviation - drift);

    var threshold = this.cusumThreshold * this.noiseStdDev;

    if (this._cusumPos > threshold || this._cusumNeg > threshold) {
      // Change point detected
      this._pushEvent('change_point', 0.9,
        'CUSUM +' + (Math.round(this._cusumPos * 100) / 100) + ' / -' + (Math.round(this._cusumNeg * 100) / 100)
      );
      // Reset after detection
      this._cusumPos = 0;
      this._cusumNeg = 0;
    }
  };

  // ── Presence event scheduling ────────────────────────────────────────

  RSSISimulator.prototype._schedulePresenceEvent = function () {
    var delayMs;
    var transition;

    switch (this.presenceState) {
      case 'absent':
        // Schedule person entering in 8-20 s
        delayMs    = randRange(8000, 20000);
        transition = 'enter';
        break;

      case 'present_still':
        // Either start moving (30%) or leave (70%), in 5-15 s
        if (Math.random() < 0.3) {
          delayMs    = randRange(3000, 8000);
          transition = 'start_motion';
        } else {
          delayMs    = randRange(15000, 45000);
          transition = 'exit';
        }
        break;

      case 'active':
        // Either stop moving (50%) or leave (50%), in 5-12 s
        if (Math.random() < 0.5) {
          delayMs    = randRange(3000, 8000);
          transition = 'stop_motion';
        } else {
          delayMs    = randRange(8000, 20000);
          transition = 'exit';
        }
        break;

      default:
        delayMs    = 10000;
        transition = 'enter';
    }

    this.nextEventTime      = Date.now() + delayMs;
    this._pendingTransition = transition;
  };

  // ── Execute a state transition ───────────────────────────────────────

  RSSISimulator.prototype._executeTransition = function (transition) {
    switch (transition) {
      case 'enter':
        this.presenceState      = 'present_still';
        this._targetRssiOffset  = -randRange(2, 5);        // body absorption: 2-5 dBm drop
        this._targetBreathAmp   = randRange(0.2, 0.5);     // breathing modulation
        this._targetMotionAmp   = 0;                       // still
        this.breathingFreq      = randRange(0.15, 0.35);   // vary breathing rate
        this._pushEvent('enter', 0.85, 'rssiDrop: ' + (-this._targetRssiOffset));
        break;

      case 'start_motion':
        this.presenceState      = 'active';
        this._targetMotionAmp   = randRange(0.8, 2.0);     // motion amplitude
        this._targetBreathAmp   = randRange(0.1, 0.3);     // breathing harder to detect during motion
        this.motionFreq         = randRange(0.8, 2.0);     // walking pace varies
        this._pushEvent('motion', 0.9, 'motionAmp: ' + this._targetMotionAmp);
        break;

      case 'stop_motion':
        this.presenceState      = 'present_still';
        this._targetMotionAmp   = 0;
        this._targetBreathAmp   = randRange(0.2, 0.5);
        this._pushEvent('motion_stop', 0.8, 'motion stopped');
        break;

      case 'exit':
        this.presenceState      = 'absent';
        this._targetRssiOffset  = 0;
        this._targetMotionAmp   = 0;
        this._targetBreathAmp   = 0;
        this._pushEvent('exit', 0.85, 'person exited');
        break;
    }
  };

  // ── Derived metrics ──────────────────────────────────────────────────

  RSSISimulator.prototype._updateDerivedMetrics = function () {
    // Confidence: based on variance exceeding threshold
    var varianceRatio = this._smoothedVariance / this.presenceVarianceThreshold;
    if (varianceRatio > 1.0) {
      this._confidence = Math.min(1.0, 0.5 + varianceRatio * 0.25);
    } else {
      this._confidence = Math.max(0.0, varianceRatio * 0.4);
    }

    // Motion score: based on motion band power
    var motionRatio = this._smoothedMotion / Math.max(this.motionEnergyThreshold, 0.001);
    this._motionScore = Math.min(1.0, motionRatio);
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Push a value onto a ring buffer, evicting oldest if full. */
  RSSISimulator.prototype._pushRing = function (arr, value) {
    arr.push(value);
    if (arr.length > this.maxHistory) {
      arr.shift();
    }
  };

  /** Push an event to the event ring buffer. */
  RSSISimulator.prototype._pushEvent = function (type, confidence, detail) {
    this.events.push({
      ts: Date.now(),
      type: type,
      confidence: Math.round(confidence * 100) / 100,
      detail: typeof detail === 'object' ? JSON.stringify(detail) : String(detail || '')
    });
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  };

  /** Return the last `n` values from an array (for diagnostics trends). */
  RSSISimulator.prototype._recentTrend = function (arr, n) {
    if (arr.length <= n) return arr.slice();
    return arr.slice(arr.length - n);
  };

  /** Count change_point events in the last 60 seconds. */
  RSSISimulator.prototype._countRecentChangePoints = function () {
    var cutoff = Date.now() - 60000;
    var count  = 0;
    for (var i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].ts < cutoff) break;
      if (this.events[i].type === 'change_point') count++;
    }
    return count;
  };

  // ══════════════════════════════════════════════════════════════════════
  // ── Multi-Node & Multi-Person Simulation ─────────────────────────────
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Build a unified node list from config.accessPoints and config.nodes.
   * Each entry: { id, name, x, y, type }.
   */
  RSSISimulator.prototype._buildNodeList = function () {
    var nodes = [];
    var cfg = this.config || {};

    // Access points are also nodes for trilateration purposes
    var aps = cfg.accessPoints || [];
    for (var i = 0; i < aps.length; i++) {
      nodes.push({
        id:   aps[i].id   || ('ap-' + i),
        name: aps[i].name || ('AP ' + i),
        x:    aps[i].x    || 0,
        y:    aps[i].y    || 0,
        type: 'ap'
      });
    }

    // Additional nodes (ESP32, PC monitors, etc.)
    var extra = cfg.nodes || [];
    for (var j = 0; j < extra.length; j++) {
      nodes.push({
        id:   extra[j].id   || ('node-' + j),
        name: extra[j].name || ('Node ' + j),
        x:    extra[j].x    || 0,
        y:    extra[j].y    || 0,
        type: extra[j].type || 'unknown'
      });
    }

    return nodes;
  };

  // ── Person simulation initialization ─────────────────────────────────

  /**
   * Initialize the multi-person movement simulation.
   * Starts with 1 person; more may be added over time (up to _maxSimPersons).
   */
  RSSISimulator.prototype._initPersonSimulation = function () {
    this._simPersons = [];
    this._personSimInitialized = true;
    // Add the first simulated person
    this._addSimPerson();
    // Schedule the next person addition (15-40 seconds from now)
    this._nextPersonAddTime = Date.now() + randRange(15000, 40000);
  };

  /**
   * Add a new simulated person to the simulation.
   */
  RSSISimulator.prototype._addSimPerson = function () {
    var id = this._simPersons.length + 1;
    var colors = ['#00ff88', '#3b82f6', '#f59e0b', '#ef4444'];
    this._simPersons.push({
      id: 'sim-person-' + id,
      name: 'Person ' + id,
      x: Math.random() * 4 - 1,      // random start position in [-1, 3]
      y: Math.random() * 4 - 1,
      vx: 0,
      vy: 0,
      targetX: randRange(-1, 4),
      targetY: randRange(-1, 4),
      color: colors[(id - 1) % colors.length],
      moveTimer: 0,
      pauseTimer: 0,
      speed: randRange(0.3, 0.8),     // m/s movement speed
      state: 'idle'                   // idle | walking | stationary
    });
  };

  // ── RSSI calculation from person position ────────────────────────────

  /**
   * Calculate simulated RSSI that a node at (nodeX, nodeY) would observe
   * from a person at (person.x, person.y) using the log-distance path-loss model.
   *
   * @param {Object} person  Simulated person with {x, y}
   * @param {number} nodeX   Node x coordinate
   * @param {number} nodeY   Node y coordinate
   * @returns {number}       RSSI in dBm
   */
  RSSISimulator.prototype._calculatePersonRssi = function (person, nodeX, nodeY) {
    var dx = person.x - nodeX;
    var dy = person.y - nodeY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.1) distance = 0.1;

    // Path-loss model parameters from config
    var sm = this.config.signalMap || {};
    var n = sm.pathLossExponent || 3.0;
    var refRssi = sm.referenceRssi || -30;

    // Log-distance path loss: RSSI = refRssi - 10 * n * log10(d)
    var rssi = refRssi - 10 * n * Math.log10(distance);

    // Add Gaussian noise (2 dBm standard deviation for realistic variation)
    rssi += gaussianRandom() * 2;

    // Clamp to realistic range
    return Math.max(-90, Math.min(-20, rssi));
  };

  /**
   * Generate an ambient RSSI reading for a specific node,
   * reflecting the overall presence state (not person-specific).
   * Used for per-node baseline RSSI in getMultiNodeState().
   *
   * @param {Object} node  Node with {id, x, y}
   * @returns {number}     RSSI in dBm
   */
  RSSISimulator.prototype._generateNodeAmbientRssi = function (node) {
    // Each node sees a slightly different baseline based on position
    var posHash = Math.abs(Math.sin(node.x * 13.37 + node.y * 7.13)) * 5;
    var nodeBaseline = this.baselineRssi - posHash;

    var noise = gaussianRandom() * this.noiseStdDev;
    var rssi = nodeBaseline + noise;

    // Apply presence effects (scaled by inverse distance from origin for variety)
    var distFromOrigin = Math.sqrt(node.x * node.x + node.y * node.y);
    var presenceScale = 1.0 / (1.0 + distFromOrigin * 0.15);
    rssi += this._rssiOffset * presenceScale;

    // Add breathing/motion components with per-node phase offset
    var phaseOffset = (node.x * 0.5 + node.y * 0.3);
    if (this._breathingAmp > 0.001) {
      rssi += this._breathingAmp * presenceScale *
              Math.sin(2.0 * Math.PI * this.breathingFreq * this.t + phaseOffset);
    }
    if (this._motionAmplitude > 0.001) {
      rssi += this._motionAmplitude * presenceScale *
              Math.sin(2.0 * Math.PI * this.motionFreq * this.t + phaseOffset);
    }

    return rssi;
  };

  // ── Person movement update ───────────────────────────────────────────

  /**
   * Update all simulated persons' positions and states.
   * Called once per tick from _tick().
   *
   * @param {number} dt  Time step in seconds (1/sampleRate)
   */
  RSSISimulator.prototype._updatePersons = function (dt) {
    var now = Date.now();

    // Occasionally add a new person (up to max)
    if (this._simPersons.length < this._maxSimPersons && now >= this._nextPersonAddTime) {
      this._addSimPerson();
      this._nextPersonAddTime = now + randRange(20000, 60000);
    }

    // Movement bounds
    var boundsMinX = -3;
    var boundsMaxX = 6;
    var boundsMinY = -2;
    var boundsMaxY = 5;

    for (var i = 0; i < this._simPersons.length; i++) {
      var person = this._simPersons[i];

      switch (person.state) {
        case 'idle':
          // Pick a target and start walking
          person.targetX = randRange(boundsMinX + 0.5, boundsMaxX - 0.5);
          person.targetY = randRange(boundsMinY + 0.5, boundsMaxY - 0.5);
          person.speed = randRange(0.3, 0.8);
          person.state = 'walking';
          break;

        case 'walking':
          // Move toward target
          var dx = person.targetX - person.x;
          var dy = person.targetY - person.y;
          var dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 0.15) {
            // Reached target, become stationary
            person.vx = 0;
            person.vy = 0;
            person.state = 'stationary';
            person.pauseTimer = randRange(3, 10); // pause for 3-10 seconds
          } else {
            // Move toward target at configured speed
            var moveSpeed = person.speed;
            person.vx = (dx / dist) * moveSpeed;
            person.vy = (dy / dist) * moveSpeed;

            // Add slight random drift for natural movement
            person.vx += gaussianRandom() * 0.05;
            person.vy += gaussianRandom() * 0.05;

            // Update position
            person.x += person.vx * dt;
            person.y += person.vy * dt;

            // Clamp to bounds
            person.x = Math.max(boundsMinX, Math.min(boundsMaxX, person.x));
            person.y = Math.max(boundsMinY, Math.min(boundsMaxY, person.y));
          }
          break;

        case 'stationary':
          // Wait at current position, with tiny idle drift
          person.x += gaussianRandom() * 0.005;
          person.y += gaussianRandom() * 0.005;

          person.pauseTimer -= dt;
          if (person.pauseTimer <= 0) {
            // Done pausing, pick a new target
            person.state = 'idle';
          }
          break;
      }
    }
  };

  // ── Expose globally ──────────────────────────────────────────────────
  window.RSSISimulator = RSSISimulator;

})();
