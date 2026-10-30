-- Independent reconstruction: no application transition, projection or database RPC computes expected values.
WITH violations AS (
  SELECT r.sandbox_id,r.id AS rfq_id,'ACCEPTANCE_ORDER_COUNT' AS invariant
  FROM fi.rfqs r LEFT JOIN fi.orders o ON (o.sandbox_id,o.rfq_id)=(r.sandbox_id,r.id)
  GROUP BY r.sandbox_id,r.id,r.state
  HAVING count(o.id)<>CASE WHEN r.state='ACCEPTED' THEN 1 ELSE 0 END
  UNION ALL
  SELECT r.sandbox_id,r.id,'ORDER_CONTRACT_MISMATCH'
  FROM fi.orders o JOIN fi.rfqs r ON (r.sandbox_id,r.id)=(o.sandbox_id,o.rfq_id)
  JOIN fi.quotes q ON (q.sandbox_id,q.id)=(o.sandbox_id,o.quote_id)
  JOIN fi.instrument_versions iv ON iv.id=r.instrument_revision
  WHERE r.accepted_quote_id IS DISTINCT FROM q.id OR o.status<>'PENDING_ACK'
    OR o.contract IS DISTINCT FROM q.snapshot||jsonb_build_object('clean_price',CASE r.side WHEN 'BUY' THEN q.ask_clean_price ELSE q.bid_clean_price END)
    OR o.contract->>'side' IS DISTINCT FROM r.side
    OR o.contract->>'par_amount' IS DISTINCT FROM r.par_amount::text
    OR o.contract->>'settlement_date' IS DISTINCT FROM r.settlement_date::text
    OR o.contract->>'instrument_revision' IS DISTINCT FROM iv.id
    OR o.contract->'instrument_terms' IS DISTINCT FROM iv.terms
    OR o.contract->>'financial_source' IS DISTINCT FROM iv.financial_source
    OR o.contract->>'valuation_model_version' IS DISTINCT FROM 'phase1-regular-coupon-v1'
    OR o.created_at>=q.expires_at OR o.created_at>=r.expires_at
  UNION ALL
  SELECT q.sandbox_id,q.rfq_id,'DEALER_GRID_MISMATCH'
  FROM fi.quotes q JOIN fi.rfqs r ON (r.sandbox_id,r.id)=(q.sandbox_id,q.rfq_id)
  JOIN fi.instrument_versions iv ON iv.id=r.instrument_revision
  JOIN (VALUES
    ('SYN-UST-2031','ATLAS','99.950000000123','100.050000000123'),
    ('SYN-UST-2031','BIRCH','99.940000000123','100.060000000123'),
    ('SYN-UST-2031','CEDAR','99.930000000123','100.070000000123'),
    ('SYN-CORP-2031','ATLAS','98.950000000123','99.050000000123'),
    ('SYN-CORP-2031','BIRCH','98.940000000123','99.060000000123'),
    ('SYN-CORP-2031','CEDAR','98.930000000123','99.070000000123')) AS expected(instrument,dealer,bid,ask)
    ON expected.instrument=iv.instrument_id AND expected.dealer=q.dealer_id
  WHERE q.bid_clean_price<>expected.bid OR q.ask_clean_price<>expected.ask
    OR q.snapshot->>'model_version' IS DISTINCT FROM 'synthetic-dealer-grid-v1'
    OR q.snapshot->>'valuation_model_version' IS DISTINCT FROM 'phase1-regular-coupon-v1'
    OR q.snapshot->>'bid_clean_price' IS DISTINCT FROM q.bid_clean_price
    OR q.snapshot->>'ask_clean_price' IS DISTINCT FROM q.ask_clean_price
    OR q.snapshot->>'instrument_id' IS DISTINCT FROM iv.instrument_id
    OR q.snapshot->>'instrument_revision' IS DISTINCT FROM iv.id
    OR q.snapshot->>'financial_source' IS DISTINCT FROM iv.financial_source
    OR q.snapshot->'instrument_terms' IS DISTINCT FROM iv.terms
    OR q.snapshot->>'side' IS DISTINCT FROM r.side
    OR q.snapshot->>'par_amount' IS DISTINCT FROM r.par_amount::text
    OR q.snapshot->>'settlement_date' IS DISTINCT FROM r.settlement_date::text
    OR q.snapshot->>'quote_id' IS DISTINCT FROM q.id::text
    OR q.snapshot->>'rfq_id' IS DISTINCT FROM r.id::text
    OR q.snapshot->>'dealer_id' IS DISTINCT FROM q.dealer_id
    OR q.snapshot->>'currency' IS DISTINCT FROM 'USD'
    OR q.snapshot->>'price_unit' IS DISTINCT FROM 'per 100 par'
    OR q.snapshot->>'quoted_at' IS DISTINCT FROM to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR q.snapshot->>'expires_at' IS DISTINCT FROM to_char(q.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  UNION ALL
  SELECT c.sandbox_id,(c.response_body->'rfq'->>'id')::uuid,'ACCEPTANCE_AUDIT_MISMATCH'
  FROM fi.commands c LEFT JOIN fi.audit_events e ON (e.sandbox_id,e.command_id)=(c.sandbox_id,c.id)
  WHERE c.operation='ACCEPT_QUOTE' AND c.result_kind='APPLIED'
  GROUP BY c.sandbox_id,c.id,c.response_body
  HAVING count(e.command_id)<>3 OR array_agg(e.event_type ORDER BY e.event_index)<>ARRAY['QUOTE_ACCEPTED','RFQ_ACCEPTED','ORDER_CREATED']
)
SELECT sandbox_id,rfq_id,invariant FROM violations ORDER BY sandbox_id,rfq_id,invariant;
