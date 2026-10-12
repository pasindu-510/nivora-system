"""Test suite for the shop API.

Covers the critical business invariants from the spec:

* JWT auth flow (login / me / refresh).
* Tenant isolation (data of business A never leaks to business B).
* FIFO cost allocation and stock decrement on sale.
* Sale math: subtotal, percent/amount discounts, tax, installments.
* Installment payment bookkeeping.
* Purchase receipt stock-in.
* Role-based access control.
"""
import shutil
import tempfile
from datetime import timedelta
from decimal import Decimal

from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from django.utils.functional import empty as lazy_sentinel
from rest_framework import status
from rest_framework.test import APITestCase

from .models import (
    Branch,
    Brand,
    Business,
    CashAccount,
    Category,
    Customer,
    ExpenseCategory,
    Installment,
    Item,
    LotAllocation,
    Payment,
    Purchase,
    PurchaseItem,
    RoleConstants,
    Sale,
    SaleItem,
    StockLot,
    StockMovement,
    Supplier,
    SupplierPayment,
    User,
)
from .services import (
    record_installment_payment,
    record_purchase_receipt,
    record_sale,
)


def _make_business(name, tax_rate='10.00'):
    return Business.objects.create(
        name=name, is_active=True, tax_rate=Decimal(tax_rate),
    )


def _make_user(username, role, business, branch=None):
    return User.objects.create_user(
        username=username, password='testpass1234',
        role=role, business=business, branch=branch,
    )


def _make_branch(business, name='Main'):
    return Branch.objects.create(business=business, name=name)


def _make_item(business, code, cost, price, opening=10, branch=None):
    item = Item.objects.create(
        business=business, code=code, name=code + ' Item',
        cost_price=Decimal(cost), selling_price=Decimal(price),
        stock_quantity=opening,
    )
    if opening:
        StockLot.objects.create(
            business=business, branch=branch or _make_branch(business),
            item=item, quantity_total=opening, quantity_remaining=opening,
            unit_cost=Decimal(cost), source=StockLot.OPENING,
        )
    return item


class TenantIsolationTests(APITestCase):
    """Business A's data must be invisible to authenticated business B users."""

    def setUp(self):
        self.biz_a = _make_business('Alpha', tax_rate='0.00')
        self.biz_b = _make_business('Beta', tax_rate='0.00')
        self.branch_a = _make_branch(self.biz_a, 'Alpha Branch')
        self.branch_b = _make_branch(self.biz_b, 'Beta Branch')
        self.item_a = _make_item(self.biz_a, 'A-001', '100.00', '150.00', opening=5, branch=self.branch_a)
        self.item_b = _make_item(self.biz_b, 'B-001', '200.00', '250.00', opening=5, branch=self.branch_b)
        self.cashier_a = _make_user('cash_a', RoleConstants.CASHIER, self.biz_a, self.branch_a)
        self.cashier_b = _make_user('cash_b', RoleConstants.CASHIER, self.biz_b, self.branch_b)

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_items_scoped_to_business(self):
        self._auth(self.cashier_a)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        codes = [r['code'] for r in resp.data['results']]
        self.assertIn('A-001', codes)
        self.assertNotIn('B-001', codes)

    def test_cannot_read_foreign_item(self):
        self._auth(self.cashier_a)
        resp = self.client.get(reverse('item-detail', kwargs={'pk': self.item_b.id}))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_tenant_manager_none_returns_empty(self):
        self.assertEqual(list(Item.objects.for_business(None)), [])
        self.assertEqual(list(Item.objects.for_business(self.biz_a).values_list('code', flat=True)), ['A-001'])


