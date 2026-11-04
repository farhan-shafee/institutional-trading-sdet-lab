-- Independent protocol-application reconstruction. No application/domain helper calls.
-- Financial ledger reconstruction runs alongside this query in the same read-only snapshot.
WITH bindings AS (SELECT b.*,o.contract,l.status,l.version FROM fi.fix_bindings b JOIN fi.orders o ON(o.sandbox_id,o.id)=(b.sandbox_id,b.order_id) JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(b.sandbox_id,b.order_id) WHERE b.sandbox_id=$1),
wire_bytes AS MATERIALIZED (
 SELECT a.*,NOT EXISTS(SELECT 1 FROM generate_series(0,octet_length(a.raw_bytes)-1) g(i)
 WHERE get_byte(a.raw_bytes,g.i)<>1 AND get_byte(a.raw_bytes,g.i) NOT BETWEEN 32 AND 126) AS ascii_valid
 FROM fi.fix_attempts a WHERE a.sandbox_id=$1
),
wire_evidence AS (SELECT a.*,m.semantic_hash,(SELECT jsonb_object_agg(split_part(part,'=',1),substring(part,length(split_part(part,'=',1))+2)) FROM unnest(string_to_array(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,chr(1))) part WHERE part<>'') decoded FROM wire_bytes a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) WHERE a.sandbox_id=$1),
prepared AS MATERIALIZED (
 SELECT p.*,CASE WHEN jsonb_typeof(p.payload->'expected_version')='string' AND p.payload->>'expected_version' ~ '^[1-9][0-9]{0,2}$'
 THEN (p.payload->>'expected_version')::bigint END AS expected_version FROM fi.fix_prepared p WHERE p.sandbox_id=$1
),
receipts AS MATERIALIZED (
 SELECT c.*,CASE WHEN jsonb_typeof(c.response_body)='object' THEN c.response_body ELSE '{}'::jsonb END AS body FROM fi.fix_commands c WHERE c.sandbox_id=$1
),
-- Capacity policy still uses the retained binding timestamp. This separate
-- witness reconstruction detects contradictory provenance without trusting it.
-- The first BIND is selected by immutable FIX sequence, never by a mutable clock.
capacity_bind_witnesses AS MATERIALIZED (
 SELECT b.order_id,b.created_at,w.command_seq,w.recorded_at,
 COALESCE(w.associations=1 AND isfinite(b.created_at) AND isfinite(w.recorded_at),false) AS valid
 FROM fi.fix_bindings b LEFT JOIN LATERAL (
 SELECT count(*) OVER() AS associations,c.command_seq,e.recorded_at
 FROM receipts c JOIN fi.fix_events e
 ON(e.sandbox_id,e.command_seq,e.event_index)=(c.sandbox_id,c.command_seq,0)
 WHERE c.sandbox_id=b.sandbox_id AND c.operation='BIND' AND c.http_status=201
 AND c.response_body=jsonb_build_object('order_id',b.order_id,'cl_ord_id',b.order_id,
 'dealer_order_id',NULL::text,'reserved_commands',25,'reserved_events',43,'financial_applied',false)
 AND c.request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',b.sandbox_id,
 'operation','BIND','payload',jsonb_build_object('order_id',b.order_id,'dealer_id',b.dealer_id,'channel_id',b.channel_id))::text,'UTF8')),'hex')
 AND e.event_type='BIND' AND e.order_id=b.order_id
 AND e.payload=jsonb_build_object('financial_applied',false,'record',c.response_body)
 ) w ON true WHERE b.sandbox_id=$1
),
capacity_epoch AS MATERIALIZED (
 SELECT min(created_at) AS stored_epoch,
 (SELECT recorded_at FROM capacity_bind_witnesses WHERE valid ORDER BY command_seq LIMIT 1) AS audit_epoch
 FROM capacity_bind_witnesses
),
capacity_rotations AS MATERIALIZED (
 SELECT c.id,c.created_at,e.decided_at,e.recorded_at,COALESCE(
 isfinite(c.created_at) AND isfinite(e.decided_at) AND isfinite(e.recorded_at)
 AND e.decided_at<=e.recorded_at AND e.recorded_at<=c.created_at
 AND ((c.result_kind='APPLIED' AND c.http_status=200 AND e.event_type='CAPABILITIES_ROTATED'
 AND c.response_body#>'{sandbox,id}'=to_jsonb(c.sandbox_id::text) AND c.response_body->>'scope'='trade'
 AND e.aggregate_version::text=c.response_body#>>'{sandbox,generation}'
 AND e.payload=jsonb_build_object('generation',c.response_body#>>'{sandbox,generation}'))
 OR (c.result_kind='REJECTED' AND c.http_status=409 AND e.event_type='COMMAND_REJECTED'
 AND c.response_body#>>'{error,code}' IN('GENERATION_CONFLICT','CAPABILITY_REUSE','GENERATION_LIMIT_REACHED')
 AND c.response_body=jsonb_build_object('error',jsonb_build_object('code',c.response_body#>>'{error,code}',
 'message','The fixed-income workflow request could not be completed.'))
 AND e.aggregate_version IS NULL AND e.payload=jsonb_build_object('code',c.response_body#>>'{error,code}'))),false) AS valid
 FROM fi.commands c LEFT JOIN fi.audit_events e
 ON(e.sandbox_id,e.command_id,e.command_seq,e.event_index)=(c.sandbox_id,c.id,c.command_seq,0)
 WHERE c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES'
),
claims AS MATERIALIZED (
 SELECT c.*,row_number() OVER(PARTITION BY sandbox_id,body->>'order_id' ORDER BY command_seq) AS ordinal FROM receipts c WHERE operation='CLAIM'
),
application_links AS MATERIALIZED (
 SELECT a.*,pc.id AS receipt_id,COALESCE(
 p.work_id IS NOT NULL AND w.id IS NOT NULL AND c.id IS NOT NULL AND pc.id IS NOT NULL AND h.version IS NOT NULL
 AND w.order_id=a.order_id AND w.message_id=a.message_id AND p.order_id=a.order_id AND p.operation=w.operation
 AND w.operation IN('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL')
 AND c.operation=p.operation AND c.idempotency_key=p.financial_key AND a.financial_key=p.financial_key
 AND c.command_seq=a.financial_command_seq AND c.request_hash=a.financial_request_hash AND c.result_kind='APPLIED'
 AND p.request_hash=encode(sha256(convert_to(p.payload::text,'UTF8')),'hex')
 AND a.financial_request_hash=encode(sha256(convert_to(
 '{"version":1,"method":"POST","operation":'||to_json(p.operation)::text||',"sandbox_id":'||to_json(p.sandbox_id::text)::text||',"payload":{"order_id":'||to_json(p.payload->>'order_id')::text||',"expected_version":'||to_json(p.payload->>'expected_version')::text||
 CASE WHEN p.operation='EXECUTE_ORDER' THEN ',"execution_id":'||to_json(p.payload->>'execution_id')::text||',"source_event_id":'||to_json(p.payload->>'source_event_id')::text||',"par_amount":'||to_json(p.payload->>'par_amount')::text
 WHEN p.operation IN('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN ',"cancel_id":'||to_json(p.payload->>'cancel_id')::text ELSE '' END||'}}','UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM fi.order_history n WHERE(n.sandbox_id,n.order_id,n.version,n.command_id,n.command_seq,n.operation)=(h.sandbox_id,h.order_id,h.version+1,c.id,c.command_seq,p.operation))
 AND EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE(k.sandbox_id,k.idempotency_key,k.domain)=(a.sandbox_id,p.financial_key,'FINANCIAL'))
 AND x.commands=1 AND x.events=CASE p.operation WHEN 'EXECUTE_ORDER' THEN 3 ELSE 1 END
 AND x.events=(SELECT count(*) FROM fi.audit_events e WHERE e.sandbox_id=a.sandbox_id AND e.command_id=c.id)
 AND pc.operation='APPLY' AND pc.http_status=200 AND pc.body=a.result
 AND a.result=jsonb_build_object('order_id',a.order_id,'work_id',a.work_id,'financial_applied',true,'delivery_verified',false,
 'financial_key',a.financial_key,'financial_command_id',a.financial_command_id,'financial_command_seq',a.financial_command_seq::text,
 'financial_result',jsonb_build_object('status',c.http_status,'body',c.response_body,'replayed',false))
 AND q.id IS NOT NULL AND pc.actor_id=q.actor_id AND a.applied_fence=q.ordinal AND a.applied_fence BETWEEN p.prepared_fence AND l.fence
 AND a.applied_generation BETWEEN p.prepared_generation AND s.generation AND a.applied_generation<=l.capability_generation
 AND (a.applied_fence<>l.fence OR a.applied_generation=l.capability_generation)
 AND pc.request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',a.sandbox_id,'operation','APPLY','payload',
 jsonb_build_object('order_id',a.order_id,'owner_id',q.body->'owner_id','fence',q.ordinal::text,'work_id',a.work_id))::text,'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM receipts pr WHERE pr.operation='PREPARE' AND pr.body->'work_id'=to_jsonb(a.work_id::text) AND pr.command_seq<pc.command_seq)
 AND NOT EXISTS(SELECT 1 FROM fi.fix_outcomes o WHERE(o.sandbox_id,o.work_id)=(a.sandbox_id,a.work_id)),false) AS link_valid
 FROM fi.fix_applications a
 LEFT JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id)
 LEFT JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(a.sandbox_id,a.work_id)
 LEFT JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id)
 LEFT JOIN receipts pc ON(pc.sandbox_id,pc.command_seq)=(a.sandbox_id,a.protocol_command_seq)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.version::text)=(p.sandbox_id,p.order_id,p.payload->>'expected_version')
 LEFT JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(a.sandbox_id,a.order_id)
 LEFT JOIN fi.sandboxes s ON s.id=a.sandbox_id
 LEFT JOIN fi.fix_consumptions x ON(x.sandbox_id,x.work_id,x.order_id)=(a.sandbox_id,a.work_id,a.order_id)
 LEFT JOIN LATERAL(SELECT q.* FROM claims q WHERE q.sandbox_id=a.sandbox_id AND q.body->'order_id'=to_jsonb(a.order_id::text)
 AND q.command_seq<pc.command_seq ORDER BY q.command_seq DESC LIMIT 1) q ON true
 WHERE a.sandbox_id=$1
),
observation_links AS MATERIALIZED (
 SELECT v.*,pc.id AS receipt_id,COALESCE(
 w.id IS NOT NULL AND p.work_id IS NOT NULL AND m.id IS NOT NULL AND o.work_id IS NOT NULL AND h.version IS NOT NULL
 AND w.operation='PROTOCOL_ONLY' AND p.operation=w.operation AND m.message_type='8' AND m.fields->>'150'='6' AND m.fields->>'39'='6'
 AND w.order_id=v.order_id AND p.order_id=v.order_id AND m.order_id=v.order_id
 AND p.payload->'expected_version'=to_jsonb(v.financial_version::text)
 AND m.fields->'11'=to_jsonb(v.cancel_id::text) AND m.fields->'41'=to_jsonb(v.order_id::text)
 AND m.fields->'14'=to_jsonb(v.filled_par::text) AND m.fields->'151'=to_jsonb(v.remaining_par::text)
 AND h.state->'filled_par'=to_jsonb(v.filled_par::text) AND h.state->'remaining_par'=to_jsonb(v.remaining_par::text)
 AND h.state->'pending_cancel_id'=to_jsonb(v.cancel_id::text)
 AND h.state->>'status' IN('NEW','PARTIALLY_FILLED')
 AND EXISTS(SELECT 1 FROM fi.cancellation_requests r WHERE(r.sandbox_id,r.order_id,r.id)=(v.sandbox_id,v.order_id,v.cancel_id))
 AND o.outcome='METADATA_ONLY' AND o.financial_command_id IS NULL AND o.financial_command_seq IS NULL
 AND pc.operation='APPLY' AND pc.http_status=200 AND pc.body=jsonb_build_object('order_id',v.order_id,'work_id',v.work_id,
 'financial_applied',false,'delivery_verified',false,'outcome','METADATA_ONLY','validated_pending_cancel',true)
 AND q.id IS NOT NULL AND pc.actor_id=q.actor_id AND v.applied_fence=q.ordinal AND v.applied_fence BETWEEN p.prepared_fence AND l.fence
 AND v.applied_generation BETWEEN p.prepared_generation AND s.generation AND v.applied_generation<=l.capability_generation
 AND (v.applied_fence<>l.fence OR v.applied_generation=l.capability_generation)
 AND pc.request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',v.sandbox_id,'operation','APPLY','payload',
 jsonb_build_object('order_id',v.order_id,'owner_id',q.body->'owner_id','fence',q.ordinal::text,'work_id',v.work_id))::text,'UTF8')),'hex')
 AND EXISTS(SELECT 1 FROM receipts pr WHERE pr.operation='PREPARE' AND pr.body->'work_id'=to_jsonb(v.work_id::text) AND pr.command_seq<pc.command_seq)
 AND NOT EXISTS(SELECT 1 FROM fi.fix_applications a WHERE(a.sandbox_id,a.work_id)=(v.sandbox_id,v.work_id)),false) AS link_valid
 FROM fi.fix_protocol_observations v
 LEFT JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(v.sandbox_id,v.work_id)
 LEFT JOIN prepared p ON(p.sandbox_id,p.work_id)=(v.sandbox_id,v.work_id)
 LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id)
 LEFT JOIN fi.fix_outcomes o ON(o.sandbox_id,o.work_id)=(v.sandbox_id,v.work_id)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.version)=(v.sandbox_id,v.order_id,v.financial_version)
 LEFT JOIN receipts pc ON(pc.sandbox_id,pc.command_seq)=(v.sandbox_id,v.protocol_command_seq)
 LEFT JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(v.sandbox_id,v.order_id)
 LEFT JOIN fi.sandboxes s ON s.id=v.sandbox_id
 LEFT JOIN LATERAL(SELECT q.* FROM claims q WHERE q.sandbox_id=v.sandbox_id AND q.body->'order_id'=to_jsonb(v.order_id::text)
 AND q.command_seq<pc.command_seq ORDER BY q.command_seq DESC LIMIT 1) q ON true
 WHERE v.sandbox_id=$1
),
issues AS (
 SELECT 'WIRE_FRAMING' code,a.id::text record_id FROM wire_evidence a WHERE
 NOT a.ascii_valid OR split_part(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,chr(1),1)<>'8=FIX.4.4'
 OR split_part(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,chr(1),2) !~ '^9=[1-9][0-9]{0,4}$'
 OR right(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,7) !~ ('^10=[0-9]{3}'||chr(1)||'$')
 OR (CASE WHEN a.decoded->>'9' ~ '^[1-9][0-9]{0,4}$' THEN (a.decoded->>'9')::integer ELSE -1 END)<>octet_length(a.raw_bytes)-7-length(split_part(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,chr(1),1))-length(split_part(CASE WHEN a.ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END,chr(1),2))-2
 OR (CASE WHEN a.decoded->>'10' ~ '^[0-9]{3}$' THEN (a.decoded->>'10')::integer ELSE -1 END)<>(SELECT sum(get_byte(a.raw_bytes,g.i))%256 FROM generate_series(0,octet_length(a.raw_bytes)-8) g(i))
 UNION ALL SELECT 'WIRE_SEMANTICS' code,a.id::text record_id FROM wire_evidence a WHERE a.semantic_hash<>encode(sha256(convert_to((a.decoded-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex')
 UNION ALL
 SELECT 'BINDING_CONTRACT' code,b.order_id::text record_id FROM bindings b WHERE b.cl_ord_id<>b.order_id OR b.dealer_id<>b.contract->>'dealer_id' OR b.contract_hash<>encode(sha256(convert_to(b.contract::text,'UTF8')),'hex')
 UNION ALL SELECT 'RAW_BYTES',a.id::text FROM fi.fix_attempts a WHERE a.sandbox_id=$1 AND (a.raw_hash<>encode(sha256(a.raw_bytes),'hex') OR NOT EXISTS(SELECT 1 FROM fi.fix_messages m WHERE m.sandbox_id=a.sandbox_id AND m.id=a.message_id))
 UNION ALL SELECT 'SEMANTIC_HASH',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.semantic_hash<>encode(sha256(convert_to((m.fields-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex')
 UNION ALL SELECT 'LANE_SEQUENCE',w.id::text FROM fi.fix_work w WHERE w.sandbox_id=$1 AND w.lane_seq<>(SELECT count(*) FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<=w.lane_seq)
 UNION ALL SELECT 'UNAUTHORIZED_FINANCIAL_REFERENCE',o.work_id::text FROM fi.fix_outcomes o WHERE o.sandbox_id=$1 AND (o.outcome<>'METADATA_ONLY' OR o.financial_command_id IS NOT NULL OR o.financial_command_seq IS NOT NULL)
 UNION ALL SELECT 'PREPARED_FINGERPRINT',p.work_id::text FROM prepared p WHERE p.sandbox_id=$1 AND (p.request_hash<>encode(sha256(convert_to(p.payload::text,'UTF8')),'hex') OR p.payload->>'order_id'<>p.order_id::text OR NOT EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE k.sandbox_id=p.sandbox_id AND k.idempotency_key=p.financial_key AND k.domain=CASE WHEN EXISTS(SELECT 1 FROM fi.fix_applications a WHERE a.sandbox_id=p.sandbox_id AND a.work_id=p.work_id) THEN 'FINANCIAL' ELSE 'FIX_PREPARED' END))
 UNION ALL SELECT 'CAPACITY_RESERVATION',b.order_id::text FROM bindings b JOIN fi.fix_lanes l USING(sandbox_id,order_id) LEFT JOIN fi_control.fix_reservations r USING(sandbox_id,order_id) WHERE r.order_id IS NULL OR r.commands<>25 OR r.events<>43 OR (r.released_at IS NOT NULL)<>(l.closed_at IS NOT NULL)
 UNION ALL SELECT 'PROTOCOL_AUDIT',c.id::text FROM fi.fix_commands c WHERE c.sandbox_id=$1 AND (c.command_seq<>(SELECT count(*) FROM fi.fix_commands x WHERE x.sandbox_id=c.sandbox_id AND x.command_seq<=c.command_seq) OR (SELECT count(*) FROM fi.fix_events e WHERE e.sandbox_id=c.sandbox_id AND e.command_seq=c.command_seq)<>1)

 UNION ALL SELECT 'DEALER_CORRELATION',d.order_id::text FROM fi.fix_dealer_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.message_type<>'8' OR m.direction<>'IN' OR m.order_id<>d.order_id OR m.dealer_id<>d.dealer_id OR m.fields->>'37' IS DISTINCT FROM d.dealer_order_id)
 UNION ALL SELECT 'DEALER_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '37' AND NOT EXISTS(SELECT 1 FROM fi.fix_dealer_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.dealer_id=m.dealer_id AND d.dealer_order_id=m.fields->>'37')
 UNION ALL SELECT 'CANCEL_CORRELATION',d.cl_ord_id::text FROM fi.fix_cancel_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.order_id<>d.order_id OR m.fields->>'11' IS DISTINCT FROM d.cl_ord_id::text OR m.fields->>'41' IS DISTINCT FROM d.orig_cl_ord_id::text OR d.orig_cl_ord_id<>d.order_id)
 UNION ALL SELECT 'CANCEL_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '41' AND NOT EXISTS(SELECT 1 FROM fi.fix_cancel_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.cl_ord_id::text=m.fields->>'11' AND d.orig_cl_ord_id::text=m.fields->>'41')
 UNION ALL SELECT 'SEQUENCE_CORRELATION',x.message_id::text FROM fi.fix_sequence_slots x WHERE x.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM wire_evidence a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id) WHERE a.sandbox_id=x.sandbox_id AND a.message_id=x.message_id AND b.channel_id=x.channel_id AND x.epoch=1 AND m.direction=x.direction AND a.decoded->>'34'=x.message_seq::text)
 UNION ALL SELECT 'MISSING_SEQUENCE',a.id::text FROM wire_evidence a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id) WHERE NOT EXISTS(SELECT 1 FROM fi.fix_sequence_slots x WHERE x.sandbox_id=a.sandbox_id AND x.message_id=a.message_id AND x.channel_id=b.channel_id AND x.direction=m.direction AND x.message_seq::text=a.decoded->>'34')
 UNION ALL SELECT 'WORK_OPERATION',w.id::text FROM fi.fix_work w JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) WHERE w.sandbox_id=$1 AND w.operation IS DISTINCT FROM CASE m.message_type WHEN 'F' THEN 'REQUEST_CANCEL' WHEN '9' THEN 'REJECT_CANCEL' WHEN '8' THEN CASE m.fields->>'150' WHEN '0' THEN 'ACK_ORDER' WHEN '8' THEN 'REJECT_ORDER' WHEN 'F' THEN 'EXECUTE_ORDER' WHEN '4' THEN 'ACK_CANCEL' WHEN '6' THEN 'PROTOCOL_ONLY' END END
 UNION ALL SELECT 'PREPARED_REFERENCE',p.work_id::text FROM prepared p JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(p.sandbox_id,p.order_id) WHERE p.sandbox_id=$1 AND (p.expected_version IS NULL OR p.operation<>w.operation OR p.prepared_fence>l.fence OR p.payload IS DISTINCT FROM (jsonb_build_object('order_id',w.order_id,'expected_version',p.payload->>'expected_version')||CASE WHEN w.operation='EXECUTE_ORDER' THEN jsonb_build_object('execution_id',m.execution_id,'source_event_id',m.source_event_id,'par_amount',m.fields->>'32') WHEN w.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN jsonb_build_object('cancel_id',m.fields->>'11') ELSE '{}'::jsonb END))
 UNION ALL SELECT 'OUTCOME_ELIGIBILITY',o.work_id::text FROM fi.fix_outcomes o JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(o.sandbox_id,o.work_id) WHERE o.sandbox_id=$1 AND (w.operation<>'PROTOCOL_ONLY' OR NOT EXISTS(SELECT 1 FROM prepared p WHERE p.sandbox_id=o.sandbox_id AND p.work_id=o.work_id))
 UNION ALL SELECT 'AUDIT_CORRESPONDENCE',c.id::text FROM fi.fix_commands c JOIN fi.fix_events e ON(e.sandbox_id,e.command_seq)=(c.sandbox_id,c.command_seq) WHERE c.sandbox_id=$1 AND (e.event_type<>c.operation OR e.order_id::text IS DISTINCT FROM c.response_body->>'order_id' OR e.payload IS DISTINCT FROM CASE WHEN c.operation='APPLY' THEN jsonb_build_object('financial_applied',c.response_body->'financial_applied','record',c.response_body) ELSE jsonb_build_object('financial_applied',false,'record',c.response_body-'payload') END)
 UNION ALL SELECT 'MANUAL_FIX_WRITER',c.id::text FROM fi.commands c JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id::text)=(c.sandbox_id,c.response_body->>'order_id') WHERE c.sandbox_id=$1 AND c.created_at>b.created_at AND c.operation IN ('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') AND NOT EXISTS(SELECT 1 FROM fi.fix_applications a WHERE a.sandbox_id=c.sandbox_id AND a.financial_command_id=c.id)
 UNION ALL SELECT 'APPLICATION_RECEIPT',a.work_id::text FROM fi.fix_applications a
 LEFT JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id) LEFT JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(a.sandbox_id,a.work_id)
 LEFT JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id)
 LEFT JOIN fi.fix_commands pc ON(pc.sandbox_id,pc.command_seq)=(a.sandbox_id,a.protocol_command_seq)
 WHERE a.sandbox_id=$1 AND (p.work_id IS NULL OR w.id IS NULL OR c.id IS NULL OR pc.id IS NULL OR c.result_kind<>'APPLIED'
 OR a.message_id<>w.message_id OR a.order_id<>w.order_id OR a.financial_key<>p.financial_key OR c.idempotency_key<>p.financial_key
 OR c.operation<>p.operation OR p.operation<>w.operation OR c.command_seq<>a.financial_command_seq OR c.request_hash<>a.financial_request_hash
 OR pc.operation<>'APPLY' OR pc.response_body IS DISTINCT FROM a.result OR a.result->'financial_applied' IS DISTINCT FROM 'true'::jsonb
 OR a.result->'financial_result'->'body' IS DISTINCT FROM c.response_body OR a.result->'financial_result'->'status' IS DISTINCT FROM to_jsonb(c.http_status)
 OR NOT EXISTS(SELECT 1 FROM fi.order_history h WHERE h.sandbox_id=a.sandbox_id AND h.order_id=a.order_id AND h.command_id=c.id AND h.operation=p.operation AND h.version=p.expected_version+1)
 OR EXISTS(SELECT 1 FROM fi.fix_outcomes o WHERE o.sandbox_id=a.sandbox_id AND o.work_id=a.work_id))
 UNION ALL SELECT 'FINANCIAL_FINGERPRINT',a.work_id::text FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id)
 WHERE a.sandbox_id=$1 AND a.financial_request_hash<>encode(sha256(convert_to(
 '{"version":1,"method":"POST","operation":'||to_json(p.operation)::text||',"sandbox_id":'||to_json(p.sandbox_id::text)::text||',"payload":{"order_id":'||to_json(p.payload->>'order_id')::text||',"expected_version":'||to_json(p.payload->>'expected_version')::text||
 CASE WHEN p.operation='EXECUTE_ORDER' THEN ',"execution_id":'||to_json(p.payload->>'execution_id')::text||',"source_event_id":'||to_json(p.payload->>'source_event_id')::text||',"par_amount":'||to_json(p.payload->>'par_amount')::text
 WHEN p.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN ',"cancel_id":'||to_json(p.payload->>'cancel_id')::text ELSE '' END||'}}','UTF8')),'hex')
 UNION ALL SELECT 'EXECUTION_CORRELATION',a.work_id::text FROM fi.fix_applications a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id) LEFT JOIN fi.executions e ON(e.sandbox_id,e.id)=(m.sandbox_id,m.execution_id)
 JOIN fi.orders o ON(o.sandbox_id,o.id)=(a.sandbox_id,a.order_id)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.command_id)=(a.sandbox_id,a.financial_command_id)
 WHERE a.sandbox_id=$1 AND p.operation='EXECUTE_ORDER' AND (e.id IS NULL OR e.source_event_id IS DISTINCT FROM m.source_event_id
 OR e.order_id<>a.order_id OR e.par_amount<>(CASE WHEN m.fields->>'32' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'32')::numeric END) OR e.clean_price<>m.fields->>'31'
 OR e.command_id<>a.financial_command_id OR p.payload->>'execution_id'<>e.id::text OR p.payload->>'source_event_id'<>e.source_event_id::text
 OR (CASE WHEN m.fields->>'14' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'14')::numeric END)<>(CASE WHEN h.state->>'filled_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'filled_par')::numeric END) OR (CASE WHEN m.fields->>'151' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'151')::numeric END)<>(CASE WHEN h.state->>'remaining_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'remaining_par')::numeric END)
 OR e.clean_price<>o.contract->>'clean_price' OR e.instrument_revision<>o.contract->>'instrument_revision'
 OR e.settlement_date<>CASE WHEN pg_input_is_valid(o.contract->>'settlement_date','date') THEN (o.contract->>'settlement_date')::date END OR e.side<>o.contract->>'side')
 UNION ALL SELECT 'MISSING_PROTOCOL_EXECUTION',e.id::text FROM fi.executions e JOIN fi.fix_bindings b USING(sandbox_id,order_id) WHERE e.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.fix_applications a WHERE a.sandbox_id=e.sandbox_id AND a.financial_command_id=e.command_id)
 UNION ALL SELECT 'APPLICATION_ORDER',a.work_id::text FROM fi.fix_applications a JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(a.sandbox_id,a.work_id) WHERE a.sandbox_id=$1 AND EXISTS(SELECT 1 FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<w.lane_seq AND NOT EXISTS(SELECT 1 FROM fi.fix_applications y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id) AND (NOT EXISTS(SELECT 1 FROM fi.fix_outcomes y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id) OR (x.operation='PROTOCOL_ONLY' AND NOT EXISTS(SELECT 1 FROM fi.fix_protocol_observations v WHERE v.sandbox_id=x.sandbox_id AND v.work_id=x.id))))
 UNION ALL SELECT 'APPLICATION_CAPACITY',a.work_id::text FROM fi.fix_applications a JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id) LEFT JOIN fi.fix_consumptions x ON(x.sandbox_id,x.work_id)=(a.sandbox_id,a.work_id) WHERE a.sandbox_id=$1 AND (x.work_id IS NULL OR x.order_id<>a.order_id OR x.commands<>1 OR x.events<>CASE c.operation WHEN 'EXECUTE_ORDER' THEN 3 ELSE 1 END OR x.events<>(SELECT count(*) FROM fi.audit_events e WHERE e.sandbox_id=c.sandbox_id AND e.command_id=c.id))
 UNION ALL SELECT 'UNBACKED_CONSUMPTION',x.work_id::text FROM fi.fix_consumptions x LEFT JOIN fi.fix_applications a USING(sandbox_id,work_id) WHERE x.sandbox_id=$1 AND a.work_id IS NULL
 UNION ALL SELECT 'RESERVATION_BUDGET',r.order_id::text FROM fi_control.fix_reservations r WHERE r.sandbox_id=$1 AND ((SELECT count(*) FROM fi.fix_consumptions x WHERE x.sandbox_id=r.sandbox_id AND x.order_id=r.order_id)>25 OR (SELECT COALESCE(sum(events),0) FROM fi.fix_consumptions x WHERE x.sandbox_id=r.sandbox_id AND x.order_id=r.order_id)>41 OR (r.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM fi.fix_consumptions x WHERE x.sandbox_id=r.sandbox_id AND x.order_id=r.order_id)))
 UNION ALL SELECT 'PREPARED_VERSION',p.work_id::text FROM prepared p WHERE p.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.order_history h WHERE h.sandbox_id=p.sandbox_id AND h.order_id=p.order_id AND h.version=p.expected_version)
 UNION ALL SELECT 'PENDING_CANCEL_EVIDENCE',v.work_id::text FROM fi.fix_protocol_observations v JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(v.sandbox_id,v.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.version)=(v.sandbox_id,v.order_id,v.financial_version) WHERE v.sandbox_id=$1 AND (w.operation<>'PROTOCOL_ONLY' OR m.message_type<>'8' OR m.fields->>'150' IS DISTINCT FROM '6' OR m.fields->>'39' IS DISTINCT FROM '6' OR m.fields ? '31' OR m.fields ? '32' OR m.fields->>'6' IS DISTINCT FROM CASE WHEN v.filled_par=0 THEN '0.000000000000' ELSE (SELECT contract->>'clean_price' FROM fi.orders o WHERE o.sandbox_id=v.sandbox_id AND o.id=v.order_id) END OR m.fields->>'11'<>v.cancel_id::text OR h.state->>'pending_cancel_id' IS DISTINCT FROM v.cancel_id::text OR (CASE WHEN m.fields->>'14' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'14')::numeric END)<>v.filled_par OR (CASE WHEN m.fields->>'151' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'151')::numeric END)<>v.remaining_par OR (CASE WHEN h.state->>'filled_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'filled_par')::numeric END)<>v.filled_par OR (CASE WHEN h.state->>'remaining_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'remaining_par')::numeric END)<>v.remaining_par)
 UNION ALL SELECT 'CANCEL_FINANCIAL_REFERENCE',a.work_id::text FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 WHERE a.sandbox_id=$1 AND p.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') AND (p.payload->>'cancel_id' IS DISTINCT FROM m.fields->>'11' OR NOT EXISTS(SELECT 1 FROM fi.cancellation_requests r WHERE r.sandbox_id=a.sandbox_id AND r.order_id=a.order_id AND r.id::text=p.payload->>'cancel_id')
 OR (p.operation<>'REQUEST_CANCEL' AND NOT EXISTS(SELECT 1 FROM fi.cancellation_outcomes o WHERE o.sandbox_id=a.sandbox_id AND o.cancel_id::text=p.payload->>'cancel_id' AND o.command_id=a.financial_command_id AND o.outcome=CASE p.operation WHEN 'ACK_CANCEL' THEN 'ACKNOWLEDGED' ELSE 'REJECTED' END AND (m.fields->>'102' IS DISTINCT FROM '0' OR o.reason='TOO_LATE'))))

 UNION ALL SELECT 'MESSAGE_CONTRACT',m.id::text FROM fi.fix_messages m JOIN fi.orders o ON(o.sandbox_id,o.id)=(m.sandbox_id,m.order_id) WHERE m.sandbox_id=$1 AND (
 (m.message_type<>'9' AND (m.fields->>'55' IS DISTINCT FROM o.contract->>'instrument_id' OR m.fields->>'167' IS DISTINCT FROM CASE o.contract->>'instrument_id' WHEN 'SYN-UST-2031' THEN 'TNOTE' ELSE 'CORP' END OR m.fields->>'54' IS DISTINCT FROM CASE o.contract->>'side' WHEN 'BUY' THEN '1' ELSE '2' END OR m.fields->>'38' IS DISTINCT FROM o.contract->>'par_amount'))
 OR (m.message_type IN ('D','8') AND (m.fields->>'44' IS DISTINCT FROM o.contract->>'clean_price' OR m.fields->>'64' IS DISTINCT FROM replace(o.contract->>'settlement_date','-','') OR m.fields->>'15' IS DISTINCT FROM 'USD' OR m.fields->>'854' IS DISTINCT FROM '0' OR m.fields->>'40' IS DISTINCT FROM '2' OR m.fields->>'59' IS DISTINCT FROM '1' OR m.fields->>'423' IS DISTINCT FROM '1')))
 UNION ALL SELECT 'MESSAGE_DIRECTION',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND (m.direction IS DISTINCT FROM CASE WHEN m.message_type IN ('D','F') THEN 'OUT' ELSE 'IN' END OR m.fields->>'49' IS DISTINCT FROM CASE WHEN m.message_type IN ('D','F') THEN 'TRADEFLOW' ELSE m.dealer_id END OR m.fields->>'56' IS DISTINCT FROM CASE WHEN m.message_type IN ('D','F') THEN m.dealer_id ELSE 'TRADEFLOW' END)
 UNION ALL SELECT 'APPLIED_REPORT_TOTALS',a.work_id::text FROM fi.fix_applications a JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.order_history h ON(h.sandbox_id,h.command_id)=(a.sandbox_id,a.financial_command_id) JOIN fi.orders o ON(o.sandbox_id,o.id)=(a.sandbox_id,a.order_id) WHERE a.sandbox_id=$1 AND m.message_type='8' AND ((CASE WHEN m.fields->>'14' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'14')::numeric END) IS DISTINCT FROM (CASE WHEN h.state->>'filled_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'filled_par')::numeric END) OR (CASE WHEN m.fields->>'151' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (m.fields->>'151')::numeric END) IS DISTINCT FROM (CASE WHEN h.state->>'remaining_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'remaining_par')::numeric END) OR m.fields->>'6' IS DISTINCT FROM CASE WHEN (CASE WHEN h.state->>'filled_par' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (h.state->>'filled_par')::numeric END)=0 THEN '0.000000000000' ELSE o.contract->>'clean_price' END)
 UNION ALL SELECT 'APPLIED_REPORT_STATUS',a.work_id::text FROM fi.fix_applications a JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(a.sandbox_id,a.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) JOIN fi.order_history h ON(h.sandbox_id,h.command_id)=(a.sandbox_id,a.financial_command_id) WHERE a.sandbox_id=$1 AND m.message_type IN ('8','9') AND m.fields->>'39' IS DISTINCT FROM CASE
 WHEN w.operation='EXECUTE_ORDER' AND EXISTS(SELECT 1 FROM fi.fix_protocol_observations v JOIN fi.fix_work vw ON(vw.sandbox_id,vw.id)=(v.sandbox_id,v.work_id) WHERE v.sandbox_id=a.sandbox_id AND v.order_id=a.order_id AND vw.lane_seq<w.lane_seq AND v.cancel_id::text=h.state->>'pending_cancel_id') THEN '6'
 ELSE CASE h.state->>'status' WHEN 'NEW' THEN '0' WHEN 'REJECTED' THEN '8' WHEN 'PARTIALLY_FILLED' THEN '1' WHEN 'FILLED' THEN '2' WHEN 'CANCELED' THEN '4' END END
 UNION ALL SELECT 'AMBIGUOUS_REJECTION_APPLIED',a.work_id::text FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) WHERE a.sandbox_id=$1 AND p.operation='REJECT_ORDER' AND (m.fields->>'103' IS DISTINCT FROM '99' OR m.fields->>'58' IS DISTINCT FROM 'SYNTHETIC_REJECTION')
 UNION ALL SELECT 'UNRESOLVED_INGRESS',attempt_id::text FROM fi.fix_unresolved_ingest WHERE sandbox_id=$1

 UNION ALL SELECT 'CAPACITY_EPOCH_PROVENANCE',s.id::text FROM fi.sandboxes s WHERE s.id=$1 AND (
 EXISTS(SELECT 1 FROM capacity_bind_witnesses WHERE NOT valid)
 OR (EXISTS(SELECT 1 FROM capacity_bind_witnesses) AND EXISTS(
 SELECT 1 FROM capacity_rotations r CROSS JOIN capacity_epoch e WHERE NOT r.valid
 -- Strictly separated audit observations support membership disagreement.
 -- Equality/touching intervals do not prove order; policy's inclusive >= is unchanged.
 OR (r.created_at<e.stored_epoch AND r.decided_at>e.audit_epoch)
 OR (r.created_at>e.stored_epoch AND r.recorded_at<e.audit_epoch))))
 UNION ALL SELECT 'EFFECTIVE_CAPACITY',s.id::text FROM fi.sandboxes s WHERE s.id=$1 AND (
 greatest(s.command_count,(SELECT count(*) FROM fi.commands c WHERE c.sandbox_id=s.id))+(SELECT COALESCE(sum(r.commands-(SELECT COALESCE(sum(c.commands),0) FROM fi.fix_consumptions c WHERE c.sandbox_id=r.sandbox_id AND c.order_id=r.order_id)),0) FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL)
 +(CASE WHEN EXISTS(SELECT 1 FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL) THEN (SELECT greatest(2-count(*),0) FROM fi.commands c WHERE c.sandbox_id=s.id AND c.operation='ROTATE_CAPABILITIES' AND c.created_at >= (SELECT min(b.created_at) FROM fi.fix_bindings b WHERE b.sandbox_id=s.id)) ELSE 0 END)>512
 OR greatest(s.event_count,(SELECT count(*) FROM fi.audit_events e WHERE e.sandbox_id=s.id))+(SELECT COALESCE(sum(r.events-(SELECT COALESCE(sum(c.events),0) FROM fi.fix_consumptions c WHERE c.sandbox_id=r.sandbox_id AND c.order_id=r.order_id)),0) FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL)
 +(CASE WHEN EXISTS(SELECT 1 FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL) THEN (SELECT greatest(2-count(*),0) FROM fi.commands c WHERE c.sandbox_id=s.id AND c.operation='ROTATE_CAPABILITIES' AND c.created_at >= (SELECT min(b.created_at) FROM fi.fix_bindings b WHERE b.sandbox_id=s.id)) ELSE 0 END)>1024)
 -- Financial and observation completions retain their own exact APPLY control witness.
 UNION ALL SELECT 'APPLICATION_RECEIPT',a.work_id::text FROM application_links a WHERE NOT a.link_valid
 UNION ALL SELECT 'PENDING_CANCEL_EVIDENCE',v.work_id::text FROM observation_links v WHERE NOT v.link_valid
 UNION ALL SELECT 'APPLY_EVIDENCE',c.id::text FROM receipts c WHERE c.operation='APPLY'
 AND NOT EXISTS(SELECT 1 FROM application_links a WHERE a.receipt_id=c.id AND a.link_valid)
 AND NOT EXISTS(SELECT 1 FROM observation_links v WHERE v.receipt_id=c.id AND v.link_valid)
 -- Audit cardinality alone cannot establish a financial effect: reconstruct each exact event.
 UNION ALL SELECT 'APPLICATION_FINANCIAL_AUDIT',a.work_id::text
 FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id)
 LEFT JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.command_id,h.command_seq)=(a.sandbox_id,a.order_id,c.id,c.command_seq)
 LEFT JOIN receipts pc ON pc.command_seq=a.protocol_command_seq
 JOIN fi.orders o ON(o.sandbox_id,o.id)=(a.sandbox_id,a.order_id)
 WHERE a.sandbox_id=$1 AND NOT COALESCE(
 c.http_status=CASE WHEN p.operation IN('EXECUTE_ORDER','REQUEST_CANCEL') THEN 201 ELSE 200 END
 AND (SELECT count(*) FROM fi.audit_events e WHERE(e.sandbox_id,e.command_id)=(a.sandbox_id,c.id))=CASE WHEN p.operation='EXECUTE_ORDER' THEN 3 ELSE 1 END
 AND NOT EXISTS(
 SELECT 1 FROM (VALUES
 (0,CASE p.operation WHEN 'ACK_ORDER' THEN 'ORDER_ACKNOWLEDGED' WHEN 'REJECT_ORDER' THEN 'ORDER_REJECTED'
 WHEN 'EXECUTE_ORDER' THEN 'EXECUTION_RECORDED' WHEN 'REQUEST_CANCEL' THEN 'CANCEL_REQUESTED'
 WHEN 'ACK_CANCEL' THEN 'CANCEL_ACKNOWLEDGED' WHEN 'REJECT_CANCEL' THEN 'CANCEL_REJECTED' END,
 jsonb_build_object('order_id',a.order_id)||CASE WHEN p.operation='EXECUTE_ORDER' THEN jsonb_build_object('execution_id',p.payload->>'execution_id')
 WHEN p.operation IN('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN jsonb_build_object('cancel_id',p.payload->>'cancel_id') ELSE '{}'::jsonb END),
 (1,CASE WHEN p.operation='EXECUTE_ORDER' THEN 'ORDER_STATE_CHANGED' END,jsonb_build_object('order_id',a.order_id)),
 (2,CASE WHEN p.operation='EXECUTE_ORDER' THEN 'POSITION_UPDATED' END,jsonb_build_object('order_id',a.order_id,'instrument_revision',o.contract->>'instrument_revision'))
 ) expected(idx,kind,payload)
 LEFT JOIN fi.audit_events e ON(e.sandbox_id,e.command_id,e.command_seq,e.event_index)=(a.sandbox_id,c.id,c.command_seq,expected.idx)
 WHERE expected.kind IS NOT NULL AND NOT COALESCE(e.event_type=expected.kind AND e.payload=expected.payload
 AND e.aggregate_version=h.version AND e.actor_id=pc.actor_id AND e.decided_at=h.decided_at AND e.recorded_at>=e.decided_at,false)),false)
 -- History belongs to this exact financial command, not merely an available version.
 UNION ALL SELECT 'APPLICATION_RECEIPT',a.work_id::text
 FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id)
 LEFT JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id)
 LEFT JOIN fi.order_history prev ON(prev.sandbox_id,prev.order_id,prev.version)=(a.sandbox_id,a.order_id,p.expected_version)
 LEFT JOIN fi.order_history post ON(post.sandbox_id,post.order_id,post.version)=(a.sandbox_id,a.order_id,p.expected_version+1)
 WHERE a.sandbox_id=$1 AND NOT COALESCE(
 prev.version IS NOT NULL AND post.command_id=c.id AND post.command_seq=c.command_seq AND post.operation=p.operation
 AND c.response_body->'order_id'=to_jsonb(a.order_id::text) AND c.response_body->'lifecycle'=post.state
 AND post.state->'version'=to_jsonb(post.version::text)
 AND CASE p.operation
 WHEN 'ACK_ORDER' THEN prev.state->>'status'='PENDING_ACK' AND post.state->>'status'='NEW'
 WHEN 'REJECT_ORDER' THEN prev.state->>'status'='PENDING_ACK' AND post.state->>'status'='REJECTED'
 WHEN 'EXECUTE_ORDER' THEN prev.state->>'status' IN('NEW','PARTIALLY_FILLED') AND post.state->>'status' IN('PARTIALLY_FILLED','FILLED')
 AND post.state->'pending_cancel_id'=prev.state->'pending_cancel_id'
 AND EXISTS(SELECT 1 FROM fi.executions e WHERE(e.sandbox_id,e.order_id,e.command_id,e.command_seq)=(a.sandbox_id,a.order_id,c.id,c.command_seq)
 AND p.payload->'execution_id'=to_jsonb(e.id::text) AND p.payload->'source_event_id'=to_jsonb(e.source_event_id::text)
 AND p.payload->'par_amount'=to_jsonb(e.par_amount::text))
 WHEN 'REQUEST_CANCEL' THEN prev.state->>'status' IN('NEW','PARTIALLY_FILLED') AND post.state->'status'=prev.state->'status'
 AND prev.state->'pending_cancel_id'='null'::jsonb AND post.state->'pending_cancel_id'=p.payload->'cancel_id'
 AND EXISTS(SELECT 1 FROM fi.cancellation_requests r WHERE(r.sandbox_id,r.order_id,r.command_id,r.command_seq)=(a.sandbox_id,a.order_id,c.id,c.command_seq)
 AND p.payload->'cancel_id'=to_jsonb(r.id::text))
 WHEN 'ACK_CANCEL' THEN prev.state->>'status' IN('NEW','PARTIALLY_FILLED') AND post.state->>'status'='CANCELED'
 AND prev.state->'pending_cancel_id'=p.payload->'cancel_id' AND post.state->'pending_cancel_id'='null'::jsonb
 WHEN 'REJECT_CANCEL' THEN prev.state->>'status' IN('NEW','PARTIALLY_FILLED','FILLED') AND post.state->'status'=prev.state->'status'
 AND prev.state->'pending_cancel_id'=p.payload->'cancel_id' AND post.state->'pending_cancel_id'='null'::jsonb
 ELSE false END
 AND (p.operation='EXECUTE_ORDER' OR (post.state->'filled_par'=prev.state->'filled_par'
 AND post.state->'executed_cents'=prev.state->'executed_cents' AND post.state->'execution_count'=prev.state->'execution_count'))
 AND NOT EXISTS(SELECT 1 FROM fi.executions e WHERE(e.sandbox_id,e.command_id)=(a.sandbox_id,c.id) AND p.operation<>'EXECUTE_ORDER')
 AND NOT EXISTS(SELECT 1 FROM fi.cancellation_requests r WHERE(r.sandbox_id,r.command_id)=(a.sandbox_id,c.id) AND p.operation<>'REQUEST_CANCEL')
 AND NOT EXISTS(SELECT 1 FROM fi.cancellation_outcomes r WHERE(r.sandbox_id,r.command_id)=(a.sandbox_id,c.id) AND p.operation NOT IN('ACK_CANCEL','REJECT_CANCEL')),false)
 UNION ALL SELECT 'CANCEL_FINANCIAL_REFERENCE',a.work_id::text
 FROM fi.fix_applications a JOIN prepared p ON(p.sandbox_id,p.work_id)=(a.sandbox_id,a.work_id)
 JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.command_id,h.command_seq)=(a.sandbox_id,a.order_id,a.financial_command_id,a.financial_command_seq)
 LEFT JOIN fi.order_history prev ON(prev.sandbox_id,prev.order_id,prev.version)=(h.sandbox_id,h.order_id,h.version-1)
 WHERE a.sandbox_id=$1 AND p.operation IN('ACK_CANCEL','REJECT_CANCEL') AND NOT EXISTS(
 SELECT 1 FROM fi.cancellation_outcomes o JOIN fi.cancellation_requests r ON(r.sandbox_id,r.order_id,r.id)=(o.sandbox_id,o.order_id,o.cancel_id)
 WHERE(o.sandbox_id,o.order_id,o.command_id,o.command_seq)=(a.sandbox_id,a.order_id,a.financial_command_id,a.financial_command_seq)
 AND p.payload->'cancel_id'=to_jsonb(o.cancel_id::text) AND r.command_seq<o.command_seq
 AND o.outcome=CASE WHEN p.operation='ACK_CANCEL' THEN 'ACKNOWLEDGED' ELSE 'REJECTED' END
 AND o.reason=CASE WHEN p.operation='ACK_CANCEL' THEN 'CANCELED_REMAINDER' WHEN m.fields->>'102'='0' THEN 'TOO_LATE' ELSE 'SIMULATED_REJECTION' END
 AND ((p.operation='ACK_CANCEL' AND prev.state->>'status' IN('NEW','PARTIALLY_FILLED'))
 OR (p.operation='REJECT_CANCEL' AND ((m.fields->>'102'='0' AND prev.state->>'status'='FILLED' AND m.fields->>'39'='2')
 OR (m.fields->>'102'='99' AND prev.state->>'status' IN('NEW','PARTIALLY_FILLED'))))))
 -- JSON type/shape equality is safe even for malformed numeric report values.
 UNION ALL SELECT 'APPLIED_REPORT_TOTALS',a.work_id::text FROM fi.fix_applications a
 JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 LEFT JOIN fi.order_history h ON(h.sandbox_id,h.order_id,h.command_id,h.command_seq)=(a.sandbox_id,a.order_id,a.financial_command_id,a.financial_command_seq)
 WHERE a.sandbox_id=$1 AND m.message_type='8' AND NOT COALESCE(
 jsonb_typeof(m.fields->'14')='string' AND jsonb_typeof(m.fields->'151')='string'
 AND m.fields->'14'=h.state->'filled_par' AND m.fields->'151'=h.state->'remaining_par',false)

)
SELECT 'fix-application-v2' AS profile,8 AS physical_schema_revision,
 pg_current_snapshot()::text AS snapshot_id,clock_timestamp() AS snapshot_at,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.commands WHERE sandbox_id=$1) AS financial_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1) AS protocol_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1 AND operation IN ('RECORD','INGEST_REJECTED')) AS protocol_ingest_watermark,
 (SELECT COALESCE(max(command_seq),0)::text FROM fi.fix_commands WHERE sandbox_id=$1 AND operation='PREPARE') AS protocol_prepare_watermark,
 (SELECT COALESCE(max(protocol_command_seq),0)::text FROM fi.fix_applications WHERE sandbox_id=$1) AS protocol_application_watermark,
 (SELECT count(*)::integer FROM fi.fix_applications WHERE sandbox_id=$1) AS applied_work_count,
 (SELECT count(*)::integer FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.message_type<>'D' AND NOT EXISTS(SELECT 1 FROM fi.fix_work w WHERE w.sandbox_id=m.sandbox_id AND w.message_id=m.id AND (EXISTS(SELECT 1 FROM fi.fix_applications a WHERE a.sandbox_id=w.sandbox_id AND a.work_id=w.id) OR EXISTS(SELECT 1 FROM fi.fix_protocol_observations a WHERE a.sandbox_id=w.sandbox_id AND a.work_id=w.id)))) AS unresolved_message_count,
 false AS delivery_verified,false AS external_completeness_verified,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY code,record_id) FROM (SELECT DISTINCT code,record_id FROM issues ORDER BY code,record_id LIMIT 128) x),'[]'::jsonb) AS findings,
 (SELECT count(*)::integer FROM (SELECT DISTINCT code,record_id FROM issues) x) AS total_findings;
