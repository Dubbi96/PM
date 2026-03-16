#!/usr/bin/env python3
"""
PM (Pochak Manager) - Observer Server
Multi-PC RSSI Fusion Engine

Standalone HTTP server (Python stdlib only) that:
  - Serves the dashboard UI (static files)
  - Accepts observer scan data via REST API
  - Runs RSSI fusion in-memory
  - Requires zero external dependencies

Usage:
  python3 observer-server.py [--port 8080] [--ui-dir ../ui] [--auto-calibrate] [--verbose]
"""

import argparse
import json
import mimetypes
import os
import statistics
import sys
import threading
import time
import urllib.parse
from collections import deque
from http.server import HTTPServer, BaseHTTPRequestHandler

# ---------------------------------------------------------------------------
# Domain model
# ---------------------------------------------------------------------------

RING_BUFFER_SIZE = 300        # ~60s at 5 Hz
CALIBRATION_DURATION = 30     # seconds
DELTA_THRESHOLD = 2.0         # dBm
VARIANCE_THRESHOLD = 0.5      # dBm^2
OBSERVER_TIMEOUT = 10.0       # seconds before marking offline
RECENT_WINDOW = 5             # samples for current mean
VARIANCE_WINDOW = 30          # samples for rolling variance


class ObserverState:
    """Per-observer in-memory state."""

    def __init__(self, observer_id: str):
        self.id: str = observer_id
        self.platform: str = ""
        self.last_seen: float = 0.0          # epoch seconds
        self.scan_count: int = 0
        self.rssi_buffer: dict[str, deque] = {}   # bssid -> deque(maxlen)
        self.latest_rssi: dict[str, float] = {}    # bssid -> last rssi
        self.baseline: dict[str, float] = {}       # bssid -> mean after calibration
        self.delta: dict[str, float] = {}           # bssid -> current - baseline
        self.variance: dict[str, float] = {}        # bssid -> rolling var

    @property
    def connected(self) -> bool:
        return (time.time() - self.last_seen) < OBSERVER_TIMEOUT

    # -- ingestion -----------------------------------------------------------

    def ingest(self, scan: dict) -> None:
        self.platform = scan.get("platform", self.platform)
        self.last_seen = time.time()
        self.scan_count += 1

        for ap in scan.get("aps", []):
            bssid = ap.get("bssid", "").upper()
            rssi = ap.get("rssi_dbm")
            if bssid and rssi is not None:
                if bssid not in self.rssi_buffer:
                    self.rssi_buffer[bssid] = deque(maxlen=RING_BUFFER_SIZE)
                self.rssi_buffer[bssid].append(float(rssi))
                self.latest_rssi[bssid] = float(rssi)

        self._recompute()

    # -- derived metrics ------------------------------------------------------

    def _recompute(self) -> None:
        for bssid, buf in self.rssi_buffer.items():
            if len(buf) == 0:
                continue
            recent = list(buf)[-RECENT_WINDOW:]
            current_mean = statistics.mean(recent)
            bl = self.baseline.get(bssid)
            if bl is not None:
                self.delta[bssid] = current_mean - bl
            else:
                self.delta[bssid] = 0.0
            var_samples = list(buf)[-VARIANCE_WINDOW:]
            if len(var_samples) >= 2:
                self.variance[bssid] = statistics.variance(var_samples)
            else:
                self.variance[bssid] = 0.0

    def is_disturbed(self) -> bool:
        for bssid in self.delta:
            if abs(self.delta.get(bssid, 0)) > DELTA_THRESHOLD:
                return True
            if self.variance.get(bssid, 0) > VARIANCE_THRESHOLD:
                return True
        return False

    def aggregate_delta(self) -> float:
        """Mean absolute delta across all tracked BSSIDs."""
        vals = [abs(d) for d in self.delta.values() if d != 0]
        return statistics.mean(vals) if vals else 0.0

    def aggregate_variance(self) -> float:
        vals = list(self.variance.values())
        return statistics.mean(vals) if vals else 0.0

    def primary_rssi(self) -> float | None:
        """Return the RSSI of the strongest (primary) AP for summary display."""
        if not self.latest_rssi:
            return None
        return max(self.latest_rssi.values())

    def primary_delta(self) -> float:
        if not self.delta:
            return 0.0
        # Use the AP with the largest absolute delta
        return max(self.delta.values(), key=abs, default=0.0)

    def rssi_trend(self) -> str:
        """Determine if RSSI is rising, falling, or stable across tracked APs.

        Compares the mean of the first half of recent samples to the second half
        in the ring buffer for the primary (strongest) AP.  Returns one of:
        ``"rising"``, ``"falling"``, or ``"stable"``.
        """
        if not self.rssi_buffer:
            return "stable"

        # Pick the AP with the largest absolute delta (same as primary_delta)
        primary_bssid = None
        best_abs = 0.0
        for bssid, d in self.delta.items():
            if abs(d) > best_abs:
                best_abs = abs(d)
                primary_bssid = bssid

        if primary_bssid is None:
            # Fallback: use the AP with the most samples
            primary_bssid = max(self.rssi_buffer, key=lambda b: len(self.rssi_buffer[b]))

        buf = self.rssi_buffer.get(primary_bssid)
        if buf is None or len(buf) < 4:
            return "stable"

        recent = list(buf)[-VARIANCE_WINDOW:]
        mid = len(recent) // 2
        first_half = recent[:mid]
        second_half = recent[mid:]

        mean_first = statistics.mean(first_half)
        mean_second = statistics.mean(second_half)
        diff = mean_second - mean_first

        if diff > 1.0:
            return "rising"
        elif diff < -1.0:
            return "falling"
        return "stable"

    def to_status_dict(self) -> dict:
        return {
            "id": self.id,
            "platform": self.platform,
            "connected": self.connected,
            "last_seen_ms": int(self.last_seen * 1000),
            "scan_count": self.scan_count,
            "latest_rssi": dict(self.latest_rssi),
            "baseline_rssi": dict(self.baseline),
            "delta": {k: round(v, 2) for k, v in self.delta.items()},
            "trend": self.rssi_trend(),
        }


