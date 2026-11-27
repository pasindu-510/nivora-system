"""One business must never see, change or reference another business's data.

Business A's records all carry a marker string. Business B's staff then try
every read, write and cross-reference the API offers.
"""
from datetime import timedelta
from decimal import Decimal

from django.apps import apps
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (
    ActivityLog, Branch, Brand, CapitalEntry, CashAccount, Category, Customer,
    Expense, ExpenseCategory, Installment, Item, Payment, Purchase,
    PurchaseItem, RecurringExpense, Sale, SeasonalDiscount, StockLot,
    StockMovement, Supplier, SupplierPayment, User,
)
from .tests import _make_branch, _make_business, _make_item, _make_user

MARK = 'ZZSECRET'


class TenantIsolationTests(APITestCase):
    def _build(self, tag, key):
        """A business with one of everything, created through the API."""
        biz = _make_business(f'{tag} Shop', tax_rate='0')
        ids = {'business': biz.id}
        branch = _make_branch(biz)
        branch.name = f'{tag} branch'
        branch.save()
        admin = _make_user(f'{tag}-admin-{key}', 'business_admin', biz)
        manager = _make_user(f'{tag}-manager-{key}', 'manager', biz)
        cashier = _make_user(f'{tag}-cashier-{key}', 'cashier', biz)
        self.client.force_authenticate(admin)

        def post(url, body, expect=(200, 201)):
            res = self.client.post(url, body, format='json')
            self.assertIn(res.status_code, expect, (url, res.data))
            return res.data

        today = timezone.localdate().isoformat()
        ids['branches'] = branch.id
        ids['users'] = cashier.id
        ids['categories'] = post('/api/categories/', {'name': f'{tag} category'})['id']
        ids['brands'] = post('/api/brands/', {'name': f'{tag} brand'})['id']
        item = _make_item(biz, f'{tag}-CODE', '10', '1000', opening=0)
        item.name = f'{tag} product'
        item.save()
        ids['items'] = item.id
        ids['customers'] = post('/api/customers/', {
            'name': f'{tag} buyer', 'phone': f'{tag}-phone', 'nic': f'{tag}-nic'})['id']
        ids['guarantor'] = post('/api/customers/', {'name': f'{tag} guarantor'})['id']
        ids['suppliers'] = post('/api/suppliers/', {'name': f'{tag} supplier'})['id']
        ids['cash-accounts'] = post('/api/cash-accounts/', {
            'name': f'{tag} till', 'type': 'CASH', 'opening_balance': '100000'})['id']
        post('/api/stock-ins/', {
            'source': 'OPENING', 'branch': branch.id,
            'lines': [{'item': item.id, 'quantity': 10, 'unit_cost': '10'}]})
        ids['stock-lots'] = StockLot.objects.filter(business=biz).first().id
        ids['stock-movements'] = StockMovement.objects.filter(business=biz).first().id
        biz.required_guarantors = 1
        biz.save()
        admin.refresh_from_db()
        self.client.force_authenticate(admin)
        sale = post('/api/sales/', {
            'branch': branch.id, 'customer': ids['customers'],
            'guarantors': [ids['guarantor']],
            'lines': [{'item': item.id, 'quantity': 1}],
            'is_single_payment': False, 'down_payment': '100',
            'number_of_installments': 3})
        ids['sales'] = sale['id']
        ids['installment'] = Installment.objects.filter(sale_id=sale['id']).first().id
        Installment.objects.filter(sale_id=sale['id'], number=1).update(
            due_date=timezone.localdate() - timedelta(days=3))
        ids['payments'] = Payment.objects.filter(business=biz).first().id
        ids['purchases'] = post('/api/purchases/', {
            'supplier': ids['suppliers'], 'branch': branch.id,
            'notes': f'{tag} order'})['id']
        post(f"/api/purchases/{ids['purchases']}/add_item/",
             {'item': item.id, 'quantity': 2, 'unit_cost': '10'})
        ids['line'] = PurchaseItem.objects.get(purchase_id=ids['purchases']).id
        ids['expense-categories'] = post(
            '/api/expense-categories/', {'name': f'{tag} rent'})['id']
        ids['expenses'] = post('/api/expenses/', {
            'branch': branch.id, 'category': ids['expense-categories'],
            'amount': '50', 'expense_date': today, 'description': f'{tag} expense',
            'cash_account': ids['cash-accounts']})['id']
        ids['recurring-expenses'] = post('/api/recurring-expenses/', {
            'branch': branch.id, 'category': ids['expense-categories'],
            'amount': '50', 'frequency': 'MONTHLY', 'next_due_date': today,
            'description': f'{tag} recurring'})['id']
        ids['capital-entries'] = post('/api/capital-entries/', {
            'type': 'OWNER_IN', 'amount': '500', 'date': today,
            'note': f'{tag} capital'})['id']
        ids['supplier-payments'] = post('/api/supplier-payments/', {
            'supplier': ids['suppliers'], 'amount': '5', 'payment_date': today,
            'cash_account': ids['cash-accounts'], 'note': f'{tag} paid'})['id']
        ids['seasonal-discounts'] = post('/api/seasonal-discounts/', {
            'name': f'{tag} promo', 'scope': 'ALL', 'discount_percentage': '1',
            'start_date': today, 'end_date': today})['id']
        # An audit entry carrying the marker.
        res = self.client.patch(f"/api/brands/{ids['brands']}/",
                                {'name': f'{tag} brand 2'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        ids['activity-logs'] = ActivityLog.objects.filter(business=biz).first().id
        return biz, ids, {'admin': admin, 'manager': manager, 'cashier': cashier}

    def setUp(self):
        self.a, self.a_ids, self.a_users = self._build(MARK, 'a')
        self.b, self.b_ids, self.b_users = self._build('Bravo', 'b')

    RESOURCES = [
        'branches', 'categories', 'brands', 'items', 'customers', 'activity-logs',
        'suppliers', 'purchases', 'stock-lots', 'stock-movements', 'sales',
        'payments', 'cash-accounts', 'expense-categories', 'expenses',
        'supplier-payments', 'capital-entries', 'recurring-expenses',
        'seasonal-discounts', 'users',
    ]

    def _snapshot(self):
        """Every row of business A, to prove nothing of it changed."""
        rows = {}
        for model in apps.get_app_config('core').get_models():
            if any(f.name == 'business' for f in model._meta.fields):
                rows[model.__name__] = list(
                    model.objects.filter(business=self.a).order_by('pk').values())
        return rows

    def test_no_read_returns_another_business_data(self):
        a = self.a_ids
        urls = [f'/api/{name}/' for name in self.RESOURCES]
        urls += [f'/api/{name}/?page_size=100&q={MARK}' for name in self.RESOURCES]
        urls += [
            '/api/dashboard/', '/api/dashboard/summary/',
            '/api/dashboard/branch-sales/', '/api/dashboard/employee-sales/',
            '/api/installments/due/', '/api/finance-settings/', '/api/business/logo/',
            '/api/auth/me/', '/api/reports/sales/', '/api/reports/cash/',
            '/api/reports/profit/', '/api/reports/balance-sheet/',
            '/api/reports/cash-flow/', '/api/reports/tax/', '/api/reports/stock/',
            f"/api/reports/sales/?branch={a['branches']}",
            f"/api/sales/?customer={a['customers']}",
            f"/api/sales/?branch={a['branches']}",
            f"/api/sales/?created_by={a['users']}",
            f"/api/sales/?customer_name={MARK}",
            f"/api/sales/?customer_nic={MARK}",
            f"/api/payments/?sale={a['sales']}",
            f"/api/items/?category={a['categories']}",
            f"/api/stock-lots/?item={a['items']}",
            f"/api/purchases/?supplier={a['suppliers']}",
            f"/api/expenses/?category={a['expense-categories']}",
            f"/api/activity-logs/?record_id={a['brands']}",
            '/api/customers/?blacklisted=false',
        ]
        for role, user in self.b_users.items():
            self.client.force_authenticate(user)
            for url in urls:
                res = self.client.get(url)
                self.assertLess(res.status_code, 500, (role, url))
                self.assertNotIn(MARK.encode(), res.content, (role, url))

    def test_other_business_records_cannot_be_opened_changed_or_removed(self):
        before = self._snapshot()
        a = self.a_ids
        for role, user in self.b_users.items():
            self.client.force_authenticate(user)
            for name in self.RESOURCES:
                url = f'/api/{name}/{a[name]}/'
                for method in ('get', 'patch', 'put', 'delete'):
                    res = getattr(self.client, method)(url, {'name': 'x'}, format='json')
                    self.assertIn(res.status_code, (403, 404, 405), (role, method, url))
                    self.assertNotIn(MARK.encode(), res.content, (role, method, url))
            reads = [
                f"/api/customers/{a['customers']}/history/",
                f"/api/suppliers/{a['suppliers']}/ledger/",
                f"/api/items/{a['items']}/barcode/",
            ]
            for url in reads:
                res = self.client.get(url)
                self.assertIn(res.status_code, (403, 404), (role, url))
            actions = [
                (f"/api/sales/{a['sales']}/cancel/", {}),
                (f"/api/sales/{a['sales']}/pay_installment/",
                 {'installment': a['installment'], 'amount': '10'}),
                (f"/api/items/{a['items']}/adjust/",
                 {'quantity': -1, 'branch': a['branches']}),
                (f"/api/customers/{a['customers']}/blacklist/", {'reason': 'x'}),
                (f"/api/customers/{a['customers']}/unblacklist/", {}),
                (f"/api/purchases/{a['purchases']}/place/", {}),
                (f"/api/purchases/{a['purchases']}/cancel/", {}),
                (f"/api/purchases/{a['purchases']}/receive/", {}),
                (f"/api/purchases/{a['purchases']}/add_item/",
                 {'item': a['items'], 'quantity': 1, 'unit_cost': '1'}),
                (f"/api/purchases/{a['purchases']}/remove_item/",
                 {'item_id': a['line']}),
            ]
            for url, body in actions:
                res = self.client.post(url, body, format='json')
                self.assertIn(res.status_code, (403, 404), (role, url))
        self.assertEqual(self._snapshot(), before)

    def test_another_business_ids_cannot_be_referenced(self):
        before = self._snapshot()
        a, b = self.a_ids, self.b_ids
        self.client.force_authenticate(self.b_users['admin'])
        today = timezone.localdate().isoformat()
        line = [{'item': b['items'], 'quantity': 1}]
        sale = {'branch': b['branches'], 'lines': line}
        plan = dict(sale, is_single_payment=False, down_payment='100',
                    number_of_installments=2, customer=b['customers'],
                    guarantors=[b['guarantor']])
        creates = [
            ('categories', {'name': 'n1', 'parent': a['categories']}),
            ('items', {'code': 'n2', 'name': 'n2', 'category': a['categories'],
                       'selling_price': '1'}),
            ('items', {'code': 'n3', 'name': 'n3', 'brand': a['brands'],
                       'selling_price': '1'}),
            ('items', {'code': 'n4', 'name': 'n4', 'selling_price': '1',
                       'opening_stock': 1, 'opening_branch': a['branches']}),
            ('sales', dict(sale, branch=a['branches'])),
            ('sales', dict(sale, customer=a['customers'])),
            ('sales', dict(sale, lines=[{'item': a['items'], 'quantity': 1}])),
            ('sales', dict(sale, cash_account=a['cash-accounts'])),
            ('sales', dict(plan, guarantors=[a['guarantor']])),
            ('purchases', {'supplier': a['suppliers'], 'branch': b['branches']}),
            ('purchases', {'supplier': b['suppliers'], 'branch': a['branches']}),
            (f"purchases/{b['purchases']}/add_item",
             {'item': a['items'], 'quantity': 1, 'unit_cost': '1'}),
            ('expenses', {'branch': a['branches'],
                          'category': b['expense-categories'], 'amount': '1',
                          'expense_date': today, 'description': 'd'}),
            ('expenses', {'branch': b['branches'],
                          'category': a['expense-categories'], 'amount': '1',
                          'expense_date': today, 'description': 'd'}),
            ('expenses', {'branch': b['branches'],
                          'category': b['expense-categories'], 'amount': '1',
                          'expense_date': today, 'description': 'd',
                          'cash_account': a['cash-accounts']}),
            ('recurring-expenses', {
                'branch': a['branches'], 'category': a['expense-categories'],
                'amount': '1', 'frequency': 'MONTHLY', 'next_due_date': today,
                'description': 'd'}),
            ('supplier-payments', {'supplier': a['suppliers'], 'amount': '1',
                                   'payment_date': today}),
            ('supplier-payments', {'supplier': b['suppliers'], 'amount': '1',
                                   'payment_date': today,
                                   'purchase': a['purchases']}),
            ('supplier-payments', {'supplier': b['suppliers'], 'amount': '1',
                                   'payment_date': today,
                                   'cash_account': a['cash-accounts']}),
            ('seasonal-discounts', {'name': 'n', 'scope': 'ITEM', 'target_id': a['items'],
                                    'discount_percentage': '1', 'start_date': today,
                                    'end_date': today}),
            ('seasonal-discounts', {
                'name': 'n', 'scope': 'CATEGORY', 'target_id': a['categories'],
                'discount_percentage': '1', 'start_date': today, 'end_date': today}),
            ('seasonal-discounts', {
                'name': 'n', 'scope': 'BRAND', 'target_id': a['brands'],
                'discount_percentage': '1', 'start_date': today, 'end_date': today}),
            ('stock-ins', {'source': 'OPENING', 'branch': a['branches'],
                           'lines': [{'item': b['items'], 'quantity': 1,
                                      'unit_cost': '1'}]}),
            ('stock-ins', {'source': 'OPENING', 'branch': b['branches'],
                           'lines': [{'item': a['items'], 'quantity': 1,
                                      'unit_cost': '1'}]}),
            ('stock-ins', {'source': 'PURCHASE', 'supplier': a['suppliers'],
                           'branch': b['branches'],
                           'lines': [{'item': b['items'], 'quantity': 1,
                                      'unit_cost': '1'}]}),
            ('users', {'username': 'sneaky', 'password': 'testpass1234',
                       'role': 'cashier', 'branch': a['branches']}),
            ('users', {'username': 'sneaky2', 'password': 'testpass1234',
                       'role': 'cashier', 'business': a['business']}),
        ]
        for name, body in creates:
            res = self.client.post(f'/api/{name}/', body, format='json')
            self.assertIn(res.status_code, (400, 403, 404), (name, body, res.content))
            self.assertNotIn(MARK.encode(), res.content, (name, body))
        patches = [
            ('categories', {'parent': a['categories']}),
            ('items', {'category': a['categories']}),
            ('items', {'brand': a['brands']}),
            ('expenses', {'branch': a['branches']}),
            ('expenses', {'category': a['expense-categories']}),
            ('expenses', {'cash_account': a['cash-accounts']}),
            ('recurring-expenses', {'branch': a['branches']}),
            ('recurring-expenses', {'category': a['expense-categories']}),
            ('supplier-payments', {'supplier': a['suppliers']}),
            ('supplier-payments', {'purchase': a['purchases']}),
            ('supplier-payments', {'cash_account': a['cash-accounts']}),
            ('seasonal-discounts', {'scope': 'ITEM', 'target_id': a['items']}),
            ('purchases', {'supplier': a['suppliers']}),
            ('purchases', {'branch': a['branches']}),
            ('users', {'branch': a['branches']}),
            ('users', {'business': a['business']}),
        ]
        for name, body in patches:
            res = self.client.patch(f'/api/{name}/{b[name]}/', body, format='json')
            self.assertNotIn(MARK.encode(), res.content, (name, body))
            if res.status_code < 300:
                # Accepted only if the foreign id was ignored (read-only field).
                for field, value in body.items():
                    if field != 'scope':
                        self.assertNotEqual(res.data.get(field), value, (name, body))
        self.assertEqual(self._snapshot(), before)
        # No row of B points at a row of A.
        for model in apps.get_app_config('core').get_models():
            if not any(f.name == 'business' for f in model._meta.fields):
                continue
            for field in model._meta.fields:
                target = field.related_model if field.is_relation else None
                if field.name == 'business' or not target:
                    continue
                if not any(f.name == 'business' for f in target._meta.fields):
                    continue
                crossed = model.objects.filter(
                    business=self.b, **{f'{field.name}__business': self.a})
                self.assertFalse(crossed.exists(), (model.__name__, field.name))

        def mine(value, key=None):
            if isinstance(value, dict):
                return {k: mine(v, k) for k, v in value.items()}
            if isinstance(value, list):
                return [mine(v, key) for v in value]
            id_keys = {'parent', 'category', 'brand', 'opening_branch', 'branch',
                       'customer', 'item', 'cash_account', 'guarantors', 'supplier',
                       'purchase', 'target_id', 'business'}
            if key not in id_keys or not isinstance(value, int):
                return value
            for name, theirs in a.items():
                # Ids repeat across tables, so map by the kind of record.
                if value == theirs and name in KINDS[key]:
                    return b[name]
            return value

        KINDS = {
            'parent': ['categories'], 'category': ['categories', 'expense-categories'],
            'brand': ['brands'], 'opening_branch': ['branches'], 'branch': ['branches'],
            'customer': ['customers'], 'item': ['items'],
            'cash_account': ['cash-accounts'], 'guarantors': ['guarantor'],
            'supplier': ['suppliers'], 'purchase': ['purchases'],
            'target_id': ['items', 'categories', 'brands'], 'business': ['business'],
        }
        for index, (name, body) in enumerate(creates):
            fixed = mine(body)
            if name in ('expenses', 'recurring-expenses'):
                fixed['category'] = b['expense-categories']
            if name == 'seasonal-discounts':
                fixed['target_id'] = b[{'ITEM': 'items', 'CATEGORY': 'categories',
                                        'BRAND': 'brands'}[body['scope']]]
            if name == 'users':
                fixed['username'] = f'own-{index}'
                fixed.pop('business', None)
            if 'code' in fixed:
                fixed['code'] = f'own-{index}'
            if name in ('categories', 'items'):
                fixed['name'] = f'own-{index}'
            res = self.client.post(f'/api/{name}/', fixed, format='json')
            self.assertIn(res.status_code, (200, 201), (name, fixed, res.content))

    def test_platform_account_sees_no_shop_data_through_shop_screens(self):
        root = User.objects.create_user(
            username='root-iso', password='testpass1234', role='super_admin')
        self.client.force_authenticate(root)
        for name in self.RESOURCES:
            res = self.client.get(f'/api/{name}/')
            self.assertNotIn(MARK.encode(), res.content, name)

    def test_shop_staff_cannot_use_the_platform_endpoints(self):
        for role, user in self.b_users.items():
            self.client.force_authenticate(user)
            for url in ('/api/admin/businesses/', '/api/admin/users/',
                        f"/api/admin/businesses/{self.a_ids['business']}/",
                        f"/api/admin/users/{self.a_ids['users']}/"):
                self.assertEqual(self.client.get(url).status_code, 403, (role, url))

    def test_login_is_required(self):
        self.client.force_authenticate(None)
        for name in self.RESOURCES:
            self.assertEqual(self.client.get(f'/api/{name}/').status_code, 401, name)
