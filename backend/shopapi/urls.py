"""URL configuration for the shopapi project."""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve as media_serve
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from core.admin import admin_site

urlpatterns = [
    path('admin/', admin_site.urls),
    path('api/', include('core.urls')),
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path(
        'api/docs/',
        SpectacularSwaggerView.as_view(url_name='schema'),
        name='swagger-ui',
    ),
]

# Serve uploaded business logos. django.conf.urls.static.static() no-ops when
# DEBUG=False (this project runs dev with DEBUG=False, no .env), so declare the
# media route explicitly. In production the web server (cPanel/Apache) maps
# MEDIA_URL to the media directory and intercepts before Django, so this
# fallback is only reached in local dev.
urlpatterns += [
    re_path(
        r'^media/(?P<path>.*)$',
        media_serve,
        {'document_root': settings.MEDIA_ROOT},
    ),
]
