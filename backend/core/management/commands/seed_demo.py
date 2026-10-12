"""Seed demo data: tenant, users, catalog, stock, customers, a supplier.

Usage:
    python manage.py seed_demo

Idempotent: each resource is created only if missing, so re-running the
command is safe and only fills gaps (e.g. a supplier added later).
"""
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import (
    Branch,
    Brand,
    Business,
    CashAccount,
    Category,
    Customer,
    Item,
    RoleConstants,
    StockLot,
    StockMovement,
    Supplier,
    User,
)

DEFAULT_PASSWORD = 'ShopPass123!'

CATALOG = [
    # (code, name, category_name, brand_name, cost, price, stock, threshold)
    ('REF-001', 'Samsung 250L Refrigerator', 'Cooling', 'Samsung',
     '120000.00', '145000.00', 8, 3),
    ('REF-002', 'LG 310L French Door Fridge', 'Cooling', 'LG',
     '240000.00', '275000.00', 4, 2),
    ('WM-001', 'Samsung 8kg Front Load Washer', 'Laundry', 'Samsung',
     '85000.00', '99900.00', 6, 3),
    ('WM-002', 'LG 7kg Twin Tub Washer', 'Laundry', 'LG',
     '55000.00', '68000.00', 10, 4),
    ('MW-001', 'Panasonic 23L Microwave', 'Kitchen', 'Panasonic',
     '28000.00', '35500.00', 15, 5),
    ('AC-001', 'LG 1.5T Split AC', 'Cooling', 'LG',
     '180000.00', '209000.00', 5, 2),
    ('HT-001', 'Resys 2000W Hair Dryer', 'Small Appliances', 'Resys',
     '6500.00', '8900.00', 30, 10),
    ('HT-002', 'Philips 1200W Iron', 'Small Appliances', 'Philips',
     '7800.00', '10500.00', 25, 8),
]


