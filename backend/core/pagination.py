"""Shared DRF pagination (applied to list endpoints via settings default)."""
from rest_framework.pagination import PageNumberPagination


class StandardResultsPagination(PageNumberPagination):
    """20-item pages, clients may request up to 100 per page."""

    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100
