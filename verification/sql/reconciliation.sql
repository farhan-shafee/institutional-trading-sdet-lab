-- Independent, sandbox-scoped evidence. Expected values are reconstructed from immutable ledger/contract records.
-- No application calculator, projection body helper or business command is invoked.
WITH definitions(revision,instrument,day_count) AS (VALUES
 ('phase1-ust-1','SYN-UST-2031','ACT_ACT_ICMA'),('phase1-corp-1','SYN-CORP-2031','THIRTY_360_US')),
contracts AS (
 SELECT o.*,o.contract->>'instrument_revision' revision,(o.contract->>'par_amount')::numeric original_par,
 (o.contract->>'settlement_date')::date settlement,(o.contract->>'clean_price')::numeric clean,
 jsonb_build_object('order_id',o.id::text,'rfq_id',o.rfq_id::text,'quote_id',o.quote_id::text,'instrument_revision',o.contract->>'instrument_revision') related
 FROM fi.orders o WHERE o.sandbox_id=$1
), periods AS (
 SELECT coupon::date previous,lead(coupon::date) OVER(ORDER BY coupon) following
 FROM generate_series(DATE '2025-01-15',DATE '2031-01-15',interval '6 months') coupon
), raw_cash AS (
 SELECT e.*,c.related||jsonb_build_object('execution_id',e.id::text,'command_id',e.command_id::text,'command_seq',e.command_seq::text) related,c.contract,
 c.clean,c.settlement,c.revision,
 CASE d.day_count WHEN 'ACT_ACT_ICMA' THEN c.settlement-p.previous ELSE
 360*(extract(year FROM c.settlement)::int-extract(year FROM p.previous)::int)+30*(extract(month FROM c.settlement)::int-extract(month FROM p.previous)::int)+extract(day FROM c.settlement)::int-15 END elapsed,
 CASE d.day_count WHEN 'ACT_ACT_ICMA' THEN p.following-p.previous ELSE 180 END period
 FROM fi.executions e JOIN contracts c ON(c.sandbox_id,c.id)=(e.sandbox_id,e.order_id)
 JOIN definitions d ON d.revision=c.revision JOIN periods p ON c.settlement>=p.previous AND c.settlement<p.following WHERE e.sandbox_id=$1
), ratios AS (
 SELECT r.*,par_amount*100*(clean*1000000000000*period+2*elapsed*1000000000000::numeric) numerator,100*1000000000000::numeric*period denominator FROM raw_cash r
), cash AS (
 SELECT *,div(numerator,denominator)+CASE WHEN 2*mod(numerator,denominator)>denominator OR (2*mod(numerator,denominator)=denominator AND mod(div(numerator,denominator),2)=1) THEN 1 ELSE 0 END expected_cents FROM ratios
), order_totals AS (
 SELECT order_id,sum(par_amount) par,sum(consideration_cents) cents,count(*) n FROM fi.executions WHERE sandbox_id=$1 GROUP BY order_id
), position_totals AS (
 SELECT instrument_revision,sum(CASE side WHEN 'BUY' THEN par_amount ELSE -par_amount END) par,sum(CASE side WHEN 'BUY' THEN -consideration_cents ELSE consideration_cents END) cents,count(*) n,max(command_seq) seq
 FROM fi.executions WHERE sandbox_id=$1 GROUP BY instrument_revision
), owned_positions AS (SELECT * FROM fi.positions WHERE sandbox_id=$1),
command_events AS (
 SELECT c.*,count(a.command_id) n,min(a.event_index) first_index,max(a.event_index) last_index,
 count(a.command_id) FILTER(WHERE a.command_seq<>c.command_seq) wrong_seq,
 string_agg(a.event_type,',' ORDER BY a.event_index) event_types
 FROM fi.commands c LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_id)=(c.sandbox_id,c.id) WHERE c.sandbox_id=$1 GROUP BY c.sandbox_id,c.id
), history AS (
 SELECT h.*,lag(h.state->>'status') OVER(PARTITION BY h.order_id ORDER BY h.version) previous_status,
 lag(h.version) OVER(PARTITION BY h.order_id ORDER BY h.version) previous_version
 FROM fi.order_history h WHERE h.sandbox_id=$1
), findings AS (
 SELECT 'ORDER_QUANTITY' category,x.code,'ORDER' record_kind,c.id::text record_id,c.related,
 jsonb_build_object('value',x.expected) expected,jsonb_build_object('value',x.observed) observed
 FROM contracts c LEFT JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(c.sandbox_id,c.id) LEFT JOIN order_totals t ON t.order_id=c.id
 CROSS JOIN LATERAL(VALUES
 ('ORDER_FILLED_PAR',to_char(COALESCE(t.par,0),'FM999999999990.00'),l.filled_par::text),
 ('ORDER_REMAINING_PAR',to_char(CASE WHEN l.status IN ('CANCELED','REJECTED') THEN 0 ELSE c.original_par-COALESCE(t.par,0) END,'FM999999999990.00'),l.remaining_par::text),
 ('ORDER_EXECUTED_CENTS',COALESCE(t.cents,0)::text,l.executed_cents::text),
 ('ORDER_EXECUTION_COUNT',COALESCE(t.n,0)::text,l.execution_count::text)) x(code,expected,observed)
 WHERE x.expected IS DISTINCT FROM x.observed
 UNION ALL
 SELECT 'EXECUTION_FINANCE','EXECUTION_CONSIDERATION','EXECUTION',id::text,related,
 jsonb_build_object('consideration_cents',expected_cents::text,'accrual_elapsed',elapsed::text,'accrual_period',period::text,'clean_price',contract->>'clean_price','par_amount',par_amount::text,'settlement_date',settlement::text,'day_count',contract->'instrument_terms'->>'day_count'),
 jsonb_build_object('consideration_cents',consideration_cents::text,'accrual_elapsed',accrual_elapsed::text,'accrual_period',accrual_period::text,'clean_price',clean_price,'par_amount',par_amount::text,'settlement_date',settlement_date::text)
 FROM cash WHERE consideration_cents IS DISTINCT FROM expected_cents OR accrual_elapsed IS DISTINCT FROM elapsed OR accrual_period IS DISTINCT FROM period
 UNION ALL
 SELECT 'REFERENCE','EXECUTION_CONTRACT','EXECUTION',e.id::text,c.related||jsonb_build_object('execution_id',e.id::text,'command_id',e.command_id::text),
 jsonb_build_object('clean_price',c.contract->>'clean_price','revision',c.revision,'side',c.contract->>'side','settlement',c.settlement::text),
 jsonb_build_object('clean_price',e.clean_price,'revision',e.instrument_revision,'side',e.side,'settlement',e.settlement_date::text)
 FROM fi.executions e JOIN contracts c ON(c.sandbox_id,c.id)=(e.sandbox_id,e.order_id) WHERE e.sandbox_id=$1
 AND (e.clean_price IS DISTINCT FROM c.contract->>'clean_price' OR e.instrument_revision IS DISTINCT FROM c.revision OR e.side IS DISTINCT FROM c.contract->>'side' OR e.settlement_date IS DISTINCT FROM c.settlement)
 UNION ALL
 SELECT 'REFERENCE','FILL_SEQUENCE','EXECUTION',e.id::text,jsonb_build_object('order_id',e.order_id::text,'execution_id',e.id::text,'source_event_id',e.source_event_id::text),
 jsonb_build_object('sequence',(SELECT count(*) FROM fi.executions x WHERE x.sandbox_id=$1 AND x.order_id=e.order_id AND x.fill_sequence<=e.fill_sequence)::text),jsonb_build_object('sequence',e.fill_sequence::text)
 FROM fi.executions e WHERE e.sandbox_id=$1 AND e.fill_sequence<>(SELECT count(*) FROM fi.executions x WHERE x.sandbox_id=$1 AND x.order_id=e.order_id AND x.fill_sequence<=e.fill_sequence)
 UNION ALL
 SELECT 'POSITION',CASE WHEN p.sandbox_id IS NULL THEN 'POSITION_MISSING' ELSE 'POSITION_TOTALS' END,'POSITION',COALESCE(t.instrument_revision,p.instrument_revision),
 COALESCE((SELECT c.related||jsonb_build_object('execution_id',e.id::text,'command_id',e.command_id::text,'command_seq',e.command_seq::text) FROM fi.executions e JOIN contracts c ON c.id=e.order_id WHERE e.sandbox_id=$1 AND e.instrument_revision=COALESCE(t.instrument_revision,p.instrument_revision) ORDER BY e.command_seq,e.fill_sequence LIMIT 1),jsonb_build_object('instrument_revision',p.instrument_revision)),
 jsonb_build_object('signed_par',to_char(t.par,'FM999999999990.00'),'signed_cash_cents',t.cents::text,'execution_count',t.n::text,'last_command_seq',t.seq::text),
 jsonb_build_object('signed_par',p.signed_par::text,'signed_cash_cents',p.signed_cash_cents::text,'execution_count',p.execution_count::text,'last_command_seq',p.last_command_seq::text)
 FROM position_totals t FULL JOIN owned_positions p USING(instrument_revision)
 WHERE p.sandbox_id IS NULL OR t.n IS NULL OR p.signed_par IS DISTINCT FROM t.par OR p.signed_cash_cents IS DISTINCT FROM t.cents OR p.execution_count IS DISTINCT FROM t.n OR p.last_command_seq IS DISTINCT FROM t.seq
 UNION ALL
 SELECT 'AUDIT_HISTORY','COMMAND_AUDIT','COMMAND',c.id::text,jsonb_build_object('command_id',c.id::text,'command_seq',c.command_seq::text),
 jsonb_build_object('event_count',CASE WHEN c.operation='EXECUTE_ORDER' AND c.http_status=201 THEN '3' WHEN c.operation='ACCEPT_QUOTE' AND c.result_kind='APPLIED' THEN '3' ELSE '1..3' END,'first_index','0','last_index',(c.n-1)::text,'wrong_sequence','0'),
 jsonb_build_object('event_count',c.n::text,'first_index',c.first_index::text,'last_index',c.last_index::text,'wrong_sequence',c.wrong_seq::text,'event_types',c.event_types)
 FROM command_events c WHERE c.n NOT BETWEEN 1 AND 3 OR c.first_index IS DISTINCT FROM 0 OR c.last_index IS DISTINCT FROM c.n-1 OR c.wrong_seq<>0 OR (c.operation IN ('EXECUTE_ORDER','ACCEPT_QUOTE') AND c.http_status=201 AND c.n<>3)
 UNION ALL
 SELECT 'AUDIT_HISTORY','EXECUTION_AUDIT','EXECUTION',e.id::text,c.related||jsonb_build_object('execution_id',e.id::text,'command_id',e.command_id::text,'command_seq',e.command_seq::text),
 jsonb_build_object('command_id',e.command_id::text,'type','EXECUTION_RECORDED','execution_id',e.id::text,'order_id',e.order_id::text),
 jsonb_build_object('command_id',a.command_id::text,'type',a.event_type,'execution_id',a.payload->>'execution_id','order_id',a.payload->>'order_id')
 FROM fi.executions e JOIN contracts c ON c.id=e.order_id LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(e.sandbox_id,e.command_seq,e.event_index)
 WHERE e.sandbox_id=$1 AND (a.command_id IS DISTINCT FROM e.command_id OR a.event_type IS DISTINCT FROM 'EXECUTION_RECORDED' OR a.payload->>'execution_id' IS DISTINCT FROM e.id::text OR a.payload->>'order_id' IS DISTINCT FROM e.order_id::text OR a.decided_at IS DISTINCT FROM e.decided_at)
 UNION ALL
 SELECT 'AUDIT_HISTORY','EXECUTION_RECEIPT','EXECUTION',e.id::text,c.related||jsonb_build_object('execution_id',e.id::text,'command_id',e.command_id::text),
 jsonb_build_object('execution_id',e.id::text,'source_event_id',e.source_event_id::text,'par_amount',e.par_amount::text,'consideration_cents',e.consideration_cents::text,'operation','EXECUTE_ORDER','status','201'),
 jsonb_build_object('execution_id',r.response_body->'execution'->>'id','source_event_id',r.response_body->'execution'->>'source_event_id','par_amount',r.response_body->'execution'->>'par_amount','consideration_cents',r.response_body->'execution'->>'consideration_cents','operation',r.operation,'status',r.http_status::text)
 FROM fi.executions e JOIN contracts c ON c.id=e.order_id LEFT JOIN fi.commands r ON(r.sandbox_id,r.id,r.command_seq)=(e.sandbox_id,e.command_id,e.command_seq)
 WHERE e.sandbox_id=$1 AND (r.operation IS DISTINCT FROM 'EXECUTE_ORDER' OR r.http_status IS DISTINCT FROM 201 OR r.response_body->'execution'->>'id' IS DISTINCT FROM e.id::text OR r.response_body->'execution'->>'source_event_id' IS DISTINCT FROM e.source_event_id::text OR r.response_body->'execution'->>'par_amount' IS DISTINCT FROM e.par_amount::text OR r.response_body->'execution'->>'consideration_cents' IS DISTINCT FROM e.consideration_cents::text)
 UNION ALL
 SELECT 'AUDIT_HISTORY','ORDER_HISTORY','ORDER',c.id::text,c.related,
 jsonb_build_object('version',l.version::text,'count',l.version::text,'status',l.status,'filled_par',l.filled_par::text,'remaining_par',l.remaining_par::text,'executed_cents',l.executed_cents::text),
 jsonb_build_object('version',h.version::text,'count',(SELECT count(*) FROM history WHERE order_id=c.id)::text,'status',h.state->>'status','filled_par',h.state->>'filled_par','remaining_par',h.state->>'remaining_par','executed_cents',h.state->>'executed_cents')
 FROM contracts c JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(c.sandbox_id,c.id) LEFT JOIN history h ON(h.order_id,h.version)=(c.id,l.version)
 WHERE h.version IS NULL OR (SELECT count(*) FROM history WHERE order_id=c.id)<>l.version OR h.state->>'status' IS DISTINCT FROM l.status OR h.state->>'filled_par' IS DISTINCT FROM l.filled_par::text OR h.state->>'remaining_par' IS DISTINCT FROM l.remaining_par::text OR h.state->>'executed_cents' IS DISTINCT FROM l.executed_cents::text
 UNION ALL
 SELECT 'AUDIT_HISTORY','HISTORICAL_EXECUTION_TOTALS','ORDER',h.order_id::text,c.related||jsonb_build_object('command_id',h.command_id::text,'command_seq',h.command_seq::text),
 jsonb_build_object('filled_par',to_char(t.par,'FM999999999990.00'),'remaining_par',to_char(CASE WHEN h.state->>'status' IN ('CANCELED','REJECTED') THEN 0 ELSE c.original_par-t.par END,'FM999999999990.00'),'executed_cents',t.cents::text,'execution_count',t.n::text),
 jsonb_build_object('filled_par',h.state->>'filled_par','remaining_par',h.state->>'remaining_par','executed_cents',h.state->>'executed_cents','execution_count',h.state->>'execution_count')
 FROM history h JOIN contracts c ON c.id=h.order_id
 CROSS JOIN LATERAL(SELECT COALESCE(sum(par_amount),0) par,COALESCE(sum(consideration_cents),0) cents,count(*) n FROM fi.executions WHERE sandbox_id=$1 AND order_id=h.order_id AND command_seq<=h.command_seq) t
 WHERE h.version>1 AND (h.state->>'filled_par' IS DISTINCT FROM to_char(t.par,'FM999999999990.00') OR h.state->>'remaining_par' IS DISTINCT FROM to_char(CASE WHEN h.state->>'status' IN ('CANCELED','REJECTED') THEN 0 ELSE c.original_par-t.par END,'FM999999999990.00') OR h.state->>'executed_cents' IS DISTINCT FROM t.cents::text OR h.state->>'execution_count' IS DISTINCT FROM t.n::text)
 UNION ALL
 SELECT 'AUDIT_HISTORY','HISTORY_COMMAND_REFERENCE','ORDER',h.order_id::text,c.related||jsonb_build_object('command_id',h.command_id::text,'command_seq',h.command_seq::text),
 jsonb_build_object('operation',h.operation,'version',h.version::text),jsonb_build_object('operation',r.operation,'version',r.response_body->'lifecycle'->>'version')
 FROM history h JOIN contracts c ON c.id=h.order_id LEFT JOIN fi.commands r ON(r.sandbox_id,r.id,r.command_seq)=(h.sandbox_id,h.command_id,h.command_seq)
 WHERE h.version>1 AND (r.operation IS DISTINCT FROM h.operation OR r.response_body->'lifecycle' IS DISTINCT FROM h.state OR h.previous_version IS DISTINCT FROM h.version-1)
 UNION ALL
 SELECT 'CANCELLATION','CANCELLATION_STATE','CANCELLATION',r.id::text,c.related||jsonb_build_object('cancel_id',r.id::text,'command_id',r.command_id::text),
 jsonb_build_object('pending',o.cancel_id IS NULL,'terminal_order',CASE WHEN o.outcome='ACKNOWLEDGED' THEN 'CANCELED' WHEN o.reason='TOO_LATE' THEN 'FILLED' ELSE NULL END),
 jsonb_build_object('pending',l.pending_cancel_id IS NOT DISTINCT FROM r.id,'terminal_order',CASE WHEN o.outcome='ACKNOWLEDGED' OR o.reason='TOO_LATE' THEN l.status ELSE NULL END,'outcome',o.outcome,'reason',o.reason)
 FROM fi.cancellation_requests r JOIN contracts c ON c.id=r.order_id JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(r.sandbox_id,r.order_id) LEFT JOIN fi.cancellation_outcomes o ON(o.sandbox_id,o.cancel_id)=(r.sandbox_id,r.id)
 WHERE r.sandbox_id=$1 AND ((o.cancel_id IS NULL) IS DISTINCT FROM (l.pending_cancel_id IS NOT DISTINCT FROM r.id) OR (o.outcome='ACKNOWLEDGED' AND l.status<>'CANCELED') OR (o.reason='TOO_LATE' AND l.status<>'FILLED'))
 UNION ALL
 SELECT 'RFQ_CONTRACT','RFQ_ORDER_CARDINALITY','RFQ',r.id::text,jsonb_build_object('rfq_id',r.id::text),jsonb_build_object('orders',CASE WHEN r.state='ACCEPTED' THEN '1' ELSE '0' END),jsonb_build_object('orders',count(o.id)::text)
 FROM fi.rfqs r LEFT JOIN contracts o ON o.rfq_id=r.id WHERE r.sandbox_id=$1 GROUP BY r.sandbox_id,r.id HAVING count(o.id)<>CASE WHEN r.state='ACCEPTED' THEN 1 ELSE 0 END
 UNION ALL
 SELECT 'RFQ_CONTRACT','ORDER_CONTRACT','ORDER',c.id::text,c.related,jsonb_build_object('contract',(q.snapshot||jsonb_build_object('clean_price',CASE r.side WHEN 'BUY' THEN q.ask_clean_price ELSE q.bid_clean_price END))::text,'quote_id',r.accepted_quote_id::text),jsonb_build_object('contract',c.contract::text,'quote_id',c.quote_id::text)
 FROM contracts c JOIN fi.rfqs r ON(r.sandbox_id,r.id)=(c.sandbox_id,c.rfq_id) LEFT JOIN fi.quotes q ON(q.sandbox_id,q.id)=(c.sandbox_id,c.quote_id)
 WHERE r.accepted_quote_id IS DISTINCT FROM c.quote_id OR c.contract IS DISTINCT FROM q.snapshot||jsonb_build_object('clean_price',CASE r.side WHEN 'BUY' THEN q.ask_clean_price ELSE q.bid_clean_price END)
 UNION ALL
 SELECT 'INSTRUMENT_SOURCE','INSTRUMENT_SOURCE_VERSION','INSTRUMENT',iv.id,jsonb_build_object('instrument_revision',iv.id),
 jsonb_build_object('instrument_id',d.instrument,'revision','1','financial_source','6016fb700840d081fe1fba651c918f0a7e709383','terms',jsonb_build_object('currency','USD','dated_date','2025-01-15','first_coupon_date','2025-07-15','maturity_date','2031-01-15','coupon_rate','0.04','frequency',2,'day_count',d.day_count)::text),
 jsonb_build_object('instrument_id',iv.instrument_id,'revision',iv.revision::text,'financial_source',iv.financial_source,'terms',iv.terms::text)
 FROM fi.instrument_versions iv LEFT JOIN definitions d ON d.revision=iv.id
 WHERE EXISTS(SELECT 1 FROM fi.rfqs r WHERE r.sandbox_id=$1 AND r.instrument_revision=iv.id)
 AND (iv.instrument_id IS DISTINCT FROM d.instrument OR iv.revision<>1 OR iv.financial_source IS DISTINCT FROM '6016fb700840d081fe1fba651c918f0a7e709383' OR iv.terms IS DISTINCT FROM jsonb_build_object('currency','USD','dated_date','2025-01-15','first_coupon_date','2025-07-15','maturity_date','2031-01-15','coupon_rate','0.04','frequency',2,'day_count',d.day_count))
 UNION ALL
 SELECT 'RFQ_CONTRACT','QUOTE_GRID','QUOTE',q.id::text,jsonb_build_object('rfq_id',q.rfq_id::text,'quote_id',q.id::text,'instrument_revision',r.instrument_revision),
 jsonb_build_object('bid',g.bid,'ask',g.ask,'snapshot_bid',g.bid,'snapshot_ask',g.ask,'model_version','synthetic-dealer-grid-v1','valuation_model_version','phase1-regular-coupon-v1','financial_source','6016fb700840d081fe1fba651c918f0a7e709383'),
 jsonb_build_object('bid',q.bid_clean_price,'ask',q.ask_clean_price,'snapshot_bid',q.snapshot->>'bid_clean_price','snapshot_ask',q.snapshot->>'ask_clean_price','model_version',q.snapshot->>'model_version','valuation_model_version',q.snapshot->>'valuation_model_version','financial_source',q.snapshot->>'financial_source')
 FROM fi.quotes q JOIN fi.rfqs r ON(r.sandbox_id,r.id)=(q.sandbox_id,q.rfq_id)
 JOIN(VALUES('phase1-ust-1','ATLAS','99.950000000123','100.050000000123'),('phase1-ust-1','BIRCH','99.940000000123','100.060000000123'),('phase1-ust-1','CEDAR','99.930000000123','100.070000000123'),('phase1-corp-1','ATLAS','98.950000000123','99.050000000123'),('phase1-corp-1','BIRCH','98.940000000123','99.060000000123'),('phase1-corp-1','CEDAR','98.930000000123','99.070000000123')) g(revision,dealer,bid,ask) ON(g.revision,g.dealer)=(r.instrument_revision,q.dealer_id)
 WHERE q.sandbox_id=$1 AND (q.bid_clean_price IS DISTINCT FROM g.bid OR q.ask_clean_price IS DISTINCT FROM g.ask OR q.snapshot->>'bid_clean_price' IS DISTINCT FROM g.bid OR q.snapshot->>'ask_clean_price' IS DISTINCT FROM g.ask OR q.snapshot->>'model_version' IS DISTINCT FROM 'synthetic-dealer-grid-v1' OR q.snapshot->>'valuation_model_version' IS DISTINCT FROM 'phase1-regular-coupon-v1' OR q.snapshot->>'financial_source' IS DISTINCT FROM '6016fb700840d081fe1fba651c918f0a7e709383')
 UNION ALL
 SELECT 'REFERENCE','ORDER_PARENT','ORDER',c.id::text,c.related,jsonb_build_object('owned_rfq',true,'owned_quote',true),jsonb_build_object('owned_rfq',r.id IS NOT NULL,'owned_quote',q.id IS NOT NULL)
 FROM contracts c LEFT JOIN fi.rfqs r ON(r.sandbox_id,r.id)=(c.sandbox_id,c.rfq_id) LEFT JOIN fi.quotes q ON(q.sandbox_id,q.rfq_id,q.id)=(c.sandbox_id,c.rfq_id,c.quote_id) WHERE r.id IS NULL OR q.id IS NULL
 UNION ALL
 SELECT 'REFERENCE','EXECUTION_PARENT','EXECUTION',e.id::text,jsonb_build_object('order_id',e.order_id::text,'execution_id',e.id::text),jsonb_build_object('owned_order',true),jsonb_build_object('owned_order',false)
 FROM fi.executions e LEFT JOIN contracts c ON(c.sandbox_id,c.id)=(e.sandbox_id,e.order_id) WHERE e.sandbox_id=$1 AND c.id IS NULL UNION ALL
 SELECT 'AUDIT_HISTORY','INITIAL_ORDER_HISTORY','ORDER',c.id::text,c.related,
 jsonb_build_object('operation','CONTRACT_CREATED','status','PENDING_ACK','version','1','filled_par','0.00','remaining_par',c.contract->>'par_amount','executed_cents','0','execution_count',0,'pending_cancel_id',NULL),
 jsonb_build_object('operation',h.operation,'status',h.state->>'status','version',h.state->>'version','filled_par',h.state->>'filled_par','remaining_par',h.state->>'remaining_par','executed_cents',h.state->>'executed_cents','execution_count',h.state->'execution_count','pending_cancel_id',h.state->>'pending_cancel_id')
 FROM contracts c LEFT JOIN history h ON h.order_id=c.id AND h.version=1
 WHERE h.operation IS DISTINCT FROM 'CONTRACT_CREATED' OR h.command_id IS NOT NULL OR h.command_seq IS NOT NULL OR h.state->>'status' IS DISTINCT FROM 'PENDING_ACK' OR h.state->>'version' IS DISTINCT FROM '1' OR h.state->>'filled_par' IS DISTINCT FROM '0.00' OR h.state->>'remaining_par' IS DISTINCT FROM c.contract->>'par_amount' OR h.state->>'executed_cents' IS DISTINCT FROM '0' OR h.state->'execution_count' IS DISTINCT FROM '0'::jsonb OR h.state->>'pending_cancel_id' IS NOT NULL
 UNION ALL
 SELECT 'AUDIT_HISTORY','LIFECYCLE_TRANSITION','ORDER',h.order_id::text,c.related||jsonb_build_object('command_id',h.command_id::text,'command_seq',h.command_seq::text),
 jsonb_build_object('operation',h.operation,'expected_status',x.status,'previous_version',(h.version-1)::text,'previous_status',p.state->>'status'),
 jsonb_build_object('status',h.state->>'status','previous_version',p.version::text,'pending_cancel_id',h.state->>'pending_cancel_id')
 FROM history h JOIN contracts c ON c.id=h.order_id LEFT JOIN history p ON(p.order_id,p.version)=(h.order_id,h.version-1)
 CROSS JOIN LATERAL(SELECT CASE h.operation WHEN 'ACK_ORDER' THEN 'NEW' WHEN 'REJECT_ORDER' THEN 'REJECTED' WHEN 'EXECUTE_ORDER' THEN CASE WHEN (SELECT COALESCE(sum(e.par_amount),0) FROM fi.executions e WHERE e.sandbox_id=$1 AND e.order_id=h.order_id AND e.command_seq<=h.command_seq)=c.original_par THEN 'FILLED' ELSE 'PARTIALLY_FILLED' END WHEN 'REQUEST_CANCEL' THEN p.state->>'status' WHEN 'ACK_CANCEL' THEN CASE WHEN p.state->>'status'='FILLED' THEN 'FILLED' ELSE 'CANCELED' END WHEN 'REJECT_CANCEL' THEN p.state->>'status' END status) x
 WHERE h.version>1 AND (p.version IS NULL OR h.command_seq<=COALESCE(p.command_seq,0) OR h.state->>'status' IS DISTINCT FROM x.status
 OR (h.operation IN ('ACK_ORDER','REJECT_ORDER') AND p.state->>'status' IS DISTINCT FROM 'PENDING_ACK')
 OR (h.operation IN ('EXECUTE_ORDER','REQUEST_CANCEL') AND COALESCE(p.state->>'status','') NOT IN ('NEW','PARTIALLY_FILLED'))
 OR (h.operation IN ('ACK_CANCEL','REJECT_CANCEL') AND COALESCE(p.state->>'status','') NOT IN ('NEW','PARTIALLY_FILLED','FILLED'))
 OR h.decided_at<p.decided_at OR h.recorded_at<h.decided_at OR h.state->>'version' IS DISTINCT FROM h.version::text
 OR (h.operation='REQUEST_CANCEL' AND (p.state->>'pending_cancel_id' IS NOT NULL OR h.state->>'pending_cancel_id' IS NULL))
 OR (h.operation IN ('ACK_CANCEL','REJECT_CANCEL') AND (p.state->>'pending_cancel_id' IS NULL OR h.state->>'pending_cancel_id' IS NOT NULL))
 OR (h.operation='EXECUTE_ORDER' AND NOT EXISTS(SELECT 1 FROM fi.executions e WHERE (e.sandbox_id,e.order_id,e.command_id,e.command_seq)=(h.sandbox_id,h.order_id,h.command_id,h.command_seq)))
 OR (h.operation='EXECUTE_ORDER' AND h.state->>'pending_cancel_id' IS DISTINCT FROM p.state->>'pending_cancel_id'))
 UNION ALL
 SELECT 'AUDIT_HISTORY','LIFECYCLE_AUDIT','ORDER',h.order_id::text,c.related||jsonb_build_object('command_id',h.command_id::text,'command_seq',h.command_seq::text),
 jsonb_build_object('event_type',x.kind,'order_id',h.order_id::text,'aggregate_version',h.version::text,'command_id',h.command_id::text,'decision_time',h.decided_at::text,'event_index',x.event_index::text,'instrument_revision',CASE WHEN x.event_index=2 THEN c.revision END),
 jsonb_build_object('event_type',a.event_type,'order_id',a.payload->>'order_id','aggregate_version',a.aggregate_version::text,'command_id',a.command_id::text,'decision_time',a.decided_at::text,'instrument_revision',CASE WHEN x.event_index=2 THEN a.payload->>'instrument_revision' END)
 FROM history h JOIN contracts c ON c.id=h.order_id
 CROSS JOIN LATERAL(VALUES(0,CASE h.operation WHEN 'ACK_ORDER' THEN 'ORDER_ACKNOWLEDGED' WHEN 'REJECT_ORDER' THEN 'ORDER_REJECTED' WHEN 'EXECUTE_ORDER' THEN 'EXECUTION_RECORDED' WHEN 'REQUEST_CANCEL' THEN 'CANCEL_REQUESTED' WHEN 'ACK_CANCEL' THEN CASE WHEN h.state->>'status'='CANCELED' THEN 'CANCEL_ACKNOWLEDGED' ELSE 'CANCEL_REJECTED' END WHEN 'REJECT_CANCEL' THEN 'CANCEL_REJECTED' END),(1,CASE WHEN h.operation='EXECUTE_ORDER' THEN 'ORDER_STATE_CHANGED' END),(2,CASE WHEN h.operation='EXECUTE_ORDER' THEN 'POSITION_UPDATED' END)) x(event_index,kind)
 LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(h.sandbox_id,h.command_seq,x.event_index)
 WHERE h.version>1 AND x.kind IS NOT NULL AND (a.command_id IS DISTINCT FROM h.command_id OR a.event_type IS DISTINCT FROM x.kind OR a.payload->>'order_id' IS DISTINCT FROM h.order_id::text OR a.aggregate_version IS DISTINCT FROM h.version OR a.decided_at IS DISTINCT FROM h.decided_at OR a.recorded_at<a.decided_at OR (x.event_index=2 AND a.payload->>'instrument_revision' IS DISTINCT FROM c.revision))
 UNION ALL
 SELECT 'CANCELLATION','CANCELLATION_REQUEST_REFERENCE','CANCELLATION',r.id::text,c.related||jsonb_build_object('cancel_id',r.id::text,'command_id',r.command_id::text,'command_seq',r.command_seq::text),
 jsonb_build_object('operation','REQUEST_CANCEL','status','201','cancel_id',r.id::text,'order_id',r.order_id::text,'request_sequence',x.n::text,'audit_type','CANCEL_REQUESTED'),
 jsonb_build_object('operation',cmd.operation,'status',cmd.http_status::text,'cancel_id',cmd.response_body->'cancellation'->>'id','order_id',cmd.response_body->'cancellation'->>'order_id','request_sequence',r.request_sequence::text,'audit_type',a.event_type,'audit_cancel_id',a.payload->>'cancel_id','history_pending',h.state->>'pending_cancel_id')
 FROM fi.cancellation_requests r JOIN contracts c ON c.id=r.order_id
 LEFT JOIN fi.commands cmd ON(cmd.sandbox_id,cmd.id,cmd.command_seq)=(r.sandbox_id,r.command_id,r.command_seq)
 LEFT JOIN history h ON(h.order_id,h.command_id,h.command_seq)=(r.order_id,r.command_id,r.command_seq)
 LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(r.sandbox_id,r.command_seq,0)
 CROSS JOIN LATERAL(SELECT count(*) n FROM fi.cancellation_requests x WHERE x.sandbox_id=$1 AND x.order_id=r.order_id AND x.command_seq<=r.command_seq) x
 WHERE r.sandbox_id=$1 AND (r.request_sequence<>x.n OR cmd.operation IS DISTINCT FROM 'REQUEST_CANCEL' OR cmd.http_status IS DISTINCT FROM 201 OR cmd.response_body->'cancellation'->>'id' IS DISTINCT FROM r.id::text OR cmd.response_body->'cancellation'->>'state' IS DISTINCT FROM 'PENDING' OR cmd.response_body->'cancellation'->>'order_id' IS DISTINCT FROM r.order_id::text OR h.operation IS DISTINCT FROM 'REQUEST_CANCEL' OR h.state->>'pending_cancel_id' IS DISTINCT FROM r.id::text OR a.command_id IS DISTINCT FROM r.command_id OR a.event_type IS DISTINCT FROM 'CANCEL_REQUESTED' OR a.payload->>'cancel_id' IS DISTINCT FROM r.id::text OR a.payload->>'order_id' IS DISTINCT FROM r.order_id::text OR a.decided_at IS DISTINCT FROM r.decided_at OR h.decided_at IS DISTINCT FROM r.decided_at)
 UNION ALL
 SELECT 'CANCELLATION','CANCELLATION_TERMS','CANCELLATION',o.cancel_id::text,c.related||jsonb_build_object('cancel_id',o.cancel_id::text,'command_id',o.command_id::text,'command_seq',o.command_seq::text),
 jsonb_build_object('outcome',CASE x.reason WHEN 'CANCELED_REMAINDER' THEN 'ACKNOWLEDGED' ELSE 'REJECTED' END,'reason',x.reason),
 jsonb_build_object('outcome',o.outcome,'reason',o.reason)
 FROM fi.cancellation_outcomes o JOIN contracts c ON c.id=o.order_id
 LEFT JOIN fi.commands cmd ON(cmd.sandbox_id,cmd.id,cmd.command_seq)=(o.sandbox_id,o.command_id,o.command_seq)
 LEFT JOIN history h ON(h.order_id,h.command_id,h.command_seq)=(o.order_id,o.command_id,o.command_seq)
 LEFT JOIN history p ON(p.order_id,p.version)=(o.order_id,h.version-1)
 CROSS JOIN LATERAL(SELECT CASE WHEN p.state->>'status'='FILLED' THEN 'TOO_LATE' WHEN cmd.operation='ACK_CANCEL' THEN 'CANCELED_REMAINDER' ELSE 'SIMULATED_REJECTION' END reason) x
 WHERE o.sandbox_id=$1 AND (o.outcome IS DISTINCT FROM CASE x.reason WHEN 'CANCELED_REMAINDER' THEN 'ACKNOWLEDGED' ELSE 'REJECTED' END OR o.reason IS DISTINCT FROM x.reason)
 UNION ALL
 SELECT 'CANCELLATION','CANCELLATION_OUTCOME_REFERENCE','CANCELLATION',o.cancel_id::text,c.related||jsonb_build_object('cancel_id',o.cancel_id::text,'command_id',o.command_id::text,'command_seq',o.command_seq::text),
 jsonb_build_object('operation','ACK_CANCEL|REJECT_CANCEL','status','200','cancel_id',o.cancel_id::text,'outcome',o.outcome,'reason',o.reason,'audit_type',CASE o.outcome WHEN 'ACKNOWLEDGED' THEN 'CANCEL_ACKNOWLEDGED' ELSE 'CANCEL_REJECTED' END),
 jsonb_build_object('operation',cmd.operation,'status',cmd.http_status::text,'cancel_id',cmd.response_body->'cancellation'->>'id','outcome',cmd.response_body->'cancellation'->>'state','reason',cmd.response_body->'cancellation'->>'reason','audit_type',a.event_type,'audit_cancel_id',a.payload->>'cancel_id','history_operation',h.operation)
 FROM fi.cancellation_outcomes o JOIN contracts c ON c.id=o.order_id
 LEFT JOIN fi.cancellation_requests r ON(r.sandbox_id,r.id,r.order_id)=(o.sandbox_id,o.cancel_id,o.order_id)
 LEFT JOIN fi.commands cmd ON(cmd.sandbox_id,cmd.id,cmd.command_seq)=(o.sandbox_id,o.command_id,o.command_seq)
 LEFT JOIN history h ON(h.order_id,h.command_id,h.command_seq)=(o.order_id,o.command_id,o.command_seq)
 LEFT JOIN history p ON(p.order_id,p.version)=(o.order_id,h.version-1)
 LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(o.sandbox_id,o.command_seq,0)
 WHERE o.sandbox_id=$1 AND (COALESCE(cmd.operation,'') NOT IN ('ACK_CANCEL','REJECT_CANCEL') OR cmd.http_status IS DISTINCT FROM 200 OR cmd.response_body->'cancellation'->>'id' IS DISTINCT FROM o.cancel_id::text OR cmd.response_body->'cancellation'->>'order_id' IS DISTINCT FROM o.order_id::text OR cmd.response_body->'cancellation'->>'state' IS DISTINCT FROM o.outcome OR cmd.response_body->'cancellation'->>'reason' IS DISTINCT FROM o.reason OR h.operation IS DISTINCT FROM cmd.operation OR p.state->>'pending_cancel_id' IS DISTINCT FROM o.cancel_id::text OR o.command_seq<=r.command_seq OR a.command_id IS DISTINCT FROM o.command_id OR a.event_type IS DISTINCT FROM CASE o.outcome WHEN 'ACKNOWLEDGED' THEN 'CANCEL_ACKNOWLEDGED' ELSE 'CANCEL_REJECTED' END OR a.payload->>'cancel_id' IS DISTINCT FROM o.cancel_id::text OR a.payload->>'order_id' IS DISTINCT FROM o.order_id::text OR a.decided_at IS DISTINCT FROM o.decided_at OR h.decided_at IS DISTINCT FROM o.decided_at)

)
SELECT category,code,record_kind,record_id,jsonb_strip_nulls(related) related,expected,observed
FROM findings ORDER BY category,code,record_kind,record_id,expected::text,observed::text;
