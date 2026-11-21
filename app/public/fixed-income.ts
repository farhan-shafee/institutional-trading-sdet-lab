import { analyticsResponseSchema } from '../domain/fixed-income/contracts.js';
import { zeroAnalyticsSchema } from '../domain/fixed-income-v2/zero.js';
import { advancedAnalyticsView } from './advanced-analytics.js';

/** Independent view; request ownership follows the existing token plus a reset epoch. */
export function fixedIncomeView(getToken: () => string | null, expired: () => void) {
  const form = document.getElementById('fi-form') as HTMLFormElement;
  const results = document.getElementById('fi-results')!;
  const error = document.getElementById('fi-error')!;
  const submit = document.getElementById('fi-submit') as HTMLButtonElement;
  const panel = document.getElementById('fixed-income-panel') as HTMLDetailsElement;
  const advanced = advancedAnalyticsView(getToken, expired);
  let epoch = 0;
  for (const name of ['yield', 'clean_price']) {
    const field = form.elements.namedItem(name) as HTMLInputElement;
    field.addEventListener('input', () => {
      if (field.value !== '')
        (
          form.elements.namedItem(name === 'yield' ? 'clean_price' : 'yield') as HTMLInputElement
        ).value = '';
    });
  }
  const reset = () => {
    epoch++;
    advanced.reset();
    form.reset();
    results.replaceChildren();
    error.textContent = '';
    submit.disabled = false;
    panel.open = false;
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void calculate();
  });
  async function calculate() {
    const owner = getToken(),
      version = ++epoch;
    if (!owner) return;
    const current = () => getToken() === owner && version === epoch;
    results.replaceChildren();
    error.textContent = '';
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const query = new URLSearchParams();
      for (const [key, value] of fields)
        if (typeof value === 'string' && value !== '') query.set(key, value);
      const zero = query.get('instrument_id') === 'SYN-ZERO-2031';
      const response = await fetch(
        `/api/fixed-income/${zero ? 'v2' : 'v1'}/analytics?${query.toString()}`,
        {
          headers: { Authorization: `Bearer ${owner}` },
        },
      );
      if (!current()) return;
      if (response.status === 401) {
        expired();
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 400
            ? 'Invalid fixed-income query; check instrument, date, units and supported ranges.'
            : `Analytics unavailable (HTTP ${response.status}).`,
        );
      const body: unknown = await response.json();
      if (!current()) return;
      if (zero) {
        const parsed = zeroAnalyticsSchema.safeParse(body);
        if (!parsed.success)
          throw new Error('Server response did not match the expected contract.');
        const a = parsed.data;
        if (a.settlement_date !== query.get('settlement_date'))
          throw new Error(
            'Server response did not match the expected contract for this settlement date.',
          );
        const lines = [
          `Analytics only · ${a.instrument.id} · ${a.model_version}; this instrument is ineligible for RFQ/order entry.`,
          `Settlement date: ${a.settlement_date}; par amount USD: ${a.par_amount}`,
          `Annual yield: ${a.yield}; ACT/365F simple compounding`,
          `Clean price per 100 par: ${a.clean_price}`,
          `Dirty price per 100 par: ${a.dirty_price}`,
          `Accrued interest per 100 par: ${a.accrued_interest}`,
          `Consideration USD: ${a.consideration_usd}`,
          `Maturity: ${a.instrument.maturity_date}; days to maturity: ${a.days_to_maturity}; time in years: ${a.time_to_maturity_years}`,
          ...Object.entries(a.conventions).map(([key, value]) => `${key}: ${String(value)}`),
        ];
        for (const line of lines) {
          const p = document.createElement('p');
          p.textContent = line;
          results.append(p);
        }
        return;
      }
      const parsed = analyticsResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error('Server response did not match the expected contract.');
      const a = parsed.data;
      if (
        a.instrument.id !== query.get('instrument_id') ||
        a.settlement_date !== query.get('settlement_date')
      )
        throw new Error(
          'Server response did not match the expected contract for this instrument and settlement date.',
        );
      const lines = [
        `Settlement date: ${a.settlement_date}; par amount USD: ${a.par_amount}`,
        `Instrument: ${a.instrument.id} · ${a.instrument.issuer} · ${a.instrument.day_count}`,
        `Dated date: ${a.instrument.dated_date}; maturity: ${a.instrument.maturity_date}; coupon: ${a.instrument.coupon_rate} annual decimal; frequency: ${a.instrument.frequency}`,
        `Annual yield: ${a.yield}`,
        `Clean price per 100 par: ${a.clean_price}`,
        `Dirty price per 100 par: ${a.dirty_price}`,
        `Accrued interest per 100 par: ${a.accrued_interest}`,
        `Consideration USD: ${a.consideration_usd}`,
        `Macaulay duration years: ${a.macaulay_duration}`,
        `Modified duration years: ${a.modified_duration}`,
        `Convexity years squared: ${a.convexity}`,
        `DV01 USD for stated long par: ${a.dv01_usd}`,
        `Previous coupon: ${a.previous_coupon_date}; next coupon: ${a.next_coupon_date}`,
        `Remaining coupon dates: ${a.remaining_coupon_dates.join(', ')}`,
        ...Object.entries(a.conventions).map(([key, value]) => `${key}: ${String(value)}`),
      ];
      for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        results.append(p);
      }
    } catch (failure) {
      if (current())
        error.textContent = failure instanceof Error ? failure.message : 'Analytics unavailable.';
    } finally {
      if (current()) submit.disabled = false;
    }
  }
  return { reset };
}
