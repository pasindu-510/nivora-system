"""WSGI entry point (Phusion Passenger loads shopapi.wsgi:application)."""
import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shopapi.settings')

application = get_wsgi_application()
