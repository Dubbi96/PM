// Location API Adapter for RuView UI
//
// Normalizes RuView's pose-centric REST API into a location-oriented
// view model suitable for the location dashboard.
//
// Supports both the legacy zone-based model and the new RSSI-based
// presence detection model (Section 5 of RSSI-MESH-DETECTION-PLAN).
//
// Depends on: window.API_CONFIG (from config/api.config.js loaded before this file)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTION_TREND_SIZE = 60;
const SIGNAL_TREND_SIZE = 60;
const PRESENCE_TREND_SIZE = 60;

/** Safe JSON fetch with timeout. Returns parsed body or throws. */
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 8000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Clamp a number between min and max. */
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

// ---------------------------------------------------------------------------
// Presence detection helpers
// ---------------------------------------------------------------------------

/** Default disconnected presence state — returned when server is unreachable. */
function defaultDisconnectedPresence() {
  return {
    mode: 'simulation',
    source: 'simulated',
    connected: false,
    presence: 'absent',
    confidence: 0.0,
    motionScore: 0.0,
    rssi: { current: 0, baseline: 0, variance: 0, snr: 0 },
    spectral: { breathingPower: 0, motionPower: 0, dominantFreq: 0, changePoints: 0 },
    events: [],
    diagnostics: {
      rssiTrend: [],
      varianceTrend: [],
      motionTrend: [],
      breathingTrend: [],
      processingTimeMs: 0
    }
  };
}

/**
 * Derive presence state from RSSI variance and motion score.
 * Thresholds from Section 1-1 of the RSSI Mesh Detection plan:
 *   - variance < 0.3 dBm^2  => absent
 *   - variance >= 0.5 dBm^2 => present
 *   - motionScore > 0.15    => active (if present)
 */
function derivePresenceState(variance, motionScore) {
  if (variance < 0.3) return 'absent';
  if (motionScore > 0.15) return 'active';
  return 'present_still';
}

/**
 * Derive confidence from variance relative to threshold band [0.3, 2.0].
 * Returns 0..1. Below 0.3 => low confidence in presence, above 2.0 => high.
 */
function derivePresenceConfidence(variance, presence) {
  if (presence === 'absent') {
    // Confidence that nobody is there — higher when variance is very low
    return clamp(1.0 - (variance / 0.3), 0, 1);
  }
  // Confidence that someone IS there — scales with variance
  return clamp((variance - 0.3) / 1.7, 0.1, 1.0);
}

// ---------------------------------------------------------------------------
// Simulation helpers — produce plausible location data from pose responses
// ---------------------------------------------------------------------------

function generateSimulatedZones(poseData) {
  const zones = [];
  const persons = poseData?.persons || [];
  const zoneSummary = poseData?.zone_summary || {};

  // If the backend gave us a zone summary, use it
  const zoneIds = Object.keys(zoneSummary);
  if (zoneIds.length > 0) {
    for (const id of zoneIds) {
      const count = zoneSummary[id] || 0;
      zones.push({
        id,
        name: `Zone ${id}`,
        occupied: count > 0,
        personCount: count,
        confidence: poseData?.metadata?.confidence ?? 0.85,
        lastActivity: poseData?.timestamp || new Date().toISOString(),
        motionLevel: clamp(count * 0.25 + Math.random() * 0.1, 0, 1)
      });
    }
    return zones;
  }

  // Fallback: derive synthetic zones from person data
  if (persons.length > 0) {
    const syntheticId = 'zone-main';
    zones.push({
      id: syntheticId,
      name: 'Main Area',
      occupied: true,
      personCount: persons.length,
      confidence: persons.reduce((sum, p) => sum + (p.confidence ?? 0.8), 0) / persons.length,
      lastActivity: poseData?.timestamp || new Date().toISOString(),
      motionLevel: clamp(persons.length * 0.2 + Math.random() * 0.1, 0, 1)
    });
  }

  return zones;
}

function generateSimulatedNodes() {
  // In simulation / single-node mode there is exactly one logical node
  return [
    {
      id: 'node-local',
      name: 'Local Node',
      connected: true,
      signalStrength: 0.9 + Math.random() * 0.1,
      lastSeen: new Date().toISOString()
    }
  ];
}