# ---------------------------------------------------------------------------
# Fusion engine
# ---------------------------------------------------------------------------

class FusionEngine:
    """Stateless inference from a set of ObserverStates."""

    ZONE_DEFS = [
        ("zone-a", "PC1-AP \uad6c\uac04"),
        ("zone-b", "PC2-AP \uad6c\uac04"),
        ("zone-c", "\uad50\ucc28 \uc601\uc5ed"),
    ]

    @classmethod
    def compute(cls, observers: dict[str, ObserverState]) -> dict:
        now_ms = int(time.time() * 1000)

        active = {oid: obs for oid, obs in observers.items() if obs.connected}
        disturbed = [oid for oid, obs in active.items() if obs.is_disturbed()]

        # Presence
        if len(active) == 0:
            presence = "waiting"
        elif len(disturbed) == 0:
            presence = "absent"
        else:
            max_var = max(
                (active[oid].aggregate_variance() for oid in disturbed), default=0
            )
            presence = "active" if max_var > 1.5 else "present_still"

        # Confidence
        if disturbed:
            mean_abs_delta = statistics.mean(
                [active[oid].aggregate_delta() for oid in disturbed]
            )
            confidence = min(mean_abs_delta / 5.0, 1.0)
        else:
            confidence = 0.0

        # Zones -- map first N observers to zone slots
        sorted_ids = sorted(active.keys())
        zones = {}
        for idx, (zone_id, zone_name) in enumerate(cls.ZONE_DEFS):
            if idx < len(sorted_ids):
                obs = active[sorted_ids[idx]]
                z_occupied = obs.is_disturbed()
                z_conf = min(obs.aggregate_delta() / 5.0, 1.0)
            else:
                z_occupied = False
                z_conf = 0.0
            zones[zone_id] = {
                "name": zone_name,
                "occupied": z_occupied,
                "confidence": round(z_conf, 2),
            }

        # If multiple observers disturbed simultaneously -> mark cross-zone
        if len(disturbed) >= 2 and "zone-c" in zones:
            zones["zone-c"]["occupied"] = True
            zones["zone-c"]["confidence"] = round(confidence, 2)

        # -- Estimated position (weighted centroid of disturbed observers) ----
        # Default observer node positions (metres, arbitrary coordinate frame).
        # AP is assumed at the origin (0, 0).
        _OBSERVER_POSITIONS = [(-5, 0), (5, 0), (0, 6), (3, 0)]

        estimated_position = None
        if disturbed:
            total_weight = 0.0
            wx, wy = 0.0, 0.0
            ap_x, ap_y = 0, 0

            sorted_active_ids = sorted(active.keys())
            for obs_id in disturbed:
                obs = active.get(obs_id)
                if not obs:
                    continue
                idx = sorted_active_ids.index(obs_id) if obs_id in sorted_active_ids else 0
                node_x, node_y = _OBSERVER_POSITIONS[min(idx, len(_OBSERVER_POSITIONS) - 1)]

                # Use VARIANCE as weight (not delta!)
                variance = obs.aggregate_variance()
                weight = max(0.001, variance)

                # Pull toward the node: higher variance = person closer to that node
                import math
                pull = min(1.0, math.log10(1 + variance * 10) / 2)
                # pull=0 → at AP, pull=1 → at the node position

                px = ap_x + (node_x - ap_x) * pull
                py = ap_y + (node_y - ap_y) * pull

                wx += px * weight
                wy += py * weight
                total_weight += weight

            if total_weight > 0:
                estimated_position = {
                    "x": round(wx / total_weight, 2),
                    "y": round(wy / total_weight, 2),
                }

        # Per-observer RSSI summary (includes trend direction)
        observers_rssi = {}
        for oid, obs in active.items():
            rssi_val = obs.primary_rssi()
            observers_rssi[oid] = {
                "rssi": rssi_val if rssi_val is not None else 0,
                "delta": round(obs.primary_delta(), 2),
                "variance": round(obs.aggregate_variance(), 2),
                "disturbed": obs.is_disturbed(),
                "trend": obs.rssi_trend(),
                "csi_features": getattr(obs, 'csi_features', {}),
            }

        if len(active) == 0:
            accuracy = "none"
        elif len(active) >= 2:
            accuracy = "approximate"
        else:
            accuracy = "low"

        return {
            "timestamp_ms": now_ms,
            "presence": presence,
            "confidence": round(confidence, 2),
            "disturbed_observers": disturbed,
            "estimated_position": estimated_position,
            "zones": zones,
            "observers_rssi": observers_rssi,
            "active_observers": len(active),
            "accuracy": accuracy,
        }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class ObserverServer(BaseHTTPRequestHandler):
    """stdlib HTTP handler with class-level shared state."""

    # -- shared state (class variables) ----------------------------------------
    observers: dict[str, ObserverState] = {}
    ml_position = None  # Latest ML-estimated position
    calibrating: bool = False
    calibration_start: float = 0.0
    calibration_data: dict[str, dict[str, list]] = {}  # observer_id -> bssid -> [rssi]
    start_time: float = time.time()
    auto_calibrate: bool = False
    _auto_calibrate_triggered: bool = False
    ui_dir: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ui")
    verbose: bool = False
    _lock: threading.Lock = threading.Lock()

    # -- request routing -------------------------------------------------------

    server_version = "PM-ObserverServer/1.0"

    def log_message(self, fmt, *args):
        if self.__class__.verbose:
            super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/observers/status":
            self._send_json(self._get_status())
        elif path == "/api/observers/fusion":
            self._send_json(self._get_fusion())
        elif path == "/health/health":
            self._send_json(self._get_health())
        elif path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:
            self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/observers/scan":
            body = self._read_body()
            if body is None:
                return  # error already sent
            self._handle_scan(body)
        elif path == "/api/observers/calibrate":
            self._start_calibration()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_OPTIONS(self):
        self._send_cors_preflight()

    # -- API handlers ----------------------------------------------------------

    def _handle_scan(self, data: dict) -> None:
        observer_id = data.get("observer_id")
        if not observer_id:
            self._send_json({"error": "observer_id required"}, 400)
            return

        with self.__class__._lock:
            if observer_id not in self.__class__.observers:
                self.__class__.observers[observer_id] = ObserverState(observer_id)
                if self.__class__.verbose:
                    print(f"[observer] New observer registered: {observer_id}")

                # Auto-calibrate on first connection
                if (
                    self.__class__.auto_calibrate
                    and not self.__class__._auto_calibrate_triggered
                ):
                    self.__class__._auto_calibrate_triggered = True
                    self._begin_calibration_locked()

            obs = self.__class__.observers[observer_id]
            obs.ingest(data)

            # Check for ML position data
            ml_pos = data.get("ml_position")
            if ml_pos:
                self.__class__.ml_position = {
                    "x": ml_pos.get("x", 0),
                    "y": ml_pos.get("y", 0),
                    "confidence": ml_pos.get("confidence", 0),
                    "method": ml_pos.get("method", "unknown"),
                    "timestamp_ms": int(time.time() * 1000),
                }

            # Store CSI features if present
            if "esp32_csi" in data:
                csi = data["esp32_csi"]
                obs.csi_features = csi.get("csi_features", {})

            # Calibration collection
            if self.__class__.calibrating:
                elapsed = time.time() - self.__class__.calibration_start
                if elapsed < CALIBRATION_DURATION:
                    if observer_id not in self.__class__.calibration_data:
                        self.__class__.calibration_data[observer_id] = {}
                    for ap in data.get("aps", []):
                        bssid = ap.get("bssid", "").upper()
                        rssi = ap.get("rssi_dbm")
                        if bssid and rssi is not None:
                            self.__class__.calibration_data[observer_id].setdefault(
                                bssid, []
                            ).append(float(rssi))
                else:
                    self._finish_calibration_locked()

        self._send_json({"status": "ok", "observer_id": observer_id})

    def _start_calibration(self) -> None:
        with self.__class__._lock:
            self._begin_calibration_locked()
        self._send_json(
            {"status": "calibrating", "duration_seconds": CALIBRATION_DURATION}
        )

    def _begin_calibration_locked(self) -> None:
        """Must be called with _lock held."""
        self.__class__.calibrating = True
        self.__class__.calibration_start = time.time()
        self.__class__.calibration_data = {}
        if self.__class__.verbose:
            print(
                f"[calibration] Started — collecting for {CALIBRATION_DURATION}s"
            )

    def _finish_calibration_locked(self) -> None:
        """Must be called with _lock held."""
        self.__class__.calibrating = False
        for observer_id, bssid_data in self.__class__.calibration_data.items():
            obs = self.__class__.observers.get(observer_id)
            if obs is None:
                continue
            for bssid, samples in bssid_data.items():
                if samples:
                    obs.baseline[bssid] = statistics.mean(samples)
        self.__class__.calibration_data = {}
        if self.__class__.verbose:
            calibrated_count = sum(
                1 for o in self.__class__.observers.values() if o.baseline
            )
            print(
                f"[calibration] Complete — {calibrated_count} observer(s) baselined"
            )

    def _get_status(self) -> dict:
        with self.__class__._lock:
            # Check if calibration timed out (no scan came to trigger finish)
            if self.__class__.calibrating:
                elapsed = time.time() - self.__class__.calibration_start
                if elapsed >= CALIBRATION_DURATION:
                    self._finish_calibration_locked()

            obs_dict = {}
            for oid, obs in self.__class__.observers.items():
                obs_dict[oid] = obs.to_status_dict()

            calibrated = all(
                obs.baseline for obs in self.__class__.observers.values()
            ) if self.__class__.observers else False

            return {
                "observers": obs_dict,
                "observer_count": len(self.__class__.observers),
                "calibrated": calibrated,
                "calibrating": self.__class__.calibrating,
            }

    def _get_fusion(self) -> dict:
        with self.__class__._lock:
            # Check if calibration timed out
            if self.__class__.calibrating:
                elapsed = time.time() - self.__class__.calibration_start
                if elapsed >= CALIBRATION_DURATION:
                    self._finish_calibration_locked()

            result = FusionEngine.compute(self.__class__.observers)
            result["ml_estimated_position"] = self.__class__.ml_position
            return result

    def _get_health(self) -> dict:
        with self.__class__._lock:
            connected = sum(
                1 for o in self.__class__.observers.values() if o.connected
            )
        return {
            "status": "healthy",
            "observers": connected,
            "uptime_seconds": round(time.time() - self.__class__.start_time, 1),
        }

    # -- static file serving ---------------------------------------------------

    def _serve_static(self, path: str) -> None:
        # Redirect root to location.html
        if path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/location.html")
            self._add_cors_headers()
            self.end_headers()
            return

        # Sanitize path to prevent directory traversal
        path = path.lstrip("/")
        path = os.path.normpath(path)
        if path.startswith("..") or os.path.isabs(path):
            self._send_json({"error": "forbidden"}, 403)
            return

        ui_dir = os.path.abspath(self.__class__.ui_dir)
        file_path = os.path.join(ui_dir, path)
        file_path = os.path.abspath(file_path)

        # Ensure we stay within the UI directory (add os.sep to prevent prefix match on sibling dirs)
        if not file_path.startswith(ui_dir + os.sep) and file_path != ui_dir:
            self._send_json({"error": "forbidden"}, 403)
            return

        if not os.path.isfile(file_path):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self._add_cors_headers()
            self.end_headers()
            self.wfile.write(f"404 Not Found: {path}\n".encode())
            return

        mime_type = self._guess_mime(file_path)
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(len(content)))
            if file_path.endswith('.js') or file_path.endswith('.html'):
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.send_header('Expires', '0')
            self._add_cors_headers()
            self.end_headers()
            self.wfile.write(content)
        except OSError:
            self._send_json({"error": "read error"}, 500)

    @staticmethod
    def _guess_mime(file_path: str) -> str:
        ext_map = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".ico": "image/x-icon",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
            ".map": "application/json",
        }
        _, ext = os.path.splitext(file_path)
        if ext.lower() in ext_map:
            return ext_map[ext.lower()]
        guess, _ = mimetypes.guess_type(file_path)
        return guess or "application/octet-stream"

    # -- helpers ---------------------------------------------------------------

    def _read_body(self) -> dict | None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_json({"error": "empty body"}, 400)
            return None
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self._send_json({"error": f"invalid JSON: {e}"}, 400)
            return None

    def _send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._add_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _add_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, OPTIONS"
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        )

    def _send_cors_preflight(self) -> None:
        self.send_response(204)
        self._add_cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


