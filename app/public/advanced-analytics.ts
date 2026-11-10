import { curveAnalyticsSchema } from '../domain/fixed-income-v3/contracts.js';

/** Read-only immutable fixture views; valuation remains entirely server-side. */
export function advancedAnalyticsView(getToken: () => string | null, expired: () => void) {
  const form = document.getElementById('curve-form') as HTMLFormElement;
  const results = document.getElementById('curve-results')!;
  const provenance = document.getElementById('curve-provenance')!;
  const error = document.getElementById('curve-error')!;
  const submit = document.getElementById('curve-submit') as HTMLButtonElement;
  let epoch = 0;
  const reset = () => {
    epoch++;
    form.reset();
    results.replaceChildren();
    provenance.textContent = '';
    error.textContent = '';
    submit.disabled = false;
  };
  for (const name of ['z_spread', 'clean_price']) {
    const field = form.elements.namedItem(name) as HTMLInputElement;
    field.addEventListener('input', () => {
      if (field.value !== '')
        (
          form.elements.namedItem(
            name === 'z_spread' ? 'clean_price' : 'z_spread',
          ) as HTMLInputElement
        ).value = '';
    });
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void calculate();
  });
  async function calculate() {
    const owner = getToken(),
      version = ++epoch;
    if (!owner) return;
    const current = () => owner === getToken() && version === epoch;
    results.replaceChildren();
    provenance.textContent = '';
    error.textContent = '';
    submit.disabled = true;
    try {
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form))
        if (typeof value === 'string' && value !== '') query.set(name, value);
      const response = await fetch('/api/fixed-income/v3/analytics?' + query.toString(), {
        headers: { Authorization: 'Bearer ' + owner },
      });
      if (!current()) return;
      if (response.status === 401) {
        expired();
        return;
      }
      if (!response.ok)
        throw new Error(
          `Curve mark unavailable (HTTP ${response.status}); check supported dates, par and spread/price inputs.`,
        );
      const body: unknown = await response.json();
      if (!current()) return;
      const parsed = curveAnalyticsSchema.safeParse(body);
      if (!parsed.success) throw new Error('Server response did not match the expected contract.');
      const a = parsed.data;
      if (
        a.instrument_id !== query.get('instrument_id') ||
        a.as_of_date !== query.get('as_of_date') ||
        a.curve.fixture_id !== query.get('fixture_id')
      )
        throw new Error(
          'Server response did not match the expected contract for this requested instrument, date and fixture.',
        );
      const lines = [
        `Curve fixture: ${a.curve.fixture_id}`,
        `Economic as-of date: ${a.as_of_date}; instrument: ${a.instrument_id}; par USD: ${a.par_amount}`,
        `USD mark: ${a.mark_value_usd}; this is a valuation, not settlement cash.`,
        `Continuous z-spread: ${a.z_spread}`,
        `Clean price per 100 par: ${a.clean_price}; dirty price: ${a.dirty_price}; accrued interest: ${a.accrued_interest}`,
      ];
      provenance.textContent = [
        ...a.curve.nodes.map(
          (node) =>
            `Node +${node.offset_days} days: zero rate ${node.zero_rate}; discount factor ${node.discount_factor}`,
        ),
        ...a.remaining_cash_flows.map(
          (flow) =>
            `Contractual flow ${flow.payment_date}: ${flow.amount_per_100} per100, discount factor ${flow.discount_factor}`,
        ),
        `Source: ${a.curve.snapshot_id}; definition: ${a.definition_version}; model: ${a.model_version}`,
        ...Object.entries(a.conventions).map(([key, value]) => `${key}: ${String(value)}`),
      ].join('\n');
      for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        results.append(p);
      }
    } catch (failure) {
      if (current())
        error.textContent = failure instanceof Error ? failure.message : 'Curve mark unavailable.';
    } finally {
      if (current()) submit.disabled = false;
    }
  }
  return { reset };
}