function mapActivitiesToEvents(activities) {
  if (!Array.isArray(activities)) return [];

  return activities.map(a => {
    let type = 'movement';
    const detail = a.description || a.activity || a.type || '';
    const lowerDetail = detail.toLowerCase();

    if (lowerDetail.includes('enter') || lowerDetail.includes('appear')) {
      type = 'enter';
    } else if (lowerDetail.includes('exit') || lowerDetail.includes('disappear') || lowerDetail.includes('leave')) {
      type = 'exit';
    } else if (lowerDetail.includes('alert') || lowerDetail.includes('fall') || lowerDetail.includes('alarm')) {
      type = 'alert';
    }

    return {
      timestamp: a.timestamp || new Date().toISOString(),
      type,
      zoneId: a.zone_id || a.zoneId || '',
      zoneName: a.zone_name || a.zoneName || `Zone ${a.zone_id || '?'}`,
      detail
    };
  });
}

// ---------------------------------------------------------------------------
// LocationAPI class
// ---------------------------------------------------------------------------

class LocationAPI {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] - Override auto-detected base URL
   * @param {number} [options.timeout] - Request timeout in ms (default 8000)
   */
  constructor(options = {}) {
    this._baseUrl = options.baseUrl || this._detectBaseUrl();
    this._timeout = options.timeout || 8000;

    // Polling state (legacy location polling)
    this._pollTimer = null;
    this._pollIntervalMs = null;
    this._pollCallback = null;

    // Presence polling state
    this._presencePollTimer = null;
    this._presencePollIntervalMs = null;
    this._presencePollCallback = null;

    // Trend buffers (kept across polls to build sparklines)
    this._motionTrend = [];
    this._signalTrend = [];

    // Presence-specific trend buffers (rolling 60 samples each)
    this._rssiTrend = [];
    this._varianceTrend = [];
    this._presenceMotionTrend = [];
    this._breathingTrend = [];

    // Presence events ring buffer (keep last 50 events)
    this._presenceEvents = [];
    this._prevPresenceState = 'absent';

    // Cached last-known view models
    this._lastViewModel = null;
    this._lastPresenceModel = null;
  }

  // ------------------------------------------------------------------
  // Public methods
  // ------------------------------------------------------------------

  /**
   * Health check — returns the raw health response.
   * Gracefully returns a degraded status object on failure.
   */
  async getHealth() {
    try {
      var cfg = window.API_CONFIG || {};
      var endpoints = (cfg.ENDPOINTS && cfg.ENDPOINTS.HEALTH) || {};
      var endpoint = endpoints.SYSTEM || '/health/health';
      const url = this._url(endpoint);
      return await safeFetch(url, { timeout: this._timeout });
    } catch (err) {
      return { status: 'offline', error: err.message, timestamp: new Date().toISOString() };
    }
  }

  /** Alias for getHealth — used by app.js */
  async health() {
    return this.getHealth();
  }

  /**
   * Build the full LocationViewModel by combining multiple API calls.
   * On partial failure, fills in the missing sections with sensible defaults
   * so the UI always gets a complete object.
   */
  async getLocationData() {
    const startTime = performance.now();

    // Fire all requests in parallel; use null sentinels for failures
    var cfg = (window.API_CONFIG || {}).ENDPOINTS || {};
    var healthEp = (cfg.HEALTH || {}).SYSTEM || '/health/health';
    var poseCurrent = (cfg.POSE || {}).CURRENT || '/api/v1/pose/current';
    var poseZones = (cfg.POSE || {}).ZONES_SUMMARY || '/api/v1/pose/zones/summary';
    var poseActivities = (cfg.POSE || {}).ACTIVITIES || '/api/v1/pose/activities';
    var statusEp = cfg.STATUS || '/api/v1/status';
    var streamStatusEp = (cfg.STREAM || {}).STATUS || '/api/v1/stream/status';

    const [health, poseData, zonesSummary, activities, apiStatus, streamStatus] = await Promise.all([
      this._safeGet(healthEp),
      this._safeGet(poseCurrent),
      this._safeGet(poseZones),
      this._safeGet(poseActivities),
      this._safeGet(statusEp),
      this._safeGet(streamStatusEp)
    ]);

    const processingTimeMs = Math.round(performance.now() - startTime);

    // --- Derive server status ---
    let serverStatus = 'offline';
    if (health && health.status === 'healthy') {
      serverStatus = 'online';
    } else if (health && health.status) {
      // Backend responded but not fully healthy
      serverStatus = 'degraded';
    } else if (poseData || apiStatus) {
      // Some endpoints are reachable
      serverStatus = 'degraded';
    }

    // --- Derive mode & source ---
    const isMock = poseData?.metadata?.mock_data === true;
    const rawSource = poseData?.metadata?.source
      || poseData?.pose_source
      || streamStatus?.source
      || (isMock ? 'simulated' : 'wifi');

    let source = 'wifi';
    if (rawSource === 'simulated' || rawSource === 'simulation' || isMock) {
      source = 'simulated';
    } else if (rawSource === 'esp32') {
      source = 'esp32';
    }

    const multiNode = (streamStatus?.nodes && streamStatus.nodes.length > 1);
    let mode = 'single-node';
    if (source === 'simulated') {
      mode = 'simulation';
    } else if (multiNode) {
      mode = 'multi-node';
    }

    // --- Zones ---
    let zones = [];
    if (zonesSummary && Array.isArray(zonesSummary.zones)) {
      zones = zonesSummary.zones.map(z => ({
        id: z.zone_id || z.id || '',
        name: z.zone_name || z.name || `Zone ${z.zone_id || z.id || '?'}`,
        occupied: (z.person_count || z.personCount || 0) > 0,
        personCount: z.person_count || z.personCount || 0,
        confidence: z.confidence ?? 0,
        lastActivity: z.last_activity || z.lastActivity || z.timestamp || new Date().toISOString(),
        motionLevel: clamp(z.motion_level ?? z.motionLevel ?? 0, 0, 1)
      }));
    } else if (poseData) {
      zones = generateSimulatedZones(poseData);
    }

    // --- People count ---
    const peopleCount = poseData?.persons?.length
      ?? zones.reduce((sum, z) => sum + z.personCount, 0);

    // --- Nodes ---
    let nodes = [];
    if (streamStatus?.nodes && Array.isArray(streamStatus.nodes)) {
      nodes = streamStatus.nodes.map(n => ({
        id: n.id || n.node_id || '',
        name: n.name || n.node_name || `Node ${n.id || '?'}`,
        connected: n.connected ?? n.status === 'connected',
        signalStrength: n.signal_strength ?? n.signalStrength ?? 0,
        lastSeen: n.last_seen || n.lastSeen || new Date().toISOString()
      }));
    } else {
      nodes = generateSimulatedNodes();
    }

    // --- Events ---
    const events = mapActivitiesToEvents(
      activities?.activities || activities?.events || (Array.isArray(activities) ? activities : [])
    );

    // --- Diagnostics / trends ---
    const avgMotion = zones.length > 0
      ? zones.reduce((s, z) => s + z.motionLevel, 0) / zones.length
      : 0;
    pushTrend(this._motionTrend, avgMotion, MOTION_TREND_SIZE);

    const avgSignal = nodes.length > 0
      ? nodes.reduce((s, n) => s + n.signalStrength, 0) / nodes.length
      : 0;
    pushTrend(this._signalTrend, avgSignal, SIGNAL_TREND_SIZE);

    const avgConfidence = zones.length > 0
      ? zones.reduce((s, z) => s + z.confidence, 0) / zones.length
      : 0;

    const diagnostics = {
      motionTrend: [...this._motionTrend],
      signalTrend: [...this._signalTrend],
      avgConfidence,
      processingTimeMs
    };

    // --- Assemble view model ---
    const viewModel = {
      mode,
      connected: serverStatus !== 'offline',
      source,
      serverStatus,
      peopleCount,
      zones,
      nodes,
      events,
      diagnostics
    };

    this._lastViewModel = viewModel;
    return viewModel;
  }

  /**
   * Get presence data using the RSSI-based detection model.
   *
   * Calls the existing pose and health endpoints, then transforms
   * the responses into the Section 5 presence state model:
   *   { presence, confidence, motionScore, rssi, spectral, events, diagnostics }
   *
   * On failure, returns a default "disconnected" state so the UI
   * always receives a complete object.
   */
  async getPresenceData() {
    const startTime = performance.now();

    var cfg = (window.API_CONFIG || {}).ENDPOINTS || {};
    var healthEp = (cfg.HEALTH || {}).SYSTEM || '/health/health';
    var poseCurrent = (cfg.POSE || {}).CURRENT || '/api/v1/pose/current';

    const [health, poseData] = await Promise.all([
      this._safeGet(healthEp),
      this._safeGet(poseCurrent)
    ]);

    const processingTimeMs = Math.round(performance.now() - startTime);

    // --- Fallback: server unreachable ---
    if (!health && !poseData) {
      const disconnected = defaultDisconnectedPresence();
      disconnected.diagnostics.processingTimeMs = processingTimeMs;
      this._lastPresenceModel = disconnected;
      return disconnected;
    }

    // --- Connection status ---
    const connected = !!(health && (health.status === 'healthy' || health.status));

    // --- Derive mode & source ---
    const isMock = poseData?.metadata?.mock_data === true;
    const rawSource = poseData?.metadata?.source
      || poseData?.pose_source
      || (isMock ? 'simulated' : 'wifi-rssi');

    let source = 'wifi-rssi';
    let mode = 'rssi-only';
    if (rawSource === 'simulated' || rawSource === 'simulation' || isMock) {
      source = 'simulated';
      mode = 'simulation';
    } else if (rawSource === 'esp32' || rawSource === 'esp32-csi') {
      source = 'esp32-csi';
      mode = 'rssi+csi';
    }

    // --- Extract RSSI metrics from pose data ---
    // The backend may provide rssi/signal data in various places.
    // We look for explicit fields first, then synthesize from available info.
    const metadata = poseData?.metadata || {};
    const signalData = poseData?.signal || poseData?.rssi_data || {};
    const spectralData = poseData?.spectral || poseData?.frequency_analysis || {};

    const rssiCurrent = signalData.rssi
      ?? signalData.current
      ?? metadata.rssi
      ?? (poseData ? -42 + (Math.random() - 0.5) * 4 : 0);

    const rssiBaseline = signalData.baseline
      ?? signalData.rssi_baseline
      ?? metadata.rssi_baseline
      ?? -42;

    const rssiVariance = signalData.variance
      ?? signalData.rssi_variance
      ?? metadata.rssi_variance
      ?? this._estimateVariance(rssiCurrent);

    const rssiSnr = signalData.snr
      ?? signalData.rssi_snr
      ?? metadata.snr
      ?? Math.max(0, 30 + rssiCurrent / 2);

    // --- Extract spectral / motion metrics ---
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

    // --- Derive motion score from available data ---
    // Use persons / motion level if available, otherwise derive from spectral
    const persons = poseData?.persons || [];
    let motionScore = 0;
    if (persons.length > 0) {
      // Person data available — derive motion from person count and activity
      motionScore = clamp(persons.length * 0.2 + motionPower * 0.5, 0, 1);
    } else if (motionPower > 0) {
      motionScore = clamp(motionPower, 0, 1);
    } else {
      // Derive from RSSI variance as a proxy
      motionScore = clamp((rssiVariance - 0.3) / 3.0, 0, 1);
    }

    // --- Determine presence state ---
    const presence = derivePresenceState(rssiVariance, motionScore);
    const confidence = derivePresenceConfidence(rssiVariance, presence);

    // --- Update rolling trend buffers ---
    pushTrend(this._rssiTrend, rssiCurrent, PRESENCE_TREND_SIZE);
    pushTrend(this._varianceTrend, rssiVariance, PRESENCE_TREND_SIZE);
    pushTrend(this._presenceMotionTrend, motionScore, PRESENCE_TREND_SIZE);
    pushTrend(this._breathingTrend, breathingPower, PRESENCE_TREND_SIZE);

    // --- Generate events from state transitions ---
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

      // Keep only last 50 events
      if (this._presenceEvents.length > 50) {
        this._presenceEvents.splice(0, this._presenceEvents.length - 50);
      }

      this._prevPresenceState = presence;
    }

    // --- Assemble presence model (Section 5 format) ---
    const presenceModel = {
      mode,
      source,
      connected,

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
        motionTrend: [...this._presenceMotionTrend],
        breathingTrend: [...this._breathingTrend],
        processingTimeMs
      }
    };

    this._lastPresenceModel = presenceModel;
    return presenceModel;
  }

  /**
   * Lightweight zone-only fetch.
   */
  async getZoneSummary() {
    try {
      var cfg = (window.API_CONFIG || {}).ENDPOINTS || {};
      var endpoint = (cfg.POSE || {}).ZONES_SUMMARY || '/api/v1/pose/zones/summary';
      const url = this._url(endpoint);
      const raw = await safeFetch(url, { timeout: this._timeout });
      const zones = (raw?.zones || []).map(z => ({
        id: z.zone_id || z.id || '',
        name: z.zone_name || z.name || `Zone ${z.zone_id || z.id || '?'}`,
        occupied: (z.person_count || z.personCount || 0) > 0,
        personCount: z.person_count || z.personCount || 0,
        confidence: z.confidence ?? 0,
        lastActivity: z.last_activity || z.lastActivity || new Date().toISOString(),
        motionLevel: clamp(z.motion_level ?? z.motionLevel ?? 0, 0, 1)
      }));
      return zones;
    } catch (err) {
      console.warn('[LocationAPI] getZoneSummary failed:', err.message);
      return [];
    }
  }

  /**
   * Fetch recent events/activities.
   * @param {number} [limit=20]
   */
  async getEvents(limit = 20) {
    try {
      var cfg = (window.API_CONFIG || {}).ENDPOINTS || {};
      var endpoint = (cfg.POSE || {}).ACTIVITIES || '/api/v1/pose/activities';
      const url = this._url(endpoint) + `?limit=${limit}`;
      const raw = await safeFetch(url, { timeout: this._timeout });
      return mapActivitiesToEvents(
        raw?.activities || raw?.events || (Array.isArray(raw) ? raw : [])
      );
    } catch (err) {
      console.warn('[LocationAPI] getEvents failed:', err.message);
      return [];
    }
  }

  /**
   * Start periodic polling of the full location view model.
   * @param {number} intervalMs - Polling interval in milliseconds
   * @param {function} callback - Called with (viewModel, error) on each tick
   */
  startPolling(intervalMs, callback) {
    if (this._pollTimer) {
      this.stopPolling();
    }

    this._pollIntervalMs = intervalMs;
    this._pollCallback = callback;

    // Immediate first poll
    this._poll();

    this._pollTimer = setInterval(() => this._poll(), intervalMs);
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollIntervalMs = null;
    this._pollCallback = null;
  }

  /**
   * Start periodic polling of the RSSI-based presence model.
   * @param {number} intervalMs - Polling interval in milliseconds
   * @param {function} callback - Called with (presenceModel, error) on each tick
   */
  startPresencePolling(intervalMs, callback) {
    if (this._presencePollTimer) {
      this.stopPresencePolling();
    }

    this._presencePollIntervalMs = intervalMs;
    this._presencePollCallback = callback;

    // Immediate first poll
    this._presencePoll();

    this._presencePollTimer = setInterval(() => this._presencePoll(), intervalMs);
  }

  /**
   * Stop presence polling.
   */
  stopPresencePolling() {
    if (this._presencePollTimer) {
      clearInterval(this._presencePollTimer);
      this._presencePollTimer = null;
    }
    this._presencePollIntervalMs = null;
    this._presencePollCallback = null;
  }

  /**
   * Return the last cached view model (or null if none fetched yet).
   */
  getLastViewModel() {
    return this._lastViewModel;
  }

  /**
   * Return the last cached presence model (or null if none fetched yet).
   */
  getLastPresenceModel() {
    return this._lastPresenceModel;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /** Auto-detect the backend base URL from the page origin. */
  _detectBaseUrl() {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin;
    }
    return 'http://localhost:3000';
  }

  /** Build a full URL for the given endpoint path. */
  _url(endpoint) {
    return `${this._baseUrl}${endpoint}`;
  }

  /** Fetch an endpoint, returning null on any error instead of throwing. */
  async _safeGet(endpoint) {
    try {
      return await safeFetch(this._url(endpoint), { timeout: this._timeout });
    } catch {
      return null;
    }
  }

  /** Execute a single poll tick (legacy location model). */
  async _poll() {
    if (!this._pollCallback) return;
    try {
      const viewModel = await this.getLocationData();
      this._pollCallback(viewModel, null);
    } catch (err) {
      console.error('[LocationAPI] Poll error:', err);
      this._pollCallback(this._lastViewModel, err);
    }
  }

  /** Execute a single presence poll tick. */
  async _presencePoll() {
    if (!this._presencePollCallback) return;
    try {
      const presenceModel = await this.getPresenceData();
      this._presencePollCallback(presenceModel, null);
    } catch (err) {
      console.error('[LocationAPI] Presence poll error:', err);
      // On error, return the disconnected default so UI stays consistent
      const fallback = this._lastPresenceModel || defaultDisconnectedPresence();
      this._presencePollCallback(fallback, err);
    }
  }

  /**
   * Estimate RSSI variance from the rolling RSSI trend buffer.
   * Used when the server does not provide an explicit variance value.
   * If we have fewer than 3 samples, return a low default.
   */
  _estimateVariance(currentRssi) {
    // Include the current sample in the calculation
    const samples = [...this._rssiTrend, currentRssi];
    if (samples.length < 3) return 0.1;

    // Use last 15 samples (approx windowSeconds=15 at 1Hz polling)
    const window = samples.slice(-15);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    return variance;
  }
}

// Alias: app.js calls getLocationState()
LocationAPI.prototype.getLocationState = LocationAPI.prototype.getLocationData;

// Expose to window for non-module script loading
window.LocationAPI = LocationAPI;
