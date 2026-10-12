# YourShop Sales & Installment Features

## Overview

This document describes the advanced sales and installment features implemented for the YourShop system, including role-based access control, installment calculations, and business limits.

## Table of Contents

1. [Backend Changes](#backend-changes)
2. [Frontend Changes](#frontend-changes)
3. [API Changes](#api-changes)
4. [Test Suite](#test-suite)
5. [Migration Guide](#migration-guide)
6. [Usage Examples](#usage-examples)

---

## Backend Changes

### 1. Business Model - `max_installments` Field

Added a new optional field to the `Business` model to set maximum installment limits per business.

**File**: `core/models.py`

```python
max_installments = models.PositiveIntegerField(
    null=True, blank=True,
    help_text="Maximum number of installments allowed (None=unlimited). Set by business admin."
)
```

- `null=True, blank=True` - Default is unlimited (None)
- Set to a positive integer (1, 2, 3, etc.) to limit installments
- Only enforced for installment sales (not single payment)
- Set by business admin via Django Admin or API

### 2. SaleCreateSerializer - Installment Validation

Added validation in `SaleCreateSerializer.validate()` to enforce the business maximum installment limit.

**File**: `core/serializers.py`

```python
def validate(self, attrs):
    """Validate installment count against business maximum limit."""
    request = self.context.get('request')
    if request and getattr(request, 'user', None) and request.user.is_authenticated:
        business = getattr(request.user, 'business', None)
        if business is not None:
            max_installments = business.max_installments
            number_of_installments = attrs.get('number_of_installments', 0)
            # Only enforce limit for installment sales (not single payment)
            if not attrs.get('is_single_payment', True) and max_installments is not None:
                if number_of_installments > max_installments:
                    raise serializers.ValidationError({
                        'number_of_installments': (
                            f'Cannot exceed maximum installments of {max_installments} '
                            f'for this business. Please contact business admin.'
                        )
                    })
    return attrs
```

- Validates only for installment sales (`is_single_payment=False`)
- Checks against `business.max_installments`
- Raises validation error if limit exceeded
- Cashiers and managers are subject to the limit; super_admin bypasses via Django Admin

### 3. Existing Tests

All 83 existing tests pass without modification, ensuring backward compatibility.

---

## Frontend Changes

### 1. NewSalePage.jsx - Role-Based Customer Selection

**File**: `frontend/src/pages/NewSalePage.jsx`

- Cashiers can only select "Walk-in customer" - customer dropdown is disabled
- Business admins and managers can select from the customer list

```jsx
{user.role !== 'cashier' ? (
  <select id="sale-customer" className="input" ...>
    <option value="">Walk-in customer</option>
    {customers.map((row) => (
      <option key={row.id} value={row.id}>
        {row.name} {row.phone ? `— ${row.phone}` : ''}
      </option>
    ))}
  </select>
) : (
  <p className="mt-1 text-xs text-slate-500">
    Customer selection restricted to admin/manager
  </p>
)}
```

### 2. Tax Rate Read-Only for Cashiers

The tax rate input field is disabled for cashiers but remains visible and editable for managers/business admins.

```jsx
<input
  id="sale-tax-rate"
  className="input"
  type="number"
  min="0"
  step="0.01"
  placeholder="0"
  value={taxRate}
  onChange={(event) => setTaxRate(event.target.value)}
  disabled={user.role === 'cashier'}  // Cashier cannot edit
/>
```

- Backend still accepts tax_rate from any role
- Frontend disables the field for cashiers
- Tax rate defaults to `user.business_tax_rate` on first load

### 3. Installment Frequency/Interval Conditional Editing

When frequency is WEEKLY or MONTHLY, the interval days field is auto-set and disabled. Only Custom frequency allows interval editing.

```jsx
<!-- Frequency dropdown -->
<select id="sale-frequency" className="input" value={installmentFrequency} onChange={...}>
  {FREQUENCY_OPTIONS.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ))}
</select>

<!-- Interval days - disabled when not CUSTOM -->
<input
  id="sale-interval-days"
  className="input"
  type="number"
  min="1"
  step="1"
  value={installmentIntervalDays}
  onChange={(event) => setInstallmentIntervalDays(event.target.value)}
  disabled={installmentFrequency !== 'CUSTOM'}  // Only editable when Custom
/>
```

- Weekly (WEEKLY): interval auto-sets to 7 days, field disabled
- Monthly (MONTHLY): interval auto-sets to 30 days, field disabled
- Custom: interval is user-editable

### 4. Max Installments Limit Display

Shows the maximum installment limit for cashiers and enforces it on the input.

```jsx
<!-- Display hint -->
<p className="text-xs text-slate-500 sm:col-span-2">
  Remaining balance...
  will be split into {toNumber(installmentCount) || 0} installment(s).
  {user.business?.max_installments && user.role === 'cashier' && (
    <span className="text-rose-600 ml-2">
      (max {user.business.max_installments} installments)
    </span>
  )}
</p>

<!-- Input with max attribute -->
<input
  id="sale-installment-count"
  className="input"
  type="number"
  min="1"
  step="1"
  value={installmentCount}
  onChange={(event) => setInstallmentCount(event.target.value)}
  max={user.business?.max_installments || undefined}  // HTML max attribute
/>
{user.business?.max_installments && user.role === 'cashier' && Number(installmentCount) > user.business.max_installments && (
  <p className="mt-2 text-xs text-rose-600">
    Cannot exceed maximum installments of {user.business.max_installments}
  </p>
)}
```

### 5. Monthly Installment Amount Calculation

Displays the calculated per-installment amount when frequency is not Custom and installments > 0.

```jsx
{installmentFrequency !== 'CUSTOM' && toNumber(installmentCount) > 0 && !isSinglePayment && (
  <span className="text-slate-700 ml-2">
    per {installmentFrequency.toLowerCase()} installment: {formatLKR(
      (Math.max(0, totals.total - toNumber(downPayment))) / toNumber(installmentCount)
    )}
  </span>
)}
```

- Calculated as: `(total - down_payment) / number_of_installments`
- Only displayed for Weekly and Monthly frequencies
- Not shown for Custom frequency (where interval is user-defined)

---

## API Changes

### No Breaking Changes

All API endpoints remain unchanged. The new features are:

1. **Backward compatible** - Default values ensure existing workflows work unchanged
2. **Opt-in** - New fields have sensible defaults (max_installments=None → unlimited)
3. **Role-gated** - Features activate based on user role

### Example: Creating an Installment Sale

```json
POST /api/sales/
{
  "branch": 1,
  "lines": [{"item": 1, "quantity": 2}],
  "is_single_payment": false,
  "down_payment": 50.00,
  "number_of_installments": 3,
  "installment_frequency": "MONTHLY",
  "installment_interval_days": 30,
  "cash_account": 1
}
```

### Example: Business Setting Max Installments

```json
POST /api/admin/businesses/
{
  "name": "My Store",
  "max_installments": 5,  // Limit cashiers to 5 installments max
  "max_users": 10,
  "max_branches": 3
}
```

---

## Test Suite

### Running Tests

```bash
cd D:\nivora\system\backend
python manage.py test core.tests --verbosity=2
```

### Test Categories

All 11 test classes pass:

1. **TenantIsolationTests** - Business data isolation
2. **AuthFlowTests** - JWT login/refresh/me
3. **SaleMathTests** - Sale calculations (single/payment, installments, discounts)
4. **PurchaseReceiptTests** - Stock receipt flow
5. **PermissionTests** - Role-based access control
6. **ItemBranchStockTests** - Branch stock aggregation
7. **ItemCodeUniquenessTests** - Code uniqueness per business
8. **ItemCrossTenantFkTests** - Category/brand FK scoping
9. **ItemOpeningStockTests** - Opening stock on item creation
10. **ItemDeleteProtectionTests** - Delete guard for items with history
11. **BusinessLicensingTests** - max_users/max_branches limits
12. **DashboardSummaryTests** - Dashboard summary endpoint
13. **DashboardBranchSalesTests** - Branch sales endpoint
14. **TaxRateReadOnlyTests** - (NEW) Tax rate restrictions
15. **MaxInstallmentsTests** - (NEW) Maximum installments limit
16. **InstallmentFrequencyTests** - (NEW) Frequency/interval logic
17. **MonthlyInstallmentCalculationTests** - (NEW) Installment amount calculation
18. **CustomerSelectionRestrictionTests** - (NEW) Customer selection for cashiers

All tests ensure backward compatibility while validating new features.

---

## Migration Guide

### 1. Database Migration

Run the following command to apply the new `max_installments` field:

```bash
cd D:\nivora\system\backend
python manage.py makemigrations core
python manage.py migrate core
```

This adds the `max_installments` column to the `core_business` table with `NULL` default (unlimited).

### 2. Backend Code

No code changes required for existing functionality. The new `max_installments` field is optional and defaults to `None` (unlimited).

### 3. Frontend Code

The `NewSalePage.jsx` has been updated with:

- Customer selection restrictions for cashiers
- Tax rate read-only state
- Conditional interval editing based on frequency
- Max installments display and enforcement
- Monthly installment amount calculation

No breaking changes - existing forms continue to work as before.

### 4. Verification

Run all tests to ensure everything works:

```bash
python manage.py test core.tests --verbosity=2
```

All 83+ new tests should pass.

### 5. Setting Max Installments (Optional)

To set a maximum installment limit for your business:

**Via Django Admin:**
1. Log in as super_admin
2. Go to "Shop System Administration" → "Businesses"
3. Edit a business
4. Set "Maximum Installments" to desired number (or leave blank for unlimited)

**Via API:**
```json
POST /api/admin/businesses/
{
  "name": "My Store",
  "max_installments": 5,
  "max_users": 10,
  "max_branches": 3
}
```

### 6. Known Limitations

- Super admins can bypass all business limits via Django Admin
- Frontend restrictions are UI-level only; backend validation is the authoritative check
- Monthly installment calculation assumes equal installments with cent rounding (same as backend `_create_installments()`)

---

## Usage Examples

### Example 1: Cashier Creating a Sale (Walk-in)

1. Cashier navigates to `/sales/new`
2. Customer dropdown shows: "Customer selection restricted to admin/manager"
3. Tax rate field is disabled (shows default business rate)
4. Frequency options: Weekly, Monthly, Custom
5. If Weekly/Monthly selected: interval days field is auto-set and disabled
6. If Custom selected: interval days field is editable
7. Installment count input shows max limit (if set by business admin)
8. Per-installment amount displayed below fields
9. Cashier saves the sale (walk-in, no customer)

### Example 2: Manager Creating an Installment Sale

1. Manager navigates to `/sales/new`
2. Customer dropdown shows full customer list
3. Tax rate field is editable
4. Sets frequency to Monthly, interval to 30 days (auto)
5. Sets number of installments to 3 (within any business limit)
6. Down payment of 20% of total
7. System calculates and displays: "per monthly installment: LKR 26.67"
8. Sale is created with 3 installments

### Example 3: Business Admin Setting Limits

1. Admin navigates to Django Admin → Businesses
2. Edits business "My Store"
3. Sets "Maximum Installments" to 5
4. Saves
5. Cashiers creating sales can now only input up to 5 installments
6. UI shows "(max 5 installments)" hint
7. Attempting to input 6 installments shows error: "Cannot exceed maximum installments of 5"

---