class AuthFlowTests(APITestCase):
    """Login obtains tokens; /me returns the profile."""

    def setUp(self):
        self.biz = _make_business('Auth Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.admin = _make_user('owner', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)

    def test_login_returns_tokens(self):
        resp = self.client.post(
            reverse('api-login'),
            {'username': 'owner', 'password': 'testpass1234'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('access', resp.data)
        self.assertIn('refresh', resp.data)
        self.assertEqual(resp.data['user']['username'], 'owner')

    def test_login_rejects_bad_credentials(self):
        resp = self.client.post(
            reverse('api-login'),
            {'username': 'owner', 'password': 'wrong-password'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_me_requires_auth(self):
        resp = self.client.get(reverse('api-me'))
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_me_returns_profile_after_login(self):
        resp = self.client.post(
            reverse('api-login'),
            {'username': 'owner', 'password': 'testpass1234'},
            format='json',
        )
        token = resp.data['access']
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        me = self.client.get(reverse('api-me'))
        self.assertEqual(me.status_code, status.HTTP_200_OK)
        self.assertEqual(me.data['business'], self.biz.id)

    def test_refresh_exchanges_token(self):
        login = self.client.post(
            reverse('api-login'),
            {'username': 'owner', 'password': 'testpass1234'},
            format='json',
        )
        resp = self.client.post(
            reverse('api-refresh'),
            {'refresh': login.data['refresh']},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('access', resp.data)


class HealthEndpointTests(APITestCase):
    """The public liveness probe must answer with no auth and no tenant context."""

    def test_health_returns_ok_anonymously(self):
        resp = self.client.get(reverse('health'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['status'], 'ok')

    def test_health_is_db_free(self):
        # The endpoint must not touch shared state; calling it with no users
        # or tenants provisioned still answers 200.
        resp = self.client.get(reverse('health'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, {'status': 'ok'})


class BusinessLogoTests(APITestCase):
    """Business logo upload: business_admin only, persists to Business.logo.

    Uses an isolated MEDIA_ROOT (reset on the lazy ``default_storage`` so the
    override is honored even if an earlier test already touched the storage).
    """

    def setUp(self):
        self._media_root = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media_root)
        self._override.enable()
        # default_storage caches the first MEDIA_ROOT it sees; force a rebuild.
        default_storage._wrapped = lazy_sentinel

        self.biz = _make_business('Logo Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.admin = _make_user('logo_owner', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)
        self.manager = _make_user('logo_mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.cashier = _make_user('logo_cash', RoleConstants.CASHIER, self.biz, self.branch)

    def tearDown(self):
        self._override.disable()
        default_storage._wrapped = lazy_sentinel
        shutil.rmtree(self._media_root, ignore_errors=True)

    def _png(self, name='logo.png'):
        return SimpleUploadedFile(name, b'fake-png-bytes', content_type='image/png')

    def _upload(self, user, name='logo.png'):
        self.client.force_authenticate(user)
        return self.client.post(
            reverse('business-logo'),
            {'logo': self._png(name)},
            format='multipart',
        )

    def test_upload_requires_business_admin(self):
        for user in (self.manager, self.cashier):
            resp = self._upload(user)
            self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_upload_requires_auth(self):
        resp = self.client.post(
            reverse('business-logo'),
            {'logo': self._png()},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_upload_without_file_is_bad_request(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.post(reverse('business-logo'), {}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_upload_rejects_non_image_content_type(self):
        self.client.force_authenticate(self.admin)
        bad = SimpleUploadedFile('notes.txt', b'not an image', content_type='text/plain')
        resp = self.client.post(reverse('business-logo'), {'logo': bad}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_upload_persists_to_business_logo(self):
        resp = self._upload(self.admin)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(resp.data['url'].startswith('/media/business_logos/'))

        self.biz.refresh_from_db()
        self.assertIsNotNone(self.biz.logo)
        self.assertTrue(self.biz.logo.name.startswith('business_logos/'))
        self.assertTrue(default_storage.exists(self.biz.logo.name))

    def test_get_returns_none_when_unset(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('business-logo'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, {'none': True})

    def test_get_returns_url_after_upload(self):
        self._upload(self.admin, name='first.png')
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('business-logo'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data['url'].startswith('/media/business_logos/'))

    def test_replacement_deletes_previous_file(self):
        self._upload(self.admin, name='first.png')
        self.biz.refresh_from_db()
        first_name = self.biz.logo.name
        self.assertTrue(default_storage.exists(first_name))

        self._upload(self.admin, name='second.png')
        self.biz.refresh_from_db()
        second_name = self.biz.logo.name

        self.assertNotEqual(first_name, second_name)
        self.assertFalse(default_storage.exists(first_name))
        self.assertTrue(default_storage.exists(second_name))

    def test_me_includes_business_name_and_logo(self):
        self._upload(self.admin)
        self.client.force_authenticate(self.admin)
        me = self.client.get(reverse('api-me'))
        self.assertEqual(me.status_code, status.HTTP_200_OK)
        self.assertEqual(me.data['business_name'], 'Logo Co')
        self.assertTrue(str(me.data['business_logo']).startswith('/media/business_logos/'))


class SaleMathTests(APITestCase):
    """Single-payment and installment sale calculations (spec 5.2)."""

    def setUp(self):
        self.biz = _make_business('Math Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'M-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def test_single_payment_sale_math(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
        )
        # subtotal = 2×150 = 300, no discount, tax 10% → total 330.
        self.assertEqual(sale.subtotal, Decimal('300.00'))
        self.assertEqual(sale.discount_amount, Decimal('0.00'))
        self.assertEqual(sale.tax_amount, Decimal('30.00'))
        self.assertEqual(sale.total_cost, Decimal('330.00'))
        self.assertEqual(sale.remaining_cost, Decimal('0.00'))
        from django.utils import timezone
        self.assertEqual(
            sale.invoice_no, f'INV-{timezone.now().year}-0001'
        )

    def test_fifo_cost_and_stock(self):
        # Second lot at a higher cost to verify weighted-average FIFO cost.
        StockLot.objects.create(
            business=self.biz, branch=self.branch, item=self.item,
            quantity_total=5, quantity_remaining=5, unit_cost=Decimal('120.00'),
            source=StockLot.PURCHASE, reference='PO-2',
        )
        self.item.stock_quantity = 25
        self.item.save(update_fields=['stock_quantity'])
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 15}],
        )
        # Consumes 15 units from lot 1 (100.00/unit) → fifo_cost = 100.00.
        sale_item = sale.items.get()
        self.assertEqual(sale_item.fifo_cost, Decimal('100.00'))
        self.item.refresh_from_db()
        self.assertEqual(self.item.stock_quantity, 10)

        allocations = LotAllocation.objects.filter(sale_item=sale_item)
        self.assertEqual(sum(a.quantity for a in allocations), 15)

    def test_insufficient_stock_raises(self):
        with self.assertRaises(ValueError):
            record_sale(
                business=self.biz, branch=self.branch,
                created_by=self.cashier,
                lines=[{'item': self.item, 'quantity': 999}],
            )

    def test_installment_sale_splits_balance(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=3,
        )
        # total 165.00, down 50 → remaining 115 → 3 installments (38.33 ×3 = 114.99, +0.01 rounding).
        self.assertEqual(sale.total_cost, Decimal('165.00'))
        self.assertEqual(sale.down_payment, Decimal('50.00'))
        self.assertEqual(sale.remaining_cost, Decimal('115.00'))
        installments = list(sale.installments.order_by('number'))
        self.assertEqual(len(installments), 3)
        total_installments = sum(i.amount for i in installments)
        self.assertEqual(total_installments, Decimal('115.00'))

    def test_installment_payment_records_and_closes(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        installments = list(sale.installments.order_by('number'))
        self.assertEqual(len(installments), 2)
        first = installments[0]
        record_installment_payment(
            business=self.biz, installment=first, amount=first.amount,
            received_by=self.cashier,
        )
        first.refresh_from_db()
        self.assertTrue(first.is_paid)
        self.assertTrue(Payment.objects.filter(installment=first).exists())
        sale.refresh_from_db()
        self.assertEqual(sale.remaining_cost, first.amount)  # 115 - 57.50

    def test_overpayment_rolls_forward(self):
        """Paying amount > inst.amount rolls forward to later installments.
        
        Paying inst.amount + 10 on the first of 2 installments must succeed,
        mark installment 1 paid, roll 10.00 onto installment 2,
        and remaining_cost = 115.00 - (inst.amount + 10).
        """
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        inst = sale.installments.first()
        # Pay inst.amount + 10 → rolls forward 10.00 onto installment 2
        record_installment_payment(
            business=self.biz, installment=inst,
            amount=inst.amount + Decimal('10.00'),
            received_by=self.cashier,
        )
        # Installment 1 should be fully paid
        inst.refresh_from_db()
        self.assertTrue(inst.is_paid)
        # Installment 2 should have paid_amount = 10.00
        inst2 = sale.installments.order_by('number').last()
        inst2.refresh_from_db()
        self.assertEqual(inst2.paid_amount, Decimal('10.00'))
        # remaining_cost = 115.00 - (inst.amount + 10)
        sale.refresh_from_db()
        self.assertEqual(sale.remaining_cost, Decimal('115.00') - (inst.amount + Decimal('10.00')))


class InstallmentInterestTests(APITestCase):
    """Tests for one-time interest on underpaid installments."""

    def setUp(self):
        # tax_rate 10% matches the established installment-sale shape used by
        # SaleMathTests: total 165.00, down 50.00 → 115.00 → 2 × 57.50.
        self.biz = _make_business('Interest Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'INT-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def _make_sale(self, down_payment=Decimal('50.00'), number_of_installments=2):
        return record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=down_payment,
            number_of_installments=number_of_installments,
        )

    def _pay_selected_installment(self, sale, amount, biz):
        inst = sale.installments.first()
        record_installment_payment(
            business=biz, installment=inst, amount=amount,
            received_by=self.cashier,
        )
        return inst

    def test_underpayment_charges_one_time_interest(self):
        """Pay 20.00 on installment 1 → shortfall 37.50 → interest 0.75 → interest_charged 0.75."""
        # Rate must be set BEFORE the payment so the service sees it.
        self.biz.installment_interest_rate = Decimal('2')
        self.biz.save(update_fields=['installment_interest_rate'])
        sale = self._make_sale()
        self._pay_selected_installment(sale, Decimal('20.00'), self.biz)
        inst = sale.installments.first()
        # shortfall = max(0, 57.50 - 20.00) = 37.50
        # interest = (37.50 * 2 / 100).quantize(0.01) = 0.75
        inst.refresh_from_db()
        self.assertEqual(inst.interest_charged, Decimal('0.75'))
        # is_paid False since paid_amount (20.00) < amount + interest_charged (57.50 + 0.75)
        self.assertFalse(inst.is_paid)
        sale.refresh_from_db()
        # remaining_cost = 115.00 - 20.00 + 0.75 = 95.75
        self.assertEqual(sale.remaining_cost, Decimal('95.75'))

    def test_zero_rate_no_interest(self):
        """Rate 0 → paying 20.00 on installment 1 → interest_charged 0."""
        self.biz.installment_interest_rate = Decimal('0')
        self.biz.save(update_fields=['installment_interest_rate'])
        sale = self._make_sale()
        self._pay_selected_installment(sale, Decimal('20.00'), self.biz)
        inst = sale.installments.first()
        inst.refresh_from_db()
        self.assertEqual(inst.interest_charged, Decimal('0.00'))
        sale.refresh_from_db()
        # remaining_cost = 115.00 - 20.00 + 0 = 95.00
        self.assertEqual(sale.remaining_cost, Decimal('95.00'))

    def test_full_payment_no_interest(self):
        """Paying exactly inst.amount → interest_charged 0, is_paid True."""
        # Rate 2% set BEFORE paying: an exact payment still earns no interest.
        self.biz.installment_interest_rate = Decimal('2')
        self.biz.save(update_fields=['installment_interest_rate'])
        sale = self._make_sale()
        self._pay_selected_installment(sale, sale.installments.first().amount, self.biz)
        inst = sale.installments.first()
        inst.refresh_from_db()
        self.assertEqual(inst.interest_charged, Decimal('0.00'))
        self.assertTrue(inst.is_paid)

    def test_payment_over_sale_balance_rejected(self):
        """amount > remaining_cost → ValueError('Payment exceeds balance due.')."""
        sale = self._make_sale()
        with self.assertRaises(ValueError) as ctx:
            record_installment_payment(
                business=self.biz, installment=sale.installments.first(),
                amount=sale.remaining_cost + Decimal('1.00'),
                received_by=self.cashier,
            )
        self.assertEqual(str(ctx.exception), 'Payment exceeds balance due.')

    def test_interest_must_be_repaid_to_close(self):
        """After underpayment with interest, close only when paid_amount >= amount + interest_charged."""
        sale = self._make_sale()
        self.biz.installment_interest_rate = Decimal('2')
        self.biz.save(update_fields=['installment_interest_rate'])
        # Pay 20.00 on installment 1 → shortfall 37.50 → interest 0.75
        self._pay_selected_installment(sale, Decimal('20.00'), self.biz)
        inst = sale.installments.first()
        # Now pay the remaining effective due: amount + interest_charged - paid_amount = 57.50 + 0.75 - 20.00 = 38.25
        record_installment_payment(
            business=self.biz, installment=inst, amount=Decimal('38.25'),
            received_by=self.cashier,
        )
        inst.refresh_from_db()
        # paid_amount 58.25 >= amount 57.50 + interest_charged 0.75 → settled.
        self.assertTrue(inst.is_paid)
        sale.refresh_from_db()
        # 115.00 − 20.00 + 0.75 = 95.75, then 95.75 − 38.25 + 0 = 57.50
        # (second payment has shortfall 0 → no new interest).
        self.assertEqual(sale.remaining_cost, Decimal('57.50'))

    def test_interest_must_be_repaid_to_close_exact(self):
        """Pay exact remaining effective due → is_paid True, no new interest."""
        sale = self._make_sale()
        self.biz.installment_interest_rate = Decimal('2')
        self.biz.save(update_fields=['installment_interest_rate'])
        # Pay 20.00 on installment 1 → shortfall 37.50 → interest 0.75
        self._pay_selected_installment(sale, Decimal('20.00'), self.biz)
        inst = sale.installments.first()
        # Pay exactly the remaining: 57.50 + 0.75 - 20.00 = 38.25
        record_installment_payment(
            business=self.biz, installment=inst, amount=Decimal('38.25'),
            received_by=self.cashier,
        )
        inst.refresh_from_db()
        self.assertTrue(inst.is_paid)
        # No new interest since shortfall is 0
        self.assertEqual(inst.interest_charged, Decimal('0.75'))
        sale.refresh_from_db()
        # remaining_cost = 95.75 - 38.25 + 0 = 57.50
        self.assertEqual(sale.remaining_cost, Decimal('57.50'))

    def test_installment_due_view_includes_interest(self):
        """GET /api/installments/due/ includes interest_charged and correct due_amount."""
        from datetime import timedelta
        from django.utils import timezone

        sale = self._make_sale()
        self.biz.installment_interest_rate = Decimal('2')
        self.biz.save(update_fields=['installment_interest_rate'])
        # Pay 20.00 on installment 1 → shortfall 37.50 → interest 0.75
        self._pay_selected_installment(sale, Decimal('20.00'), self.biz)
        # Set first installment due today
        inst = sale.installments.order_by('number').first()
        inst.due_date = timezone.localdate()
        inst.save(update_fields=['due_date'])

        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        inst_data = resp.data['results'][0]
        # due_amount = amount + interest_charged - paid_amount
        # = 57.50 + 0.75 - 20.00 = 38.25
        self.assertEqual(Decimal(str(inst_data['due_amount'])), Decimal('38.25'))
        self.assertIn('interest_charged', inst_data)
        self.assertEqual(
            Decimal(str(inst_data['interest_charged'])), Decimal('0.75'),
        )

    def test_pay_installment_endpoint_reflects_payment(self):
        """API payment must return the updated sale (stale-response guard)."""
        from rest_framework.test import APIClient
        self.client.force_authenticate(self.cashier)
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        inst = sale.installments.order_by('number').first()
        url = reverse('sale-pay-installment', kwargs={'pk': sale.id})
        resp = self.client.post(
            url, {'installment': inst.id, 'amount': str(inst.amount)},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            Decimal(resp.data['remaining_cost']),
            sale.remaining_cost - inst.amount,
        )
        paid = [i for i in resp.data['installments'] if i['id'] == inst.id][0]
        self.assertTrue(paid['is_paid'])

    def test_overpay_endpoint_returns_400(self):
        self.client.force_authenticate(self.cashier)
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        inst = sale.installments.order_by('number').first()
        url = reverse('sale-pay-installment', kwargs={'pk': sale.id})
        resp = self.client.post(
            url, {'installment': inst.id, 'amount': '999999'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_percent_discount_math(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            discount_type=Sale.PERCENT, discount_value=Decimal('10'),
        )
        # 150 − 10% = 135, tax 10% → 148.50.
        self.assertEqual(sale.discount_amount, Decimal('15.00'))
        self.assertEqual(sale.total_cost, Decimal('148.50'))


class PurchaseReceiptTests(APITestCase):
    """Receiving stock creates lots, movements and updates stock."""

    def setUp(self):
        self.biz = _make_business('PO Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        from .models import Supplier
        self.supplier = Supplier.objects.create(business=self.biz, name='Parts Ltd')
        self.item = _make_item(self.biz, 'P-001', '50.00', '80.00', opening=0, branch=self.branch)

        self.purchase = Purchase.objects.create(
            business=self.biz, branch=self.branch, supplier=self.supplier,
            order_no='PO-2026-0001', status=Purchase.ORDERED,
            ordered_by=self.manager,
        )
        self.purchase_item = PurchaseItem.objects.create(
            business=self.biz, purchase=self.purchase, item=self.item,
            quantity=10, unit_cost=Decimal('55.00'), total=Decimal('550.00'),
        )

    def test_receive_full_quantity(self):
        purchase, receipt = record_purchase_receipt(
            business=self.biz, branch=self.branch,
            purchase=self.purchase, received_by=self.manager,
        )
        self.assertIsNotNone(receipt)
        self.item.refresh_from_db()
        self.assertEqual(self.item.stock_quantity, 10)
        lot = StockLot.objects.filter(item=self.item).first()
        self.assertEqual(lot.quantity_remaining, 10)
        self.assertEqual(lot.unit_cost, Decimal('55.00'))
        self.purchase.refresh_from_db()
        self.assertEqual(self.purchase.status, Purchase.RECEIVED)
        self.assertEqual(
            StockMovement.objects.filter(item=self.item, type=StockMovement.IN).count(), 1
        )

    def test_partial_receive(self):
        purchase, receipt = record_purchase_receipt(
            business=self.biz, branch=self.branch,
            purchase=self.purchase, received_by=self.manager,
            quantities={self.purchase_item.id: 4},
        )
        self.item.refresh_from_db()
        self.assertEqual(self.item.stock_quantity, 4)
        self.purchase.refresh_from_db()
        self.assertEqual(self.purchase.status, Purchase.PARTIALLY_RECEIVED)
        self.purchase_item.refresh_from_db()
        self.assertEqual(self.purchase_item.received_quantity, 4)

    def test_purchase_add_item_endpoint_accepts_tenant_item(self):
        """add_item must resolve business-scoped items (context fix)."""
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(self.manager)
        url = reverse('purchase-add-item', kwargs={'pk': self.purchase.id})
        resp = client.post(
            url,
            {'item': self.item.id, 'quantity': 3, 'unit_cost': '55.00'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.purchase.refresh_from_db()
        # setUp already created one line; the POST appends a second.
        self.assertEqual(self.purchase.items.count(), 2)

    def test_purchase_receive_endpoint_creates_receipt(self):
        """API receive flow must create a receipt + lots (context fix)."""
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(self.manager)
        url = reverse('purchase-receive', kwargs={'pk': self.purchase.id})
        resp = client.post(url, {}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data['receipt_no'].startswith('RCP'), True)
        self.item.refresh_from_db()
        self.assertEqual(self.item.stock_quantity, 10)


class PermissionTests(APITestCase):
    """Role matrix: cashier cannot write catalog; only admin manages finance."""

    def setUp(self):
        self.biz = _make_business('Perm Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash1', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr1', RoleConstants.MANAGER, self.biz, self.branch)
        self.admin = _make_user('adm1', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_cashier_reads_items_but_cannot_create(self):
        self._auth(self.cashier)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        resp = self.client.post(
            reverse('item-list'),
            {'code': 'X-1', 'name': 'X', 'cost_price': '1', 'selling_price': '2'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_creates_item(self):
        self._auth(self.manager)
        resp = self.client.post(
            reverse('item-list'),
            {'code': 'M-9', 'name': 'Manager Item',
             'cost_price': '10.00', 'selling_price': '15.00'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_cashier_cannot_create_expense(self):
        self._auth(self.cashier)
        resp = self.client.post(
            reverse('expense-list'),
            {'description': 'Tea', 'amount': '50.00', 'category': 1},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_creates_expense(self):
        from .models import ExpenseCategory
        cat = ExpenseCategory.objects.create(business=self.biz, name='Utilities')
        self._auth(self.admin)
        resp = self.client.post(
            reverse('expense-list'),
            {'description': 'Electricity', 'amount': '2500.00',
             'category': cat.id, 'branch': self.branch.id,
             'expense_date': '2026-01-15'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_anonymous_rejected(self):
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)


# ── Catalog hardening: branch stock, tenant FKs, opening lots, delete guard ──


class ItemBranchStockTests(APITestCase):
    """branch_stock aggregates FIFO lots per branch on list and detail."""

    def setUp(self):
        self.biz = _make_business('BranchStock Co', tax_rate='0.00')
        self.branch_alpha = _make_branch(self.biz, 'Alpha Counter')
        self.branch_mid = _make_branch(self.biz, 'Mid Store')
        self.branch_zulu = _make_branch(self.biz, 'Zulu Depot')
        self.branch_empty = _make_branch(self.biz, 'Empty Rack')
        self.manager = _make_user(
            'bs_mgr', RoleConstants.MANAGER, self.biz, self.branch_alpha
        )
        self.item = _make_item(
            self.biz, 'BS-001', '100.00', '150.00', opening=0, branch=self.branch_alpha
        )
        # Lots created out of name order to prove explicit sorting + aggregation.
        for branch, remaining, source in (
            (self.branch_zulu, 6, StockLot.OPENING),
            (self.branch_alpha, 4, StockLot.OPENING),
            (self.branch_mid, 2, StockLot.PURCHASE),
            (self.branch_alpha, 5, StockLot.PURCHASE),
            (self.branch_empty, 0, StockLot.OPENING),
        ):
            StockLot.objects.create(
                business=self.biz, branch=branch, item=self.item,
                quantity_total=10, quantity_remaining=remaining,
                unit_cost=Decimal('100.00'), source=source, reference='T',
            )
        self.item.stock_quantity = 17
        self.item.save(update_fields=['stock_quantity'])
        self.expected = [
            {'branch_id': self.branch_alpha.id, 'branch_name': 'Alpha Counter', 'quantity': 9},
            {'branch_id': self.branch_mid.id, 'branch_name': 'Mid Store', 'quantity': 2},
            {'branch_id': self.branch_zulu.id, 'branch_name': 'Zulu Depot', 'quantity': 6},
        ]

    def test_list_includes_sorted_aggregated_branch_stock(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        row = next(r for r in resp.data['results'] if r['id'] == self.item.id)
        self.assertEqual(row['branch_stock'], self.expected)

    def test_detail_includes_branch_stock(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('item-detail', kwargs={'pk': self.item.id}))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['branch_stock'], self.expected)

    def test_branch_stock_does_not_change_stock_quantity(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('item-detail', kwargs={'pk': self.item.id}))
        self.assertEqual(resp.data['stock_quantity'], 17)
        self.item.refresh_from_db()
        self.assertEqual(self.item.stock_quantity, 17)


class ItemCodeUniquenessTests(APITestCase):
    """Duplicate codes are rejected per business, allowed across businesses."""

    def setUp(self):
        self.biz_a = _make_business('Uniq A', tax_rate='0.00')
        self.biz_b = _make_business('Uniq B', tax_rate='0.00')
        self.branch_a = _make_branch(self.biz_a)
        self.branch_b = _make_branch(self.biz_b)
        self.manager_a = _make_user(
            'uniq_mgr_a', RoleConstants.MANAGER, self.biz_a, self.branch_a
        )
        self.manager_b = _make_user(
            'uniq_mgr_b', RoleConstants.MANAGER, self.biz_b, self.branch_b
        )
        self.existing = _make_item(self.biz_a, 'DUP-001', '10.00', '20.00', opening=0)

    def _payload(self, **extra):
        payload = {
            'code': 'DUP-001', 'name': 'Copy Item',
            'cost_price': '10.00', 'selling_price': '20.00',
        }
        payload.update(extra)
        return payload

    def test_duplicate_code_in_same_business_returns_400(self):
        self.client.force_authenticate(self.manager_a)
        resp = self.client.post(reverse('item-list'), self._payload(), format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('code', resp.data)
        self.assertEqual(
            Item.objects.for_business(self.biz_a).filter(code='DUP-001').count(), 1
        )

    def test_same_code_allowed_in_other_business(self):
        self.client.force_authenticate(self.manager_b)
        resp = self.client.post(reverse('item-list'), self._payload(), format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(
            Item.objects.for_business(self.biz_b).filter(code='DUP-001').exists()
        )

    def test_update_own_item_without_code_change_allowed(self):
        self.client.force_authenticate(self.manager_a)
        resp = self.client.patch(
            reverse('item-detail', kwargs={'pk': self.existing.id}),
            {'name': 'Renamed'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_update_to_duplicate_code_returns_400(self):
        _make_item(self.biz_a, 'DUP-002', '10.00', '20.00', opening=0)
        self.client.force_authenticate(self.manager_a)
        resp = self.client.patch(
            reverse('item-detail', kwargs={'pk': self.existing.id}),
            {'code': 'DUP-002'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('code', resp.data)
        self.existing.refresh_from_db()
        self.assertEqual(self.existing.code, 'DUP-001')


class ItemCrossTenantFkTests(APITestCase):
    """category/brand FKs on items are scoped to the requester's business."""

    def setUp(self):
        self.biz_a = _make_business('Fk A', tax_rate='0.00')
        self.biz_b = _make_business('Fk B', tax_rate='0.00')
        self.branch_a = _make_branch(self.biz_a)
        self.manager_a = _make_user(
            'fk_mgr_a', RoleConstants.MANAGER, self.biz_a, self.branch_a
        )
        self.cat_a = Category.objects.create(business=self.biz_a, name='Own Cat')
        self.cat_b = Category.objects.create(business=self.biz_b, name='Foreign Cat')
        self.brand_b = Brand.objects.create(business=self.biz_b, name='Foreign Brand')

    def _payload(self, **extra):
        payload = {
            'code': 'FK-001', 'name': 'FK Item',
            'cost_price': '10.00', 'selling_price': '20.00',
        }
        payload.update(extra)
        return payload

    def test_foreign_category_returns_400(self):
        self.client.force_authenticate(self.manager_a)
        resp = self.client.post(
            reverse('item-list'), self._payload(category=self.cat_b.id), format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('category', resp.data)
        self.assertFalse(
            Item.objects.for_business(self.biz_a).filter(code='FK-001').exists()
        )

    def test_foreign_brand_returns_400(self):
        self.client.force_authenticate(self.manager_a)
        resp = self.client.post(
            reverse('item-list'), self._payload(brand=self.brand_b.id), format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('brand', resp.data)
        self.assertFalse(
            Item.objects.for_business(self.biz_a).filter(code='FK-001').exists()
        )

    def test_own_category_accepted(self):
        self.client.force_authenticate(self.manager_a)
        resp = self.client.post(
            reverse('item-list'), self._payload(category=self.cat_a.id), format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        item = Item.objects.get(pk=resp.data['id'])
        self.assertEqual(item.category_id, self.cat_a.id)


class ItemOpeningStockTests(APITestCase):
    """Item create can seed an opening FIFO lot atomically."""

    def setUp(self):
        self.biz = _make_business('Open Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.manager = _make_user(
            'open_mgr', RoleConstants.MANAGER, self.biz, self.branch
        )
        self.foreign_branch = _make_branch(
            _make_business('Other Open Co', tax_rate='0.00'), 'Other'
        )

    def _payload(self, **extra):
        payload = {
            'code': 'OPEN-001', 'name': 'Opening Item',
            'cost_price': '100.00', 'selling_price': '150.00',
        }
        payload.update(extra)
        return payload

    def test_create_with_opening_stock_seeds_lot_and_movement(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.post(
            reverse('item-list'),
            self._payload(
                opening_stock=3, opening_branch=self.branch.id,
                opening_unit_cost='80.00',
            ),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        # Opening fields are write-only and never serialize out.
        for field in ('opening_stock', 'opening_branch', 'opening_unit_cost'):
            self.assertNotIn(field, resp.data)
        item = Item.objects.get(pk=resp.data['id'])
        self.assertEqual(item.stock_quantity, 3)
        lot = StockLot.objects.get(item=item)
        self.assertEqual(lot.source, StockLot.OPENING)
        self.assertEqual(lot.branch_id, self.branch.id)
        self.assertEqual(lot.quantity_total, 3)
        self.assertEqual(lot.quantity_remaining, 3)
        self.assertEqual(lot.unit_cost, Decimal('80.00'))
        self.assertEqual(lot.reference, 'OPENING')
        movement = StockMovement.objects.get(item=item)
        self.assertEqual(movement.type, StockMovement.IN)
        self.assertEqual(movement.quantity, 3)
        self.assertEqual(movement.reference, 'OPENING')
        self.assertEqual(movement.created_by_id, self.manager.id)
        self.assertEqual(
            resp.data['branch_stock'],
            [{'branch_id': self.branch.id, 'branch_name': 'Main', 'quantity': 3}],
        )

    def test_opening_unit_cost_defaults_to_cost_price(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.post(
            reverse('item-list'),
            self._payload(opening_stock=3, opening_branch=self.branch.id),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        item = Item.objects.get(pk=resp.data['id'])
        lot = StockLot.objects.get(item=item)
        self.assertEqual(lot.unit_cost, Decimal('100.00'))

    def test_opening_stock_without_branch_returns_400(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.post(
            reverse('item-list'), self._payload(opening_stock=3), format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('opening_branch', resp.data)
        self.assertFalse(
            Item.objects.for_business(self.biz).filter(code='OPEN-001').exists()
        )

    def test_foreign_opening_branch_returns_400(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.post(
            reverse('item-list'),
            self._payload(opening_stock=3, opening_branch=self.foreign_branch.id),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('opening_branch', resp.data)
        self.assertFalse(
            Item.objects.for_business(self.biz).filter(code='OPEN-001').exists()
        )

    def test_create_without_opening_fields_defaults_to_zero_stock(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.post(reverse('item-list'), self._payload(), format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        item = Item.objects.get(pk=resp.data['id'])
        self.assertEqual(item.stock_quantity, 0)
        self.assertEqual(StockLot.objects.filter(item=item).count(), 0)
        self.assertEqual(StockMovement.objects.filter(item=item).count(), 0)
        self.assertEqual(resp.data['branch_stock'], [])


class ItemDeleteProtectionTests(APITestCase):
    """Deleting an item with sale history returns 400 with a clear message."""

    DETAIL_MESSAGE = (
        'This item has sale or purchase history and cannot be deleted. '
        'Deactivate it instead.'
    )

    def setUp(self):
        self.biz = _make_business('Del Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.manager = _make_user(
            'del_mgr', RoleConstants.MANAGER, self.biz, self.branch
        )
        self.item = _make_item(
            self.biz, 'DEL-001', '100.00', '150.00', opening=5, branch=self.branch
        )
        record_sale(
            business=self.biz, branch=self.branch, created_by=self.manager,
            lines=[{'item': self.item, 'quantity': 1}],
        )

    def test_delete_item_with_sale_history_returns_400(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.delete(reverse('item-detail', kwargs={'pk': self.item.id}))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(resp.data['detail'], self.DETAIL_MESSAGE)
        self.assertTrue(Item.objects.filter(pk=self.item.id).exists())

    def test_delete_item_without_history_succeeds(self):
        fresh = _make_item(self.biz, 'DEL-002', '10.00', '20.00', opening=0)
        self.client.force_authenticate(self.manager)
        resp = self.client.delete(reverse('item-detail', kwargs={'pk': fresh.id}))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Item.objects.filter(pk=fresh.id).exists())


class BusinessProvisioningTests(APITestCase):
    """POST /api/admin/businesses/ provisions a default Main Branch."""

    def setUp(self):
        self.super_admin = _make_user('root', RoleConstants.SUPER_ADMIN, None)

    def test_create_business_provisions_main_branch(self):
        self.client.force_authenticate(self.super_admin)
        resp = self.client.post(
            reverse('admin-business-list'),
            {
                'name': 'Gamma Traders',
                'address': '12 Lake Road',
                'phone': '0771234567',
                'email': 'ops@gamma.example',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        business = Business.objects.get(pk=resp.data['id'])
        self.assertEqual(business.created_by, self.super_admin)
        branches = Branch.objects.filter(business=business)
        self.assertEqual(branches.count(), 1)
        branch = branches.get()
        self.assertEqual(branch.name, 'Main Branch')
        self.assertEqual(branch.address, '12 Lake Road')
        self.assertEqual(branch.phone, '0771234567')
        self.assertTrue(branch.is_active)


class ItemLowStockFilterTests(APITestCase):
    """?low_stock=true filters items at or below their low-stock threshold."""

    def setUp(self):
        self.biz = _make_business('Low Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user(
            'low_cash', RoleConstants.CASHIER, self.biz, self.branch
        )
        # Default low_stock_threshold is 5 on every item.
        self.low = _make_item(
            self.biz, 'LOW-001', '10.00', '20.00', opening=3, branch=self.branch
        )
        self.boundary = _make_item(
            self.biz, 'LOW-002', '10.00', '20.00', opening=5, branch=self.branch
        )
        self.ok = _make_item(
            self.biz, 'LOW-003', '10.00', '20.00', opening=50, branch=self.branch
        )

    def _codes(self, resp):
        return {r['code'] for r in resp.data['results']}

    def test_low_stock_true_returns_only_low_items(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('item-list'), {'low_stock': 'true'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(self._codes(resp), {'LOW-001', 'LOW-002'})

    def test_without_flag_returns_all_items(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(self._codes(resp), {'LOW-001', 'LOW-002', 'LOW-003'})

    def test_low_stock_false_is_ignored(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('item-list'), {'low_stock': 'false'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(self._codes(resp), {'LOW-001', 'LOW-002', 'LOW-003'})


# ── Business licensing: per-business limits + admin statistics ──────────────


class BusinessLicensingTests(APITestCase):
    """max_users / max_branches limits, count statistics, stock-adj fix."""

    def setUp(self):
        self.super_admin = _make_user('lic_root', RoleConstants.SUPER_ADMIN, None)

    def _auth(self, user):
        self.client.force_authenticate(user)

    # (a) business create stores limits and auto-creates Main Branch.

    def test_create_business_stores_limits_and_creates_main_branch(self):
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-business-list'),
            {
                'name': 'Licence Traders',
                'max_users': 5,
                'max_branches': 3,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data['max_users'], 5)
        self.assertEqual(resp.data['max_branches'], 3)
        business = Business.objects.get(pk=resp.data['id'])
        self.assertEqual(business.max_users, 5)
        self.assertEqual(business.max_branches, 3)
        branches = Branch.objects.filter(business=business)
        self.assertEqual(branches.count(), 1)
        self.assertEqual(branches.get().name, 'Main Branch')

    def test_create_business_rejects_zero_limit(self):
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-business-list'),
            {'name': 'Zero Co', 'max_users': 0},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Business.objects.filter(name='Zero Co').exists())

    # (b) list/retrieve include all five counts, correct after related rows.

    def test_business_list_and_retrieve_include_counts(self):
        biz = _make_business('Stats Co', tax_rate='0.00')
        _make_branch(biz, 'S1')
        _make_branch(biz, 'S2')
        Category.objects.create(business=biz, name='Stats Cat')
        Brand.objects.create(business=biz, name='Stats Brand')
        _make_item(biz, 'STAT-001', '10.00', '20.00', opening=0)
        _make_item(biz, 'STAT-002', '10.00', '20.00', opening=0)
        _make_user('stat_u1', RoleConstants.CASHIER, biz)
        _make_user('stat_u2', RoleConstants.MANAGER, biz)
        expected = {
            'item_count': 2,
            'category_count': 1,
            'brand_count': 1,
            'branch_count': 2,
            'user_count': 2,
        }
        self._auth(self.super_admin)
        list_resp = self.client.get(reverse('admin-business-list'))
        self.assertEqual(list_resp.status_code, status.HTTP_200_OK)
        row = next(
            r for r in list_resp.data['results'] if r['id'] == biz.id
        )
        for key, value in expected.items():
            self.assertIn(key, row)
            self.assertEqual(row[key], value)
        detail_resp = self.client.get(
            reverse('admin-business-detail', kwargs={'pk': biz.id})
        )
        self.assertEqual(detail_resp.status_code, status.HTTP_200_OK)
        for key, value in expected.items():
            self.assertIn(key, detail_resp.data)
            self.assertEqual(detail_resp.data[key], value)
        self.assertIn('max_users', detail_resp.data)
        self.assertIn('max_branches', detail_resp.data)

    # (c) superadmin creating a user for a business at max_users → 400.

    def test_user_create_blocked_at_user_limit(self):
        biz = _make_business('UserCap Co', tax_rate='0.00')
        biz.max_users = 1
        biz.save(update_fields=['max_users'])
        _make_user('usercap_first', RoleConstants.CASHIER, biz)
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-user-list'),
            {
                'username': 'usercap_second',
                'password': 'testpass1234',
                'role': RoleConstants.CASHIER,
                'business': biz.id,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('user limit', resp.data['detail'])
        self.assertFalse(
            User.objects.filter(username='usercap_second').exists()
        )

    # (d) extra user allowed when max_users is null (unlimited).

    def test_extra_user_allowed_when_unlimited(self):
        biz = _make_business('Unltd Co', tax_rate='0.00')
        self.assertIsNone(biz.max_users)
        _make_user('unltd_first', RoleConstants.CASHIER, biz)
        _make_user('unltd_second', RoleConstants.CASHIER, biz)
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-user-list'),
            {
                'username': 'unltd_third',
                'password': 'testpass1234',
                'role': RoleConstants.CASHIER,
                'business': biz.id,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(
            User.objects.filter(username='unltd_third', business=biz).exists()
        )

    # (e) moving a user INTO a full business via PATCH → 400.

    def test_move_user_into_full_business_blocked(self):
        biz_a = _make_business('MoveSrc Co', tax_rate='0.00')
        biz_b = _make_business('MoveDst Co', tax_rate='0.00')
        biz_b.max_users = 1
        biz_b.save(update_fields=['max_users'])
        _make_user('movedst_occupant', RoleConstants.CASHIER, biz_b)
        movable = _make_user('movable_user', RoleConstants.CASHIER, biz_a)
        self._auth(self.super_admin)
        resp = self.client.patch(
            reverse('admin-user-detail', kwargs={'pk': movable.id}),
            {'business': biz_b.id},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('user limit', resp.data['detail'])
        movable.refresh_from_db()
        self.assertEqual(movable.business_id, biz_a.id)

    # (f) branch create blocked at max_branches (auto Main Branch counts).

    def test_branch_create_blocked_at_branch_limit(self):
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-business-list'),
            {'name': 'BranchCap Co', 'max_branches': 1},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        biz = Business.objects.get(pk=resp.data['id'])
        # perform_create already provisioned 'Main Branch' → limit reached.
        self.assertEqual(biz.branchs.count(), 1)
        admin_user = _make_user(
            'branchcap_admin', RoleConstants.BUSINESS_ADMIN, biz
        )
        self._auth(admin_user)
        resp = self.client.post(
            reverse('branch-list'), {'name': 'Annex'}, format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Branch limit reached', resp.data['detail'])
        self.assertEqual(biz.branchs.count(), 1)

    def test_branch_create_allowed_below_limit(self):
        self._auth(self.super_admin)
        resp = self.client.post(
            reverse('admin-business-list'),
            {'name': 'BranchOk Co', 'max_branches': 2},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        biz = Business.objects.get(pk=resp.data['id'])
        self.assertEqual(biz.branchs.count(), 1)  # auto Main Branch.
        admin_user = _make_user(
            'branchok_admin', RoleConstants.BUSINESS_ADMIN, biz
        )
        self._auth(admin_user)
        resp = self.client.post(
            reverse('branch-list'), {'name': 'Annex'}, format='json'
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(biz.branchs.count(), 2)

    # (g) stock adjustment with a branch_id works (branches/branchs fix).

    def test_stock_adjust_with_branch_creates_lot_on_branch(self):
        biz = _make_business('Adj Co', tax_rate='0.00')
        branch = _make_branch(biz, 'Adj Main')
        manager = _make_user(
            'adj_mgr', RoleConstants.MANAGER, biz, branch
        )
        item = _make_item(
            biz, 'ADJ-001', '100.00', '150.00', opening=0, branch=branch
        )
        self._auth(manager)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': item.id}),
            {'quantity': 7, 'branch': branch.id, 'note': 'restock'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['new_stock'], 7)
        lot = StockLot.objects.get(item=item, source=StockLot.ADJUSTMENT)
        self.assertEqual(lot.branch_id, branch.id)
        self.assertEqual(lot.quantity_total, 7)
        movement = StockMovement.objects.get(
            item=item, type=StockMovement.ADJUST
        )
        self.assertEqual(movement.branch_id, branch.id)


class DashboardSummaryTests(APITestCase):
    """Tests for GET /api/dashboard/summary/ endpoint."""

    def setUp(self):
        self.biz = _make_business('Dash Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        # Item with low stock (threshold default 5, stock 3)
        self.low_item = _make_item(
            self.biz, 'LOW-001', '50.00', '100.00', opening=3, branch=self.branch
        )
        # Normal item
        self.item = _make_item(
            self.biz, 'ITM-001', '50.00', '100.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def test_dashboard_summary_returns_expected_keys(self):
        # Create a sale today
        record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
        )
        # Create an installment sale with a due installment within 7 days
        sale_inst = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        # Adjust first installment due_date to today
        inst = sale_inst.installments.order_by('number').first()
        inst.due_date = timezone.localdate()
        inst.save(update_fields=['due_date'])

        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('dashboard-summary'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # Check all expected keys present
        expected_keys = {
            'today_sales', 'low_stock_count', 'low_stock_items',
            'top_item', 'due_installments_count', 'due_installments_list',
            'open_sales',
        }
        self.assertEqual(set(resp.data.keys()), expected_keys)

        # today_sales > 0
        self.assertGreater(Decimal(str(resp.data['today_sales'])), Decimal('0'))

        # top_item == item name
        self.assertEqual(resp.data['top_item'], self.item.name)

        # low_stock_count >= 1 and low_stock_items[0]['name']
        self.assertGreaterEqual(resp.data['low_stock_count'], 1)
        self.assertEqual(resp.data['low_stock_items'][0]['name'], self.low_item.name)

        # due_installments_count >= 1 and list has customer_name + due_amount
        self.assertGreaterEqual(resp.data['due_installments_count'], 1)
        due_list = resp.data['due_installments_list']
        self.assertGreaterEqual(len(due_list), 1)
        self.assertIn('customer_name', due_list[0])
        self.assertIn('due_amount', due_list[0])
        self.assertIn('invoice_no', due_list[0])
        self.assertIn('due_date', due_list[0])

        # open_sales present
        self.assertIn('open_sales', resp.data)

    def test_dashboard_summary_not_404(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('dashboard-summary'))
        self.assertNotEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class DashboardBranchSalesTests(APITestCase):
    """Tests for GET /api/dashboard/branch-sales/ endpoint."""

    def setUp(self):
        self.biz = _make_business('BranchSales Co', tax_rate='10.00')
        self.branch1 = _make_branch(self.biz, 'Branch One')
        self.branch2 = _make_branch(self.biz, 'Branch Two')
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch1)
        self.manager = _make_user('dashmgr', RoleConstants.MANAGER, self.biz, self.branch1)
        self.item = _make_item(
            self.biz, 'ITM-001', '50.00', '100.00', opening=20, branch=self.branch1
        )
        # Also create stock for branch2
        _make_item(
            self.biz, 'ITM-002', '50.00', '100.00', opening=20, branch=self.branch2
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def test_branch_sales_returns_two_branches(self):
        today = timezone.localdate()
        yesterday = today - timedelta(days=1)

        # Sale on branch1
        record_sale(
            business=self.biz, branch=self.branch1,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
        )
        # Sale on branch2 (need an item for branch2)
        item2 = Item.objects.get(code='ITM-002')
        record_sale(
            business=self.biz, branch=self.branch2,
            created_by=self.cashier,
            lines=[{'item': item2, 'quantity': 3}],
        )

        self.client.force_authenticate(self.manager)
        resp = self.client.get(
            reverse('dashboard-branch-sales'),
            {'start': yesterday.isoformat(), 'end': today.isoformat()}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsInstance(resp.data, list)
        self.assertEqual(len(resp.data), 2)
        for row in resp.data:
            self.assertIn('branch', row)
            self.assertIn('total', row)
            self.assertGreater(Decimal(str(row['total'])), Decimal('0'))
        # Sorted by total descending
        self.assertGreaterEqual(
            Decimal(str(resp.data[0]['total'])),
            Decimal(str(resp.data[1]['total']))
        )

    def test_branch_sales_empty_business_returns_empty_list(self):
        empty_biz = _make_business('Empty Co', tax_rate='0.00')
        empty_branch = _make_branch(empty_biz, 'Empty')
        empty_manager = _make_user('empty_mgr', RoleConstants.MANAGER, empty_biz, empty_branch)

        self.client.force_authenticate(empty_manager)
        resp = self.client.get(reverse('dashboard-branch-sales'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])


class CashierCostHiddenTests(APITestCase):
    """Tests that cashiers cannot see cost_price on items or fifo_cost on sale items."""

    def setUp(self):
        self.biz = _make_business('CostHide Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'ITM-001', '50.00', '100.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def test_cashier_item_list_hides_cost_price(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        item_data = next(r for r in resp.data['results'] if r['id'] == self.item.id)
        self.assertNotIn('cost_price', item_data)
        self.assertIn('selling_price', item_data)

    def test_manager_item_list_shows_cost_price(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('item-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        item_data = next(r for r in resp.data['results'] if r['id'] == self.item.id)
        self.assertIn('cost_price', item_data)

    def test_cashier_sale_detail_hides_fifo_cost(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
        )
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('sale-detail', kwargs={'pk': sale.id}))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_item = resp.data['items'][0]
        self.assertNotIn('fifo_cost', sale_item)
        self.assertIn('unit_price', sale_item)

    def test_manager_sale_detail_shows_fifo_cost(self):
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
        )
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('sale-detail', kwargs={'pk': sale.id}))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_item = resp.data['items'][0]
        self.assertIn('fifo_cost', sale_item)


class DashboardRoleGateTests(APITestCase):
    """Dashboard endpoints must be manager+ only (cashiers get 403)."""

    def setUp(self):
        self.biz = _make_business('RoleGate Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'ITM-001', '50.00', '100.00', opening=20, branch=self.branch
        )

    def test_cashier_forbidden_on_dashboard_summary(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('dashboard-summary'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_cashier_forbidden_on_dashboard_branch_sales(self):
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('dashboard-branch-sales'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_allowed_on_dashboard_summary(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('dashboard-summary'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_manager_allowed_on_dashboard_branch_sales(self):
        self.client.force_authenticate(self.manager)
        resp = self.client.get(reverse('dashboard-branch-sales'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)


class InstallmentDueViewTests(APITestCase):
    """Tests for GET /api/installments/due/ endpoint."""

    def setUp(self):
        self.biz = _make_business('Due Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'DUE-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Buyer')

    def test_cashier_can_list_due_installments(self):
        """Cashier can list due installments; unpaid installment appears with due_amount = amount."""
        from datetime import timedelta
        from django.utils import timezone

        # Create an installment sale with 2 installments
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        # First installment due today, second due in 5 days
        installments = list(sale.installments.order_by('number'))
        installments[0].due_date = timezone.localdate()
        installments[0].save(update_fields=['due_date'])
        installments[1].due_date = timezone.localdate() + timedelta(days=5)
        installments[1].save(update_fields=['due_date'])

        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('results', resp.data)
        self.assertEqual(len(resp.data['results']), 2)
        # Check first installment (due today)
        inst_data = next(i for i in resp.data['results'] if i['number'] == 1)
        self.assertEqual(Decimal(str(inst_data['due_amount'])), inst_data['amount'])
        self.assertFalse(inst_data['is_paid'])

    def test_due_installments_are_business_scoped(self):
        """Installments from another business do NOT appear."""
        from datetime import timedelta
        from django.utils import timezone

        # Create installment sale in biz A
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=1,
        )
        inst = sale.installments.first()
        inst.due_date = timezone.localdate()
        inst.save(update_fields=['due_date'])

        # Create another business with its own installment
        biz_b = _make_business('Other Biz', tax_rate='0.00')
        branch_b = _make_branch(biz_b)
        item_b = _make_item(biz_b, 'OTH-001', '100.00', '150.00', opening=10, branch=branch_b)
        cashier_b = _make_user('cash_b', RoleConstants.CASHIER, biz_b, branch_b)
        sale_b = record_sale(
            business=biz_b, branch=branch_b,
            created_by=cashier_b,
            lines=[{'item': item_b, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=1,
        )
        inst_b = sale_b.installments.first()
        inst_b.due_date = timezone.localdate()
        inst_b.save(update_fields=['due_date'])

        # Query as cashier from biz A
        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        self.assertEqual(resp.data['results'][0]['id'], inst.id)

    def test_due_installments_respects_days_param(self):
        """days param controls the due-soon window."""
        from datetime import timedelta
        from django.utils import timezone

        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )
        installments = list(sale.installments.order_by('number'))
        installments[0].due_date = timezone.localdate() + timedelta(days=3)  # within 7 days
        installments[0].save(update_fields=['due_date'])
        installments[1].due_date = timezone.localdate() + timedelta(days=10)  # outside 7 days
        installments[1].save(update_fields=['due_date'])

        self.client.force_authenticate(self.cashier)
        # Default days=7 should include only first
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        self.assertEqual(resp.data['results'][0]['number'], 1)

        # days=15 should include both
        resp = self.client.get(reverse('installments-due'), {'days': 15})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 2)

    def test_paid_installments_excluded(self):
        """Fully paid installments are excluded from results."""
        from datetime import timedelta
        from django.utils import timezone

        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=1,
        )
        inst = sale.installments.first()
        inst.due_date = timezone.localdate()
        inst.is_paid = True
        inst.paid_amount = inst.amount
        inst.save(update_fields=['is_paid', 'paid_amount'])

        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 0)

    def test_partially_paid_installment_included(self):
        """Partially paid installments are included with correct due_amount."""
        from datetime import timedelta
        from django.utils import timezone

        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=1,
        )
        inst = sale.installments.first()
        inst.due_date = timezone.localdate()
        inst.paid_amount = Decimal('20.00')
        inst.save(update_fields=['due_date', 'paid_amount'])

        self.client.force_authenticate(self.cashier)
        resp = self.client.get(reverse('installments-due'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        inst_data = resp.data['results'][0]
        self.assertEqual(Decimal(str(inst_data['due_amount'])), inst.amount - Decimal('20.00'))
        self.assertFalse(inst_data['is_paid'])


class CustomerHistoryViewTests(APITestCase):
    """Tests for GET /api/customers/<id>/history/ endpoint."""

    def setUp(self):
        self.biz = _make_business('Hist Co', tax_rate='10.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'HIST-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='History Buyer', phone='0771234567')

    def test_customer_history_shape(self):
        """Cashier GET returns 200 with customer/total_spent/outstanding/sales keys."""
        # Create a paid single-payment sale
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
        )

        self.client.force_authenticate(self.cashier)
        url = reverse('customer-history', kwargs={'pk': self.customer.id})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # Check all required keys
        self.assertIn('customer', resp.data)
        self.assertIn('total_sales_count', resp.data)
        self.assertIn('total_spent', resp.data)
        self.assertIn('outstanding', resp.data)
        self.assertIn('sales', resp.data)

        # Check values for a paid single-payment sale
        self.assertEqual(resp.data['total_sales_count'], 1)
        self.assertEqual(Decimal(str(resp.data['total_spent'])), sale.total_cost)
        self.assertEqual(Decimal(str(resp.data['outstanding'])), Decimal('0.00'))
        self.assertEqual(len(resp.data['sales']), 1)
        self.assertEqual(resp.data['sales'][0]['id'], sale.id)

    def test_customer_history_outstanding_open_sale(self):
        """Outstanding reflects remaining_cost of OPEN sales."""
        # Create an installment sale (OPEN with remaining_cost > 0)
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=2,
        )

        self.client.force_authenticate(self.cashier)
        url = reverse('customer-history', kwargs={'pk': self.customer.id})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self.assertEqual(resp.data['total_sales_count'], 1)
        self.assertEqual(Decimal(str(resp.data['total_spent'])), sale.total_cost)
        self.assertEqual(Decimal(str(resp.data['outstanding'])), sale.remaining_cost)

    def test_customer_history_excludes_cancelled_sales(self):
        """Cancelled sales are excluded from totals and list."""
        # Create a normal sale
        sale1 = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
        )
        # Create a cancelled sale
        sale2 = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
        )
        sale2.status = Sale.CANCELLED
        sale2.save(update_fields=['status'])

        self.client.force_authenticate(self.cashier)
        url = reverse('customer-history', kwargs={'pk': self.customer.id})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self.assertEqual(resp.data['total_sales_count'], 1)
        self.assertEqual(Decimal(str(resp.data['total_spent'])), sale1.total_cost)
        self.assertEqual(len(resp.data['sales']), 1)
        self.assertEqual(resp.data['sales'][0]['id'], sale1.id)

    def test_customer_history_latest_20_sales(self):
        """Only latest 20 sales are returned, ordered by -created_at."""
        # Create 25 sales (need enough stock)
        self.item.stock_quantity = 30
        self.item.save(update_fields=['stock_quantity'])
        lot = StockLot.objects.filter(item=self.item).first()
        lot.quantity_remaining = 30
        lot.save(update_fields=['quantity_remaining'])

        for i in range(25):
            record_sale(
                business=self.biz, branch=self.branch,
                created_by=self.cashier,
                lines=[{'item': self.item, 'quantity': 1}],
                customer=self.customer,
            )

        self.client.force_authenticate(self.cashier)
        url = reverse('customer-history', kwargs={'pk': self.customer.id})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self.assertEqual(len(resp.data['sales']), 20)
        # Check ordering: latest first
        for i in range(19):
            self.assertGreaterEqual(
                resp.data['sales'][i]['created_at'],
                resp.data['sales'][i + 1]['created_at']
            )


class SaleCancelViewTests(APITestCase):
    """Tests for POST /api/sales/<id>/cancel/ endpoint."""

    def setUp(self):
        self.biz = _make_business('Cancel Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz)
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.admin = _make_user('adm', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'CAN-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(business=self.biz, name='Cancel Buyer')

    def test_cashier_cannot_cancel_sale(self):
        """Cashier POST cancel -> 403."""
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
        )

        self.client.force_authenticate(self.cashier)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(resp.data['detail'], 'Only managers and admins can cancel sales.')

    def test_manager_cancels_sale_restores_lots(self):
        """Manager cancel restores lot quantities and item stock_quantity."""
        # Capture pre-sale stock state
        lot = StockLot.objects.filter(item=self.item).first()
        pre_lot_remaining = lot.quantity_remaining
        pre_item_stock = self.item.stock_quantity

        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 5}],
            customer=self.customer,
        )

        # Verify stock decreased
        lot.refresh_from_db()
        self.item.refresh_from_db()
        self.assertEqual(lot.quantity_remaining, pre_lot_remaining - 5)
        self.assertEqual(self.item.stock_quantity, pre_item_stock - 5)

        # Cancel as manager
        self.client.force_authenticate(self.manager)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # Verify sale status
        sale.refresh_from_db()
        self.assertEqual(sale.status, Sale.CANCELLED)
        self.assertEqual(sale.remaining_cost, Decimal('0.00'))

        # Verify stock restored
        lot.refresh_from_db()
        self.item.refresh_from_db()
        self.assertEqual(lot.quantity_remaining, pre_lot_remaining)
        self.assertEqual(self.item.stock_quantity, pre_item_stock)

        # Verify reversing StockMovement created
        movements = StockMovement.objects.filter(
            item=self.item, reference=sale.invoice_no, type=StockMovement.ADJUST
        )
        self.assertEqual(movements.count(), 1)
        movement = movements.first()
        self.assertEqual(movement.quantity, 5)
        self.assertEqual(movement.note, f'Cancelled sale {sale.invoice_no}')

    def test_admin_cancels_sale_restores_lots(self):
        """Business admin can also cancel sales."""
        lot = StockLot.objects.filter(item=self.item).first()
        pre_lot_remaining = lot.quantity_remaining

        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 3}],
            customer=self.customer,
        )

        self.client.force_authenticate(self.admin)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        sale.refresh_from_db()
        self.assertEqual(sale.status, Sale.CANCELLED)

        lot.refresh_from_db()
        self.assertEqual(lot.quantity_remaining, pre_lot_remaining)

    def test_cancel_already_cancelled_returns_400(self):
        """Cancelling an already cancelled sale returns 400."""
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            customer=self.customer,
        )
        sale.status = Sale.CANCELLED
        sale.save(update_fields=['status'])

        self.client.force_authenticate(self.manager)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(resp.data['detail'], 'Sale is already cancelled.')

    def test_cancel_sale_with_no_items_allowed(self):
        """Cancelling a sale with no items is allowed (edge case)."""
        sale = Sale.objects.create(
            business=self.biz, branch=self.branch, customer=self.customer,
            created_by=self.cashier,
            invoice_no='INV-TEST-001',
            subtotal=Decimal('0.00'), total_cost=Decimal('0.00'),
            remaining_cost=Decimal('0.00'), status=Sale.OPEN,
        )

        self.client.force_authenticate(self.manager)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        sale.refresh_from_db()
        self.assertEqual(sale.status, Sale.CANCELLED)

    def test_cancel_response_mirrors_pay_installment(self):
        """Response structure matches pay_installment (SaleDetailSerializer)."""
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 2}],
            customer=self.customer,
        )

        self.client.force_authenticate(self.manager)
        url = reverse('sale-cancel', kwargs={'pk': sale.id})
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # Check SaleDetailSerializer fields present
        self.assertIn('id', resp.data)
        self.assertIn('invoice_no', resp.data)
        self.assertIn('items', resp.data)
        self.assertIn('installments', resp.data)
        self.assertIn('payments', resp.data)
        self.assertEqual(resp.data['status'], Sale.CANCELLED)

class TenantScopeRegressionTests(APITestCase):
    """Regressions for the cross-tenant write holes closed this round."""

    def setUp(self):
        self.biz_a = _make_business('ScopeA', tax_rate='0.00')
        self.biz_b = _make_business('ScopeB', tax_rate='0.00')
        self.branch_a = _make_branch(self.biz_a, 'A Main')
        self.branch_b = _make_branch(self.biz_b, 'B Main')
        self.mgr_a = _make_user('scope_mgr_a', RoleConstants.MANAGER, self.biz_a, self.branch_a)
        self.cash_a = _make_user('scope_cash_a', RoleConstants.CASHIER, self.biz_a, self.branch_a)
        self.cat_a = ExpenseCategory.objects.create(business=self.biz_a, name='Rent A')
        self.cat_b = ExpenseCategory.objects.create(business=self.biz_b, name='Rent B')
        self.acct_b = CashAccount.objects.create(business=self.biz_b, name='B Cash')
        self.item_a = _make_item(
            self.biz_a, 'A-S-001', '10.00', '20.00', opening=5, branch=self.branch_a
        )
        self.item_b = _make_item(
            self.biz_b, 'B-S-001', '10.00', '20.00', opening=5, branch=self.branch_b
        )

    def _auth(self, user):
        self.client.force_authenticate(user)

    # -- ExpenseCreateSerializer must only accept this tenant's FKs --------

    def test_expense_rejects_foreign_category(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('expense-list'),
            {'category': self.cat_b.id, 'description': 'x', 'amount': '10.00'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('category', resp.data)

    def test_expense_rejects_foreign_branch(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('expense-list'),
            {
                'branch': self.branch_b.id,
                'category': self.cat_a.id,
                'description': 'x',
                'amount': '10.00',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('branch', resp.data)

    def test_expense_rejects_foreign_cash_account(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('expense-list'),
            {
                'category': self.cat_a.id,
                'cash_account': self.acct_b.id,
                'description': 'x',
                'amount': '10.00',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('cash_account', resp.data)

    def test_expense_accepts_own_tenant_rows(self):
        acct_a = CashAccount.objects.create(business=self.biz_a, name='A Cash')
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('expense-list'),
            {
                'branch': self.branch_a.id,
                'category': self.cat_a.id,
                'cash_account': acct_a.id,
                'description': 'rent',
                'amount': '10.00',
                'expense_date': '2026-01-15',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    # -- Manual stock adjustment is manager+ and tenant-scoped -------------

    def test_item_adjust_requires_manager(self):
        """Cashiers must not be able to rewrite stock."""
        self._auth(self.cash_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': 3},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_item_adjust_allowed_for_manager(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': 3, 'branch': self.branch_a.id, 'note': 'restock'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['new_stock'], 8)
        lot = StockLot.objects.get(item=self.item_a, source=StockLot.ADJUSTMENT)
        self.assertEqual(lot.branch_id, self.branch_a.id)
        self.assertTrue(
            StockMovement.objects.filter(
                item=self.item_a, type=StockMovement.ADJUST
            ).exists()
        )

    def test_item_adjust_requires_branch(self):
        """StockLot.branch is NOT NULL, so omitting it must be a 400, not a 500."""
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': 3},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('branch', resp.data)

    def test_item_adjust_negative_quantity_writes_off_without_lot(self):
        """A write-off lowers stock and records the movement, but opens no lot."""
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': -2, 'branch': self.branch_a.id, 'note': 'damaged'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['new_stock'], 3)
        self.assertFalse(
            StockLot.objects.filter(
                item=self.item_a, source=StockLot.ADJUSTMENT
            ).exists()
        )
        self.assertTrue(
            StockMovement.objects.filter(
                item=self.item_a, type=StockMovement.ADJUST, quantity=-2
            ).exists()
        )

    def test_item_adjust_rejects_foreign_branch(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': 1, 'branch': self.branch_b.id},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_item_adjust_cannot_touch_foreign_item(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_b.id}),
            {'quantity': 1},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_item_adjust_rejects_zero_quantity(self):
        self._auth(self.mgr_a)
        resp = self.client.post(
            reverse('item-adjust', kwargs={'pk': self.item_a.id}),
            {'quantity': 0},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


class BusinessUserIsolationTests(APITestCase):
    """`/api/users/` must stay inside one tenant and never mint a super admin."""

    def setUp(self):
        self.biz_a = _make_business('UsersA', tax_rate='0.00')
        self.biz_b = _make_business('UsersB', tax_rate='0.00')
        self.branch_a = _make_branch(self.biz_a, 'A Main')
        self.branch_b = _make_branch(self.biz_b, 'B Main')
        self.admin_a = _make_user(
            'u_admin_a', RoleConstants.BUSINESS_ADMIN, self.biz_a, self.branch_a
        )
        self.mgr_a = _make_user('u_mgr_a', RoleConstants.MANAGER, self.biz_a, self.branch_a)
        self.staff_b = _make_user('u_staff_b', RoleConstants.MANAGER, self.biz_b, self.branch_b)

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_list_only_returns_own_business(self):
        self._auth(self.admin_a)
        resp = self.client.get(reverse('user-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        usernames = [r['username'] for r in resp.data['results']]
        self.assertIn('u_admin_a', usernames)
        self.assertNotIn('u_staff_b', usernames)

    def test_cannot_read_foreign_user(self):
        self._auth(self.admin_a)
        resp = self.client.get(reverse('user-detail', kwargs={'pk': self.staff_b.id}))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_create_super_admin(self):
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'evil', 'password': 'testpass1234',
                'role': RoleConstants.SUPER_ADMIN, 'full_name': 'Evil',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_escalate_existing_user_role(self):
        self._auth(self.admin_a)
        resp = self.client.patch(
            reverse('user-detail', kwargs={'pk': self.mgr_a.id}),
            {'role': RoleConstants.SUPER_ADMIN},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_move_user_to_other_business(self):
        self._auth(self.admin_a)
        resp = self.client.patch(
            reverse('user-detail', kwargs={'pk': self.mgr_a.id}),
            {'business': self.biz_b.id},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_rejects_foreign_business(self):
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'smuggled', 'password': 'testpass1234',
                'role': RoleConstants.CASHIER, 'full_name': 'Smuggled',
                'business': self.biz_b.id,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(username='smuggled').exists())

    def test_create_forces_own_business(self):
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'new_cashier', 'password': 'testpass1234',
                'role': RoleConstants.CASHIER, 'full_name': 'New Cashier',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data['business'], self.biz_a.id)

    def test_create_rejects_foreign_branch(self):
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'bad_branch', 'password': 'testpass1234',
                'role': RoleConstants.CASHIER, 'full_name': 'Bad Branch',
                'branch': self.branch_b.id,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_manager_cannot_manage_users(self):
        self._auth(self.mgr_a)
        resp = self.client.get(reverse('user-list'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_max_users_enforced(self):
        self.biz_a.max_users = 1
        self.biz_a.save(update_fields=['max_users'])
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'overflow', 'password': 'testpass1234',
                'role': RoleConstants.CASHIER, 'full_name': 'Overflow',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(username='overflow').exists())

    def test_unlimited_when_max_users_is_null(self):
        self._auth(self.admin_a)
        resp = self.client.post(
            reverse('user-list'),
            {
                'username': 'seat_ok', 'password': 'testpass1234',
                'role': RoleConstants.CASHIER, 'full_name': 'Seat OK',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_cannot_deactivate_self(self):
        self._auth(self.admin_a)
        resp = self.client.patch(
            reverse('user-detail', kwargs={'pk': self.admin_a.id}),
            {'is_active': False},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_demote_self(self):
        self._auth(self.admin_a)
        resp = self.client.patch(
            reverse('user-detail', kwargs={'pk': self.admin_a.id}),
            {'role': RoleConstants.CASHIER},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_list_reports_seat_limit(self):
        self.biz_a.max_users = 5
        self.biz_a.save(update_fields=['max_users'])
        self._auth(self.admin_a)
        resp = self.client.get(reverse('user-list'))
        self.assertEqual(resp.data['max_users'], 5)
        self.assertEqual(resp.data['seats_used'], 2)


class SupplierLedgerTests(APITestCase):
    """The statement bills only received stock and nets off payments."""

    def setUp(self):
        self.biz = _make_business('LedgerCo', tax_rate='0.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.mgr = _make_user('led_mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.supplier = Supplier.objects.create(business=self.biz, name='Acme')
        self.item = _make_item(
            self.biz, 'LED-1', '10.00', '20.00', opening=0, branch=self.branch
        )

    def _auth(self, user):
        self.client.force_authenticate(user)

    def _purchase(self, order_no, status, quantity, received, unit_cost, total):
        purchase = Purchase.objects.create(
            business=self.biz, branch=self.branch, supplier=self.supplier,
            order_no=order_no, status=status, ordered_by=self.mgr,
        )
        PurchaseItem.objects.create(
            business=self.biz, purchase=purchase, item=self.item,
            quantity=quantity, received_quantity=received,
            unit_cost=Decimal(unit_cost), total=Decimal(total),
        )
        return purchase

    def test_empty_ledger_is_zero(self):
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['total_billed'], Decimal('0.00'))
        self.assertEqual(resp.data['total_paid'], Decimal('0.00'))
        self.assertEqual(resp.data['balance'], Decimal('0.00'))
        self.assertEqual(resp.data['purchases'], [])

    def test_draft_order_is_not_a_payable(self):
        self._purchase('PO-D1', Purchase.DRAFT, 10, 0, '10.00', '100.00')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.data['total_billed'], Decimal('0.00'))

    def test_cancelled_order_is_not_a_payable(self):
        self._purchase('PO-C1', Purchase.CANCELLED, 10, 10, '10.00', '100.00')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.data['total_billed'], Decimal('0.00'))

    def test_partial_receipt_bills_only_received_value(self):
        self._purchase('PO-P1', Purchase.PARTIALLY_RECEIVED, 10, 4, '10.00', '100.00')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.data['total_billed'], Decimal('40.00'))
        self.assertEqual(resp.data['balance'], Decimal('40.00'))
        self.assertEqual(resp.data['purchases'][0]['received_value'], Decimal('40.00'))

    def test_fully_received_bills_whole_line(self):
        self._purchase('PO-R1', Purchase.RECEIVED, 10, 10, '10.00', '100.00')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.data['total_billed'], Decimal('100.00'))

    def test_payment_reduces_balance(self):
        purchase = self._purchase(
            'PO-R2', Purchase.RECEIVED, 10, 10, '10.00', '100.00'
        )
        SupplierPayment.objects.create(
            business=self.biz, supplier=self.supplier, purchase=purchase,
            amount=Decimal('40.00'), payment_date='2026-01-15', paid_by=self.mgr,
        )
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': self.supplier.id})
        )
        self.assertEqual(resp.data['total_paid'], Decimal('40.00'))
        self.assertEqual(resp.data['balance'], Decimal('60.00'))
        self.assertEqual(len(resp.data['payments']), 1)

    def test_ledger_is_tenant_scoped(self):
        other_biz = _make_business('OtherCo', tax_rate='0.00')
        other_supplier = Supplier.objects.create(business=other_biz, name='Other')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': other_supplier.id})
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class ReportContractTests(APITestCase):
    """The four frontend report routes resolve and are manager+."""

    def setUp(self):
        self.biz = _make_business('RepCo', tax_rate='18.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.mgr = _make_user('rep_mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.cashier = _make_user('rep_cash', RoleConstants.CASHIER, self.biz, self.branch)

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_all_four_reports_return_200(self):
        self._auth(self.mgr)
        for name in (
            'report-profit-loss', 'report-balance-sheet',
            'report-cash-flow', 'report-tax',
        ):
            with self.subTest(report=name):
                resp = self.client.get(reverse(name))
                self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_profit_loss_shape(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-profit-loss'))
        for key in ('revenue', 'cogs', 'gross_profit', 'expenses', 'net_profit'):
            self.assertIn(key, resp.data)

    def test_balance_sheet_shape_and_balances_when_empty(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-balance-sheet'))
        for key in ('as_of', 'assets', 'liabilities', 'equity', 'difference'):
            self.assertIn(key, resp.data)
        self.assertEqual(resp.data['difference'], Decimal('0.00'))

    def test_balance_sheet_rejects_bad_as_of(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-balance-sheet'), {'as_of': 'not-a-date'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cash_flow_has_weekly_buckets(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-cash-flow'))
        self.assertEqual(len(resp.data['buckets']), 13)
        for bucket in resp.data['buckets']:
            for key in ('week_start', 'inflows', 'outflows', 'net', 'cumulative'):
                self.assertIn(key, bucket)

    def test_cash_flow_weeks_is_configurable(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-cash-flow'), {'weeks': 4})
        self.assertEqual(len(resp.data['buckets']), 4)

    def test_tax_report_uses_business_rate(self):
        self._auth(self.mgr)
        resp = self.client.get(reverse('report-tax'))
        self.assertEqual(resp.data['rate'], '18.00')
        self.assertIn('taxable_sales', resp.data)
        self.assertIn('payable', resp.data)

    def test_cashier_cannot_read_reports(self):
        self._auth(self.cashier)
        resp = self.client.get(reverse('report-balance-sheet'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class RoleMatrixTests(APITestCase):
    """Backend permissions must match the frontend route matrix."""

    def setUp(self):
        self.biz = _make_business('RoleCo', tax_rate='0.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.admin = _make_user('role_admin', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)
        self.mgr = _make_user('role_mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.cashier = _make_user('role_cash', RoleConstants.CASHIER, self.biz, self.branch)

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_manager_can_read_recurring_expenses(self):
        """`/expenses/recurring` is business_admin+manager in the route matrix."""
        self._auth(self.mgr)
        resp = self.client.get(reverse('recurringexpense-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_cashier_cannot_read_recurring_expenses(self):
        self._auth(self.cashier)
        resp = self.client.get(reverse('recurringexpense-list'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_can_read_supplier_ledger(self):
        supplier = Supplier.objects.create(business=self.biz, name='Acme')
        self._auth(self.mgr)
        resp = self.client.get(
            reverse('supplier-ledger', kwargs={'pk': supplier.id})
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_super_admin_cannot_reach_tenant_user_endpoint(self):
        """Super admins have no business, so the tenant endpoint refuses them."""
        root = User.objects.create_superuser(
            username='root_super', password='testpass1234',
            role=RoleConstants.SUPER_ADMIN, business=None,
        )
        self._auth(root)
        resp = self.client.get(reverse('user-list'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class BusinessFinanceSettingsTests(APITestCase):
    """GET/PATCH /api/finance-settings/: business_admin tax_rate singleton."""

    def setUp(self):
        self.biz = _make_business('FinCo', tax_rate='10.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.admin = _make_user('fin_adm', RoleConstants.BUSINESS_ADMIN, self.biz, self.branch)
        self.manager = _make_user('fin_mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.cashier = _make_user('fin_cash', RoleConstants.CASHIER, self.biz, self.branch)
        # Second tenant: any read/write attempt against it must be impossible.
        self.other_biz = _make_business('OtherFin', tax_rate='5.00')

    def _auth(self, user):
        self.client.force_authenticate(user)

    def test_admin_get_returns_own_tax_rate_as_string(self):
        self._auth(self.admin)
        resp = self.client.get(reverse('finance-settings'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            set(resp.data.keys()), {'tax_rate', 'installment_interest_rate'},
        )
        self.assertEqual(resp.data['tax_rate'], '10.00')
        self.assertIsInstance(resp.data['tax_rate'], str)
        self.assertEqual(resp.data['installment_interest_rate'], '0.00')
        self.assertIsInstance(resp.data['installment_interest_rate'], str)

    def test_admin_patch_updates_rate_and_get_reflects(self):
        self._auth(self.admin)
        resp = self.client.patch(
            reverse('finance-settings'), {'tax_rate': '15.00'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['tax_rate'], '15.00')
        self.assertIsInstance(resp.data['tax_rate'], str)

        follow_up = self.client.get(reverse('finance-settings'))
        self.assertEqual(follow_up.status_code, status.HTTP_200_OK)
        self.assertEqual(follow_up.data['tax_rate'], '15.00')
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.tax_rate, Decimal('15.00'))

    def test_get_is_scoped_to_caller_business(self):
        """A smuggled business id in the query cannot expose another tenant."""
        self._auth(self.admin)
        resp = self.client.get(
            reverse('finance-settings') + f'?business={self.other_biz.id}'
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['tax_rate'], '10.00')
        self.assertNotEqual(resp.data['tax_rate'], str(self.other_biz.tax_rate))

    def test_patch_cannot_write_other_business(self):
        """A business id in the body is ignored: only the caller's row moves."""
        self._auth(self.admin)
        resp = self.client.patch(
            reverse('finance-settings'),
            {'tax_rate': '77.00', 'business': self.other_biz.id},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['tax_rate'], '77.00')
        self.other_biz.refresh_from_db()
        self.assertEqual(self.other_biz.tax_rate, Decimal('5.00'))
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.tax_rate, Decimal('77.00'))

    def test_manager_and_cashier_denied_on_get_and_patch(self):
        for user in (self.manager, self.cashier):
            self._auth(user)
            resp = self.client.get(reverse('finance-settings'))
            self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
            resp = self.client.patch(
                reverse('finance-settings'), {'tax_rate': '20.00'}, format='json',
            )
            self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
            resp = self.client.patch(
                reverse('finance-settings'),
                {'installment_interest_rate': '9.00'}, format='json',
            )
            self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.tax_rate, Decimal('10.00'))
        self.assertEqual(self.biz.installment_interest_rate, Decimal('0.00'))

    def test_invalid_tax_rate_rejected(self):
        self._auth(self.admin)
        for bad in ('101', '-1', 'abc'):
            resp = self.client.patch(
                reverse('finance-settings'), {'tax_rate': bad}, format='json',
            )
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
            self.assertIn('tax_rate', resp.data)
            self.assertTrue(resp.data['tax_rate'])
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.tax_rate, Decimal('10.00'))

    def test_user_without_business_gets_400(self):
        orphan = _make_user('fin_orphan', RoleConstants.BUSINESS_ADMIN, None)
        self._auth(orphan)
        resp = self.client.get(reverse('finance-settings'))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.client.patch(
            reverse('finance-settings'), {'tax_rate': '15.00'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_updated_rate_flows_into_sale_tax_math(self):
        self._auth(self.admin)
        resp = self.client.patch(
            reverse('finance-settings'), {'tax_rate': '15.00'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.biz.refresh_from_db()

        item = _make_item(
            self.biz, 'FIN-001', '100.00', '200.00', opening=10, branch=self.branch
        )
        sale = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': item, 'quantity': 2}],
        )
        # Sale omitted tax_rate → service defaults to business.tax_rate (15%).
        # subtotal 2×200 = 400 → tax 60.00, total 460.00.
        self.assertEqual(sale.tax_rate, Decimal('15.00'))
        self.assertEqual(sale.tax_amount, Decimal('60.00'))
        self.assertEqual(sale.total_cost, Decimal('460.00'))

    def test_admin_get_returns_installment_interest_rate(self):
        """GET /api/finance-settings/ returns installment_interest_rate."""
        self._auth(self.admin)
        resp = self.client.get(reverse('finance-settings'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(set(resp.data.keys()), {'tax_rate', 'installment_interest_rate'})
        self.assertEqual(resp.data['tax_rate'], '10.00')
        self.assertEqual(resp.data['installment_interest_rate'], '0.00')

    def test_admin_patch_installment_interest_rate_and_get_reflects(self):
        """PATCH {installment_interest_rate: "3.50"} → GET returns "3.50"."""
        self._auth(self.admin)
        resp = self.client.patch(
            reverse('finance-settings'),
            {'installment_interest_rate': '3.50'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['installment_interest_rate'], '3.50')
        self.assertIsInstance(resp.data['installment_interest_rate'], str)

        follow_up = self.client.get(reverse('finance-settings'))
        self.assertEqual(follow_up.status_code, status.HTTP_200_OK)
        self.assertEqual(follow_up.data['installment_interest_rate'], '3.50')
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.installment_interest_rate, Decimal('3.50'))

    def test_invalid_installment_interest_rate_rejected(self):
        """Out-of-range (101) or non-numeric interest rates are rejected."""
        self._auth(self.admin)
        for bad in ('101', '-1', 'abc'):
            resp = self.client.patch(
                reverse('finance-settings'),
                {'installment_interest_rate': bad}, format='json',
            )
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
            self.assertIn('installment_interest_rate', resp.data)
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.installment_interest_rate, Decimal('0.00'))

    def test_installment_interest_rate_tenant_isolation(self):
        """Patching our rate leaves the second tenant's row untouched."""
        self._auth(self.admin)
        resp = self.client.patch(
            reverse('finance-settings'),
            {'installment_interest_rate': '3.50'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.other_biz.refresh_from_db()
        self.assertEqual(
            self.other_biz.installment_interest_rate, Decimal('0.00'),
        )
        self.biz.refresh_from_db()
        self.assertEqual(self.biz.installment_interest_rate, Decimal('3.50'))


class SaleListFilterTests(APITestCase):
    """Tests for granular list filters on GET /api/sales/ and is_fully_paid flag."""

    def setUp(self):
        self.biz = _make_business('Filter Co', tax_rate='0.00')
        self.branch = _make_branch(self.biz, 'Main')
        self.cashier = _make_user('cash', RoleConstants.CASHIER, self.biz, self.branch)
        self.manager = _make_user('mgr', RoleConstants.MANAGER, self.biz, self.branch)
        self.item = _make_item(
            self.biz, 'F-001', '100.00', '150.00', opening=20, branch=self.branch
        )
        self.customer = Customer.objects.create(
            business=self.biz, name='Acme Corp', phone='0771234567', nic='987654321'
        )

        from datetime import timedelta
        from django.utils import timezone

        # Create sales with different states
        # 1. Fully paid (remaining_cost = 0) via single payment
        self.sale_paid = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
        )

        # 2. Outstanding (remaining_cost > 0) via installment
        self.sale_outstanding = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('50.00'),
            number_of_installments=3,
        )

        # 3. Outstanding sale with a customer (installment, so remaining_cost > 0)
        self.sale_with_customer = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
            is_single_payment=False,
            down_payment=Decimal('0.00'),
            number_of_installments=1,
            customer=self.customer,
        )

    def _auth(self, user):
        self.client.force_authenticate(user)

    def _list_sales(self, params=None):
        url = reverse('sale-list')
        if params:
            return self.client.get(url, params), url
        return self.client.get(url), url

    # ── customer_name filter ──────────────────────────────────────
    def test_customer_name_filter_returns_matches(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_name': 'Acme'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        self.assertEqual(resp.data['results'][0]['customer_name'], 'Acme Corp')

    def test_customer_name_filter_no_match(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_name': 'Nonexistent'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 0)

    def test_customer_name_filter_ignored_when_absent(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # All sales (paid, outstanding, with customer, without) should appear
        self.assertGreaterEqual(len(resp.data['results']), 3)

    # ── customer_phone filter ─────────────────────────────────────
    def test_customer_phone_filter_returns_matches(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_phone': '0771234567'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        self.assertEqual(resp.data['results'][0]['customer_name'], 'Acme Corp')

    def test_customer_phone_filter_no_match(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_phone': '0779998887'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 0)

    # ── customer_nic filter ───────────────────────────────────────
    def test_customer_nic_filter_returns_matches(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_nic': '987654321'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 1)
        self.assertEqual(resp.data['results'][0]['customer_name'], 'Acme Corp')

    def test_customer_nic_filter_no_match(self):
        self._auth(self.cashier)
        resp, _ = self._list_sales({'customer_nic': '000000000'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data['results']), 0)

    # ── date_from / date_to range ─────────────────────────────────
    def test_date_from_filter_returns_newer_sales(self):
        from datetime import timedelta
        self._auth(self.cashier)
        # Create a recent sale
        recent = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
        )
        # Set created_at to 2 days ago via ORM (aware datetime avoids naive/USE_TZ warning)
        recent.created_at = timezone.now() - timedelta(days=2)
        recent.save(update_fields=['created_at'])
        resp, _ = self._list_sales({'date_from': (timezone.localdate() - timedelta(days=2)).isoformat()})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # The recent sale (created 2 days ago) should appear with date_from=2 days ago;
        # older sales (if any) filtered out
        sale_ids = [s['id'] for s in resp.data['results']]
        self.assertIn(recent.id, sale_ids)

    def test_date_to_filter_returns_older_sales(self):
        from django.utils import timezone
        from datetime import timedelta
        self._auth(self.cashier)
        # Create an older sale
        older = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
        )
        # Set created_at to 10 days ago via ORM (aware datetime avoids naive/USE_TZ warning)
        older.created_at = timezone.now() - timedelta(days=10)
        older.save(update_fields=['created_at'])
        resp, _ = self._list_sales({'date_to': (timezone.localdate() - timedelta(days=5)).isoformat()})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_ids = [s['id'] for s in resp.data['results']]
        self.assertIn(older.id, sale_ids)

    def test_date_from_date_to_combined(self):
        from django.utils import timezone
        from datetime import timedelta
        self._auth(self.cashier)
        # Create a sale within the range
        mid = record_sale(
            business=self.biz, branch=self.branch,
            created_by=self.cashier,
            lines=[{'item': self.item, 'quantity': 1}],
        )
        # Set created_at to 3 days ago via ORM (aware datetime avoids naive/USE_TZ warning)
        mid.created_at = timezone.now() - timedelta(days=3)
        mid.save(update_fields=['created_at'])
        start = (timezone.localdate() - timedelta(days=5)).isoformat()
        end = (timezone.localdate() - timedelta(days=1)).isoformat()
        resp, _ = self._list_sales({'date_from': start, 'date_to': end})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_ids = [s['id'] for s in resp.data['results']]
        self.assertIn(mid.id, sale_ids)

    # ── paid_status filter ────────────────────────────────────────
    def test_paid_status_fully_paid(self):
        """fully_paid should return only sales with remaining_cost <= 0."""
        self._auth(self.cashier)
        resp, _ = self._list_sales({'paid_status': 'fully_paid'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_ids = [s['id'] for s in resp.data['results']]
        # sale_paid has remaining_cost=0, sale_outstanding has >0, sale_with_customer has >0
        self.assertIn(self.sale_paid.id, sale_ids)
        self.assertNotIn(self.sale_outstanding.id, sale_ids)
        self.assertNotIn(self.sale_with_customer.id, sale_ids)

    def test_paid_status_outstanding(self):
        """outstanding should return only sales with remaining_cost > 0."""
        self._auth(self.cashier)
        resp, _ = self._list_sales({'paid_status': 'outstanding'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sale_ids = [s['id'] for s in resp.data['results']]
        self.assertIn(self.sale_outstanding.id, sale_ids)
        self.assertNotIn(self.sale_paid.id, sale_ids)
        # sale_with_customer is an installment sale with 0 down payment,
        # so remaining_cost = total_cost > 0 → it IS outstanding
        self.assertIn(self.sale_with_customer.id, sale_ids)

    def test_paid_status_invalid_value_ignored(self):
        """Non-paid_status values should be ignored, all sales returned."""
        self._auth(self.cashier)
        resp, _ = self._list_sales({'paid_status': 'invalid'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertGreaterEqual(len(resp.data['results']), 3)

    # ── is_fully_paid field in list response ──────────────────────
    def test_is_fully_paid_true_when_remaining_cost_zero(self):
        """is_fully_paid should be True for sale with remaining_cost <= 0."""
        self._auth(self.cashier)
        resp, _ = self._list_sales({})
        # Find the paid sale in the list
        for s in resp.data['results']:
            if s['id'] == self.sale_paid.id:
                self.assertTrue(s['is_fully_paid'])
                break

    def test_is_fully_paid_false_when_remaining_cost_nonzero(self):
        """is_fully_paid should be False for sale with remaining_cost > 0."""
        self._auth(self.cashier)
        resp, _ = self._list_sales({})
        for s in resp.data['results']:
            if s['id'] == self.sale_outstanding.id:
                self.assertFalse(s['is_fully_paid'])
                break
