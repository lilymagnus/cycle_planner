#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  setup_osrm.sh  —  Download OSM data & start OSRM bike router
#
#  Usage:
#    ./setup_osrm.sh <region>
#
#  Examples:
#    ./setup_osrm.sh england
#    ./setup_osrm.sh greater-manchester
#    ./setup_osrm.sh derbyshire
#
#  Regions: https://download.geofabrik.de/europe/great-britain.html
# ═══════════════════════════════════════════════════════════════

set -e  # exit on any error

# ── Config ────────────────────────────────────────────────────
REGION="${1}"
WORK_DIR="$HOME/osrm-bike"
OSRM_IMAGE="osrm/osrm-backend"
PLATFORM="linux/amd64" #intel 
OSRM_PORT=5001
FLASK_PORT=5000

GEOFABRIK_BASE="https://download.geofabrik.de/europe/great-britain"

# ── Colours for output ────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # no colour

info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Usage check ───────────────────────────────────────────────
if [ -z "$REGION" ]; then
  echo ""
  echo "  Usage: ./setup_osrm.sh <region>"
  echo ""
  echo "  Common regions:"
  echo "    england"
  echo "    greater-manchester"
  echo "    derbyshire"
  echo "    yorkshire"
  echo "    lancashire"
  echo "    cheshire"
  echo ""
  echo "  Full list: https://download.geofabrik.de/europe/great-britain.html"
  echo ""
  exit 1
fi

# ── Check dependencies ────────────────────────────────────────
info "Checking dependencies…"

command -v docker >/dev/null 2>&1 || error "Docker is not installed. Get it from https://www.docker.com"
command -v curl   >/dev/null 2>&1 || error "curl is not installed."
command -v python3 >/dev/null 2>&1 || warn "python3 not found — Flask app won't auto-start"

success "Dependencies OK"

# ── Prepare working directory ─────────────────────────────────
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

PBF_FILE="${REGION}-latest.osm.pbf"
DOWNLOAD_URL="${GEOFABRIK_BASE}/${PBF_FILE}"

# ── Download OSM data ─────────────────────────────────────────
if [ -f "$PBF_FILE" ]; then
  warn "Found existing file: $PBF_FILE"
  read -p "  Re-download? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Downloading $PBF_FILE from Geofabrik…"
    curl -L --progress-bar -o "$PBF_FILE" "$DOWNLOAD_URL" || error "Download failed. Check region name at https://download.geofabrik.de/europe/great-britain.html"
  else
    info "Using existing file."
  fi
else
  info "Downloading $PBF_FILE from Geofabrik…"
  curl -L --progress-bar -o "$PBF_FILE" "$DOWNLOAD_URL" || error "Download failed. Check region name at https://download.geofabrik.de/europe/great-britain.html"
fi

success "OSM data ready: $PBF_FILE"

# ── Stop any existing OSRM container ─────────────────────────
EXISTING=$(docker ps -q --filter "publish=${OSRM_PORT}")
if [ -n "$EXISTING" ]; then
  warn "Stopping existing OSRM container on port ${OSRM_PORT}…"
  docker stop "$EXISTING" >/dev/null
fi

# ── Pull OSRM Docker image ────────────────────────────────────
info "Pulling OSRM Docker image…"
docker pull --platform "$PLATFORM" "$OSRM_IMAGE" >/dev/null
success "OSRM image ready"

# ── Extract ───────────────────────────────────────────────────
info "Extracting OSRM data with bicycle profile (this may take a few minutes)…"
docker run --platform "$PLATFORM" --rm \
  -v "${WORK_DIR}:/data" \
  "$OSRM_IMAGE" \
  osrm-extract -p /opt/bicycle.lua "/data/${PBF_FILE}"
success "Extraction complete"

# ── Contract ──────────────────────────────────────────────────
info "Contracting OSRM data (this may take a few minutes)…"
docker run --platform "$PLATFORM" --rm \
  -v "${WORK_DIR}:/data" \
  "$OSRM_IMAGE" \
  osrm-contract "/data/${REGION}-latest.osrm"
success "Contraction complete"

# ── Start OSRM server ─────────────────────────────────────────
info "Starting OSRM routing server on http://localhost:${OSRM_PORT}…"
docker run --platform "$PLATFORM" -d \
  --name "osrm-bike-${REGION}" \
  -p "${OSRM_PORT}:5000" \
  -v "${WORK_DIR}:/data" \
  "$OSRM_IMAGE" \
  osrm-routed --algorithm mld \
               --max-table-size 10000 \
               "/data/${REGION}-latest.osrm"

# Wait for OSRM to be ready
info "Waiting for OSRM to be ready…"
for i in {1..15}; do
  if curl -s "http://localhost:${OSRM_PORT}/health" >/dev/null 2>&1 || \
     curl -s "http://localhost:${OSRM_PORT}/nearest/v1/bicycle/0,0" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
success "OSRM server running on http://localhost:${OSRM_PORT}"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅  OSRM is ready!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "  Routing API : http://localhost:${OSRM_PORT}"
echo "  Region      : ${REGION}"
echo "  Profile     : bicycle"
echo ""
echo "  Test it:"
echo "  curl \"http://localhost:${OSRM_PORT}/route/v1/bicycle/-2.24,53.48;-2.23,53.49?overview=false\""
echo ""
echo "  To stop OSRM:"
echo "  docker stop osrm-bike-${REGION}"
echo ""

# ── Start Flask app if cycle_planner.py exists ────────────────
if [ -f "$HOME/Desktop/cycle_planner.py" ]; then
  info "Starting Cycle Planner app…"
  python3 "$HOME/Desktop/cycle_planner.py"
fi