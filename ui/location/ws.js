// Location WebSocket Client for RuView UI
//
// Provides real-time location updates by connecting to RuView's
// pose and event WebSocket streams, transforming incoming data into
// the same LocationViewModel shape used by the REST adapter (api.js).
//
// Also supports the new RSSI-based presence detection model via
// the onPresenceUpdate() callback.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
});

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;

const WS_PRESENCE_TREND_SIZE = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Push a value onto a fixed-length ring buffer stored as a plain array. */
function pushTrend(arr, value, maxLen) {
  arr.push(value);
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}

/**
 * Derive the WS base URL from the current page origin.
 * Uses wss:// when the page is served over HTTPS or on a non-localhost host.
 */
function detectWsBaseUrl() {
  if (typeof window === 'undefined' || !window.location) {
    return 'ws://localhost:3000';
  }
  const isSecure = window.location.protocol === 'https:';
  const isLocalhost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1';
  const protocol = (isSecure || !isLocalhost) ? 'wss://' : 'ws://';
  return `${protocol}${window.location.host}`;
}

// ---------------------------------------------------------------------------
// Presence detection helpers (mirrors logic in api.js)
// ---------------------------------------------------------------------------

function derivePresenceState(variance, motionScore) {
  if (variance < 0.3) return 'absent';
  if (motionScore > 0.15) return 'active';
  return 'present_still';
}

function derivePresenceConfidence(variance, presence) {
  if (presence === 'absent') {
    return clamp(1.0 - (variance / 0.3), 0, 1);
  }
  return clamp((variance - 0.3) / 1.7, 0.1, 1.0);
}

// ---------------------------------------------------------------------------
// Internal per-socket wrapper
// ---------------------------------------------------------------------------

class ManagedSocket {
  /**
   * @param {string} url
   * @param {object} handlers - { onMessage, onOpen, onClose, onError }
   */
  constructor(url, handlers = {}) {
    this.url = url;
    this._handlers = handlers;
    this._ws = null;
    this._state = CONNECTION_STATES.DISCONNECTED;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._heartbeatTimeoutTimer = null;
    this._lastPong = null;
    this._intentionallyClosed = false;
  }

  get state() {
    return this._state;
  }