# ---------------------------------------------------------------------------
# Stale observer reaper thread
# ---------------------------------------------------------------------------

def _reaper_loop(handler_cls: type, interval: float = 5.0):
    """Periodically check calibration timeouts even when no requests arrive."""
    while True:
        time.sleep(interval)
        with handler_cls._lock:
            if handler_cls.calibrating:
                elapsed = time.time() - handler_cls.calibration_start
                if elapsed >= CALIBRATION_DURATION:
                    handler_cls.calibrating = False
                    for observer_id, bssid_data in handler_cls.calibration_data.items():
                        obs = handler_cls.observers.get(observer_id)
                        if obs is None:
                            continue
                        for bssid, samples in bssid_data.items():
                            if samples:
                                obs.baseline[bssid] = statistics.mean(samples)
                    handler_cls.calibration_data = {}
                    if handler_cls.verbose:
                        print("[reaper] Calibration finished (timeout)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _get_lan_ip():
    """Get the machine's LAN IP address."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"

BANNER = """\
\033[36m
+================================================+
|  PM (Pochak Manager) -- Observer Server        |
|  Multi-PC RSSI Fusion Engine                   |
+================================================+
|  Dashboard:  http://localhost:{port:<14s}      |
|  LAN:        http://{lan_ip}:{port:<14s}      |
|  Observers:  0 connected                       |
+================================================+
\033[0m"""


def main():
    parser = argparse.ArgumentParser(
        description="PM Observer Server - Multi-PC RSSI Fusion"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="Server port (default: 8080)"
    )
    parser.add_argument(
        "--ui-dir",
        type=str,
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ui"),
        help="UI directory path (default: ../ui relative to this script)",
    )
    parser.add_argument(
        "--auto-calibrate",
        action="store_true",
        help="Start calibration on first observer connection",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Verbose request logging"
    )
    args = parser.parse_args()

    # Configure handler class state
    ObserverServer.ui_dir = os.path.abspath(args.ui_dir)
    ObserverServer.auto_calibrate = args.auto_calibrate
    ObserverServer.verbose = args.verbose
    ObserverServer.start_time = time.time()

    # Validate UI directory
    if not os.path.isdir(ObserverServer.ui_dir):
        print(
            f"WARNING: UI directory not found: {ObserverServer.ui_dir}",
            file=sys.stderr,
        )
        print("         Static file serving will return 404.", file=sys.stderr)

    # Print banner
    port_str = str(args.port)
    lan_ip = _get_lan_ip()
    print(BANNER.format(port=port_str, lan_ip=lan_ip))
    print(f"  UI dir:          {ObserverServer.ui_dir}")
    print(f"  Auto-calibrate:  {args.auto_calibrate}")
    print(f"  Verbose:         {args.verbose}")
    print()
    print("No observers connected yet. To add a PC observer:")
    print(f"  \033[33m[같은 PC]\033[0m python3 tools/pc-observer.py --id pc-node-1 --server http://localhost:{args.port}")
    print(f"  \033[33m[다른 PC]\033[0m python3 tools/pc-observer.py --id pc-node-2 --server http://{lan_ip}:{args.port}")
    print()

    # Start reaper thread
    reaper = threading.Thread(
        target=_reaper_loop, args=(ObserverServer,), daemon=True
    )
    reaper.start()

    # Start server (SO_REUSEADDR prevents "Address already in use" after restart)
    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
    server = ReusableHTTPServer(("0.0.0.0", args.port), ObserverServer)
    print(f"Listening on 0.0.0.0:{args.port} ...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
