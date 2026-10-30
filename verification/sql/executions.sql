-- Independent ledger oracle: no application RPC, lifecycle helper or cash helper is called.
WITH contracts AS (
 SELECT o.*, (o.contract->>'par_amount')::numeric original_par, (o.contract->>'settlement_date')::date settlement,
 (o.contract->>'clean_price')::numeric clean, o.contract->'instrument_terms'->>'day_count' day_count
 FROM fi.orders o
), coupon_periods AS (
 SELECT coupon::date previous,lead(coupon::date) OVER(ORDER BY coupon) following
 FROM generate_series(DATE '2025-01-15',DATE '2031-01-15',interval '6 months') coupon
), rational AS (
 SELECT e.*, c.contract, c.clean, p.previous,p.following,
 CASE c.day_count WHEN 'ACT_ACT_ICMA' THEN c.settlement-p.previous ELSE
 360*(extract(year FROM c.settlement)::int-extract(year FROM p.previous)::int)+30*(extract(month FROM c.settlement)::int-extract(month FROM p.previous)::int)+extract(day FROM c.settlement)::int-extract(day FROM p.previous)::int END elapsed,
 CASE c.day_count WHEN 'ACT_ACT_ICMA' THEN p.following-p.previous ELSE 180 END period
 FROM fi.executions e JOIN contracts c ON(c.sandbox_id,c.id)=(e.sandbox_id,e.order_id)
 JOIN coupon_periods p ON c.settlement>=p.previous AND c.settlement<p.following
), cents_ratio AS (
 SELECT r.*, par_amount*100*(clean*1000000000000*period+2*elapsed*1000000000000::numeric) numerator,
 100*1000000000000::numeric*period denominator FROM rational r
), expected_cash AS (
 SELECT *, div(numerator,denominator)+CASE WHEN 2*mod(numerator,denominator)>denominator OR (2*mod(numerator,denominator)=denominator AND mod(div(numerator,denominator),2)=1) THEN 1 ELSE 0 END cents
 FROM cents_ratio
), order_sums AS (
 SELECT sandbox_id,order_id,sum(par_amount) par,sum(consideration_cents) cash,count(*) n,max(fill_sequence) last_fill
 FROM fi.executions GROUP BY sandbox_id,order_id
), position_sums AS (
 SELECT sandbox_id,instrument_revision,sum(CASE side WHEN 'BUY' THEN par_amount ELSE -par_amount END) par,
 sum(CASE side WHEN 'BUY' THEN -consideration_cents ELSE consideration_cents END) cash,count(*) n,max(command_seq) seq
 FROM fi.executions GROUP BY sandbox_id,instrument_revision
), violations AS (
 SELECT c.sandbox_id,c.id order_id,'ORDER_TOTALS' invariant FROM contracts c LEFT JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(c.sandbox_id,c.id)
 LEFT JOIN order_sums e ON(e.sandbox_id,e.order_id)=(c.sandbox_id,c.id)
 WHERE l.order_id IS NULL OR l.filled_par IS DISTINCT FROM COALESCE(e.par,0) OR l.executed_cents IS DISTINCT FROM COALESCE(e.cash,0) OR l.execution_count IS DISTINCT FROM COALESCE(e.n,0)
 OR COALESCE(e.n,0)>8 OR COALESCE(e.last_fill,0)<>COALESCE(e.n,0) OR l.filled_par>c.original_par
 OR l.remaining_par IS DISTINCT FROM CASE WHEN l.status IN ('CANCELED','REJECTED') THEN 0 ELSE c.original_par-COALESCE(e.par,0) END
 OR (l.status='FILLED') IS DISTINCT FROM (COALESCE(e.par,0)=c.original_par)
 OR (l.status IN ('NEW','PENDING_ACK','REJECTED') AND COALESCE(e.par,0)<>0)
 UNION ALL
 SELECT e.sandbox_id,e.order_id,'EXECUTION_CASH' FROM expected_cash e
 WHERE e.consideration_cents IS DISTINCT FROM e.cents OR e.accrual_elapsed IS DISTINCT FROM e.elapsed OR e.accrual_period IS DISTINCT FROM e.period
 UNION ALL
 SELECT e.sandbox_id,e.order_id,'EXECUTION_CONTRACT' FROM fi.executions e JOIN contracts c ON(c.sandbox_id,c.id)=(e.sandbox_id,e.order_id)
 WHERE e.clean_price IS DISTINCT FROM c.contract->>'clean_price' OR e.side IS DISTINCT FROM c.contract->>'side' OR e.instrument_revision IS DISTINCT FROM c.contract->>'instrument_revision' OR e.settlement_date IS DISTINCT FROM c.settlement
 OR NOT EXISTS(SELECT 1 FROM expected_cash x WHERE x.sandbox_id=e.sandbox_id AND x.id=e.id)
 UNION ALL
 SELECT COALESCE(e.sandbox_id,p.sandbox_id),NULL::uuid,'POSITION_TOTALS' FROM position_sums e FULL JOIN fi.positions p USING(sandbox_id,instrument_revision)
 WHERE e.n IS NULL OR p.sandbox_id IS NULL OR p.signed_par IS DISTINCT FROM e.par OR p.signed_cash_cents IS DISTINCT FROM e.cash OR p.execution_count IS DISTINCT FROM e.n OR p.last_command_seq IS DISTINCT FROM e.seq
 UNION ALL
 SELECT e.sandbox_id,e.order_id,'EXECUTION_AUDIT' FROM fi.executions e LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(e.sandbox_id,e.command_seq,e.event_index)
 WHERE a.command_id IS DISTINCT FROM e.command_id OR a.event_type IS DISTINCT FROM 'EXECUTION_RECORDED' OR a.payload->>'execution_id' IS DISTINCT FROM e.id::text
 OR a.decided_at IS DISTINCT FROM e.decided_at OR a.recorded_at<e.decided_at
 OR (SELECT count(*) FROM fi.audit_events WHERE sandbox_id=e.sandbox_id AND command_seq=e.command_seq)<>3
 UNION ALL
 SELECT l.sandbox_id,l.order_id,'LIFECYCLE_HISTORY' FROM fi.order_states l
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.version)=(l.sandbox_id,l.order_id,l.version)
 WHERE h.version IS NULL OR h.state->>'status' IS DISTINCT FROM l.status OR h.state->>'filled_par' IS DISTINCT FROM l.filled_par::text
 OR h.state->>'remaining_par' IS DISTINCT FROM l.remaining_par::text OR h.state->>'executed_cents' IS DISTINCT FROM l.executed_cents::text
 OR h.state->>'pending_cancel_id' IS DISTINCT FROM l.pending_cancel_id::text
 OR (SELECT count(*) FROM fi.order_history WHERE sandbox_id=l.sandbox_id AND order_id=l.order_id)<>l.version
 UNION ALL
 SELECT r.sandbox_id,r.order_id,'CANCELLATION_STATE' FROM fi.cancellation_requests r
 JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(r.sandbox_id,r.order_id)
 LEFT JOIN fi.cancellation_outcomes o ON(o.sandbox_id,o.cancel_id)=(r.sandbox_id,r.id)
 WHERE (o.cancel_id IS NULL) IS DISTINCT FROM (l.pending_cancel_id IS NOT DISTINCT FROM r.id)
 OR (o.outcome='ACKNOWLEDGED' AND l.status<>'CANCELED')
 OR (o.reason='TOO_LATE' AND l.status<>'FILLED')
)
SELECT * FROM violations ORDER BY sandbox_id,order_id,invariant;
