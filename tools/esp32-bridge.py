#!/usr/bin/env python3
"""
ESP32 CSI UDP Bridge → PM Observer Server

Receives UDP packets from ESP32-S3 CSI node (port 5005),
parses ADR-018 CSI frames + Vitals packets,
and forwards as observer scan data to the PM Observer Server API.

Usage:
    python3 tools/esp32-bridge.py --server http://localhost:8080

Requires: Python 3.7+ (stdlib only)
"""

import argparse
import collections
import http.client
import json
import logging
import math
import socket
import struct
import sys
import time
import urllib.parse

# ADR-018 magic numbers
CSI_MAGIC = 0xC5110001
VITALS_MAGIC = 0xC5110002

# Rolling RSSI buffer for variance calculation
RSSI_BUFFER_MAX = 60

# Rolling CSI amplitude history (last N frames)
CSI_HISTORY_MAX = 30

# Rapid-change detection: threshold in dBm over a sliding window
RAPID_CHANGE_THRESHOLD_DBM = 3.0
RAPID_CHANGE_WINDOW_SEC = 2.0

logger = logging.getLogger("esp32-bridge")


def parse_csi_frame(data):
    """Parse ADR-018 CSI binary frame."""
    if len(data) < 20:
        return None
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != CSI_MAGIC:
        return None

    n_sub = struct.unpack_from("<H", data, 6)[0]
    rssi = struct.unpack_from("<b", data, 16)[0]
    noise = struct.unpack_from("<b", data, 17)[0]

    # Parse I/Q pairs -> amplitude per subcarrier
    iq_data = data[20:]
    amplitudes = []
    for s in range(min(n_sub, len(iq_data) // 2)):
        i_val = struct.unpack_from("<b", iq_data, s * 2)[0]
        q_val = struct.unpack_from("<b", iq_data, s * 2 + 1)[0]
        amp = (i_val ** 2 + q_val ** 2) ** 0.5
        amplitudes.append(amp)

    return {
        "type": "csi",
        "node_id": data[4],
        "n_subcarriers": n_sub,
        "frequency_mhz": struct.unpack_from("<I", data, 8)[0],
        "seq": struct.unpack_from("<I", data, 12)[0],
        "rssi": rssi,
        "noise": noise,
        "amplitudes": amplitudes,  # 64 subcarrier amplitudes
    }


def parse_vitals(data):
    """Parse Vitals packet (32 bytes)."""
    if len(data) < 28:
        return None
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != VITALS_MAGIC:
        return None
    flags = data[5]
    return {
        "type": "vitals",
        "node_id": data[4],
        "presence": bool(flags & 1),
        "fall": bool(flags & 2),
        "motion_flag": bool(flags & 4),
        "breathing_bpm": struct.unpack_from("<H", data, 6)[0] / 100.0,
        "heart_rate": struct.unpack_from("<I", data, 8)[0] / 10000.0,
        "rssi": struct.unpack_from("<b", data, 12)[0],
        "persons": data[13],
        "motion_energy": struct.unpack_from("<f", data, 16)[0],
        "presence_score": struct.unpack_from("<f", data, 20)[0],
        "timestamp_ms": struct.unpack_from("<I", data, 24)[0],
    }


def send_to_server(server_url, data):
    """POST JSON to the observer server."""
    parsed = urllib.parse.urlparse(server_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 8080
    body = json.dumps(data).encode("utf-8")
    try:
        conn = http.client.HTTPConnection(host, port, timeout=3)
        conn.request("POST", "/api/observers/scan", body, {"Content-Type": "application/json"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp.status
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser(description="ESP32 CSI → PM Observer Server bridge")
    parser.add_argument("--udp-port", type=int, default=5005, help="UDP listen port (default: 5005)")
    parser.add_argument("--server", type=str, default="http://localhost:8080", help="PM Observer Server URL")
    parser.add_argument("--node-name", type=str, default="ESP32-S3", help="Node name for dashboard")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    # Configure logging for movement events
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # UDP socket (SO_REUSEADDR + SO_REUSEPORT to prevent "Address already in use")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    sock.bind(("0.0.0.0", args.udp_port))
    sock.settimeout(2.0)

    print(f"""
\033[36m+==========================================+
|  PM — ESP32 CSI Bridge                   |
+==========================================+
|  UDP Listen:  0.0.0.0:{args.udp_port:<18}|
|  Server:      {args.server:<27}|
|  Node Name:   {args.node_name:<27}|
+==========================================+\033[0m
""")

    rssi_buffer = []
    # Timestamped RSSI samples for rapid-change detection: deque of (timestamp, rssi)
    rssi_ts_buffer = collections.deque()
    csi_amplitude_history = []  # list of amplitude arrays (last N frames)
    seq = 0
    last_send = 0
    send_interval = 1.0  # Send to server every 1 second
    csi_count = 0
    vitals_count = 0
    last_vitals = None
    esp32_addr = None

    print("Waiting for ESP32 UDP packets...")

    while True:
        try:
            data, addr = sock.recvfrom(2048)

            if esp32_addr is None:
                esp32_addr = addr
                print(f"\033[32mESP32 connected from {addr[0]}:{addr[1]}\033[0m")

            # Parse packet
            if len(data) >= 4:
                magic = struct.unpack_from("<I", data, 0)[0]

                if magic == CSI_MAGIC:
                    frame = parse_csi_frame(data)
                    if frame:
                        csi_count += 1
                        sample_time = time.time()
                        rssi_val = frame["rssi"]
                        rssi_buffer.append(rssi_val)
                        if len(rssi_buffer) > RSSI_BUFFER_MAX:
                            rssi_buffer.pop(0)

                        # Store amplitude profile
                        if frame["amplitudes"]:
                            csi_amplitude_history.append(frame["amplitudes"])
                            if len(csi_amplitude_history) > CSI_HISTORY_MAX:
                                csi_amplitude_history.pop(0)

                        # Track timestamped samples for rapid-change detection
                        rssi_ts_buffer.append((sample_time, rssi_val))
                        # Evict samples older than the detection window
                        cutoff = sample_time - RAPID_CHANGE_WINDOW_SEC
                        while rssi_ts_buffer and rssi_ts_buffer[0][0] < cutoff:
                            rssi_ts_buffer.popleft()
                        # Detect rapid change within the window
                        if len(rssi_ts_buffer) >= 2:
                            window_rssi = [r for _, r in rssi_ts_buffer]
                            delta = max(window_rssi) - min(window_rssi)
                            if delta > RAPID_CHANGE_THRESHOLD_DBM:
                                direction = "approaching" if window_rssi[-1] > window_rssi[0] else "leaving"
                                logger.info(
                                    "MOVEMENT detected: RSSI delta=%.1f dBm in %.1fs (%s)",
                                    delta,
                                    sample_time - rssi_ts_buffer[0][0],
                                    direction,
                                )
                                if args.verbose:
                                    print(
                                        f"  \033[33m*** MOVEMENT: RSSI delta={delta:.1f}dBm "
                                        f"({direction})\033[0m"
                                    )

                elif magic == VITALS_MAGIC:
                    last_vitals = parse_vitals(data)
                    if last_vitals:
                        vitals_count += 1

            # Send aggregated data to server at interval
            now = time.time()
            if now - last_send >= send_interval and len(rssi_buffer) > 0:
                # Calculate stats
                mean_rssi = sum(rssi_buffer) / len(rssi_buffer)
                variance = sum((r - mean_rssi) ** 2 for r in rssi_buffer) / len(rssi_buffer) if len(rssi_buffer) > 1 else 0

                # RSSI trend: compare recent 5 samples vs older 5 samples
                # positive = signal getting stronger (person approaching)
                # negative = signal getting weaker (person leaving)
                rssi_trend = 0.0
                if len(rssi_buffer) >= 5:
                    recent = rssi_buffer[-5:]
                    older = rssi_buffer[-10:-5] if len(rssi_buffer) >= 10 else rssi_buffer[:5]
                    rssi_trend = sum(recent) / len(recent) - sum(older) / len(older)

                # Compute features from CSI amplitude data
                csi_features = {}
                if len(csi_amplitude_history) >= 5:
                    n_sub = len(csi_amplitude_history[0])

                    # Split subcarriers into 4 groups (low/mid-low/mid-high/high frequency)
                    group_size = n_sub // 4
                    groups = {
                        'low': slice(0, group_size),
                        'mid_low': slice(group_size, group_size * 2),
                        'mid_high': slice(group_size * 2, group_size * 3),
                        'high': slice(group_size * 3, n_sub),
                    }

                    # Compute per-group: mean amplitude, variance, temporal change
                    for gname, gslice in groups.items():
                        recent_amps = [frame[gslice] for frame in csi_amplitude_history[-10:]]
                        # Mean amplitude per group
                        group_means = [sum(amps) / max(1, len(amps)) for amps in recent_amps]
                        mean_amp = sum(group_means) / len(group_means)
                        var_amp = sum((m - mean_amp) ** 2 for m in group_means) / len(group_means)

                        # Temporal change (last vs first)
                        if len(group_means) >= 2:
                            change = group_means[-1] - group_means[0]
                        else:
                            change = 0

                        csi_features[gname] = {
                            'mean': round(mean_amp, 2),
                            'variance': round(var_amp, 4),
                            'change': round(change, 2),
                        }

                    # Overall amplitude profile (downsampled to 16 values for efficiency)
                    latest = csi_amplitude_history[-1]
                    step = max(1, len(latest) // 16)
                    profile = [round(latest[i * step], 1) for i in range(min(16, len(latest)))]
                    csi_features['profile'] = profile

                    # Dominant subcarrier group (highest variance = most affected by person)
                    dominant = max(groups.keys(), key=lambda g: csi_features[g]['variance'])
                    csi_features['dominant_group'] = dominant

                # Build observer scan payload
                bssid = "ESP32-CSI-NODE"
                ap_data = {
                    "bssid": bssid,
                    "ssid": "CSI-Direct",
                    "channel": 0,
                    "rssi_dbm": round(mean_rssi, 1),
                    "frequency_mhz": 2417,
                }

                # Add vitals info if available
                presence_state = "absent"
                confidence = 0.0
                if last_vitals:
                    if last_vitals["presence"]:
                        presence_state = "active" if last_vitals["motion_energy"] > 0.1 else "present_still"
                        confidence = min(1.0, last_vitals["presence_score"])
                    ap_data["presence"] = last_vitals["presence"]
                    ap_data["motion_energy"] = round(last_vitals["motion_energy"], 4)
                    ap_data["presence_score"] = round(last_vitals["presence_score"], 4)
                    ap_data["breathing_bpm"] = round(last_vitals["breathing_bpm"], 1)
                    ap_data["persons"] = last_vitals["persons"]

                payload = {
                    "observer_id": "esp32-node-1",
                    "timestamp_ms": int(now * 1000),
                    "platform": "esp32-s3",
                    "scan_seq": seq,
                    "aps": [ap_data],
                    # Extra fields for the observer server
                    "esp32_csi": {
                        "rssi": round(mean_rssi, 1),
                        "variance": round(variance, 2),
                        "snr": round(mean_rssi - (-90), 1),  # noise floor ~-90
                        "csi_rate": csi_count,
                        "presence": presence_state,
                        "confidence": round(confidence, 3),
                        "subcarriers": 64,
                        "rssi_trend": round(rssi_trend, 2),  # dBm/s direction
                        "rssi_min": min(rssi_buffer),
                        "rssi_max": max(rssi_buffer),
                        "csi_features": csi_features,  # subcarrier group analysis
                    },
                }

                status = send_to_server(args.server, payload)

                if args.verbose or seq % 10 == 0:
                    v_info = ""
                    if last_vitals:
                        v_info = f" presence={presence_state} motion={last_vitals['motion_energy']:.3f}"
                    trend_arrow = "+" if rssi_trend > 0.5 else ("-" if rssi_trend < -0.5 else "=")
                    dominant = csi_features.get('dominant_group', '?')
                    print(
                        f"  [{seq:>4}] RSSI={mean_rssi:>6.1f}dBm var={variance:>5.2f} "
                        f"trend={rssi_trend:>+5.1f}({trend_arrow}) "
                        f"[{min(rssi_buffer)}/{max(rssi_buffer)}] "
                        f"CSI={csi_count:>3}/s dom={dominant}{v_info} → HTTP {status}"
                    )

                seq += 1
                csi_count = 0
                vitals_count = 0
                last_send = now

        except socket.timeout:
            continue
        except KeyboardInterrupt:
            print("\n\033[33mBridge stopped.\033[0m")
            break

    sock.close()


if __name__ == "__main__":
    main()
