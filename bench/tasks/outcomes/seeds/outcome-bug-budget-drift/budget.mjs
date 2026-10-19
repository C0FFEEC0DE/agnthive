// budget.mjs — seeded bugfix target (deliberately contains a real bug).
//
// The per-line rounding below drifts from the end-rounded total on
// multi-line inputs that carry half-cent amounts between lines. The seeded
// test suite stays green because it only covers cases where the two agree.
// Outcome task outcome-bug-budget-drift expects a regression case plus the
// fix (round once after aggregation, not per line).
export function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

export function subtotal(lines) {
  let total = 0;
  for (const line of lines) {
    total += roundMoney(line.amount * (1 + line.tax));
  }
  return total;
}