class Command(BaseCommand):
    help = 'Seed demo data for local development (idempotent).'

    @transaction.atomic
    def handle(self, *args, **options):
        created = []

        business, was_created = Business.objects.get_or_create(
            name='Acme Appliances',
            defaults={
                'address': '123 Main Street, Colombo',
                'phone': '+94 11 234 5678',
                'email': 'shop@acme.example',
                'is_active': True,
                'tax_rate': Decimal('10.00'),
                'cashier_discount_cap': Decimal('20.00'),
            },
        )
        if was_created:
            created.append('business')

        if not User.objects.filter(username='superadmin').exists():
            super_admin = User.objects.create_superuser(
                username='superadmin', email='super@acme.example',
                password=DEFAULT_PASSWORD, role=RoleConstants.SUPER_ADMIN,
                full_name='System Owner',
            )
            created.append('superadmin')
        else:
            super_admin = User.objects.get(username='superadmin')

        if business.created_by_id is None and super_admin.pk:
            business.created_by = super_admin
            business.save(update_fields=['created_by'])

        user_specs = [
            ('admin', RoleConstants.BUSINESS_ADMIN, 'Business Admin'),
            ('manager', RoleConstants.MANAGER, 'Store Manager'),
            ('cashier', RoleConstants.CASHIER, 'Cashier'),
        ]
        for username, role, full_name in user_specs:
            if User.objects.filter(username=username).exists():
                continue
            User.objects.create_user(
                username=username, password=DEFAULT_PASSWORD,
                role=role, business=business, full_name=full_name,
            )
            created.append(username)

        branch, was_created = Branch.objects.get_or_create(
            business=business, name='Main Branch',
            defaults={
                'address': '123 Main Street, Colombo',
                'phone': '+94 11 234 5678',
            },
        )
        if was_created:
            created.append('branch')

        for username in ('admin', 'manager', 'cashier'):
            user = User.objects.filter(username=username).first()
            if user and user.branch_id is None:
                user.branch = branch
                user.save(update_fields=['branch'])

        # Categories & brands.
        cat_names = {c[2] for c in CATALOG}
        brand_names = {c[3] for c in CATALOG}
        cats = {}
        for name in sorted(cat_names):
            cat, created_now = Category.objects.get_or_create(
                business=business, name=name
            )
            cats[name] = cat
            if created_now:
                created.append(f'category:{name}')
        # Small Appliances nests under Kitchen.
        if 'Kitchen' in cats and 'Small Appliances' in cats:
            kitchen = cats['Kitchen']
            sa = cats['Small Appliances']
            if sa.parent_id is None:
                sa.parent = kitchen
                sa.save(update_fields=['parent'])

        brands = {}
        for name in sorted(brand_names):
            brand, created_now = Brand.objects.get_or_create(
                business=business, name=name
            )
            brands[name] = brand
            if created_now:
                created.append(f'brand:{name}')

        for code, name, cat_name, brand_name, cost, price, stock, threshold in CATALOG:
            item, created_now = Item.objects.get_or_create(
                business=business, code=code,
                defaults={
                    'name': name, 'category': cats[cat_name],
                    'brand': brands[brand_name], 'cost_price': Decimal(cost),
                    'selling_price': Decimal(price),
                    'stock_quantity': stock,
                    'low_stock_threshold': threshold,
                },
            )
            if created_now:
                created.append(f'item:{code}')
            if not StockLot.objects.filter(
                business=business, item=item, source=StockLot.OPENING
            ).exists():
                StockLot.objects.create(
                    business=business, branch=branch, item=item,
                    quantity_total=stock, quantity_remaining=stock,
                    unit_cost=Decimal(cost), source=StockLot.OPENING,
                )
                created.append(f'lot:{code}')
            if not StockMovement.objects.filter(
                business=business, item=item, reference='OPENING'
            ).exists():
                admin_user = User.objects.filter(username='admin').first()
                StockMovement.objects.create(
                    business=business, branch=branch, item=item,
                    type=StockMovement.IN, quantity=stock,
                    reference='OPENING', created_by=admin_user,
                )

        customer_specs = [
            ('Nimal Perera', '+94 77 123 4567', '882233445V', '45 Lake Road, Kandy'),
            ('Kavindi Silva', '+94 71 987 6543', '921122334V', '12 Temple St, Galle'),
        ]
        for name, phone, nic, address in customer_specs:
            cust, created_now = Customer.objects.get_or_create(
                business=business, name=name,
                defaults={'phone': phone, 'nic': nic, 'address': address},
            )
            if created_now:
                created.append(f'customer:{name}')

        supplier, created_now = Supplier.objects.get_or_create(
            business=business, name='Colombo Electronics Distributors',
            defaults={
                'contact_person': 'Ruwan Fernando',
                'phone': '+94 11 456 7890',
                'email': 'sales@ced.example',
                'address': '88 Warehouse Lane, Colombo',
                'is_active': True,
            },
        )
        if created_now:
            created.append('supplier')

        accounts = [
            ('Main Cash Drawer', CashAccount.CASH, '50000.00'),
            ('Bank Account', CashAccount.BANK, '1500000.00'),
        ]
        for name, acct_type, opening in accounts:
            acct, created_now = CashAccount.objects.get_or_create(
                business=business, name=name,
                defaults={
                    'type': acct_type, 'opening_balance': Decimal(opening),
                },
            )
            if created_now:
                created.append(f'account:{name}')

        supplier_count = Supplier.objects.filter(business=business).count()

        # Console summary.
        if created:
            self.stdout.write(self.style.SUCCESS(
                f'Created: {", ".join(created)}'
            ))
            self.stdout.write(self.style.SUCCESS(
                'Login users: superadmin / admin / manager / cashier — '
                f'password: {DEFAULT_PASSWORD}'
            ))
        else:
            self.stdout.write(self.style.WARNING('Nothing to create — all data present.'))
        self.stdout.write(f'Suppliers in demo business: {supplier_count}')