  /** Open the WebSocket connection. */
  connect() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return; // already active
    }

    this._intentionallyClosed = false;
    this._setState(CONNECTION_STATES.CONNECTING);

    try {
      this._ws = new WebSocket(this.url);
    } catch (err) {
      this._setState(CONNECTION_STATES.ERROR);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._setState(CONNECTION_STATES.CONNECTED);
      this._reconnectAttempt = 0;
      this._startHeartbeat();
      if (this._handlers.onOpen) {
        try { this._handlers.onOpen(); } catch (e) { console.error('[LocationWS] onOpen handler error:', e); }
      }
    };

    this._ws.onmessage = (event) => {
      this._handleRawMessage(event);
    };

    this._ws.onerror = (event) => {
      this._setState(CONNECTION_STATES.ERROR);
      if (this._handlers.onError) {
        try { this._handlers.onError(event); } catch (e) { console.error('[LocationWS] onError handler error:', e); }
      }
    };

    this._ws.onclose = (event) => {
      this._stopHeartbeat();
      const prevState = this._state;
      this._setState(CONNECTION_STATES.DISCONNECTED);
      if (this._handlers.onClose) {
        try { this._handlers.onClose(event); } catch (e) { console.error('[LocationWS] onClose handler error:', e); }
      }
      // Auto-reconnect unless we intentionally closed
      if (!this._intentionallyClosed) {
        this._scheduleReconnect();
      }
    };
  }

  /** Gracefully close the socket. */
  disconnect() {
    this._intentionallyClosed = true;
    this._clearReconnectTimer();
    this._stopHeartbeat();
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, 'Client disconnect');
      }
      this._ws = null;
    }
    this._setState(CONNECTION_STATES.DISCONNECTED);
  }

  // -- Heartbeat ----------------------------------------------------------

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        this._ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        // Set a timeout — if no pong arrives, treat the connection as dead
        this._heartbeatTimeoutTimer = setTimeout(() => {
          console.warn('[LocationWS] Heartbeat timeout, closing socket:', this.url);
          if (this._ws) this._ws.close(4000, 'Heartbeat timeout');
        }, HEARTBEAT_TIMEOUT_MS);
      } catch {
        // send failed — socket is likely dead
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer);
      this._heartbeatTimeoutTimer = null;
    }
  }

  _handlePong() {
    this._lastPong = Date.now();
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer);
      this._heartbeatTimeoutTimer = null;
    }
  }

  // -- Reconnection -------------------------------------------------------

  _scheduleReconnect() {
    this._clearReconnectTimer();
    const delay = Math.min(BACKOFF_MIN_MS * Math.pow(2, this._reconnectAttempt), BACKOFF_MAX_MS);
    console.info(`[LocationWS] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt + 1}):`, this.url);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectAttempt++;
      this.connect();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // -- State --------------------------------------------------------------

  _setState(newState) {
    if (this._state === newState) return;
    this._state = newState;
  }

  // -- Message routing ----------------------------------------------------

  _handleRawMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      // Non-JSON message — ignore
      return;
    }

    // Handle pong internally
    if (data.type === 'pong') {
      this._handlePong();
      return;
    }

    if (this._handlers.onMessage) {
      try {
        this._handlers.onMessage(data);
      } catch (e) {
        console.error('[LocationWS] onMessage handler error:', e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LocationWebSocket class
// ---------------------------------------------------------------------------

class LocationWebSocket {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] - Override auto-detected WS base URL
   */
  constructor(options = {}) {
    this._baseUrl = options.baseUrl || detectWsBaseUrl();

    // Sockets
    this._poseSocket = null;
    this._eventSocket = null;

    // Callbacks
    this._locationCallbacks = [];
    this._eventCallbacks = [];
    this._statusCallbacks = [];
    this._presenceCallbacks = [];

    // Overall connection state (aggregated from both sockets)
    this._state = CONNECTION_STATES.DISCONNECTED;

    // Presence detection state (rolling trends for WS-derived presence)
    this._rssiTrend = [];
    this._varianceTrend = [];
    this._motionTrend = [];
    this._breathingTrend = [];
    this._presenceEvents = [];
    this._prevPresenceState = 'absent';
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Open both pose and event WebSocket connections.
   */
  connect() {
    if (this._poseSocket || this._eventSocket) {
      this.disconnect();
    }

    this._setState(CONNECTION_STATES.CONNECTING);

    const poseUrl = `${this._baseUrl}/ws/stream/pose`;
    const eventUrl = `${this._baseUrl}/ws/stream/events`;

    this._poseSocket = new ManagedSocket(poseUrl, {
      onOpen: () => this._onSocketStatusChange(),
      onClose: () => this._onSocketStatusChange(),
      onError: () => this._onSocketStatusChange(),
      onMessage: (data) => this._handlePoseMessage(data)
    });

    this._eventSocket = new ManagedSocket(eventUrl, {
      onOpen: () => this._onSocketStatusChange(),
      onClose: () => this._onSocketStatusChange(),
      onError: () => this._onSocketStatusChange(),
      onMessage: (data) => this._handleEventMessage(data)
    });

    this._poseSocket.connect();
    this._eventSocket.connect();
  }

  /**
   * Disconnect both sockets.
   */
  disconnect() {
    if (this._poseSocket) {
      this._poseSocket.disconnect();
      this._poseSocket = null;
    }
    if (this._eventSocket) {
      this._eventSocket.disconnect();
      this._eventSocket = null;
    }
    this._setState(CONNECTION_STATES.DISCONNECTED);
  }

  /**
   * Register a callback for location data updates (from the pose stream).
   * The callback receives a partial LocationViewModel-like object.
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onLocationUpdate(callback) {
    this._locationCallbacks.push(callback);
    return () => {
      const idx = this._locationCallbacks.indexOf(callback);
      if (idx !== -1) this._locationCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for RSSI-based presence updates.
   *
   * Every incoming pose WS message is also transformed into the
   * Section 5 presence model and delivered here. The callback receives
   * an object with: { presence, confidence, motionScore, rssi,
   * spectral, events, diagnostics }.
   *
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onPresenceUpdate(callback) {
    this._presenceCallbacks.push(callback);
    return () => {
      const idx = this._presenceCallbacks.indexOf(callback);
      if (idx !== -1) this._presenceCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for event stream messages.
   * The callback receives a normalized event object.
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onEvent(callback) {
    this._eventCallbacks.push(callback);
    return () => {
      const idx = this._eventCallbacks.indexOf(callback);
      if (idx !== -1) this._eventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for overall connection status changes.
   * The callback receives the new state string.
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onStatusChange(callback) {
    this._statusCallbacks.push(callback);
    // Immediately send current state
    try { callback(this._state); } catch { /* ignore */ }
    return () => {
      const idx = this._statusCallbacks.indexOf(callback);
      if (idx !== -1) this._statusCallbacks.splice(idx, 1);
    };
  }

  /**
   * Returns true if at least the pose socket is connected.
   */
  isConnected() {
    return this._state === CONNECTION_STATES.CONNECTED;
  }

  /**
   * Detailed connection info for diagnostics.
   */
  getConnectionInfo() {
    return {
      state: this._state,
      pose: this._poseSocket ? this._poseSocket.state : CONNECTION_STATES.DISCONNECTED,
      events: this._eventSocket ? this._eventSocket.state : CONNECTION_STATES.DISCONNECTED,
      baseUrl: this._baseUrl
    };
  }

  // ------------------------------------------------------------------
  // Internal: message handling
  // ------------------------------------------------------------------

  /**
   * Transform a raw pose WebSocket message into a partial location view model
   * and notify subscribers. Also derives a presence model for presence subscribers.
   */
  _handlePoseMessage(data) {
    // Legacy location update
    const locationUpdate = this._transformPoseToLocation(data);
    for (const cb of this._locationCallbacks) {
      try { cb(locationUpdate); } catch (e) { console.error('[LocationWS] locationUpdate callback error:', e); }
    }

    // Presence update (RSSI-based detection model)
    if (this._presenceCallbacks.length > 0) {
      const presenceUpdate = this._transformPoseToPresence(data);
      for (const cb of this._presenceCallbacks) {
        try { cb(presenceUpdate); } catch (e) { console.error('[LocationWS] presenceUpdate callback error:', e); }
      }
    }
  }

  /**
   * Transform a raw event WebSocket message into a normalized event object
   * and notify subscribers.
   */
  _handleEventMessage(data) {
    const event = this._transformEvent(data);
    for (const cb of this._eventCallbacks) {
      try { cb(event); } catch (e) { console.error('[LocationWS] event callback error:', e); }
    }
  }

  // ------------------------------------------------------------------
  // Internal: data transformation
  // ------------------------------------------------------------------

  /**
   * Convert pose WS data into a LocationViewModel-compatible shape.
   * The WS stream typically sends messages like:
   *   { type: 'pose_data', zone_id, payload: { pose: { persons: [...] }, ... }, timestamp }
   * or:
   *   { type: 'pose_data', data: { persons: [...], zone_summary: {...} }, timestamp }
   */
  _transformPoseToLocation(raw) {
    const payload = raw.payload || raw.data || {};
    const poseBlock = payload.pose || payload;
    const persons = poseBlock.persons || [];
    const zoneSummary = payload.zone_summary || poseBlock.zone_summary || {};
    const timestamp = raw.timestamp || new Date().toISOString();

    // Determine mode / source
    const isMock = payload.metadata?.mock_data === true;
    const rawSource = raw.pose_source || payload.pose_source || payload.metadata?.source || '';
    let source = 'wifi';
    if (isMock || rawSource === 'simulated' || rawSource === 'simulation') {
      source = 'simulated';
    } else if (rawSource === 'esp32') {
      source = 'esp32';
    }

    const mode = source === 'simulated' ? 'simulation' : 'single-node';

    // Build zones from summary or derive from payload
    const zones = [];
    const zoneIds = Object.keys(zoneSummary);
    if (zoneIds.length > 0) {
      for (const id of zoneIds) {
        const count = zoneSummary[id] || 0;
        zones.push({
          id,
          name: `Zone ${id}`,
          occupied: count > 0,
          personCount: count,
          confidence: payload.confidence ?? (poseBlock.metadata?.confidence ?? 0.85),
          lastActivity: timestamp,
          motionLevel: clamp(count * 0.25, 0, 1)
        });
      }
    } else if (raw.zone_id) {
      // Single zone message
      zones.push({
        id: raw.zone_id,
        name: `Zone ${raw.zone_id}`,
        occupied: persons.length > 0,
        personCount: persons.length,
        confidence: payload.confidence ?? 0.85,
        lastActivity: timestamp,
        motionLevel: clamp(persons.length * 0.2, 0, 1)
      });
    } else if (persons.length > 0) {
      zones.push({
        id: 'zone-main',
        name: 'Main Area',
        occupied: true,
        personCount: persons.length,
        confidence: persons.reduce((s, p) => s + (p.confidence ?? 0.8), 0) / persons.length,
        lastActivity: timestamp,
        motionLevel: clamp(persons.length * 0.2, 0, 1)
      });
    }

    const peopleCount = persons.length
      || zones.reduce((s, z) => s + z.personCount, 0);

    return {
      mode,
      connected: true,
      source,
      serverStatus: 'online',
      peopleCount,
      zones,
      nodes: [{
        id: 'node-local',
        name: 'Local Node',
        connected: true,
        signalStrength: 0.95,
        lastSeen: timestamp
      }],
      events: [],  // events come via the separate event stream
      diagnostics: {
        motionTrend: [],
        signalTrend: [],
        avgConfidence: zones.length > 0
          ? zones.reduce((s, z) => s + z.confidence, 0) / zones.length
          : 0,
        processingTimeMs: payload.metadata?.processing_time_ms
          || poseBlock.metadata?.processing_time_ms
          || 0
      },
      _raw: raw  // pass through for advanced consumers
    };
  }

  /**
   * Transform a raw pose WS message into the Section 5 presence model.
   *
   * Extracts RSSI, variance, motion, and spectral data from the stream
   * payload. When explicit signal fields are not present, synthesizes
   * reasonable values from person/motion information so the presence
   * pipeline still produces meaningful output in simulation mode.
   */
  _transformPoseToPresence(raw) {
    const payload = raw.payload || raw.data || {};
    const poseBlock = payload.pose || payload;
    const metadata = payload.metadata || poseBlock.metadata || {};
    const signalData = payload.signal || payload.rssi_data || {};
    const spectralData = payload.spectral || payload.frequency_analysis || {};
    const persons = poseBlock.persons || [];
    const timestamp = raw.timestamp || new Date().toISOString();

    // --- Mode / source ---
    const isMock = metadata.mock_data === true;
    const rawSource = raw.pose_source || payload.pose_source || metadata.source || '';
    let source = 'wifi-rssi';
    let mode = 'rssi-only';
    if (isMock || rawSource === 'simulated' || rawSource === 'simulation') {
      source = 'simulated';
      mode = 'simulation';
    } else if (rawSource === 'esp32' || rawSource === 'esp32-csi') {
      source = 'esp32-csi';
      mode = 'rssi+csi';
    }

    // --- Extract RSSI metrics ---
    const rssiCurrent = signalData.rssi
      ?? signalData.current
      ?? metadata.rssi
      ?? -42 + (Math.random() - 0.5) * 4;

    const rssiBaseline = signalData.baseline
      ?? signalData.rssi_baseline
      ?? metadata.rssi_baseline
      ?? -42;

    const rssiVariance = signalData.variance
      ?? signalData.rssi_variance
      ?? metadata.rssi_variance
      ?? this._estimateWsVariance(rssiCurrent);

    const rssiSnr = signalData.snr
      ?? signalData.rssi_snr
      ?? metadata.snr
      ?? Math.max(0, 30 + rssiCurrent / 2);

    // --- Extract spectral metrics ---
    const breathingPower = spectralData.breathing_power
      ?? spectralData.breathingPower
      ?? metadata.breathing_power
      ?? 0;

    const motionPower = spectralData.motion_power
      ?? spectralData.motionPower
      ?? metadata.motion_power
      ?? 0;

    const dominantFreq = spectralData.dominant_freq
      ?? spectralData.dominantFreq
      ?? metadata.dominant_freq
      ?? 0;

    const changePoints = spectralData.change_points
      ?? spectralData.changePoints
      ?? metadata.change_points
      ?? 0;

    // --- Motion score ---
    let motionScore = 0;
    if (persons.length > 0) {
      motionScore = clamp(persons.length * 0.2 + motionPower * 0.5, 0, 1);
    } else if (motionPower > 0) {
      motionScore = clamp(motionPower, 0, 1);
    } else {
      motionScore = clamp((rssiVariance - 0.3) / 3.0, 0, 1);
    }

    // --- Presence state ---
    const presence = derivePresenceState(rssiVariance, motionScore);
    const confidence = derivePresenceConfidence(rssiVariance, presence);

    // --- Update rolling trends ---
    pushTrend(this._rssiTrend, rssiCurrent, WS_PRESENCE_TREND_SIZE);
    pushTrend(this._varianceTrend, rssiVariance, WS_PRESENCE_TREND_SIZE);
    pushTrend(this._motionTrend, motionScore, WS_PRESENCE_TREND_SIZE);
    pushTrend(this._breathingTrend, breathingPower, WS_PRESENCE_TREND_SIZE);

    // --- State transition events ---
    if (presence !== this._prevPresenceState) {
      const now = new Date().toISOString();
      let eventType = 'motion';
      if (this._prevPresenceState === 'absent' && presence !== 'absent') {
        eventType = 'enter';
      } else if (presence === 'absent' && this._prevPresenceState !== 'absent') {
        eventType = 'exit';
      } else if (presence === 'active') {
        eventType = 'motion';
      } else if (presence === 'present_still' && breathingPower > 0.02) {
        eventType = 'breathing';
      }

      this._presenceEvents.push({
        ts: now,
        type: eventType,
        confidence,
        detail: `${this._prevPresenceState} -> ${presence} (var=${rssiVariance.toFixed(2)}, motion=${motionScore.toFixed(2)})`
      });

      // Keep last 50 events
      if (this._presenceEvents.length > 50) {
        this._presenceEvents.splice(0, this._presenceEvents.length - 50);
      }

      this._prevPresenceState = presence;
    }

    // --- Processing time ---
    const processingTimeMs = metadata.processing_time_ms
      || poseBlock.metadata?.processing_time_ms
      || 0;

    return {
      mode,
      source,
      connected: true,

      presence,
      confidence,
      motionScore,

      rssi: {
        current: Math.round(rssiCurrent * 100) / 100,
        baseline: rssiBaseline,
        variance: Math.round(rssiVariance * 1000) / 1000,
        snr: Math.round(rssiSnr * 10) / 10
      },

      spectral: {
        breathingPower: Math.round(breathingPower * 10000) / 10000,
        motionPower: Math.round(motionPower * 10000) / 10000,
        dominantFreq: Math.round(dominantFreq * 100) / 100,
        changePoints
      },

      events: [...this._presenceEvents],

      diagnostics: {
        rssiTrend: [...this._rssiTrend],
        varianceTrend: [...this._varianceTrend],
        motionTrend: [...this._motionTrend],
        breathingTrend: [...this._breathingTrend],
        processingTimeMs
      }
    };
  }

  /**
   * Normalize an event stream message into the standard event shape.
   */
  _transformEvent(raw) {
    const payload = raw.payload || raw.data || raw;
    const detail = payload.description || payload.activity || payload.message || raw.type || '';
    const lowerDetail = detail.toLowerCase();

    let type = 'movement';
    if (lowerDetail.includes('enter') || lowerDetail.includes('appear')) {
      type = 'enter';
    } else if (lowerDetail.includes('exit') || lowerDetail.includes('disappear') || lowerDetail.includes('leave')) {
      type = 'exit';
    } else if (lowerDetail.includes('alert') || lowerDetail.includes('fall') || lowerDetail.includes('alarm')) {
      type = 'alert';
    }

    return {
      timestamp: raw.timestamp || payload.timestamp || new Date().toISOString(),
      type,
      zoneId: payload.zone_id || payload.zoneId || raw.zone_id || '',
      zoneName: payload.zone_name || payload.zoneName || `Zone ${payload.zone_id || raw.zone_id || '?'}`,
      detail
    };
  }

  // ------------------------------------------------------------------
  // Internal: RSSI variance estimation for WS stream
  // ------------------------------------------------------------------

  /**
   * Estimate RSSI variance from the rolling trend when the server
   * does not provide an explicit value.
   */
  _estimateWsVariance(currentRssi) {
    const samples = [...this._rssiTrend, currentRssi];
    if (samples.length < 3) return 0.1;

    const window = samples.slice(-15);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    return variance;
  }

  // ------------------------------------------------------------------
  // Internal: connection state aggregation
  // ------------------------------------------------------------------

  _onSocketStatusChange() {
    const poseState = this._poseSocket ? this._poseSocket.state : CONNECTION_STATES.DISCONNECTED;
    const eventState = this._eventSocket ? this._eventSocket.state : CONNECTION_STATES.DISCONNECTED;

    let newState;
    if (poseState === CONNECTION_STATES.CONNECTED || eventState === CONNECTION_STATES.CONNECTED) {
      // At least one socket connected — report connected
      newState = CONNECTION_STATES.CONNECTED;
    } else if (poseState === CONNECTION_STATES.CONNECTING || eventState === CONNECTION_STATES.CONNECTING) {
      newState = CONNECTION_STATES.CONNECTING;
    } else if (poseState === CONNECTION_STATES.ERROR || eventState === CONNECTION_STATES.ERROR) {
      newState = CONNECTION_STATES.ERROR;
    } else {
      newState = CONNECTION_STATES.DISCONNECTED;
    }

    this._setState(newState);
  }

  _setState(newState) {
    if (this._state === newState) return;
    const prevState = this._state;
    this._state = newState;
    for (const cb of this._statusCallbacks) {
      try { cb(newState, prevState); } catch (e) { console.error('[LocationWS] statusChange callback error:', e); }
    }
  }
}

// Expose connection state constants for consumers
LocationWebSocket.STATES = CONNECTION_STATES;

// Expose to window for non-module script loading
window.LocationWebSocket = LocationWebSocket;
