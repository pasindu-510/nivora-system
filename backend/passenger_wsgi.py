"""Phusion Passenger WSGI entry point (cPanel Setup Python App).

cPanel's "Setup Python App" (CloudLinux Python Selector) creates an app
whose startup file is `passenger_wsgi.py` and entry point is `application`.
Passenger imports this module and calls `application(environ, start_response)`.

Settings note: settings.py loads `backend/.env` via python-dotenv, so the
production `.env` (DB_ENGINE=mysql, STATIC_ROOT, ALLOWED_HOSTS, ...) must live
next to this file (i.e. in the Passenger application root).
"""
import os
import sys

# Ensure the app root (the directory containing this file) is importable so
# `shopapi.settings` resolves. Passenger does NOT guarantee the CWD is the
# app root, so anchor on this file, never os.getcwd().
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shopapi.settings')

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()