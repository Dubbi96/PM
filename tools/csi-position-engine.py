#!/usr/bin/env python3
"""
CSI Position Estimation Engine
Uses subcarrier amplitude patterns for ML-based position inference.
No external ML libraries needed — uses numpy-free implementations.

Methods:
1. Subcarrier group variance ratio → direction estimation
2. Amplitude pattern matching → distance estimation
3. Temporal pattern analysis → movement tracking
4. Simple KNN classifier for zone classification
"""

import json
import http.client
import urllib.parse
import time
import math
import argparse

class CSIPositionEngine:
    def __init__(self, server_url, ap_pos=(0,0), node_positions=None):
        self.server_url = server_url
        self.ap = ap_pos
        self.nodes = node_positions or {'esp32-node-1': (3, 0)}

        # Calibration data (auto-collected)
        self.baseline_profile = None  # amplitude profile with no person
        self.calibration_samples = []
        self.calibrated = False
        self.calibration_duration = 15  # seconds
        self.calibration_start = None

        # Position state
        self.estimated_x = 0.0
        self.estimated_y = 0.0
        self.confidence = 0.0
        self.smoothing = 0.2  # EMA factor

        # History for pattern analysis
        self.profile_history = []
        self.position_history = []
        self.MAX_HISTORY = 60

    def fetch_data(self):
        """Fetch current fusion data + CSI features from server."""
        parsed = urllib.parse.urlparse(self.server_url)
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 8080, timeout=3)
        conn.request("GET", "/api/observers/fusion")
        resp = conn.getresponse()
        data = json.loads(resp.read())
        conn.close()
        return data

    def push_position(self, x, y, confidence, method):
        """Push estimated position back to server."""
        parsed = urllib.parse.urlparse(self.server_url)
        payload = json.dumps({
            "observer_id": "csi-ml-engine",
            "timestamp_ms": int(time.time() * 1000),
            "platform": "ml-engine",
            "scan_seq": 0,
            "aps": [{
                "bssid": "ML-POSITION",
                "ssid": "CSI-ML",
                "channel": 0,
                "rssi_dbm": 0,
            }],
            "ml_position": {
                "x": round(x, 2),
                "y": round(y, 2),
                "confidence": round(confidence, 3),
                "method": method,
            }
        }).encode()
        try:
            conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 8080, timeout=2)
            conn.request("POST", "/api/observers/scan", payload, {"Content-Type": "application/json"})
            conn.getresponse().read()
            conn.close()
        except:
            pass

    def auto_calibrate(self, data):
        """Collect baseline amplitude profile (no person present)."""
        if self.calibration_start is None:
            self.calibration_start = time.time()
            print("[CSI-ML] Auto-calibration started (15s)...")

        obs_data = data.get("observers_rssi", {})
        for obs_id, obs in obs_data.items():
            csi = obs.get("csi_features", {})
            profile = csi.get("profile")
            if profile:
                self.calibration_samples.append(profile)

        if time.time() - self.calibration_start > self.calibration_duration:
            if self.calibration_samples:
                # Average all calibration profiles
                n = len(self.calibration_samples)
                n_sub = len(self.calibration_samples[0])
                self.baseline_profile = [
                    sum(s[i] for s in self.calibration_samples) / n
                    for i in range(n_sub)
                ]
                print(f"[CSI-ML] Calibration complete: {n} samples, {n_sub} subcarriers")
                self.calibrated = True
            else:
                print("[CSI-ML] Calibration failed: no CSI data received")
                self.calibration_start = None  # retry

    def estimate_position(self, data):
        """Main position estimation using CSI features."""
        presence = data.get("presence", "absent")
        if presence in ("absent", "waiting"):
            return None

        obs_data = data.get("observers_rssi", {})
        if not obs_data:
            return None

        # Collect features from all observers
        all_features = {}
        for obs_id, obs in obs_data.items():
            rssi = obs.get("rssi", -50)
            delta = obs.get("delta", 0)
            variance = obs.get("variance", 0)
            csi = obs.get("csi_features", {})
            all_features[obs_id] = {
                "rssi": rssi,
                "delta": delta,
                "variance": variance,
                "csi": csi,
            }

        # Method 1: RSSI-based distance (baseline)
        x1, y1, c1 = self._method_rssi_distance(all_features)

        # Method 2: Subcarrier group variance ratio (direction)
        x2, y2, c2 = self._method_subcarrier_direction(all_features)

        # Method 3: Amplitude pattern change (movement)
        x3, y3, c3 = self._method_amplitude_change(all_features)

        # Weighted fusion of all methods
        total_conf = c1 + c2 + c3
        if total_conf < 0.01:
            return None

        fused_x = (x1 * c1 + x2 * c2 + x3 * c3) / total_conf
        fused_y = (y1 * c1 + y2 * c2 + y3 * c3) / total_conf
        fused_conf = min(1.0, total_conf / 3.0)

        # EMA smoothing
        self.estimated_x += (fused_x - self.estimated_x) * self.smoothing
        self.estimated_y += (fused_y - self.estimated_y) * self.smoothing
        self.confidence = fused_conf

        return {
            "x": self.estimated_x,
            "y": self.estimated_y,
            "confidence": self.confidence,
            "method": "multi-fusion",
        }

    def _method_rssi_distance(self, features):
        """Method 1: Path-loss distance estimation."""
        ap_x, ap_y = self.ap
        ref_rssi = -30
        n = 3.0

        total_w = 0
        wx, wy = 0, 0

        for obs_id, f in features.items():
            node_pos = self.nodes.get(obs_id, (3, 0))
            rssi = f["rssi"]
            delta = abs(f["delta"])

            # Distance from AP
            dist = 10 ** ((ref_rssi - rssi) / (10 * n))
            dist = max(0.5, min(10, dist))

            # Position along AP-node line
            node_dist = math.sqrt((node_pos[0] - ap_x)**2 + (node_pos[1] - ap_y)**2) or 1
            t = min(1.5, dist / node_dist)

            px = ap_x + (node_pos[0] - ap_x) * t
            py = ap_y + (node_pos[1] - ap_y) * t

            w = max(0.1, delta)
            wx += px * w
            wy += py * w
            total_w += w

        if total_w > 0:
            return wx/total_w, wy/total_w, 0.4
        return 0, 0, 0

    def _method_subcarrier_direction(self, features):
        """Method 2: Use subcarrier group variance to estimate direction."""
        ap_x, ap_y = self.ap

        for obs_id, f in features.items():
            csi = f.get("csi", {})
            if not csi:
                continue

            node_pos = self.nodes.get(obs_id, (3, 0))

            # Get group variances
            low_var = csi.get("low", {}).get("variance", 0)
            mid_low_var = csi.get("mid_low", {}).get("variance", 0)
            mid_high_var = csi.get("mid_high", {}).get("variance", 0)
            high_var = csi.get("high", {}).get("variance", 0)

            total_var = low_var + mid_low_var + mid_high_var + high_var
            if total_var < 0.01:
                continue

            # Direction estimation:
            # Low subcarriers more affected → person closer to AP
            # High subcarriers more affected → person closer to node
            low_ratio = (low_var + mid_low_var) / total_var
            high_ratio = (mid_high_var + high_var) / total_var

            # t: 0 = at AP, 1 = at node
            t = high_ratio  # higher subcarrier variance → closer to node
            t = max(0.1, min(1.0, t))

            # Perpendicular offset from dominant group
            dominant = csi.get("dominant_group", "low")
            perp_offset = 0
            if dominant == "mid_low":
                perp_offset = 0.5
            elif dominant == "mid_high":
                perp_offset = -0.5

            # Direction vector AP → node
            dx = node_pos[0] - ap_x
            dy = node_pos[1] - ap_y
            length = math.sqrt(dx*dx + dy*dy) or 1

            # Position along line
            px = ap_x + dx * t
            py = ap_y + dy * t

            # Perpendicular displacement
            perp_x = -dy / length
            perp_y = dx / length
            px += perp_x * perp_offset
            py += perp_y * perp_offset

            confidence = min(1.0, total_var * 2)
            return px, py, confidence * 0.3

        return 0, 0, 0

    def _method_amplitude_change(self, features):
        """Method 3: Track amplitude profile changes for movement direction."""
        for obs_id, f in features.items():
            csi = f.get("csi", {})
            profile = csi.get("profile")
            if not profile:
                continue

            self.profile_history.append(profile)
            if len(self.profile_history) > self.MAX_HISTORY:
                self.profile_history.pop(0)

            if len(self.profile_history) < 3:
                continue

            # Compare current profile to baseline
            if self.baseline_profile:
                diff = [profile[i] - self.baseline_profile[i] for i in range(min(len(profile), len(self.baseline_profile)))]
                # Find peak change region
                n = len(diff)
                first_half_change = sum(abs(d) for d in diff[:n//2]) / max(1, n//2)
                second_half_change = sum(abs(d) for d in diff[n//2:]) / max(1, n - n//2)

                total_change = first_half_change + second_half_change
                if total_change < 0.1:
                    continue

                # More change in first half → person closer to AP
                # More change in second half → person closer to node
                node_pos = self.nodes.get(obs_id, (3, 0))
                ap_x, ap_y = self.ap

                t = second_half_change / total_change
                px = ap_x + (node_pos[0] - ap_x) * t
                py = ap_y + (node_pos[1] - ap_y) * t

                confidence = min(1.0, total_change / 5.0)
                return px, py, confidence * 0.3

        return 0, 0, 0

    def run(self, interval=1.0):
        """Main loop."""
        print(f"""
\033[35m+==========================================+
|  PM -- CSI ML Position Engine            |
+==========================================+
|  Server:   {self.server_url:<29}|
|  AP:       ({self.ap[0]}, {self.ap[1]})                         |
|  Methods:  RSSI + Subcarrier + Amplitude |
+==========================================+\033[0m
""")

        while True:
            try:
                data = self.fetch_data()

                if not self.calibrated:
                    self.auto_calibrate(data)
                else:
                    result = self.estimate_position(data)
                    if result:
                        self.push_position(result["x"], result["y"], result["confidence"], result["method"])
                        print(f"  Position: ({result['x']:.1f}, {result['y']:.1f}) conf={result['confidence']:.0%} method={result['method']}")
                    else:
                        print("  No person detected")

            except KeyboardInterrupt:
                print("\n\033[33mEngine stopped.\033[0m")
                break
            except Exception as e:
                print(f"  Error: {e}")

            time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="CSI ML Position Engine")
    parser.add_argument("--server", default="http://localhost:8080")
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--calibration-time", type=int, default=15)
    args = parser.parse_args()

    engine = CSIPositionEngine(
        server_url=args.server,
        ap_pos=(0, 0),
        node_positions={
            'esp32-node-1': (3, 0),
            'pc-node-1': (-5, 0),
            'pc-node-2': (5, 0),
            'pc-node-3': (0, 6),
        }
    )
    engine.calibration_duration = args.calibration_time
    engine.run(interval=args.interval)


if __name__ == "__main__":
    main()
