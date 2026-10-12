import django
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shopapi.settings')
django.setup()

from core.models import Business
fields = [f.name for f in Business._meta.get_fields()]
print("All field names:")
for f in fields:
    print(f"  {f}")

# Check for reverse managers
related_fields = [f for f in fields if '+' in str(f) or 'related' in str(f).lower()]
print("\nRelated fields:")
for f in related_fields:
    print(f"  {f}")

# Check branchs/categorys etc
for f in fields:
    f_str = str(f)
    if 'branchs' in f_str or 'categorys' in f_str or 'brands' in f_str or 'items' in f_str or 'users' in f_str:
        print(f"\nField with reverse manager: {f}")
        # Check if it's a reverse relation
        if hasattr(f, 'related_query_name'):
            print(f"  related_query_name: {f.related_query_name()}")