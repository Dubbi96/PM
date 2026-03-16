#!/usr/bin/env bash
# ======================================================================
#  RuView Location Environment Launcher
#
#  Usage:
#    ./start-location.sh [sim|ui|esp32]   (default: sim)
#
#  Starts:
#    - Backend API (uvicorn) on port 8080
#    - UI HTTP server on port 8081
#    - Opens http://localhost:8081/location.html in browser
#
#  chmod +x start-location.sh
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
UI_DIR="${SCRIPT_DIR}/ui"
PROFILES_DIR="${SCRIPT_DIR}/profiles"

BACKEND_PORT=8080
UI_PORT=8081

# ─── Colors ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

# ─── Helpers ─────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}[INFO]${RESET}  $1"; }
ok()    { echo -e "${GREEN}[OK]${RESET}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $1"; }
err()   { echo -e "${RED}[ERROR]${RESET} $1"; }
die()   { err "$1"; exit 1; }

# ─── Profile argument ───────────────────────────────────────────────
PROFILE="${1:-sim}"

case "$PROFILE" in
    sim)    ENV_FILE="${PROFILES_DIR}/dev-sim.env" ;;
    ui)     ENV_FILE="${PROFILES_DIR}/dev-ui.env" ;;
    esp32)  ENV_FILE="${PROFILES_DIR}/live-esp32.env" ;;
    *)
        err "Unknown profile: ${PROFILE}"
        echo ""
        echo "Usage: $0 [sim|ui|esp32]"
        echo ""
        echo "  sim    Development with mock hardware (default)"
        echo "  ui     UI development with mock hardware"
        echo "  esp32  Live mode with ESP32 hardware"
        exit 1
        ;;
esac

if [ ! -f "$ENV_FILE" ]; then
    die "Profile env file not found: ${ENV_FILE}"
fi

# ─── Banner ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}======================================================================"
echo "  RuView Location Environment"
echo -e "======================================================================${RESET}"
echo ""
echo -e "  Profile:      ${BOLD}${PROFILE}${RESET}"
echo -e "  Env file:     ${DIM}${ENV_FILE}${RESET}"
echo -e "  Backend:      ${BOLD}http://localhost:${BACKEND_PORT}${RESET}"
echo -e "  UI:           ${BOLD}http://localhost:${UI_PORT}${RESET}"
echo -e "  Dashboard:    ${BOLD}http://localhost:${UI_PORT}/location.html${RESET}"
echo ""

# ─── Port check ─────────────────────────────────────────────────────
check_port() {
    local port="$1"
    local label="$2"
    if lsof -iTCP:"${port}" -sTCP:LISTEN -t &>/dev/null; then
        die "Port ${port} is already in use (${label}). Stop the conflicting process first."
    fi
    ok "Port ${port} is available (${label})"
}

check_port "${BACKEND_PORT}" "Backend API"
check_port "${UI_PORT}" "UI Server"

# ─── Load env file ──────────────────────────────────────────────────
info "Loading environment from ${ENV_FILE}"
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# Override PORT to use BACKEND_PORT (avoid port 3000 or profile defaults)
export PORT="${BACKEND_PORT}"
ok "Environment loaded (PORT overridden to ${BACKEND_PORT})"

# ─── Python venv ─────────────────────────────────────────────────────
if [ ! -d "${VENV_DIR}" ]; then
    info "Creating Python virtual environment at ${VENV_DIR}"
    python3 -m venv "${VENV_DIR}"
    ok "Virtual environment created"
else
    ok "Virtual environment exists at ${VENV_DIR}"
fi

# Activate venv
# shellcheck source=/dev/null
source "${VENV_DIR}/bin/activate"
ok "Virtual environment activated ($(python3 --version))"

# ─── Install dependencies ───────────────────────────────────────────
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"
MARKER_FILE="${VENV_DIR}/.deps-installed"

if [ ! -f "${MARKER_FILE}" ] || [ "${REQUIREMENTS_FILE}" -nt "${MARKER_FILE}" ]; then
    info "Installing dependencies from requirements.txt..."
    pip install --quiet --upgrade pip
    pip install --quiet -r "${REQUIREMENTS_FILE}"
    touch "${MARKER_FILE}"
    ok "Dependencies installed"
else
    ok "Dependencies already up to date"
fi

# ─── Verify UI directory ────────────────────────────────────────────
if [ ! -d "${UI_DIR}" ]; then
    die "UI directory not found: ${UI_DIR}"
fi

if [ ! -f "${UI_DIR}/location.html" ]; then
    die "location.html not found in ${UI_DIR}"
fi

ok "UI directory verified (${UI_DIR})"

# ─── PID tracking & cleanup ─────────────────────────────────────────
BACKEND_PID=""
UI_PID=""

cleanup() {
    echo ""
    info "Shutting down..."

    if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
        info "Stopping backend server (PID ${BACKEND_PID})"
        kill "${BACKEND_PID}" 2>/dev/null || true
        wait "${BACKEND_PID}" 2>/dev/null || true
    fi

    if [ -n "${UI_PID}" ] && kill -0 "${UI_PID}" 2>/dev/null; then
        info "Stopping UI server (PID ${UI_PID})"
        kill "${UI_PID}" 2>/dev/null || true
        wait "${UI_PID}" 2>/dev/null || true
    fi

    ok "All processes stopped"
    echo ""
}

trap cleanup SIGINT SIGTERM EXIT

# ─── Start Backend (via main.py which runs uvicorn internally) ──────
echo ""
info "Starting backend server on port ${BACKEND_PORT}..."

cd "${SCRIPT_DIR}"
python3 v1/src/main.py &
BACKEND_PID=$!

ok "Backend server started (PID ${BACKEND_PID})"

# ─── Start UI HTTP server ───────────────────────────────────────────
info "Starting UI server on port ${UI_PORT}..."

python3 -m http.server "${UI_PORT}" \
    --directory "${UI_DIR}" \
    --bind 0.0.0.0 \
    &>/dev/null &
UI_PID=$!

ok "UI server started (PID ${UI_PID})"

# ─── Open browser ───────────────────────────────────────────────────
DASHBOARD_URL="http://localhost:${UI_PORT}/location.html"

# Wait a moment for servers to start
sleep 1

if command -v open &>/dev/null; then
    # macOS
    open "${DASHBOARD_URL}" 2>/dev/null || true
elif command -v xdg-open &>/dev/null; then
    # Linux
    xdg-open "${DASHBOARD_URL}" 2>/dev/null || true
fi

# ─── Running status ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}======================================================================"
echo "  RuView Location is running"
echo -e "======================================================================${RESET}"
echo ""
echo -e "  ${GREEN}Backend API${RESET}    http://localhost:${BACKEND_PORT}"
echo -e "  ${GREEN}API Docs${RESET}       http://localhost:${BACKEND_PORT}/docs"
echo -e "  ${GREEN}UI Server${RESET}      http://localhost:${UI_PORT}"
echo -e "  ${GREEN}Dashboard${RESET}      http://localhost:${UI_PORT}/location.html"
echo ""
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop all services"
echo ""

# ─── Wait for background processes ──────────────────────────────────
set +e
wait
