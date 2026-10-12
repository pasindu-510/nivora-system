import django
import os
os.environ['DJANGO_SETTINGS_MODULE'] = 'shopapi.settings'
django.setup()
from core.models import Business
f_max_users = Business._meta.get_field('max_users')
f_max_branches = Business._meta.get_field('max_branches')
print('max_users attrs:', f_max_users.__dict__)
print('max_branches attrs:', f_max_branches.__dict__)