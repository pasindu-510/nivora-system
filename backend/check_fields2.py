import django
import os
os.environ['DJANGO_SETTINGS_MODULE'] = 'shopapi.settings'
django.setup()
from core.models import Business
print('max_users field:', Business._meta.get_field('max_users'))
print('max_branches field:', Business._meta.get_field('max_branches'))