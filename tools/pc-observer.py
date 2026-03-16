#!/usr/bin/env python3
"""
PM (Pochak Manager) -- PC Observer
WiFi RSSI Collection Agent

Cross-platform Python script that scans nearby WiFi networks and sends
RSSI data to a central fusion server via HTTP POST.

Supported platforms:
  - Windows  (netsh wlan)
  - macOS    (CoreWLAN via swift, fallback to airport utility)
  - Linux    (nmcli, fallback to iwlist)

Requirements: Python 3.7+ stdlib only (zero external dependencies).

Usage:
  python3 pc-observer.py --id pc-node-1 --server http://192.168.1.100:8080
  python3 pc-observer.py --id pc-node-2 --server http://192.168.1.100:8080 --interval 1 --verbose
  python3 pc-observer.py --id pc-node-1 --dry-run --target-ssid MyRouter
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

__version__ = "1.0.0"

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

logger = logging.getLogger("pm-observer")


def configure_logging(verbose: bool = False, log_file: str | None = None) -> None:
    """Configure the root logger for the observer."""
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    datefmt = "%H:%M:%S"

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))

    logging.basicConfig(level=level, format=fmt, datefmt=datefmt, handlers=handlers)


# ---------------------------------------------------------------------------
# Platform scanners
# ---------------------------------------------------------------------------

def scan_windows() -> list[dict]:
    """Scan WiFi networks on Windows using ``netsh wlan show networks``.

    Parses SSID, BSSID, Signal (percentage), Channel, and Radio type.
    Signal percentage is converted to approximate dBm:
        rssi_dbm = (signal_pct / 2) - 100
    """
    try:
        output = subprocess.check_output(
            ["netsh", "wlan", "show", "networks", "mode=bssid"],
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "netsh not found. Are you running on Windows with WLAN service enabled?"
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("netsh wlan scan timed out (15 s).")

    aps: list[dict] = []
    current_ssid = ""

    # netsh output groups info per BSSID under each SSID header.
    bssid = ""
    signal_pct = 0
    channel = 0
    radio = ""

    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue

        # Match "SSID N : <name>"  (language-independent: check for "SSID")
        m = re.match(r"^SSID\s+\d+\s*:\s*(.*)", line, re.IGNORECASE)
        if m:
            current_ssid = m.group(1).strip()
            continue

        # BSSID
        m = re.match(r"^BSSID\s+\d+\s*:\s*(\S+)", line, re.IGNORECASE)
        if m:
            # Flush previous AP if we had one
            if bssid:
                aps.append(_make_ap(bssid, current_ssid, channel, signal_pct, radio))
            bssid = m.group(1).strip()
            signal_pct = 0
            channel = 0
            radio = ""
            continue

        # Signal
        m = re.match(r"^Signal\s*:\s*(\d+)", line, re.IGNORECASE)
        if m:
            signal_pct = int(m.group(1))
            continue

        # Channel
        m = re.match(r"^Channel\s*:\s*(\d+)", line, re.IGNORECASE)
        if m:
            channel = int(m.group(1))
            continue

        # Radio type (802.11ac etc.)
        m = re.match(r"^Radio\s+type\s*:\s*(.*)", line, re.IGNORECASE)
        if m:
            radio = m.group(1).strip()
            continue

    # Flush last AP
    if bssid:
        aps.append(_make_ap(bssid, current_ssid, channel, signal_pct, radio))

    return aps


def _make_ap(bssid: str, ssid: str, channel: int, signal_pct: int, radio: str) -> dict:
    """Build an AP dict, converting signal % to dBm and estimating frequency."""
    rssi_dbm = int(signal_pct / 2) - 100
    freq = _channel_to_freq(channel)
    return {
        "bssid": bssid.upper(),
        "ssid": ssid,
        "channel": channel,
        "rssi_dbm": rssi_dbm,
        "frequency_mhz": freq,
    }


def scan_macos() -> list[dict]:
    """Scan WiFi networks on macOS.

    Strategy (ordered by preference):
      1. CoreWLAN via ``swift`` -- works on macOS Sonoma+ where airport was
         removed.  Uses the system Swift compiler to call CWWiFiClient.
         Note: BSSID and SSID require Location Services permission; without
         it they return nil.  RSSI and channel are always available.
      2. Legacy ``airport -s`` utility -- pre-Sonoma only.
    """
    # Try CoreWLAN first (modern macOS).
    try:
        return _scan_macos_corewlan()
    except (FileNotFoundError, RuntimeError) as exc:
        logger.debug("CoreWLAN scan failed (%s), trying airport fallback.", exc)

    # Fallback: legacy airport binary.
    try:
        return _scan_macos_airport()
    except (FileNotFoundError, RuntimeError) as exc:
        raise RuntimeError(
            "WiFi scan failed on macOS. Neither CoreWLAN (swift) nor the "
            "legacy airport utility are available.\n"
            f"Last error: {exc}\n"
            "Hint: If BSSID/SSID show as empty, grant Location Services "
            "permission to Terminal in System Settings > Privacy & Security > "
            "Location Services."
        )


# Inline Swift source for CoreWLAN scan.  Written to a temp file once and
# compiled on first use.  The compiled binary is cached for the process
# lifetime so subsequent scans are fast (~50 ms instead of ~2 s compile).
_COREWLAN_SWIFT_SRC = r"""
import CoreWLAN
import Foundation

