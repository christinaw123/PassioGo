from flask import Blueprint

api_bp = Blueprint("api", __name__, url_prefix="/api")

# import route modules so their @api_bp decorators register
from api import routes, vehicles  # noqa: E402, F401
