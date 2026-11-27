/**
 * Installment maths shared by New Sale and the calculator, so a quoted figure
 * always matches the sale. Mirrors `minimum_down_payment` and
 * `installment_amount` in backend/core/services.py.
 */

/** Share of the total, rounded UP to the next 100. */
export function minimumDownPayment(total, percent) {
  const totalCents = Math.round(total * 100);
  return Math.ceil((totalCents * percent) / 1000000 - 1e-9) * 100;
}

/** What is left to finance after the down payment (never negative). */
export function balanceAfter(total, down) {
  return Math.max(0, Math.round((total - down) * 100) / 100);
}

/**
 * Flat monthly interest, each installment rounded UP to the next 50.
 * Monthly plans have one month per installment; others count 30 days as one.
 * Without interest the balance is split evenly.
 */
export function installmentPlan({ balance, monthlyRate, count, frequency = 'MONTHLY', intervalDays = 30 }) {
  const months = frequency === 'MONTHLY' ? count : (count * intervalDays) / 30;
  const perInstallment =
    count === 0
      ? 0
      : monthlyRate > 0
        ? Math.ceil((balance * (1 + (monthlyRate * months) / 100)) / count / 50 - 1e-9) * 50
        : balance / count;
  const planTotal = monthlyRate > 0 ? perInstallment * count : balance;
  return { perInstallment, planTotal, interest: planTotal - balance };
}
