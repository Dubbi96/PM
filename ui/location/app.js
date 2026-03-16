// Location App Orchestrator — RuView RSSI Mesh Detection
// Ties together SignalMeshRenderer (or FloorPlanRenderer fallback),
// LocationAPI, LocationWebSocket, RSSISimulator, and TrilaterationEngine.
// Manages presence-based state, RSSI metrics, spectral analysis, and UI lifecycle.

/**
 * LocationApp
 *
 * Main entry point for the RSSI mesh detection dashboard.
 * Loads signal-map config, wires up the mesh canvas, REST API adapter,
 * WebSocket stream, RSSI simulator, trilateration engine, and keeps every UI panel in sync.
 */
class LocationApp {
  constructor() {
    this.config = null;        // from default-signal-map.json (or default-room.json fallback)
    this.api = null;           // LocationAPI instance
    this.ws = null;            // LocationWebSocket instance
    this.renderer = null;      // SignalMeshRenderer (new) or FloorPlanRenderer (fallback)
    this.simulator = null;     // RSSISimulator (simulation mode only)
    this.trilateration = null; // TrilaterationEngine (multi-node positioning)

    // Canonical application state — RSSI mesh detection model
    this.state = {
      mode: 'simulation',       // simulation | rssi-only | rssi+csi
      source: 'simulated',      // simulated | wifi-rssi | esp32-csi
      connected: false,
      serverStatus: 'offline',  // online | degraded | offline

      // Presence detection (replaces zone occupancy)
      presence: 'absent',       // absent | present_still | active
      confidence: 0,
      motionScore: 0,

      // RSSI metrics
      rssi: {
        current: -42,
        baseline: -42,
        variance: 0,
        snr: 0
      },

      // Spectral analysis
      spectral: {
        breathingPower: 0,
        motionPower: 0,
        dominantFreq: 0,
        changePoints: 0
      },

      // Events
      events: [],               // [{ ts, type, confidence, detail }]

      // Diagnostics
      diagnostics: {
        rssiTrend: [],          // last 60 values
        varianceTrend: [],      // last 60 values
        motionTrend: [],        // last 60 values
        breathingTrend: [],     // last 60 values
        processingTimeMs: 0
      },

      // Node status
      nodes: [],                // [{ id, name, type, connected, lastSeen }]

      // Trilateration / multi-node tracking
      trackedDevices: [],       // [{ id, name, position, confidence, color, errorRadius, ... }]
      accuracyLevel: 'none',    // none | presence | direction | approximate | precise
      activeNodes: 0
    };

    // Timers tracked for cleanup
    this._pollTimer = null;
    this._retryTimer = null;
    this._simTimer = null;
    this._renderRafId = null;
    this._healthTimer = null;

    // Event tracking
    this._lastPushedEventCount = 0;

    // Constants
    this._MAX_EVENTS = 50;
    this._MAX_TREND_POINTS = 60;
    this._POLL_INTERVAL_MS = 2000;
    this._HEALTH_RETRY_MS = 5000;
    this._SIM_TICK_MS = 500;       // simulator ticks faster for smooth RSSI data
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  async init() {
    console.log('[LocationApp] Initializing...');
    this._setStatusText('\uCD08\uAE30\uD654 \uC911...');

    try {
      // 1. Load config: try signal-map first, fall back to room config
      if (window.__ruviewConfig) {
        this.config = window.__ruviewConfig;
      } else {
        this.config = await this._loadConfig('location/config/default-signal-map.json')
          .catch(function() { return null; });

        if (!this.config) {
          console.warn('[LocationApp] Signal map config not found, falling back to room config');
          this.config = await this._loadConfig('location/config/default-room.json');
        }
      }

      var configName = (this.config.signalMap && this.config.signalMap.name)
        || (this.config.room && this.config.room.name)
        || 'Unknown';
      console.log('[LocationApp] Config loaded:', configName);

      // 2. Determine config type and create appropriate renderer
      this._configType = this.config.signalMap ? 'signal-map' : 'room';

      var canvas = document.getElementById('floorplan-canvas');
      if (canvas) {
        if (this._configType === 'signal-map' && window.SignalMeshRenderer) {
          this.renderer = new window.SignalMeshRenderer(canvas, this.config);
          console.log('[LocationApp] Using SignalMeshRenderer');
        } else if (window.FloorPlanRenderer) {
          this.renderer = new window.FloorPlanRenderer(canvas, this.config);
          console.log('[LocationApp] Using FloorPlanRenderer (fallback)');
        } else {
          console.warn('[LocationApp] No renderer available');
        }

        if (this.renderer && typeof this.renderer.render === 'function') {
          this.renderer.render();
        }
      } else {
        console.warn('[LocationApp] #floorplan-canvas not found');
      }

      // 2b. Initialize TrilaterationEngine if available
      if (window.TrilaterationEngine) {
        this.trilateration = new window.TrilaterationEngine(this.config);
        this.trilateration.loadNodes(this.config.accessPoints, this.config.nodes);
        console.log('[LocationApp] TrilaterationEngine initialized');
      } else {
        console.log('[LocationApp] TrilaterationEngine not loaded, skipping trilateration');
      }

      // 3. Seed nodes from config
      var configNodes = this.config.nodes || [];
      this.state.nodes = configNodes.map(function(n) {
        return {
          id: n.id,
          name: n.name,
          type: n.type || 'esp32',
          connected: n.status === 'connected',
          lastSeen: null
        };
      });

      // 4. Initialize LocationAPI
      if (window.LocationAPI) {
        this.api = new window.LocationAPI();
      } else {
        console.warn('[LocationApp] LocationAPI not loaded');
      }

      // 5-8. In simulation mode, skip all server communication and just start the simulator
      if (this.state.mode === 'simulation') {
        console.log('[LocationApp] Simulation mode — skipping server health, WS, and polling');
        this.state.serverStatus = 'offline';
        this._startSimulation();
      } else {
        // 5. Check server health
        await this._checkServerHealth();

        // 6. Try WebSocket, fall back to polling
        var wsConnected = await this._connectWebSocket();
        if (!wsConnected) {
          console.log('[LocationApp] WebSocket unavailable, falling back to polling');
          this._startPolling();
        }

        // 7. If server offline, start health retry loop
        if (this.state.serverStatus === 'offline') {
          this._startHealthRetry();
        }
      }

      // 9. Start render loop
      this._startRenderLoop();

      // 10. Initial UI paint
      this._fullUiUpdate();

      this._setStatusText('');
      console.log('[LocationApp] Initialization complete');
    } catch (err) {
      console.error('[LocationApp] Init failed:', err);
      this._setStatusText('\uCD08\uAE30\uD654 \uC2E4\uD328');
      this._showRetryButton();
    }
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  updateState(newData) {
    if (!newData || typeof newData !== 'object') return;

    // Merge top-level scalars
    var scalarKeys = ['mode', 'connected', 'source', 'serverStatus', 'presence', 'confidence', 'motionScore'];
    var self = this;
    scalarKeys.forEach(function(k) {
      if (k in newData) self.state[k] = newData[k];
    });

    // Merge RSSI metrics
    if (newData.rssi && typeof newData.rssi === 'object') {
      var rssiKeys = ['current', 'baseline', 'variance', 'snr'];
      rssiKeys.forEach(function(k) {
        if (k in newData.rssi) self.state.rssi[k] = newData.rssi[k];
      });
    }

    // Merge spectral analysis
    if (newData.spectral && typeof newData.spectral === 'object') {
      var spectralKeys = ['breathingPower', 'motionPower', 'dominantFreq', 'changePoints'];
      spectralKeys.forEach(function(k) {
        if (k in newData.spectral) self.state.spectral[k] = newData.spectral[k];
      });
    }

    // Merge nodes (by id)
    if (Array.isArray(newData.nodes)) {
      newData.nodes.forEach(function(incoming) {
        var existing = self.state.nodes.find(function(n) { return n.id === incoming.id; });
        if (existing) {
          Object.assign(existing, incoming);
        } else {
          self.state.nodes.push(incoming);
        }
      });
    }

    // Append events (capped)
    if (Array.isArray(newData.events)) {
      this.state.events = newData.events.concat(this.state.events).slice(0, this._MAX_EVENTS);
    }

    // Merge diagnostics
    if (newData.diagnostics) {
      var d = newData.diagnostics;
      var diag = this.state.diagnostics;
      var maxPts = this._MAX_TREND_POINTS;

      var trendKeys = ['rssiTrend', 'varianceTrend', 'motionTrend', 'breathingTrend'];
      trendKeys.forEach(function(k) {
        if (Array.isArray(d[k])) {
          diag[k] = diag[k].concat(d[k]).slice(-maxPts);
        }
      });

      if (typeof d.processingTimeMs === 'number') {
        diag.processingTimeMs = d.processingTimeMs;
      }
    }

    // Derive mode from source
    if (this.state.source === 'simulated') {
      this.state.mode = 'simulation';
    } else if (this.state.source === 'esp32-csi') {
      this.state.mode = 'rssi+csi';
    } else if (this.state.source === 'wifi-rssi') {
      this.state.mode = 'rssi-only';
    }

    // Trigger UI updates
    this._fullUiUpdate();

    // Forward to renderer
    if (this.renderer && typeof this.renderer.update === 'function') {
      this.renderer.update({
        presence: this.state.presence,
        confidence: this.state.confidence,
        motionScore: this.state.motionScore,
        rssi: this.state.rssi,
        spectral: this.state.spectral,
        nodes: this.state.nodes
      });
    }
  }

  // ---------------------------------------------------------------------------
  // UI update orchestration
  // ---------------------------------------------------------------------------

  _fullUiUpdate() {
    this._updateStatusBanner();
    this._updatePresenceDisplay();
    this._updateRssiDisplay();
    this._updateSpectralDisplay();
    this._updateDiagnostics();
    this._updateEventTimeline();
    this._updateNodeStatus();
    this._updateTrackedDevicesDisplay();
  }

  // ---------------------------------------------------------------------------
  // Status Banner
  // ---------------------------------------------------------------------------

  _updateStatusBanner() {
    var dash = window.RuViewDashboard;
    if (!dash) return;

    // Connection badge
    if (typeof dash.setConnectionStatus === 'function') {
      dash.setConnectionStatus(this.state.connected);
    }

    // Health badge
    if (typeof dash.setHealthStatus === 'function') {
      if (this.state.serverStatus === 'online') {
        dash.setHealthStatus('healthy');
      } else if (this.state.serverStatus === 'degraded') {
        dash.setHealthStatus('degraded');
      } else {
        dash.setHealthStatus('degraded', 'Offline');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Presence Display
  // ---------------------------------------------------------------------------

  _updatePresenceDisplay() {
    var dash = window.RuViewDashboard;
    if (!dash) return;

    // Presence badge (ABSENT / PRESENT_STILL / ACTIVE)
    if (typeof dash.setPresenceState === 'function') {
      dash.setPresenceState(this.state.presence);
    }

    // Person count — 0 if absent, 1 if present_still or active
    if (typeof dash.setPersonCount === 'function') {
      var count = this.state.presence === 'absent' ? 0 : 1;
      dash.setPersonCount(count);
    }

    // Confidence percentage
    if (typeof dash.setConfidence === 'function') {
      dash.setConfidence(Math.round(this.state.confidence * 100));
    }
  }

  // ---------------------------------------------------------------------------
  // RSSI Display
  // ---------------------------------------------------------------------------

  _updateRssiDisplay() {
    var dash = window.RuViewDashboard;
    if (!dash) return;

    if (typeof dash.setRssiValue === 'function') {
      dash.setRssiValue(this.state.rssi.current);
    }

    if (typeof dash.setVariance === 'function') {
      dash.setVariance(this.state.rssi.variance);
    }

    if (typeof dash.setSnr === 'function') {
      dash.setSnr(this.state.rssi.snr);
    }
  }

  // ---------------------------------------------------------------------------
  // Spectral Display
  // ---------------------------------------------------------------------------

  _updateSpectralDisplay() {
    var dash = window.RuViewDashboard;
    if (!dash) return;

    if (typeof dash.setSpectral === 'function') {
      dash.setSpectral(
        this.state.spectral.breathingPower,
        this.state.spectral.motionPower,
        this.state.spectral.dominantFreq
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  _updateDiagnostics() {
    var dash = window.RuViewDashboard;
    var diag = this.state.diagnostics;

    // Sparklines
    this.renderSparkline('rssi-trend-canvas', diag.rssiTrend, '#00ff88');
    this.renderSparkline('variance-trend-canvas', diag.varianceTrend, '#ff9800');
    this.renderSparkline('motion-trend-canvas', diag.motionTrend, '#2196f3');
    this.renderSparkline('breathing-trend-canvas', diag.breathingTrend, '#e040fb');

    if (!dash) return;

    // RSSI trend value
    if (typeof dash.setDiagValue === 'function') {
      var rssiData = diag.rssiTrend;
      var lastRssi = rssiData.length > 0 ? rssiData[rssiData.length - 1] : 0;
      dash.setDiagValue('rssi', lastRssi.toFixed(1) + ' dBm');

      var varData = diag.varianceTrend;
      var lastVar = varData.length > 0 ? varData[varData.length - 1] : 0;
      dash.setDiagValue('variance', lastVar.toFixed(3) + ' dBm\u00B2');

      var motionData = diag.motionTrend;
      var lastMotion = motionData.length > 0 ? motionData[motionData.length - 1] : 0;
      dash.setDiagValue('motion', lastMotion.toFixed(2));

      var breathData = diag.breathingTrend;
      var lastBreath = breathData.length > 0 ? breathData[breathData.length - 1] : 0;
      dash.setDiagValue('breathing', lastBreath.toFixed(3));
    }
  }

  // ---------------------------------------------------------------------------
  // Node Status
  // ---------------------------------------------------------------------------

  _updateNodeStatus() {
    var dash = window.RuViewDashboard;
    if (!dash || typeof dash.setNodeStatus !== 'function') return;

    for (var i = 0; i < this.state.nodes.length; i++) {
      var n = this.state.nodes[i];
      dash.setNodeStatus(n.id, n.connected ? 'connected' : 'disconnected');
    }
  }

  // ---------------------------------------------------------------------------
  // Tracked Devices Display (trilateration)
  // ---------------------------------------------------------------------------

  _updateTrackedDevicesDisplay() {
    var dash = window.RuViewDashboard;
    if (!dash) return;

    if (typeof dash.setTrackedDevices === 'function') {
      dash.setTrackedDevices(this.state.trackedDevices);
    }

    if (typeof dash.setAccuracy === 'function') {
      dash.setAccuracy(this.state.accuracyLevel);
    }
  }

  // ---------------------------------------------------------------------------
  // Event Timeline
  // ---------------------------------------------------------------------------

  _updateEventTimeline() {
    var dash = window.RuViewDashboard;
    if (!dash || typeof dash.pushEvent !== 'function') return;

    var events = this.state.events;
    var startIdx = this._lastPushedEventCount || 0;
    var newEvents = events.slice(0, events.length - startIdx);

    for (var i = newEvents.length - 1; i >= 0; i--) {
      var ev = newEvents[i];
      var detail = (ev.detail != null && typeof ev.detail === 'object')
        ? JSON.stringify(ev.detail)
        : String(ev.detail || ev.type || '');
      dash.pushEvent({
        type: ev.type || 'motion',
        message: detail,
        confidence: ev.confidence || 0,
        ts: ev.ts
      });
    }
    this._lastPushedEventCount = events.length;
  }

  // ---------------------------------------------------------------------------
  // Sparkline renderer
  // ---------------------------------------------------------------------------

  /**
   * Render a tiny sparkline onto a <canvas> element.
   * Dark background with colored line. Last value highlighted with a dot.
   *
   * @param {string} canvasId  - DOM id of the canvas
   * @param {number[]} data    - data points (auto-scaled)
   * @param {string} color     - stroke/fill color (hex)
   */
  renderSparkline(canvasId, data, color) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var pad = 3;

    // Dark background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    if (!data || data.length < 2) {
      // Draw a flat line at center if no data
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      ctx.moveTo(pad, h / 2);
      ctx.lineTo(w - pad, h / 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      return;
    }

    // Auto-scale
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    var range = max - min || 1;

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    var step = (w - pad * 2) / (data.length - 1);
    var lastX = 0;
    var lastY = 0;

    for (var j = 0; j < data.length; j++) {
      var x = pad + j * step;
      var y = h - pad - ((data[j] - min) / range) * (h - pad * 2);
      if (j === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
      lastY = y;
    }
    ctx.stroke();

    // Translucent fill under the line
    ctx.lineTo(pad + (data.length - 1) * step, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();

    // Parse hex color for rgba fill
    var r = parseInt(color.slice(1, 3), 16);
    var g = parseInt(color.slice(3, 5), 16);
    var b = parseInt(color.slice(5, 7), 16);
    ctx.fillStyle = 'rgba(' + r + ', ' + g + ', ' + b + ', 0.1)';
    ctx.fill();

    // Highlight last value with a dot
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Config loader
  // ---------------------------------------------------------------------------

  async _loadConfig(path) {
    var resp = await fetch(path);
    if (!resp.ok) {
      throw new Error('Config load failed: ' + resp.status + ' ' + resp.statusText);
    }
    return resp.json();
  }

  // ---------------------------------------------------------------------------
  // Server health
  // ---------------------------------------------------------------------------

  async _checkServerHealth() {
    if (!this.api) {
      this.state.serverStatus = 'offline';
      return;
    }

    try {
      var health = await this.api.health();
      if (health && (health.status === 'healthy' || health.status === 'ok')) {
        this.state.serverStatus = 'online';
        this.state.connected = true;

        // Detect source from server info
        if (health.mock_hardware === true || health.source === 'mock') {
          this.state.source = 'simulated';
        } else if (health.source === 'esp32-csi') {
          this.state.source = 'esp32-csi';
        } else if (health.source === 'wifi-rssi' || health.source === 'wifi') {
          this.state.source = 'wifi-rssi';
        } else if (health.source) {
          this.state.source = health.source;
        }
      } else if (health && health.status === 'degraded') {
        this.state.serverStatus = 'degraded';
        this.state.connected = true;
      } else {
        this.state.serverStatus = 'offline';
        this.state.connected = false;
      }
    } catch (_) {
      this.state.serverStatus = 'offline';
      this.state.connected = false;
    }
  }

  _startHealthRetry() {
    if (this._healthTimer) return;
    var self = this;
    this._healthTimer = setInterval(async function() {
      await self._checkServerHealth();
      self._updateStatusBanner();

      if (self.state.serverStatus !== 'offline') {
        clearInterval(self._healthTimer);
        self._healthTimer = null;
        // Try WS again
        var wsOk = await self._connectWebSocket();
        if (!wsOk && !self._pollTimer) {
          self._startPolling();
        }
      }
    }, this._HEALTH_RETRY_MS);
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  async _connectWebSocket() {
    if (this.state.mode === 'simulation') {
      return false;
    }
    if (!window.LocationWebSocket) {
      return false;
    }

    try {
      this.ws = new window.LocationWebSocket();
      var self = this;

      // Subscribe to presence/RSSI updates
      this.ws.onLocationUpdate(function(data) { self._handleWsMessage(data); });

      // Subscribe to individual events
      this.ws.onEvent(function(event) {
        self._handleWsMessage({
          type: 'presence_event',
          event: {
            timestamp: event.timestamp,
            type: event.type,
            confidence: event.confidence,
            detail: event.detail
          }
        });
      });

      // Subscribe to connection status changes
      this.ws.onStatusChange(function(state) { self._handleWsStateChange(state); });

      this.ws.connect();

      // Give it a moment to connect
      var connected = await this._waitForWs(3000);
      if (connected) {
        this.state.connected = true;
        this._stopPolling();
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  _waitForWs(timeoutMs) {
    var self = this;
    return new Promise(function(resolve) {
      if (self.ws && self.ws.isConnected && self.ws.isConnected()) {
        resolve(true);
        return;
      }
      var start = Date.now();
      var check = setInterval(function() {
        if (self.ws && self.ws.isConnected && self.ws.isConnected()) {
          clearInterval(check);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(check);
          resolve(false);
        }
      }, 200);
    });
  }

  _handleWsMessage(data) {
    var patch = {};

    // Presence state
    if (data.presence) {
      patch.presence = data.presence;
    }
    if (typeof data.confidence === 'number') {
      patch.confidence = data.confidence;
    }
    if (typeof data.motionScore === 'number' || typeof data.motion_score === 'number') {
      patch.motionScore = data.motionScore || data.motion_score;
    }

    // RSSI metrics
    if (data.rssi && typeof data.rssi === 'object') {
      patch.rssi = {
        current: data.rssi.current,
        baseline: data.rssi.baseline,
        variance: data.rssi.variance,
        snr: data.rssi.snr
      };
    }

    // Spectral
    if (data.spectral && typeof data.spectral === 'object') {
      patch.spectral = {
        breathingPower: data.spectral.breathingPower || data.spectral.breathing_power || 0,
        motionPower: data.spectral.motionPower || data.spectral.motion_power || 0,
        dominantFreq: data.spectral.dominantFreq || data.spectral.dominant_freq || 0,
        changePoints: data.spectral.changePoints || data.spectral.change_points || 0
      };
    }

    // Nodes
    if (Array.isArray(data.nodes)) {
      patch.nodes = data.nodes.map(function(n) {
        return {
          id: n.id,
          name: n.name,
          type: n.type || 'esp32',
          connected: !!n.connected,
          lastSeen: n.last_seen || n.lastSeen || null
        };
      });
    }

    // Events
    if (Array.isArray(data.events)) {
      patch.events = data.events.map(function(e) {
        return {
          ts: e.timestamp || e.ts || new Date(),
          type: e.type || 'motion',
          confidence: e.confidence || 0,
          detail: e.detail || e.message || ''
        };
      });
    }

    // Single event push
    if (data.type === 'presence_event' && data.event) {
      var e = data.event;
      patch.events = [{
        ts: e.timestamp || new Date(),
        type: e.type || 'motion',
        confidence: e.confidence || 0,
        detail: e.detail || ''
      }];
    }

    // Diagnostics
    if (data.diagnostics) {
      patch.diagnostics = data.diagnostics;
    }

    // Source
    if (data.source) {
      patch.source = data.source;
    }

    this.updateState(patch);
  }

  _handleWsStateChange(newState) {
    if (newState === 'connected') {
      this.state.connected = true;
      this._stopPolling();
    } else if (newState === 'disconnected' || newState === 'error') {
      this.state.connected = false;
      if (!this._pollTimer) {
        this._startPolling();
      }
    }
    this._updateStatusBanner();
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  _startPolling() {
    if (this._pollTimer) return;
    console.log('[LocationApp] Starting polling fallback');
    var self = this;
    this._pollTimer = setInterval(function() { self._pollServer(); }, this._POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[LocationApp] Polling stopped');
    }
  }

  async _pollServer() {
    if (this.state.mode === 'simulation') return;
    if (!this.api) return;
    try {
      // Try presence-specific endpoint first, fall back to generic
      var data;
      if (typeof this.api.getPresenceData === 'function') {
        data = await this.api.getPresenceData();
      } else if (typeof this.api.getLocationState === 'function') {
        data = await this.api.getLocationState();
      }
      if (data) {
        this._handleWsMessage(data);
        this.state.connected = true;
        this.state.serverStatus = 'online';
      }
    } catch (_) {
      this.state.connected = false;
      this.state.serverStatus = 'offline';
      this._updateStatusBanner();
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation mode — RSSI-based
  // ---------------------------------------------------------------------------

  _startSimulation() {
    console.log('[LocationApp] Starting RSSI simulation mode');
    var self = this;

    // Use RSSISimulator if available
    if (window.RSSISimulator) {
      this.simulator = new window.RSSISimulator(this.config);

      // Register data callback — simulator pushes data at each tick
      this.simulator.onData(function(simData) {
        self.updateState(simData);

        // Feed trilateration engine with multi-node data from simulator
        self._processSimulationTrilateration();
      });

      this.simulator.start();
      console.log('[LocationApp] RSSISimulator started');
    } else {
      // Built-in minimal RSSI simulation
      console.log('[LocationApp] RSSISimulator not loaded, using built-in simulation');
      this._startBuiltinSimulation();
    }
  }

  /**
   * Process trilateration data from simulator in simulation mode.
   * Gets multi-node state from simulator and feeds it to the trilateration engine.
   */
  _processSimulationTrilateration() {
    if (!this.simulator || !this.trilateration) return;
    if (typeof this.simulator.getMultiNodeState !== 'function') return;

    var multiState = this.simulator.getMultiNodeState();
    if (multiState && multiState.trackedDevices) {
      var tri = this.trilateration;
      multiState.trackedDevices.forEach(function(dev) {
        tri.trackDevice(dev.id, dev.rssiByNode, { name: dev.name, color: dev.color });
      });
    }

    // Get tracked devices from trilateration engine
    var devices = this.trilateration.getTrackedDevices();
    this.state.trackedDevices = devices;

    // Get accuracy level
    var accuracy = this.trilateration.getAccuracyLevel();
    this.state.accuracyLevel = accuracy;

    // Count active nodes
    this.state.activeNodes = this.trilateration.activeNodeCount
      ? this.trilateration.activeNodeCount()
      : (this.state.nodes ? this.state.nodes.filter(function(n) { return n.connected; }).length : 0);

    // Forward tracked devices to renderer
    if (this.renderer && typeof this.renderer.updateTrackedDevices === 'function') {
      this.renderer.updateTrackedDevices(devices);
    }

    // Update dashboard
    this._updateTrackedDevicesDisplay();
  }

  _stopSimulation() {
    if (this.simulator) {
      if (typeof this.simulator.stop === 'function') {
        this.simulator.stop();
      }
      this.simulator = null;
    }
    if (this._simTimer) {
      clearTimeout(this._simTimer);
      this._simTimer = null;
    }
  }

  /**
   * Built-in minimal RSSI simulation when RSSISimulator class is not available.
   * Generates realistic RSSI patterns with presence transitions.
   */
  _startBuiltinSimulation() {
    var self = this;
    var detection = (this.config && this.config.detection) || {};
    var varianceThreshold = detection.presenceVarianceThreshold || 0.5;

    // Simulation state
    var sim = {
      baselineRssi: -42,
      currentRssi: -42,
      presence: 'absent',
      tickCount: 0,
      nextTransitionTick: this._randomInt(10, 30),   // ticks until next presence change
      breathingPhase: 0,
      motionPhase: 0,
      isMoving: false,
      variance: 0.1,
      rssiBuffer: []
    };

    var tick = function() {
      sim.tickCount++;
      var startTime = performance.now();

      // --- Determine presence transitions ---
      if (sim.tickCount >= sim.nextTransitionTick) {
        var rand = Math.random();
        if (sim.presence === 'absent') {
          sim.presence = rand > 0.3 ? 'present_still' : 'active';
          self._pushSimEvent('enter', sim.presence === 'active' ? 0.85 : 0.75,
            '\uC874\uC7AC \uAC10\uC9C0 (' + self._presenceLabel(sim.presence) + ')');
        } else if (sim.presence === 'present_still') {
          if (rand > 0.6) {
            sim.presence = 'active';
            self._pushSimEvent('motion', 0.8, '\uD65C\uB3D9 \uAC10\uC9C0');
          } else {
            sim.presence = 'absent';
            self._pushSimEvent('exit', 0.7, '\uC774\uD0C8 \uAC10\uC9C0');
          }
        } else {
          // active
          if (rand > 0.5) {
            sim.presence = 'present_still';
            self._pushSimEvent('breathing', 0.65, '\uC815\uC9C0 \uC0C1\uD0DC (\uD638\uD761 \uAC10\uC9C0)');
          } else {
            sim.presence = 'absent';
            self._pushSimEvent('exit', 0.75, '\uC774\uD0C8 \uAC10\uC9C0');
          }
        }
        sim.nextTransitionTick = sim.tickCount + self._randomInt(10, 30);
      }

      // --- Generate RSSI based on presence ---
      var noise = self._gaussianRandom() * 0.3;  // baseline noise

      if (sim.presence === 'absent') {
        sim.currentRssi = sim.baselineRssi + noise;
        sim.variance = 0.05 + Math.random() * 0.2;
        sim.isMoving = false;
      } else if (sim.presence === 'present_still') {
        // Breathing modulation (0.1-0.5 Hz) — subtle RSSI fluctuation
        sim.breathingPhase += 0.25 * (2 * Math.PI) * (self._SIM_TICK_MS / 1000);
        var breathOffset = Math.sin(sim.breathingPhase) * 0.5;
        sim.currentRssi = sim.baselineRssi - 2 + breathOffset + noise * 1.5;
        sim.variance = varianceThreshold + Math.random() * 0.5;
        sim.isMoving = false;
      } else {
        // active — larger RSSI deviations
        sim.motionPhase += 1.5 * (2 * Math.PI) * (self._SIM_TICK_MS / 1000);
        var motionOffset = Math.sin(sim.motionPhase) * 2.5 + self._gaussianRandom() * 1.5;
        sim.currentRssi = sim.baselineRssi - 4 + motionOffset + noise * 2;
        sim.variance = varianceThreshold * 2 + Math.random() * 2;
        sim.isMoving = true;
      }

      // Build RSSI buffer for variance calculation
      sim.rssiBuffer.push(sim.currentRssi);
      if (sim.rssiBuffer.length > 30) sim.rssiBuffer.shift();

      // Calculate actual variance from buffer
      var mean = sim.rssiBuffer.reduce(function(a, b) { return a + b; }, 0) / sim.rssiBuffer.length;
      var sumSqDiff = sim.rssiBuffer.reduce(function(a, val) {
        return a + (val - mean) * (val - mean);
      }, 0);
      var actualVariance = sumSqDiff / sim.rssiBuffer.length;

      // SNR: higher when absent (stable), lower when person present
      var snr = sim.presence === 'absent' ? (20 + Math.random() * 10)
        : sim.presence === 'present_still' ? (10 + Math.random() * 8)
        : (5 + Math.random() * 5);

      // Confidence: derived from variance and presence
      var confidence;
      if (sim.presence === 'absent') {
        confidence = actualVariance < varianceThreshold ? 0.9 + Math.random() * 0.1 : 0.5;
      } else {
        confidence = actualVariance >= varianceThreshold ? 0.7 + Math.random() * 0.25 : 0.4;
      }

      // Spectral analysis simulation
      var breathingPower = sim.presence !== 'absent'
        ? 0.02 + Math.random() * 0.08
        : Math.random() * 0.01;
      var motionPower = sim.isMoving
        ? 0.1 + Math.random() * 0.3
        : Math.random() * 0.02;
      var dominantFreq = sim.isMoving
        ? 0.8 + Math.random() * 1.5
        : sim.presence === 'present_still'
          ? 0.2 + Math.random() * 0.2
          : 0;

      // Motion score
      var motionScore = sim.isMoving ? 0.5 + Math.random() * 0.5 : Math.random() * 0.15;

      var processingTime = performance.now() - startTime;

      // Push update
      self.updateState({
        presence: sim.presence,
        confidence: confidence,
        motionScore: motionScore,
        rssi: {
          current: Math.round(sim.currentRssi * 10) / 10,
          baseline: sim.baselineRssi,
          variance: Math.round(actualVariance * 1000) / 1000,
          snr: Math.round(snr * 10) / 10
        },
        spectral: {
          breathingPower: Math.round(breathingPower * 1000) / 1000,
          motionPower: Math.round(motionPower * 1000) / 1000,
          dominantFreq: Math.round(dominantFreq * 100) / 100,
          changePoints: sim.tickCount === sim.nextTransitionTick ? 1 : 0
        },
        diagnostics: {
          rssiTrend: [Math.round(sim.currentRssi * 10) / 10],
          varianceTrend: [Math.round(actualVariance * 1000) / 1000],
          motionTrend: [Math.round(motionScore * 100) / 100],
          breathingTrend: [Math.round(breathingPower * 1000) / 1000],
          processingTimeMs: Math.round(processingTime * 100) / 100
        }
      });

      self._simTimer = setTimeout(tick, self._SIM_TICK_MS);
    };

    // Kick off first tick after a short delay
    this._simTimer = setTimeout(tick, 500);
  }

  /**
   * Push a simulated event to state
   */
  _pushSimEvent(type, confidence, detail) {
    this.updateState({
      events: [{
        ts: new Date(),
        type: type,
        confidence: confidence,
        detail: detail
      }]
    });
  }

  /**
   * Presence label for display
   */
  _presenceLabel(presence) {
    switch (presence) {
      case 'absent': return '\uBD80\uC7AC';
      case 'present_still': return '\uC815\uC9C0';
      case 'active': return '\uD65C\uB3D9';
      default: return presence;
    }
  }

  // ---------------------------------------------------------------------------
  // Mode switching
  // ---------------------------------------------------------------------------

  switchMode(newMode) {
    console.log('[LocationApp] Switching mode to:', newMode);

    // Stop current data source
    this._stopSimulation();
    this._stopPolling();

    switch (newMode) {
      case 'simulation':
        this.state.source = 'simulated';
        this.state.mode = 'simulation';
        this._startSimulation();
        break;

      case 'rssi-only':
        this.state.source = 'wifi-rssi';
        this.state.mode = 'rssi-only';
        this._startPolling();
        break;

      case 'rssi+csi':
        this.state.source = 'esp32-csi';
        this.state.mode = 'rssi+csi';
        this._startPolling();
        break;

      default:
        console.warn('[LocationApp] Unknown mode:', newMode);
        this.state.source = 'simulated';
        this.state.mode = 'simulation';
        this._startSimulation();
        break;
    }

    this._fullUiUpdate();
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  _startRenderLoop() {
    var self = this;
    var loop = function() {
      if (self.renderer && typeof self.renderer.renderFrame === 'function') {
        self.renderer.renderFrame();
      }
      self._renderRafId = requestAnimationFrame(loop);
    };
    this._renderRafId = requestAnimationFrame(loop);
  }

  _stopRenderLoop() {
    if (this._renderRafId) {
      cancelAnimationFrame(this._renderRafId);
      this._renderRafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  _setStatusText(text) {
    var el = document.getElementById('health-label');
    if (el) el.textContent = text;
  }

  _showRetryButton() {
    var container = document.getElementById('status-banner');
    if (!container) return;
    if (document.getElementById('btn-retry-init')) return;

    var btn = document.createElement('button');
    var self = this;
    btn.id = 'btn-retry-init';
    btn.className = 'btn btn--retry';
    btn.textContent = '\uB2E4\uC2DC \uC2DC\uB3C4';
    btn.addEventListener('click', function() {
      btn.remove();
      self.init();
    });
    container.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // Math helpers
  // ---------------------------------------------------------------------------

  /**
   * Gaussian random number (Box-Muller transform)
   */
  _gaussianRandom() {
    var u1 = Math.random();
    var u2 = Math.random();
    // Avoid log(0)
    while (u1 === 0) u1 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Random integer in [min, max] inclusive
   */
  _randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** HTML-escape to prevent XSS */
  _esc(str) {
    if (typeof str !== 'string') return '';
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return str.replace(/[&<>"']/g, function(c) { return map[c]; });
  }

  // ---------------------------------------------------------------------------
  // Source / Mode labels (for external use)
  // ---------------------------------------------------------------------------

  getSourceLabel(source) {
    var map = {
      'simulated': 'Simulation \uBAA8\uB4DC',
      'wifi-rssi': 'WiFi RSSI \uC2E4\uCE21',
      'esp32-csi': 'ESP32 CSI \uC2E4\uCE21'
    };
    return map[source] || source;
  }

  getModeBadge(mode) {
    switch (mode) {
      case 'simulation':
        return { icon: '\u25C8', label: 'SIM', cls: 'badge--amber' };
      case 'rssi-only':
        return { icon: '\u25C9', label: 'RSSI', cls: 'badge--blue' };
      case 'rssi+csi':
        return { icon: '\u25C9\u25C9', label: 'RSSI+CSI', cls: 'badge--green' };
      default:
        return { icon: '', label: '', cls: '' };
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  destroy() {
    console.log('[LocationApp] Destroying...');

    this._stopSimulation();
    this._stopPolling();
    this._stopRenderLoop();

    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }

    if (this.ws) {
      if (typeof this.ws.disconnect === 'function') {
        this.ws.disconnect();
      } else if (typeof this.ws.dispose === 'function') {
        this.ws.dispose();
      }
      this.ws = null;
    }

    if (this.renderer && typeof this.renderer.destroy === 'function') {
      this.renderer.destroy();
      this.renderer = null;
    }

    this.simulator = null;
    this.trilateration = null;
    this.api = null;
    this.config = null;

    console.log('[LocationApp] Destroyed');
  }
}

// Expose to window
window.LocationApp = LocationApp;

// ---------------------------------------------------------------------------
// Auto-initialize
// ---------------------------------------------------------------------------
if (window.__ruviewConfig) {
  window.app = new LocationApp();
  window.app.init();
} else {
  window.addEventListener('ruview:config-loaded', function() {
    window.app = new LocationApp();
    window.app.init();
  });
}

// Listen for mode changes from UI
window.addEventListener('ruview:mode-change', function(e) {
  if (window.app) {
    var mode = e.detail && e.detail.mode;
    if (mode) {
      window.app.switchMode(mode);
    }
  }
});
