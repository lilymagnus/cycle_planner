#!/usr/bin/env python3
"""
Cycle Trip Planner
──────────────────
A browser-based GUI for planning cycling routes.
No native macOS dependencies — runs in any browser.

Requirements:
    pip install flask requests svgwrite

Run:
    python3 cycle_planner.py
Then open: http://localhost:5000
"""

import io
import json
import threading
import webbrowser
from flask import Flask, request, jsonify, send_file, render_template
import requests as req
import svgwrite

app = Flask(__name__)

NOMINATIM  = "https://nominatim.openstreetmap.org/search"
OSRM_ROUTE = "http://localhost:5001/route/v1/bicycle/{coords}"
HEADERS    = {"User-Agent": "CyclePlannerApp/1.0 (personal use)"}

# ─── Flask routes ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template('index.html')


@app.route("/geocode", methods=["POST"])
def geocode():
    query = request.json.get("query", "").strip()
    try:
        r = req.get(NOMINATIM,
                    params={"q": query, "format": "json", "limit": 1},
                    headers=HEADERS, timeout=10)
        data = r.json()
        if data:
            return jsonify({"lat": float(data[0]["lat"]),
                            "lon": float(data[0]["lon"]),
                            "name": data[0].get("display_name", query).split(",")[0].strip()})
    except Exception as e:
        return jsonify({"error": str(e)})
    return jsonify({"error": "not found"})


@app.route("/route", methods=["POST"])
def route():
    wps = request.json.get("waypoints", [])
    if len(wps) < 2:
        return jsonify({"error": "need 2+ waypoints"})
    coord_str = ";".join(f"{w['lon']},{w['lat']}" for w in wps)
    url = OSRM_ROUTE.format(coords=coord_str)
    try:
        print("Calling OSRM:", url)
        r = req.get(url,
                    params={"overview": "full", "geometries": "geojson"},
                    headers=HEADERS, timeout=25)
        data = r.json()
        print("OSRM status:", r.status_code)
        print("OSRM response:", r.text[:500])
        if data.get("code") == "Ok":
            rt      = data["routes"][0]
            coords  = rt["geometry"]["coordinates"]
            points  = [[lat, lon] for lon, lat in coords]
            km      = rt["distance"] / 1000
            mins    = int(rt["duration"] / 60)
            hrs, mn = divmod(mins, 60)
            t_str   = f"{hrs}h {mn}m" if hrs else f"{mn}m"
            stats   = f"{km:.1f} km  ·  ~{t_str} cycling"
            return jsonify({"points": points, "stats": stats})
        return jsonify({"error": "OSRM error: " + data.get("code", "unknown")})
    except Exception as e:
        return jsonify({"error": str(e)})


@app.route("/export_svg", methods=["POST"])
def export_svg_route():
    data         = request.json
    route_points = data.get("route_points", [])
    wps          = data.get("waypoints", [])

    if not route_points:
        return jsonify({"error": "no route"}), 400

    W, H, pad = 1200, 900, 50
    lats = [p[0] for p in route_points]
    lons = [p[1] for p in route_points]
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    lat_span = (max_lat - min_lat) or 0.01
    lon_span = (max_lon - min_lon) or 0.01
    min_lat -= lat_span * 0.1;  max_lat += lat_span * 0.1
    min_lon -= lon_span * 0.1;  max_lon += lon_span * 0.1

    def proj(lat, lon):
        x = pad + (lon - min_lon) / (max_lon - min_lon) * (W - 2 * pad)
        y = H - pad - (lat - min_lat) / (max_lat - min_lat) * (H - 2 * pad)
        return x, y

    buf = io.StringIO()
    dwg = svgwrite.Drawing(buf, size=(f"{W}px", f"{H}px"))
    dwg.viewbox(0, 0, W, H)
    dwg.add(dwg.rect(insert=(0, 0), size=(W, H), fill="#fafafa"))

    for i in range(1, 7):
        x = pad + (W - 2 * pad) * i / 7
        y = pad + (H - 2 * pad) * i / 7
        dwg.add(dwg.line((x, pad), (x, H - pad), stroke="#e8e8e8", stroke_width=0.5, stroke_dasharray="4,4"))
        dwg.add(dwg.line((pad, y), (W - pad, y), stroke="#e8e8e8", stroke_width=0.5, stroke_dasharray="4,4"))

    pts = [proj(p[0], p[1]) for p in route_points]
    dwg.add(dwg.polyline(points=pts, fill="none", stroke="#b0c0e0", stroke_width=7,
                         stroke_linecap="round", stroke_linejoin="round"))
    dwg.add(dwg.polyline(points=pts, fill="none", stroke="#4a7fe0", stroke_width=4,
                         stroke_linecap="round", stroke_linejoin="round"))

    n = len(wps)
    for i, wp in enumerate(wps):
        x, y   = proj(wp["lat"], wp["lon"])
        colour = "#4ccc99" if i == 0 or i == n - 1 else "#5b8dff"
        dwg.add(dwg.circle(center=(x, y), r=10, fill=colour, stroke="white", stroke_width=2.5))
        dwg.add(dwg.text(str(i + 1), insert=(x, y + 4), text_anchor="middle",
                         font_size=9, font_family="Arial, sans-serif", fill="white", font_weight="bold"))
        label = wp.get("name", f"Stop {i+1}")
        dwg.add(dwg.text(label, insert=(x + 14, y + 4),
                         font_size=11, font_family="Arial, sans-serif", fill="#222"))

    dwg.add(dwg.text("Cycle Route Plan", insert=(pad, 32), font_size=22, font_weight="bold",
                     font_family="Arial, sans-serif", fill="#111"))
    dwg.add(dwg.text("© OpenStreetMap contributors · Routing by OSRM",
                     insert=(pad, H - 10), font_size=9, font_family="Arial, sans-serif", fill="#aaa"))

    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix='.svg', delete=False) as tmp:
        tmp_path = tmp.name
    dwg.filename = tmp_path
    dwg.save()
    with open(tmp_path, 'rb') as f:
        svg_bytes = f.read()
    os.unlink(tmp_path)
    return send_file(io.BytesIO(svg_bytes), mimetype="image/svg+xml",
                     as_attachment=True, download_name="cycle_route.svg")


# ─── Launch ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\nCycle Trip Planner")
    print("  ──────────────────────")
    print("  Opening at http://localhost:5000\n")
    #wait 1 second, then open the browser. 
    #1 second delay is there because Flask needs a moment to start up its server.
    threading.Timer(1.0, lambda: webbrowser.open("http://localhost:5000")).start()
    app.run(debug=False, port=5000)
