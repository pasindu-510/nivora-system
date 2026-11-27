"""Read-only audit trail for the business owner."""
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters
from rest_framework.viewsets import ReadOnlyModelViewSet

from ..models import ActivityLog
from ..permissions import IsBusinessAdmin
from ..serializers import ActivityLogSerializer


class ActivityLogViewSet(ReadOnlyModelViewSet):
    """``GET /api/activity-logs/`` — newest first; no writes of any kind."""

    serializer_class = ActivityLogSerializer
    permission_classes = [IsBusinessAdmin]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter]
    filterset_fields = ['action', 'record_type', 'record_id']
    search_fields = ['username', 'label', 'details']

    def get_queryset(self):
        return ActivityLog.objects.for_business(self.request.user.business)
