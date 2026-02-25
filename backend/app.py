import io
import os
import threading
import time
import zipfile

import requests

from flask import Flask
from flask_cors import CORS

from api import api_bp
from utils.gtfs_loader import build_static_gtfs_indices

GTFS_STATIC_URL = "https://passio3.com/harvard/passioTransit/gtfs/google_transit.zip"
GTFS_DIR = os.path.join(os.path.dirname(__file__), "data", "google_transit")
REFRESH_INTERVAL_S = 24 * 60 * 60  # re-download once per day


def download_and_reload_gtfs() -> None:
    """Download the latest GTFS zip, extract it in place, then rebuild indices."""
    try:
        print("GTFS refresh: downloading...", flush=True)
        resp = requests.get(GTFS_STATIC_URL, timeout=30)
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            zf.extractall(GTFS_DIR)
        print("GTFS refresh: extracted, rebuilding indices...", flush=True)
        build_static_gtfs_indices()
        print("GTFS refresh: done.", flush=True)
    except Exception as e:
        print(f"GTFS refresh failed: {e}", flush=True)


def _gtfs_refresh_loop() -> None:
    while True:
        time.sleep(REFRESH_INTERVAL_S)
        download_and_reload_gtfs()


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ])

    app.register_blueprint(api_bp)

    return app


if __name__ == "__main__":
    # Download fresh GTFS data on startup, then rebuild indices
    download_and_reload_gtfs()

    # Background thread refreshes every 24 h
    t = threading.Thread(target=_gtfs_refresh_loop, daemon=True)
    t.start()

    app = create_app()
    app.run(
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
        port=int(os.getenv("PORT", "5001")),
    )
