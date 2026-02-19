import os

from flask import Flask
from flask_cors import CORS

from api import api_bp
from utils.gtfs_loader import build_static_gtfs_indices


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ])

    # register API blueprint
    app.register_blueprint(api_bp)

    return app


if __name__ == "__main__":
    build_static_gtfs_indices()
    print("GTFS indices built successfully.")

    app = create_app()
    app.run(
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
        port=int(os.getenv("PORT", "5001")),
    )