let client = CWWiFiClient.shared()
guard let iface = client.interface() else {
    fputs("ERROR:no_wifi_interface\n", stderr)
    exit(1)
}

do {
    let networks = try iface.scanForNetworks(withSSID: nil)
    for net in networks {
        let bssid = net.bssid ?? ""
        let ssid  = net.ssid ?? ""
        let rssi  = net.rssiValue
        let ch    = net.wlanChannel?.channelNumber ?? 0
        let band5 = net.wlanChannel?.channelBand == .band5GHz
        let freq  = band5 ? 5000 + ch * 5 : (ch == 14 ? 2484 : 2407 + ch * 5)
        // Pipe-delimited: bssid|ssid|rssi|channel|freq
        print("\(bssid)|\(ssid)|\(rssi)|\(ch)|\(freq)")
    }
} catch {
    fputs("ERROR:\(error.localizedDescription)\n", stderr)
    exit(1)
}
"""

# Cached path to compiled binary (process-lifetime cache).
_corewlan_binary: str | None = None


def _get_corewlan_binary() -> str:
    """Compile the CoreWLAN Swift scanner once and cache the binary path."""
    global _corewlan_binary
    if _corewlan_binary and os.path.isfile(_corewlan_binary):
        return _corewlan_binary

    # Write source to temp file.
    src_fd, src_path = tempfile.mkstemp(suffix=".swift", prefix="pm_wifi_scan_")
    bin_path = src_path.replace(".swift", "")
    try:
        with os.fdopen(src_fd, "w") as f:
            f.write(_COREWLAN_SWIFT_SRC)

        # Compile.  -framework CoreWLAN is linked automatically when
        # importing the module.
        subprocess.check_output(
            ["swiftc", "-O", "-o", bin_path, src_path],
            stderr=subprocess.STDOUT,
            timeout=30,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "Swift compiler (swiftc) not found. Install Xcode Command Line Tools: "
            "xcode-select --install"
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"Failed to compile CoreWLAN scanner: {exc.output.decode(errors='replace')}"
        )
    finally:
        # Clean up source file; keep binary.
        try:
            os.unlink(src_path)
        except OSError:
            pass

    _corewlan_binary = bin_path
    return bin_path


def _scan_macos_corewlan() -> list[dict]:
    """Scan using a compiled CoreWLAN Swift binary.

    Returns a list of AP dicts.  BSSIDs and SSIDs may be empty strings
    if Location Services is not granted to the parent terminal process.
    """
    binary = _get_corewlan_binary()
    try:
        output = subprocess.check_output(
            [binary],
            encoding="utf-8",
            errors="replace",
            timeout=15,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        stderr_msg = exc.stderr.decode(errors="replace") if exc.stderr else ""
        raise RuntimeError(f"CoreWLAN scan exited {exc.returncode}: {stderr_msg}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("CoreWLAN scan timed out (15 s).")

    aps: list[dict] = []
    for line in output.strip().splitlines():
        parts = line.split("|")
        if len(parts) < 5:
            logger.debug("Skipping short CoreWLAN line: %s", line)
            continue
        try:
            bssid = parts[0].strip().upper()
            ssid = parts[1].strip()
            rssi_dbm = int(parts[2].strip())
            channel = int(parts[3].strip())
            freq = int(parts[4].strip())

            # Skip entries where channel is 0 (unusable).
            if channel == 0:
                continue

            aps.append({
                "bssid": bssid if bssid else "00:00:00:00:00:00",
                "ssid": ssid if ssid else "(hidden)",
                "channel": channel,
                "rssi_dbm": rssi_dbm,
                "frequency_mhz": freq,
            })
        except (ValueError, IndexError) as exc:
            logger.debug("Skipping unparseable CoreWLAN line: %s (%s)", line, exc)
            continue

    return aps


def _scan_macos_airport() -> list[dict]:
    """Scan using the legacy ``airport -s`` utility (pre-Sonoma macOS).

    The airport binary lives in the Apple80211 private framework.  Output is
    columnar with headers:
        SSID  BSSID  RSSI  CHANNEL  HT  CC  SECURITY
    """
    airport = (
        "/System/Library/PrivateFrameworks/Apple80211.framework"
        "/Versions/Current/Resources/airport"
    )
    try:
        output = subprocess.check_output(
            [airport, "-s"],
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"airport utility not found at {airport}."
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("airport scan timed out (15 s).")

    aps: list[dict] = []
    lines = output.strip().splitlines()
    if len(lines) < 2:
        return aps  # No results or header only

    # First line is the header; find the column positions from it.
    header = lines[0]
    col_bssid = header.index("BSSID")
    col_rssi = header.index("RSSI")
    col_channel = header.index("CHANNEL")

    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            ssid = line[:col_bssid].strip()
            bssid_region = line[col_bssid:col_rssi].strip()
            bssid_match = re.search(r"([0-9a-fA-F:]{17})", bssid_region)
            bssid = bssid_match.group(1).upper() if bssid_match else bssid_region.upper()

            rssi_region = line[col_rssi:col_channel].strip()
            rssi_dbm = int(rssi_region)

            channel_region = line[col_channel:].strip().split()[0]
            channel_num = int(re.match(r"(\d+)", channel_region).group(1))

            freq = _channel_to_freq(channel_num)
            aps.append({
                "bssid": bssid,
                "ssid": ssid,
                "channel": channel_num,
                "rssi_dbm": rssi_dbm,
                "frequency_mhz": freq,
            })
        except (ValueError, IndexError, AttributeError) as exc:
            logger.debug("Skipping unparseable airport line: %s (%s)", line, exc)
            continue

    return aps


def scan_linux() -> list[dict]:
    """Scan WiFi networks on Linux.

    Attempts ``nmcli`` first (works without root on most distros).
    Falls back to ``iwlist wlan0 scan`` which typically requires root.
    """
    try:
        return _scan_linux_nmcli()
    except (FileNotFoundError, RuntimeError) as exc:
        logger.debug("nmcli scan failed (%s), falling back to iwlist.", exc)

    try:
        return _scan_linux_iwlist()
    except FileNotFoundError:
        raise RuntimeError(
            "Neither nmcli nor iwlist found. Install NetworkManager or "
            "wireless-tools, or run this script on a system with WiFi support."
        )
    except subprocess.CalledProcessError as exc:
        if "Operation not permitted" in str(exc) or exc.returncode == 1:
            raise RuntimeError(
                "iwlist scan requires elevated privileges. "
                "Try: sudo python3 pc-observer.py ... or use nmcli instead."
            )
        raise


def _scan_linux_nmcli() -> list[dict]:
    """Parse output of ``nmcli -t -f ... dev wifi list --rescan yes``."""
    try:
        output = subprocess.check_output(
            [
                "nmcli", "-t", "-f",
                "BSSID,SSID,CHAN,SIGNAL,FREQ",
                "dev", "wifi", "list", "--rescan", "yes",
            ],
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("nmcli wifi scan timed out (20 s).")

    aps: list[dict] = []
    for line in output.strip().splitlines():
        if not line.strip():
            continue
        # nmcli -t uses ':' as delimiter, but BSSID itself contains ':'.
        # BSSID is always 17 chars (XX\:XX\:XX\:XX\:XX\:XX with escaped colons
        # in -t mode, or plain colons).  We handle both.
        #
        # Format with escaped colons:
        #   AA\:BB\:CC\:DD\:EE\:FF:MySSID:6:75:2437 MHz
        # Format without escaping (older nmcli):
        #   AA:BB:CC:DD:EE:FF:MySSID:6:75:2437 MHz

        # Try escaped-colon variant first.
        m = re.match(
            r"^([0-9A-Fa-f]{2}(?:\\?:[0-9A-Fa-f]{2}){5})"  # BSSID
            r":(.*?)"                                         # SSID
            r":(\d+)"                                         # channel
            r":(\d+)"                                         # signal %
            r":(\d+)\s*MHz",                                  # frequency
            line,
        )
        if not m:
            logger.debug("Skipping unparseable nmcli line: %s", line)
            continue

        bssid_raw = m.group(1).replace("\\", "")
        ssid = m.group(2)
        channel = int(m.group(3))
        signal_pct = int(m.group(4))
        freq_mhz = int(m.group(5))

        # nmcli reports signal as 0-100 percentage.
        rssi_dbm = int(signal_pct / 2) - 100

        aps.append({
            "bssid": bssid_raw.upper(),
            "ssid": ssid,
            "channel": channel,
            "rssi_dbm": rssi_dbm,
            "frequency_mhz": freq_mhz,
        })
    return aps


def _scan_linux_iwlist() -> list[dict]:
    """Parse output of ``iwlist wlan0 scan``."""
    output = subprocess.check_output(
        ["iwlist", "wlan0", "scan"],
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )

    aps: list[dict] = []
    current: dict = {}

    for line in output.splitlines():
        line = line.strip()

        # New cell
        m = re.match(r"Cell \d+ - Address:\s*(\S+)", line)
        if m:
            if current.get("bssid"):
                aps.append(_finalize_iwlist_ap(current))
            current = {"bssid": m.group(1).upper()}
            continue

        # Channel
        m = re.search(r"Channel[:\s]+(\d+)", line)
        if m and "channel" not in current:
            current["channel"] = int(m.group(1))

        # Frequency
        m = re.search(r"Frequency[:\s]+(\d+(?:\.\d+)?)\s*GHz", line)
        if m:
            current["frequency_mhz"] = int(float(m.group(1)) * 1000)

        # ESSID
        m = re.search(r'ESSID:"([^"]*)"', line)
        if m:
            current["ssid"] = m.group(1)

        # Signal level
        m = re.search(r"Signal level[=:]?\s*(-?\d+)\s*dBm", line)
        if m:
            current["rssi_dbm"] = int(m.group(1))
        else:
            # Some drivers report quality as XX/100
            m = re.search(r"Quality[=:]?\s*(\d+)/(\d+)", line)
            if m:
                quality = int(m.group(1))
                max_q = int(m.group(2))
                pct = (quality / max_q) * 100
                current["rssi_dbm"] = int(pct / 2) - 100

    # Flush last
    if current.get("bssid"):
        aps.append(_finalize_iwlist_ap(current))

    return aps


def _finalize_iwlist_ap(ap: dict) -> dict:
    """Ensure all expected fields are present in an iwlist-parsed AP."""
    channel = ap.get("channel", 0)
    return {
        "bssid": ap.get("bssid", ""),
        "ssid": ap.get("ssid", ""),
        "channel": channel,
        "rssi_dbm": ap.get("rssi_dbm", -100),
        "frequency_mhz": ap.get("frequency_mhz", _channel_to_freq(channel)),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _channel_to_freq(channel: int) -> int:
    """Convert a WiFi channel number to a center frequency in MHz.

    Covers 2.4 GHz (channels 1-14) and common 5 GHz channels.
    Returns 0 for unknown channels.
    """
    if 1 <= channel <= 13:
        return 2407 + channel * 5
    if channel == 14:
        return 2484
    # 5 GHz: channel * 5 + 5000 for most UNII bands
    if 32 <= channel <= 177:
        return 5000 + channel * 5
    return 0


def get_scanner():
    """Return the appropriate scan function for the current platform.

    Raises RuntimeError if the platform is unsupported.
    """
    system = platform.system().lower()
    if system == "windows":
        return scan_windows
    if system == "darwin":
        return scan_macos
    if system == "linux":
        return scan_linux
    raise RuntimeError(
        f"Unsupported platform: {platform.system()}. "
        "Only Windows, macOS, and Linux are supported."
    )


# ---------------------------------------------------------------------------
# HTTP sender
# ---------------------------------------------------------------------------

def send_to_server(server_url: str, data: dict) -> int:
    """Send scan data to the central server via HTTP POST.

    Uses only stdlib ``http.client`` -- no requests/urllib3 needed.

    Args:
        server_url: Base URL of the central server (e.g. ``http://host:8080``).
        data: Scan payload dict to be JSON-encoded.

    Returns:
        HTTP status code from the server.

    Raises:
        Exception on connection failure (caller should handle gracefully).
    """
    parsed = urllib.parse.urlparse(server_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 8080
    scheme = parsed.scheme or "http"

    path = "/api/observers/scan"
    body = json.dumps(data).encode("utf-8")

    if scheme == "https":
        import ssl
        context = ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, port, timeout=5, context=context)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=5)

    try:
        conn.request(
            "POST",
            path,
            body,
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
        )
        resp = conn.getresponse()
        # Drain the response body so the connection can be reused/closed cleanly.
        resp.read()
        return resp.status
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="pc-observer.py",
        description=(
            "PM (Pochak Manager) PC Observer -- "
            "collects WiFi RSSI data and sends it to a central fusion server."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 pc-observer.py --id pc-node-1 --server http://192.168.1.100:8080\n"
            "  python3 pc-observer.py --id pc-node-2 --server http://server:8080 --interval 1 --verbose\n"
            "  python3 pc-observer.py --id test --dry-run --target-ssid MyRouter\n"
        ),
    )

    # Required arguments
    parser.add_argument(
        "--id",
        required=True,
        metavar="NODE_ID",
        help="Observer node ID (e.g. 'pc-node-1'). Must be unique per node.",
    )
    parser.add_argument(
        "--server",
        required=False,
        default="http://localhost:8080",
        metavar="URL",
        help="Central server URL (e.g. 'http://192.168.1.100:8080'). "
             "Default: http://localhost:8080",
    )

    # Optional arguments
    parser.add_argument(
        "--interval",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="Scan interval in seconds (default: 2.0).",
    )
    parser.add_argument(
        "--target-bssid",
        default=None,
        metavar="BSSID",
        help="Only report this BSSID (e.g. 'AA:BB:CC:DD:EE:FF'). "
             "All other APs are filtered out.",
    )
    parser.add_argument(
        "--target-ssid",
        default=None,
        metavar="SSID",
        help="Only report APs whose SSID contains this string (case-insensitive).",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose/debug logging.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan but do not send to server; print JSON to stdout instead.",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        metavar="PATH",
        help="Write log output to this file in addition to stderr.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    args = parser.parse_args(argv)

    # Validate BSSID format if provided.
    if args.target_bssid:
        cleaned = args.target_bssid.replace("-", ":").upper()
        if not re.match(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$", cleaned):
            logger.warning(
                "Invalid BSSID format '%s'. Expected XX:XX:XX:XX:XX:XX. "
                "Continuing without BSSID filter.",
                args.target_bssid,
            )
            args.target_bssid = None
        else:
            args.target_bssid = cleaned

    # Server URL is required when not in dry-run mode.
    if not args.dry_run and not args.server:
        parser.error("--server is required when not using --dry-run.")

    # Warn about 0.0.0.0 — not a connectable address from another machine
    if args.server and "0.0.0.0" in args.server:
        print(
            "\033[33m[WARNING]\033[0m 0.0.0.0 is a listen address, not a connectable address.\n"
            "          Use the server machine's actual IP instead.\n"
            "          Example: --server http://192.168.1.100:8080\n"
        )

    return args


# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

def print_banner(args: argparse.Namespace) -> None:
    """Print a startup banner with configuration summary."""
    system = platform.system()
    os_label = system
    if system == "Darwin":
        os_label = "Darwin (macOS)"

    node_id = args.id
    server = args.server if not args.dry_run else "(dry-run, no server)"
    interval = f"{args.interval:.1f}s"

    # Calculate padding for right-alignment inside the box.
    lines = [
        ("Node ID:", node_id),
        ("Server:", server),
        ("Interval:", interval),
        ("Platform:", os_label),
    ]
    if args.target_bssid:
        lines.append(("Filter BSSID:", args.target_bssid))
    if args.target_ssid:
        lines.append(("Filter SSID:", args.target_ssid))

    # Fixed box width
    box_inner = 42
    title1 = "PM (Pochak Manager) -- PC Observer"
    title2 = "WiFi RSSI Collection Agent"

    print()
    print(f"+{'=' * box_inner}+")
    print(f"|{title1:^{box_inner}}|")
    print(f"|{title2:^{box_inner}}|")
    print(f"+{'=' * box_inner}+")
    for label, value in lines:
        content = f"  {label:<16}{value}"
        print(f"|{content:<{box_inner}}|")
    print(f"+{'=' * box_inner}+")
    print()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns 0 on clean exit, 1 on fatal error."""
    args = parse_args(argv)
    configure_logging(verbose=args.verbose, log_file=args.log_file)

    # Resolve scanner for this platform.
    try:
        scanner = get_scanner()
    except RuntimeError as exc:
        logger.error("%s", exc)
        return 1

    print_banner(args)

    # Quick sanity check: can we actually run the scan command?
    logger.info("Running initial scan to verify platform tooling...")
    try:
        initial_aps = scanner()
        logger.info("Initial scan OK: found %d AP(s).", len(initial_aps))
    except RuntimeError as exc:
        logger.error("Initial scan failed: %s", exc)
        return 1
    except subprocess.CalledProcessError as exc:
        logger.error("Scan command failed (exit %d): %s", exc.returncode, exc)
        return 1

    seq = 0
    logger.info("Starting scan loop (interval=%.1fs). Press Ctrl+C to stop.", args.interval)

    while True:
        try:
            # -- Scan --
            try:
                aps = scanner()
            except Exception as exc:
                logger.warning("Scan error (seq=%d): %s", seq, exc)
                time.sleep(args.interval)
                continue

            # -- Filter --
            if args.target_bssid:
                aps = [
                    ap for ap in aps
                    if ap["bssid"].upper() == args.target_bssid
                ]

            if args.target_ssid:
                ssid_lower = args.target_ssid.lower()
                aps = [
                    ap for ap in aps
                    if ssid_lower in ap["ssid"].lower()
                ]

            # -- Build payload --
            data = {
                "observer_id": args.id,
                "timestamp_ms": int(time.time() * 1000),
                "platform": platform.system().lower(),
                "scan_seq": seq,
                "aps": aps,
            }

            # -- Send or print --
            if args.dry_run:
                print(json.dumps(data, indent=2))
            else:
                try:
                    status = send_to_server(args.server, data)
                    if args.verbose:
                        logger.debug(
                            "[seq=%d] Sent %d AP(s), server responded %d.",
                            seq, len(aps), status,
                        )
                    elif status >= 400:
                        logger.warning(
                            "[seq=%d] Server returned HTTP %d.", seq, status,
                        )
                except ConnectionRefusedError:
                    logger.warning(
                        "[seq=%d] Server unreachable (connection refused). "
                        "Will retry next cycle.",
                        seq,
                    )
                except OSError as exc:
                    logger.warning(
                        "[seq=%d] Network error: %s. Will retry next cycle.",
                        seq, exc,
                    )

            seq += 1

        except KeyboardInterrupt:
            print()
            logger.info("Stopped by user. Total scans: %d.", seq)
            return 0

        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
