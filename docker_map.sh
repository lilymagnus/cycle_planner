#!/bin/bash
#run with local map file


# === Config ===
WORK_DIR="$HOME/osrm"   
OSRM_IMAGE="osrm/osrm-backend"
PLATFORM="linux/amd64"
echo "=== Step 1: Extract OSRM data (bicycle profile) ==="
docker run --platform $PLATFORM -t -v "$WORK_DIR" $OSRM_IMAGE osrm-extract -p /opt/bicycle.lua derbyshire-260404.osm.pbf

echo "=== Step 2: Contract OSRM data ==="
docker run --platform $PLATFORM -t -v "$WORK_DIR:/data" $OSRM_IMAGE osrm-contract derbyshire-260404.osrm

echo "=== Step 3: Start OSRM server on http://localhost:5000 ==="
echo "Press Ctrl+C to stop the server."
docker run --platform $PLATFORM -t -i -p 5000:5000 -v "$WORK_DIR:/data" $OSRM_IMAGE osrm-routed derbyshire-260404.osrm
