-- Independent read-only metadata reconstruction. No financial helper/projection expected totals.
WITH bindings AS (SELECT b.*,o.contract,l.status,l.version FROM fi.fix_bindings b JOIN fi.orders o ON(o.sandbox_id,o.id)=(b.sandbox_id,b.order_id) JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(b.sandbox_id,b.order_id) WHERE b.sandbox_id=$1),
wire_evidence AS (SELECT a.*,m.semantic_hash,(SELECT jsonb_object_agg(split_part(part,'=',1),substring(part,length(split_part(part,'=',1))+2)) FROM unnest(string_to_array(convert_from(a.raw_bytes,'SQL_ASCII'),chr(1))) part WHERE part<>'') decoded FROM fi.fix_attempts a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) WHERE a.sandbox_id=$1),
-- Inspect stored terms and each physical observation independently; agreement alone is insufficient.
message_evidence AS (
 SELECT m.sandbox_id,m.id AS message_id,m.order_id,m.dealer_id,m.message_type,m.direction,m.fields AS evidence
 FROM fi.fix_messages m WHERE m.sandbox_id=$1
 UNION ALL
 SELECT m.sandbox_id,m.id,m.order_id,m.dealer_id,m.message_type,m.direction,a.decoded
 FROM wire_evidence a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 WHERE m.sandbox_id=$1
),
contract_evidence AS (
 SELECT e.*,o.id AS contract_order_id,o.contract,
 CASE WHEN jsonb_typeof(e.evidence)='object' THEN e.evidence ELSE '{}'::jsonb END AS f,
 CASE WHEN jsonb_typeof(e.evidence->'38')='string' AND e.evidence->>'38' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'38')::numeric END AS total_par,
 CASE WHEN jsonb_typeof(e.evidence->'14')='string' AND e.evidence->>'14' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'14')::numeric END AS cumulative_par,
 CASE WHEN jsonb_typeof(e.evidence->'151')='string' AND e.evidence->>'151' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'151')::numeric END AS leaves_par,
 CASE WHEN jsonb_typeof(e.evidence->'32')='string' AND e.evidence->>'32' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'32')::numeric END AS last_par
 FROM message_evidence e LEFT JOIN fi.orders o ON(o.sandbox_id,o.id)=(e.sandbox_id,e.order_id)
),
issues AS (
 SELECT 'WIRE_FRAMING' code,a.id::text record_id FROM wire_evidence a WHERE
 split_part(convert_from(a.raw_bytes,'SQL_ASCII'),chr(1),1)<>'8=FIX.4.4'
 OR split_part(convert_from(a.raw_bytes,'SQL_ASCII'),chr(1),2) !~ '^9=[1-9][0-9]{0,4}$'
 OR right(convert_from(a.raw_bytes,'SQL_ASCII'),7) !~ ('^10=[0-9]{3}'||chr(1)||'$')
 OR (CASE WHEN a.decoded->>'9' ~ '^[1-9][0-9]{0,4}$' THEN (a.decoded->>'9')::integer ELSE -1 END)<>octet_length(a.raw_bytes)-7-length(split_part(convert_from(a.raw_bytes,'SQL_ASCII'),chr(1),1))-length(split_part(convert_from(a.raw_bytes,'SQL_ASCII'),chr(1),2))-2
 OR (CASE WHEN a.decoded->>'10' ~ '^[0-9]{3}$' THEN (a.decoded->>'10')::integer ELSE -1 END)<>(SELECT sum(get_byte(a.raw_bytes,g.i))%256 FROM generate_series(0,octet_length(a.raw_bytes)-8) g(i))
 UNION ALL SELECT 'WIRE_SEMANTICS' code,a.id::text record_id FROM wire_evidence a WHERE a.semantic_hash<>encode(sha256(convert_to((a.decoded-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex')
 UNION ALL
 SELECT 'BINDING_CONTRACT' code,b.order_id::text record_id FROM bindings b WHERE b.cl_ord_id<>b.order_id OR b.dealer_id<>b.contract->>'dealer_id' OR b.contract_hash<>encode(sha256(convert_to(b.contract::text,'UTF8')),'hex')
 UNION ALL SELECT DISTINCT 'MESSAGE_CONTRACT',v.message_id::text FROM contract_evidence v WHERE NOT COALESCE(
 v.contract_order_id IS NOT NULL AND jsonb_typeof(v.evidence)='object'
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(v.f) p WHERE jsonb_typeof(p.value) IS DISTINCT FROM 'string')
 AND v.message_type IN ('D','8','F','9') AND v.f->>'35'=v.message_type
 AND v.direction=CASE WHEN v.message_type IN ('D','F') THEN 'OUT' ELSE 'IN' END
 AND v.dealer_id=v.contract->>'dealer_id'
 AND v.f->>'49'=CASE WHEN v.message_type IN ('D','F') THEN 'TRADEFLOW' ELSE v.contract->>'dealer_id' END
 AND v.f->>'56'=CASE WHEN v.message_type IN ('D','F') THEN v.contract->>'dealer_id' ELSE 'TRADEFLOW' END
 AND CASE WHEN v.message_type IN ('F','9') OR (v.message_type='8' AND v.f->>'150' IN ('6','4')) THEN
   v.f->>'11' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND v.f->>'11'<>v.order_id::text AND v.f->>'41'=v.order_id::text
 ELSE v.f->>'11'=v.order_id::text AND NOT(v.f ? '41') END
 AND (v.message_type='D' OR (
   v.f->>'37' ~ '^(ATLAS|BIRCH|CEDAR)-[A-Z0-9-]{1,48}$'
   AND split_part(v.f->>'37','-',1)=v.contract->>'dealer_id'))
 AND CASE WHEN v.message_type='9' THEN
   NOT(v.f ?| ARRAY['55','167','54','38','854','40','59','423','44','15','64','17','150','14','151','6','31','32','103'])
   AND v.f->>'434'='1'
   AND ((v.f->>'102'='0' AND v.f->>'39'='2') OR (v.f->>'102'='99' AND v.f->>'39' IN ('0','1')))
 ELSE
   v.f->'55'=to_jsonb(v.contract->>'instrument_id')
   AND v.f->'167'=to_jsonb(CASE v.contract->>'instrument_id' WHEN 'SYN-UST-2031' THEN 'TNOTE' WHEN 'SYN-CORP-2031' THEN 'CORP' END)
   AND v.f->'54'=to_jsonb(CASE v.contract->>'side' WHEN 'BUY' THEN '1' WHEN 'SELL' THEN '2' END)
   AND v.f->'38'=to_jsonb(v.contract->>'par_amount') AND v.total_par BETWEEN 1 AND 1000000000
 END
 AND CASE WHEN v.message_type IN ('D','8') THEN
   v.f->'854'='"0"'::jsonb AND v.f->'40'='"2"'::jsonb AND v.f->'59'='"1"'::jsonb
   AND v.f->'423'='"1"'::jsonb AND v.f->'15'='"USD"'::jsonb
   AND v.f->'44'=to_jsonb(v.contract->>'clean_price')
   AND v.f->'64'=to_jsonb(replace(v.contract->>'settlement_date','-',''))
 ELSE NOT(v.f ?| ARRAY['854','40','59','423','44','15','64']) END
 AND CASE WHEN v.message_type='D' THEN NOT(v.f ?| ARRAY['37','17','150','39','14','151','6','31','32','103','434','102'])
 WHEN v.message_type='F' THEN NOT(v.f ?| ARRAY['17','150','39','14','151','6','31','32','103','434','102'])
 WHEN v.message_type='8' THEN
   v.f->>'17' ~ '^(ATLAS|BIRCH|CEDAR)-[A-Z0-9-]{1,48}$'
   AND split_part(v.f->>'17','-',1)=v.contract->>'dealer_id'
   AND NOT(v.f ?| ARRAY['434','102'])
   AND v.cumulative_par BETWEEN 0 AND v.total_par AND v.leaves_par BETWEEN 0 AND v.total_par
   AND v.f->'6'=to_jsonb(CASE WHEN v.cumulative_par=0 THEN '0.000000000000' ELSE v.contract->>'clean_price' END)
   AND (v.f->>'150'='F' OR NOT(v.f ?| ARRAY['31','32']))
   AND (CASE WHEN v.f->>'150'='8' THEN v.f->>'103' IN ('6','99') ELSE NOT(v.f ? '103') END)
   AND CASE v.f->>'150'
     WHEN '0' THEN v.f->>'39'='0' AND v.cumulative_par=0 AND v.leaves_par=v.total_par
     WHEN '8' THEN v.f->>'39'='8' AND v.cumulative_par=0 AND v.leaves_par=0
     WHEN '6' THEN v.f->>'39'='6' AND v.cumulative_par+v.leaves_par=v.total_par
     WHEN '4' THEN v.f->>'39'='4' AND v.cumulative_par<v.total_par AND v.leaves_par=0
     WHEN 'F' THEN v.f->>'39' IN ('1','2','6') AND v.cumulative_par>0
       AND v.cumulative_par+v.leaves_par=v.total_par AND v.last_par BETWEEN 0.01 AND v.cumulative_par
       AND v.f->'31'=to_jsonb(v.contract->>'clean_price')
       AND (v.f->>'39'<>'1' OR v.cumulative_par<v.total_par)
       AND (v.f->>'39'<>'2' OR v.cumulative_par=v.total_par)
     ELSE false END
 ELSE true END,false)
 UNION ALL SELECT 'RAW_BYTES',a.id::text FROM fi.fix_attempts a WHERE a.sandbox_id=$1 AND (a.raw_hash<>encode(sha256(a.raw_bytes),'hex') OR NOT EXISTS(SELECT 1 FROM fi.fix_messages m WHERE m.sandbox_id=a.sandbox_id AND m.id=a.message_id))
 UNION ALL SELECT 'SEMANTIC_HASH',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.semantic_hash<>encode(sha256(convert_to((m.fields-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex')
 UNION ALL SELECT 'MISSING_OUTBOX',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.direction='OUT' AND NOT EXISTS(SELECT 1 FROM fi.fix_outbox o WHERE o.sandbox_id=m.sandbox_id AND o.message_id=m.id AND o.order_id=m.order_id)
 UNION ALL SELECT 'OUTBOX_REFERENCE',o.message_id::text FROM fi.fix_outbox o WHERE o.sandbox_id=$1 AND (o.delivery_state IS DISTINCT FROM 'NOT_IMPLEMENTED' OR NOT EXISTS(SELECT 1 FROM fi.fix_messages m WHERE m.sandbox_id=o.sandbox_id AND m.id=o.message_id AND m.order_id=o.order_id AND m.direction='OUT'))
 UNION ALL SELECT 'LANE_SEQUENCE',w.id::text FROM fi.fix_work w WHERE w.sandbox_id=$1 AND w.lane_seq<>(SELECT count(*) FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<=w.lane_seq)
 UNION ALL SELECT 'PREPARED_NON_HEAD',p.work_id::text FROM fi.fix_prepared p JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id) WHERE p.sandbox_id=$1 AND EXISTS(SELECT 1 FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<w.lane_seq AND NOT EXISTS(SELECT 1 FROM fi.fix_outcomes o WHERE o.sandbox_id=x.sandbox_id AND o.work_id=x.id))
 UNION ALL SELECT 'UNAUTHORIZED_FINANCIAL_REFERENCE',o.work_id::text FROM fi.fix_outcomes o WHERE o.sandbox_id=$1 AND (o.outcome<>'METADATA_ONLY' OR o.financial_command_id IS NOT NULL OR o.financial_command_seq IS NOT NULL)
 UNION ALL SELECT 'PREPARED_FINGERPRINT',p.work_id::text FROM fi.fix_prepared p WHERE p.sandbox_id=$1 AND (p.request_hash<>encode(sha256(convert_to(p.payload::text,'UTF8')),'hex') OR p.payload->>'order_id'<>p.order_id::text OR NOT EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE k.sandbox_id=p.sandbox_id AND k.idempotency_key=p.financial_key AND k.domain='FIX_PREPARED'))
 UNION ALL SELECT 'CAPACITY_RESERVATION',b.order_id::text FROM bindings b JOIN fi.fix_lanes l USING(sandbox_id,order_id) LEFT JOIN fi_control.fix_reservations r USING(sandbox_id,order_id) WHERE r.order_id IS NULL OR r.commands<>25 OR r.events<>43 OR (r.released_at IS NOT NULL)<>(l.closed_at IS NOT NULL)
 UNION ALL SELECT 'PROTOCOL_AUDIT',c.id::text FROM fi.fix_commands c WHERE c.sandbox_id=$1 AND (c.command_seq<>(SELECT count(*) FROM fi.fix_commands x WHERE x.sandbox_id=c.sandbox_id AND x.command_seq<=c.command_seq) OR (SELECT count(*) FROM fi.fix_events e WHERE e.sandbox_id=c.sandbox_id AND e.command_seq=c.command_seq)<>1)

 UNION ALL SELECT 'DEALER_CORRELATION',d.order_id::text FROM fi.fix_dealer_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.message_type<>'8' OR m.direction<>'IN' OR m.order_id<>d.order_id OR m.dealer_id<>d.dealer_id OR m.fields->>'37' IS DISTINCT FROM d.dealer_order_id)
 UNION ALL SELECT 'DEALER_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '37' AND NOT EXISTS(SELECT 1 FROM fi.fix_dealer_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.dealer_id=m.dealer_id AND d.dealer_order_id=m.fields->>'37')
 UNION ALL SELECT 'CANCEL_CORRELATION',d.cl_ord_id::text FROM fi.fix_cancel_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.order_id<>d.order_id OR m.fields->>'11' IS DISTINCT FROM d.cl_ord_id::text OR m.fields->>'41' IS DISTINCT FROM d.orig_cl_ord_id::text OR d.orig_cl_ord_id<>d.order_id)
 UNION ALL SELECT 'CANCEL_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '41' AND NOT EXISTS(SELECT 1 FROM fi.fix_cancel_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.cl_ord_id::text=m.fields->>'11' AND d.orig_cl_ord_id::text=m.fields->>'41')
 UNION ALL SELECT 'SEQUENCE_CORRELATION',x.message_id::text FROM fi.fix_sequence_slots x WHERE x.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM wire_evidence a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id) WHERE a.sandbox_id=x.sandbox_id AND a.message_id=x.message_id AND b.channel_id=x.channel_id AND x.epoch=1 AND m.direction=x.direction AND a.decoded->>'34'=x.message_seq::text)
 UNION ALL SELECT 'MISSING_SEQUENCE',a.id::text FROM wire_evidence a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id) WHERE NOT EXISTS(SELECT 1 FROM fi.fix_sequence_slots x WHERE x.sandbox_id=a.sandbox_id AND x.message_id=a.message_id AND x.channel_id=b.channel_id AND x.direction=m.direction AND x.message_seq::text=a.decoded->>'34')
 UNION ALL SELECT 'WORK_OPERATION',w.id::text FROM fi.fix_work w JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) WHERE w.sandbox_id=$1 AND w.operation IS DISTINCT FROM CASE m.message_type WHEN 'F' THEN 'REQUEST_CANCEL' WHEN '9' THEN 'REJECT_CANCEL' WHEN '8' THEN CASE m.fields->>'150' WHEN '0' THEN 'ACK_ORDER' WHEN '8' THEN 'REJECT_ORDER' WHEN 'F' THEN 'EXECUTE_ORDER' WHEN '4' THEN 'ACK_CANCEL' WHEN '6' THEN 'PROTOCOL_ONLY' END END
 UNION ALL SELECT 'PREPARED_REFERENCE',p.work_id::text FROM fi.fix_prepared p JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(p.sandbox_id,p.order_id) WHERE p.sandbox_id=$1 AND (p.operation<>w.operation OR p.prepared_fence>l.fence OR p.payload IS DISTINCT FROM (jsonb_build_object('order_id',w.order_id,'expected_version','1')||CASE WHEN w.operation='EXECUTE_ORDER' THEN jsonb_build_object('execution_id',m.execution_id,'source_event_id',m.source_event_id,'par_amount',m.fields->>'32') WHEN w.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN jsonb_build_object('cancel_id',m.fields->>'11') ELSE '{}'::jsonb END))
 UNION ALL SELECT 'OUTCOME_ELIGIBILITY',o.work_id::text FROM fi.fix_outcomes o JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(o.sandbox_id,o.work_id) WHERE o.sandbox_id=$1 AND (w.operation<>'PROTOCOL_ONLY' OR NOT EXISTS(SELECT 1 FROM fi.fix_prepared p WHERE p.sandbox_id=o.sandbox_id AND p.work_id=o.work_id))
 UNION ALL SELECT 'AUDIT_CORRESPONDENCE',c.id::text FROM fi.fix_commands c JOIN fi.fix_events e ON(e.sandbox_id,e.command_seq)=(c.sandbox_id,c.command_seq) WHERE c.sandbox_id=$1 AND (e.event_type<>c.operation OR e.order_id::text IS DISTINCT FROM c.response_body->>'order_id' OR e.payload IS DISTINCT FROM jsonb_build_object('financial_applied',false,'record',c.response_body-'payload'))
 UNION ALL SELECT 'MANUAL_FIX_WRITER',c.id::text FROM fi.commands c JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id::text)=(c.sandbox_id,c.response_body->>'order_id') WHERE c.sandbox_id=$1 AND c.created_at>b.created_at AND c.operation IN ('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL')
)
SELECT 'fix-foundation-v1' AS profile,6 AS physical_schema_revision,
 pg_current_snapshot()::text AS snapshot_id,clock_timestamp() AS snapshot_at,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.commands WHERE sandbox_id=$1) AS financial_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1) AS protocol_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1 AND operation='RECORD') AS protocol_ingest_watermark,
 '0'::text AS protocol_application_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1 AND operation='PREPARE') AS protocol_prepare_watermark,
 (SELECT count(*)::int FROM fi.fix_work w WHERE sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.fix_outcomes o WHERE o.sandbox_id=w.sandbox_id AND o.work_id=w.id)) AS unresolved_work_count,
 'NOT_EVALUATED' AS financial_ledger_consistency,'NOT_IMPLEMENTED' AS protocol_completeness,
 false AS delivery_verified,false AS financial_application_verified,
 CASE WHEN EXISTS(SELECT 1 FROM issues) THEN 'FOUNDATION_FINDINGS' ELSE 'FOUNDATION_CONSISTENT' END AS foundation_assessment,
 COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY code,record_id) FROM (SELECT * FROM issues ORDER BY code,record_id LIMIT 128) i),'[]'::jsonb) AS findings,
 (SELECT count(*)::int FROM issues) AS total_findings;
