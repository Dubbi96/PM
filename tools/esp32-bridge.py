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
import http.client
import json
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


def parse_csi_frame(data):
    """Parse ADR-018 CSI binary frame."""
    if len(data) < 20:
        return None
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != CSI_MAGIC:
        return None
    return {
        "type": "csi",
        "node_id": data[4],
        "n_antennas": data[5],
        "n_subcarriers": struct.unpack_from("<H", data, 6)[0],
        "frequency_mhz": struct.unpack_from("<I", data, 8)[0],
        "seq": struct.unpack_from("<I", data, 12)[0],
        "rssi": struct.unpack_from("<b", data, 16)[0],
        "noise": struct.unpack_from("<b", data, 17)[0],
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

    # UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
                        rssi_buffer.append(frame["rssi"])
                        if len(rssi_buffer) > RSSI_BUFFER_MAX:
                            rssi_buffer.pop(0)

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
                    },
                }

                status = send_to_server(args.server, payload)

                if args.verbose or seq % 10 == 0:
                    v_info = ""
                    if last_vitals:
                        v_info = f" presence={presence_state} motion={last_vitals['motion_energy']:.3f}"
                    print(
                        f"  [{seq:>4}] RSSI={mean_rssi:>6.1f}dBm var={variance:>5.2f} "
                        f"CSI={csi_count:>3}/s{v_info} → HTTP {status}"
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
