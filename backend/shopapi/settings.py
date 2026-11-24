"""
Django settings for the shopapi project.

Environment-driven configuration:
- Local dev falls back to SQLite when no MySQL credentials are provided.
- Production (register.lk cPanel) sets DB_ENGINE=mysql plus DB_* variables
  and DEBUG=False via .env (python-dotenv loads it below).
"""
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')


def env_bool(name, default=False):
    """Parse a boolean environment variable."""
    return os.environ.get(name, str(default)).strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(name, default=''):
    """Parse a comma-separated environment variable into a list."""
    raw = os.environ.get(name, default)
    return [part.strip() for part in raw.split(',') if part.strip()]


# ── Core security ────────────────────────────────────────────────────────────
# Production MUST set DJANGO_SECRET_KEY in .env (see .env.example).
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'insecure-dev-only-secret-key-change-me')
DEBUG = env_bool('DEBUG', False)
ALLOWED_HOSTS = env_list('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver')

# Production placeholders (nivora.lk cPanel, per spec section 9):
#   STATIC_ROOT = "/home/USERNAME/public_html/system/static"
#   MEDIA_ROOT  = "/home/USERNAME/public_html/system/media"
#   STATIC_URL  = "https://system.nivora.lk/static/"   (API subdomain serves
#     no static; admin/docs assets are pulled from the SPA origin instead).
STATIC_URL = os.environ.get('STATIC_URL', '/static/')
STATIC_ROOT = Path(os.environ.get('STATIC_ROOT', BASE_DIR / 'staticfiles'))
MEDIA_URL = '/media/'
MEDIA_ROOT = Path(os.environ.get('MEDIA_ROOT', BASE_DIR / 'media'))
# Private uploads (customer ID-card photos). Must NOT be under public_html:
# files here are only served by the API through short-lived signed links
# (blueprint B-24). Default sits next to manage.py, outside any web root.
PRIVATE_MEDIA_ROOT = Path(os.environ.get('PRIVATE_MEDIA_ROOT', BASE_DIR / 'private_media'))
# Lifetime of a signed ID-photo link, in seconds.
PRIVATE_MEDIA_URL_MAX_AGE = int(os.environ.get('PRIVATE_MEDIA_URL_MAX_AGE', 3600))

# ── Applications ─────────────────────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third-party
    'rest_framework',
    'rest_framework_simplejwt',
    'corsheaders',
    'drf_spectacular',
    'django_filters',
    # Local
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'core.middleware.TenantMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'shopapi.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'shopapi.wsgi.application'
ASGI_APPLICATION = 'shopapi.asgi.application'

# ── Database ─────────────────────────────────────────────────────────────────
# DB_ENGINE=mysql (with DB_NAME/DB_USER/DB_PASSWORD/DB_HOST/DB_PORT) selects
# MySQL/MariaDB; anything else falls back to SQLite so local migrate/tests run
# without a reachable server.
#
# Shared cPanel hosts often cannot compile mysqlclient (no mysql_config /
# build headers in CageFS). If `pip install mysqlclient` fails there, install
# PyMySQL instead (`pip install pymysql`) and set DB_DRIVER=pymysql below:
#   from pymysql import install_as_MySQLdb; install_as_MySQLdb()
# PyMySQL masquerades as MySQLdb, which Django's mysql backend imports.
if os.environ.get('DB_DRIVER', '').strip().lower() == 'pymysql':
    from pymysql import install_as_MySQLdb

    install_as_MySQLdb()

DB_ENGINE = os.environ.get('DB_ENGINE', '').strip().lower()
if DB_ENGINE in ('mysql', 'mariadb'):
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.mysql',
            'NAME': os.environ.get('DB_NAME', 'shopapi'),
            'USER': os.environ.get('DB_USER', 'root'),
            'PASSWORD': os.environ.get('DB_PASSWORD', ''),
            'HOST': os.environ.get('DB_HOST', '127.0.0.1'),
            'PORT': os.environ.get('DB_PORT', '3306'),
            'CONN_MAX_AGE': int(os.environ.get('DB_CONN_MAX_AGE', '60')),
            'OPTIONS': {'charset': 'utf8mb4'},
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }

# ── Auth ─────────────────────────────────────────────────────────────────────
AUTH_USER_MODEL = 'core.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# NOTE: djangorestframework-simplejwt reads ``SIMPLE_JWT`` (with underscore).
# It was previously misspelled ``SIMPLEJWT``, so these lifetimes were ignored
# and the library defaults (5 min access / 1 day refresh) applied.
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(
        minutes=int(os.environ.get('JWT_ACCESS_MINUTES', '60'))
    ),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=int(os.environ.get('JWT_REFRESH_DAYS', '7'))),
    'ROTATE_REFRESH_TOKENS': False,
    'UPDATE_LAST_LOGIN': False,
}

# ── Django REST Framework ────────────────────────────────────────────────────
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_FILTER_BACKENDS': (
        'django_filters.rest_framework.DjangoFilterBackend',
    ),
    # The whole frontend sends its text filter as `q=...`, so align DRF's
    # SearchFilter with that name instead of the default `search=`.
    'SEARCH_PARAM': 'q',
    'DEFAULT_PAGINATION_CLASS': 'core.pagination.StandardResultsPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
}

SPECTACULAR_SETTINGS = {
    'TITLE': 'Shop API',
    'DESCRIPTION': (
        'Multi-tenant electric & kitchen appliances shop management system. '
        'JWT auth: obtain a token at /api/auth/login/ and send '
        '"Authorization: Bearer <access>".'
    ),
    'VERSION': '0.1.0',
    'SERVE_INCLUDE_SCHEMA': False,
}

# ── CORS (React SPA on another origin) ───────────────────────────────────────
CORS_ALLOWED_ORIGINS = env_list(
    'CORS_ALLOWED_ORIGINS', 'http://localhost:5173'
)
CORS_ALLOW_ALL_ORIGINS = env_bool('CORS_ALLOW_ALL_ORIGINS', False)

# ── Internationalization / time ──────────────────────────────────────────────
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Asia/Colombo'
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
