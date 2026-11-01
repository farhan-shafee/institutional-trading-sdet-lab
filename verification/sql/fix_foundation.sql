-- Independent read-only metadata reconstruction. No financial helper/projection expected totals.
WITH bindings AS (SELECT b.*,o.contract,l.status,l.version FROM fi.fix_bindings b JOIN fi.orders o ON(o.sandbox_id,o.id)=(b.sandbox_id,b.order_id) JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(b.sandbox_id,b.order_id) WHERE b.sandbox_id=$1),
-- Invalid wire bytes become bounded findings before any text decoding.
wire_bytes AS MATERIALIZED (
 SELECT a.*,NOT EXISTS(SELECT 1 FROM generate_series(0,octet_length(a.raw_bytes)-1) g(i)
 WHERE get_byte(a.raw_bytes,g.i)<>1 AND get_byte(a.raw_bytes,g.i) NOT BETWEEN 32 AND 126) AS ascii_valid
 FROM fi.fix_attempts a WHERE a.sandbox_id=$1
),
wire_texts AS MATERIALIZED (
 SELECT a.*,CASE WHEN ascii_valid THEN convert_from(a.raw_bytes,'SQL_ASCII') ELSE '' END AS wire_text FROM wire_bytes a
),
wire_decoded AS MATERIALIZED (
 SELECT a.*,m.semantic_hash,COALESCE((SELECT jsonb_object_agg(split_part(part,'=',1),substring(part,length(split_part(part,'=',1))+2))
 FROM unnest(string_to_array(a.wire_text,chr(1))) part WHERE part<>''),'{}'::jsonb) AS decoded,string_to_array(a.wire_text,chr(1)) AS parts
 FROM wire_texts a JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
),
wire_evidence AS MATERIALIZED (
 SELECT a.*,encode(sha256(a.raw_bytes),'hex') AS computed_raw_hash,
 encode(sha256(convert_to((a.decoded-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') AS computed_semantic_hash
 FROM wire_decoded a
),
-- Compute the exact physical witness and original request once per attempt, before joining receipts.
record_graph AS MATERIALIZED (
 SELECT a.*,m.order_id,m.message_type,m.direction,
 b.channel_id,
 b.order_id IS NOT NULL AND ch.id IS NOT NULL AND ch.epoch=1 AND x.message_id IS NOT NULL
 AND a.raw_hash=a.computed_raw_hash AND m.semantic_hash=a.computed_semantic_hash
 AND a.decoded->>'35'=m.message_type
 AND m.direction=CASE WHEN a.decoded->>'35' IN('D','F') THEN 'OUT' ELSE 'IN' END
 AND a.state=CASE m.direction WHEN 'IN' THEN 'RECEIVED' ELSE 'STAGED' END AS evidence_valid,
 encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',a.sandbox_id,'operation','RECORD','payload',
 jsonb_build_object('order_id',m.order_id::text,'attempt_id',a.id::text,'raw_hex',encode(a.raw_bytes,'hex')))::text,'UTF8')),'hex') AS record_request_hash
 FROM wire_evidence a JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 LEFT JOIN fi.fix_bindings b ON b.sandbox_id=$1 AND (b.sandbox_id,b.order_id,b.dealer_id)=(m.sandbox_id,m.order_id,m.dealer_id)
 LEFT JOIN fi.fix_channels ch ON ch.sandbox_id=$1 AND (ch.sandbox_id,ch.id,ch.dealer_id)=(b.sandbox_id,b.channel_id,b.dealer_id)
 LEFT JOIN fi.fix_sequence_slots x ON x.sandbox_id=$1 AND x.sandbox_id=a.sandbox_id AND x.channel_id=b.channel_id AND x.message_id=m.id
 AND x.epoch=1 AND x.direction=m.direction AND x.message_seq::text=a.decoded->>'34'
),
sequence_evidence AS MATERIALIZED (
 SELECT a.sandbox_id,a.id AS attempt_id,a.message_id,b.channel_id,m.direction,a.decoded->>'34' AS message_seq
 FROM wire_evidence a
 JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 JOIN fi.fix_bindings b ON b.sandbox_id=$1 AND (b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id)
),
-- Inspect stored terms and each physical observation independently; agreement alone is insufficient.
-- Independently enumerate the bounded bilateral profile; no codec/database validator is called.
profile_rules(message_type,required,allowed) AS (
 VALUES
 ('D',ARRAY['11','55','167','54','854','38','40','59','423','44','15','64','60'],
 ARRAY['11','55','167','54','854','38','40','59','423','44','15','64','60','75']),
 ('8',ARRAY['37','17','150','39','11','55','167','54','854','38','40','59','423','44','15','64','14','151','6','60'],
 ARRAY['37','17','150','39','11','41','55','167','54','854','38','40','59','423','44','15','64','14','151','6','32','31','60','75','103','58']),
 ('F',ARRAY['11','41','37','55','167','54','60','38'],ARRAY['11','41','37','55','167','54','60','38','58']),
 ('9',ARRAY['37','11','41','39','434','102','60'],ARRAY['37','11','41','39','434','102','60','58'])
),
profile_evidence AS (
 SELECT m.id::text AS record_id,'MESSAGE_CONTRACT'::text AS code,m.message_type,m.fields AS f
 FROM fi.fix_messages m WHERE m.sandbox_id=$1
 UNION ALL SELECT a.id::text,'WIRE_PROFILE',m.message_type,a.decoded FROM wire_evidence a
 JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
),
profile_times AS (
 SELECT e.record_id,e.code,t.tag,
 t.value ~ '^[0-9]{8}-([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{3})?$'
 AND substring(t.value,1,4) BETWEEN '1900' AND '2199'
 AND pg_input_is_valid(substring(t.value,1,4)||'-'||substring(t.value,5,2)||'-'||substring(t.value,7,2)||'T'||substring(t.value,10)||'+00:00','timestamp with time zone') AS valid_time
 FROM profile_evidence e CROSS JOIN LATERAL(VALUES('52',e.f->>'52'),('60',e.f->>'60'),('122',e.f->>'122')) t(tag,value)
 WHERE t.tag IN('52','60') OR e.f ? '122'
),
message_evidence AS (
 SELECT m.sandbox_id,m.id AS message_id,m.order_id,m.dealer_id,m.message_type,m.direction,m.fields AS evidence
 FROM fi.fix_messages m WHERE m.sandbox_id=$1
 UNION ALL
 SELECT m.sandbox_id,m.id,m.order_id,m.dealer_id,m.message_type,m.direction,a.decoded
 FROM wire_evidence a JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 WHERE m.sandbox_id=$1
),
contract_evidence AS MATERIALIZED (
 SELECT e.*,o.id AS contract_order_id,o.contract,
 CASE WHEN jsonb_typeof(e.evidence)='object' THEN e.evidence ELSE '{}'::jsonb END AS f,
 CASE WHEN jsonb_typeof(e.evidence->'38')='string' AND e.evidence->>'38' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'38')::numeric END AS total_par,
 CASE WHEN jsonb_typeof(e.evidence->'14')='string' AND e.evidence->>'14' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'14')::numeric END AS cumulative_par,
 CASE WHEN jsonb_typeof(e.evidence->'151')='string' AND e.evidence->>'151' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'151')::numeric END AS leaves_par,
 CASE WHEN jsonb_typeof(e.evidence->'32')='string' AND e.evidence->>'32' ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (e.evidence->>'32')::numeric END AS last_par
 FROM message_evidence e LEFT JOIN fi.orders o ON(o.sandbox_id,o.id)=(e.sandbox_id,e.order_id)
),
-- Receipt references stay JSON/text; malformed JSON never reaches a UUID/numeric cast.
receipts AS MATERIALIZED (
 SELECT c.*,row_number() OVER(ORDER BY c.command_seq) AS command_ordinal,
 jsonb_typeof(c.response_body)='object' AS is_object,
 CASE WHEN jsonb_typeof(c.response_body)='object' THEN c.response_body ELSE '{}'::jsonb END AS body,
 CASE WHEN jsonb_typeof(c.response_body->'attempt_id')='string' THEN c.response_body->>'attempt_id' END AS attempt_ref,
 CASE WHEN jsonb_typeof(c.response_body->'message_id')='string' THEN c.response_body->>'message_id' END AS message_ref
 FROM fi.fix_commands c WHERE c.sandbox_id=$1
),
record_history AS MATERIALIZED (
 SELECT c.*,min(command_seq) OVER(PARTITION BY message_ref) AS first_message_seq,
 min(command_seq) OVER(PARTITION BY attempt_ref) AS first_attempt_seq
 FROM receipts c WHERE operation='RECORD'
),
-- First accepted RECORD sequence orders distinct physical observations; replays/reuse add no ordinal.
attempt_receipts AS MATERIALIZED (
 SELECT a.sandbox_id,a.id,a.message_id,min(c.command_seq) AS first_record_seq
 FROM fi.fix_attempts a LEFT JOIN receipts c ON c.sandbox_id=a.sandbox_id
 AND c.operation='RECORD' AND c.attempt_ref=a.id::text
 WHERE a.sandbox_id=$1 GROUP BY a.sandbox_id,a.id,a.message_id
),
attempt_order AS (
 SELECT a.*,row_number() OVER(PARTITION BY sandbox_id,message_id ORDER BY first_record_seq,id) AS receipt_ordinal,
 bool_and(first_record_seq IS NOT NULL) OVER(PARTITION BY sandbox_id,message_id) AS complete_history
 FROM attempt_receipts a
),
claims AS (
 SELECT c.*,row_number() OVER(PARTITION BY sandbox_id,body->>'order_id' ORDER BY command_seq) AS ordinal
 FROM receipts c WHERE operation='CLAIM'
),
control_context AS (
 SELECT c.*,b.order_id,b.channel_id,b.dealer_id,w.id AS work_id,w.message_id,w.lane_seq,w.operation AS work_operation,
 p.financial_key,p.payload AS prepared_payload,p.operation AS prepared_operation,
 o.work_id AS outcome_work_id,l.closed_at,r.released_at,
 h.id AS claim_id,h.actor_id AS claim_actor,h.body AS claim_body,h.ordinal AS claim_fence,
 q.ordinal AS own_claim_fence
 FROM receipts c
 LEFT JOIN fi.fix_bindings b ON b.sandbox_id=c.sandbox_id AND c.body->'order_id'=to_jsonb(b.order_id::text)
 LEFT JOIN fi.fix_work w ON w.sandbox_id=c.sandbox_id AND w.order_id=b.order_id AND c.body->'work_id'=to_jsonb(w.id::text)
 LEFT JOIN fi.fix_prepared p ON(p.sandbox_id,p.work_id,p.order_id)=(w.sandbox_id,w.id,w.order_id)
 LEFT JOIN fi.fix_outcomes o ON(o.sandbox_id,o.work_id)=(w.sandbox_id,w.id)
 LEFT JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(b.sandbox_id,b.order_id)
 LEFT JOIN fi_control.fix_reservations r ON(r.sandbox_id,r.order_id)=(b.sandbox_id,b.order_id)
 LEFT JOIN claims q ON(q.sandbox_id,q.id)=(c.sandbox_id,c.id)
 LEFT JOIN LATERAL(SELECT h.* FROM claims h WHERE c.operation IN('PREPARE','RESOLVE_METADATA') AND h.sandbox_id=c.sandbox_id
 AND h.body->'order_id'=to_jsonb(b.order_id::text) AND h.command_seq<c.command_seq ORDER BY h.command_seq DESC LIMIT 1) h ON true
),
control_expected AS (
 SELECT c.*,
 CASE c.operation
 WHEN 'BIND' THEN jsonb_build_object('order_id',order_id,'cl_ord_id',order_id,'dealer_order_id',NULL::text,'reserved_commands',25,'reserved_events',43,'financial_applied',false)
 WHEN 'CLAIM' THEN jsonb_build_object('order_id',order_id,'owner_id',body->'owner_id','fence',own_claim_fence::text,'lease_expires_at',body->'lease_expires_at')
 WHEN 'QUEUE' THEN jsonb_build_object('order_id',order_id,'work_id',work_id,'lane_seq',lane_seq,'operation',work_operation)
 WHEN 'PREPARE' THEN jsonb_build_object('order_id',order_id,'work_id',work_id,'financial_key',financial_key,'payload',prepared_payload,'operation',prepared_operation,'application_state','NOT_IMPLEMENTED','financial_applied',false)
 WHEN 'RESOLVE_METADATA' THEN jsonb_build_object('order_id',order_id,'work_id',work_id,'outcome','METADATA_ONLY','financial_applied',false)
 WHEN 'RELEASE' THEN jsonb_build_object('order_id',order_id,'released',true,'financial_applied',false) END AS expected_body,
 CASE c.operation
 WHEN 'BIND' THEN jsonb_build_object('order_id',order_id,'dealer_id',dealer_id,'channel_id',channel_id)
 WHEN 'CLAIM' THEN jsonb_build_object('order_id',order_id,'owner_id',body->'owner_id')
 WHEN 'QUEUE' THEN jsonb_build_object('order_id',order_id,'message_id',message_id,'work_id',work_id)
 WHEN 'PREPARE' THEN jsonb_build_object('order_id',order_id,'owner_id',claim_body->'owner_id','fence',claim_fence::text,'work_id',work_id,'financial_key',financial_key)
 WHEN 'RESOLVE_METADATA' THEN jsonb_build_object('order_id',order_id,'owner_id',claim_body->'owner_id','fence',claim_fence::text,'work_id',work_id)
 WHEN 'RELEASE' THEN jsonb_build_object('order_id',order_id) END AS expected_request,
 CASE c.operation
 WHEN 'BIND' THEN order_id IS NOT NULL
 WHEN 'CLAIM' THEN order_id IS NOT NULL AND jsonb_typeof(body->'owner_id')='string'
 AND body->>'owner_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND jsonb_typeof(body->'lease_expires_at')='string'
 AND body->>'lease_expires_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?[+-][0-9]{2}:[0-9]{2}$'
 AND CASE WHEN pg_input_is_valid(body->>'lease_expires_at','timestamp with time zone') THEN isfinite((body->>'lease_expires_at')::timestamptz) ELSE false END
 WHEN 'QUEUE' THEN work_id IS NOT NULL
 WHEN 'PREPARE' THEN work_id IS NOT NULL AND financial_key IS NOT NULL AND claim_id IS NOT NULL AND actor_id=claim_actor
 WHEN 'RESOLVE_METADATA' THEN outcome_work_id IS NOT NULL AND claim_id IS NOT NULL AND actor_id=claim_actor
 WHEN 'RELEASE' THEN order_id IS NOT NULL AND closed_at IS NOT NULL AND released_at IS NOT NULL
 ELSE false END AS effect_valid
 FROM control_context c WHERE operation<>'RECORD'
),
canonical_messages AS (
 SELECT m.*,CASE message_type WHEN 'D' THEN 'ORDER' WHEN 'F' THEN 'CANCEL' WHEN '8' THEN 'EXEC_REPORT' WHEN '9' THEN 'CANCEL_REJECT' END AS canonical_kind,
 CASE message_type WHEN '8' THEN fields->>'17' ELSE fields->>'11' END AS canonical_value
 FROM fi.fix_messages m WHERE sandbox_id=$1
),
lane_history AS (
 SELECT b.sandbox_id,b.order_id,
 (SELECT count(*) FROM receipts c WHERE c.body->'order_id'=to_jsonb(b.order_id::text) AND c.operation='CLAIM') AS claim_count,
 (SELECT count(*) FROM receipts c WHERE c.body->'order_id'=to_jsonb(b.order_id::text) AND c.operation='RELEASE') AS release_count,
 h.id AS claim_id,h.body AS claim_body,h.actor_id AS claim_actor
 FROM fi.fix_bindings b LEFT JOIN LATERAL(
 SELECT c.* FROM claims c WHERE c.sandbox_id=b.sandbox_id AND c.body->'order_id'=to_jsonb(b.order_id::text) ORDER BY c.command_seq DESC LIMIT 1) h ON true
 WHERE b.sandbox_id=$1
),
raw_issues AS (
 SELECT 'WIRE_FRAMING' code,a.id::text record_id FROM wire_evidence a WHERE
 NOT a.ascii_valid OR split_part(a.wire_text,chr(1),1)<>'8=FIX.4.4'
 OR split_part(a.wire_text,chr(1),2) !~ '^9=[1-9][0-9]{0,4}$'
 OR right(a.wire_text,7) !~ ('^10=[0-9]{3}'||chr(1)||'$')
 OR octet_length(a.raw_bytes) NOT BETWEEN 1 AND 8192 OR cardinality(a.parts) NOT BETWEEN 4 AND 65
 OR a.parts[cardinality(a.parts)] IS DISTINCT FROM '' OR a.parts[3] !~ '^35=[D8F9]$'
 OR EXISTS(SELECT 1 FROM unnest(a.parts[1:cardinality(a.parts)-1]) part
 WHERE part !~ '^[1-9][0-9]{0,4}=[ -~]+$' OR length(substring(part,position('=' IN part)+1))>256)
 OR (SELECT count(*) FROM unnest(a.parts[1:cardinality(a.parts)-1]) part)
 <>(SELECT count(DISTINCT split_part(part,'=',1)) FROM unnest(a.parts[1:cardinality(a.parts)-1]) part)
 OR a.parts[3:2+(SELECT count(*) FROM unnest(ARRAY['35','49','56','34','43','52','122']) h(tag) WHERE a.decoded ? h.tag)]
 IS DISTINCT FROM ARRAY(SELECT h.tag||'='||(a.decoded->>h.tag)
 FROM unnest(ARRAY['35','49','56','34','43','52','122']) WITH ORDINALITY h(tag,n) WHERE a.decoded ? h.tag ORDER BY h.n)
 OR (CASE WHEN a.decoded->>'9' ~ '^[1-9][0-9]{0,4}$' THEN (a.decoded->>'9')::integer ELSE -1 END)<>octet_length(a.raw_bytes)-7-length(split_part(a.wire_text,chr(1),1))-length(split_part(a.wire_text,chr(1),2))-2
 OR (CASE WHEN a.decoded->>'10' ~ '^[0-9]{3}$' THEN (a.decoded->>'10')::integer ELSE -1 END)<>(SELECT sum(get_byte(a.raw_bytes,g.i))%256 FROM generate_series(0,octet_length(a.raw_bytes)-8) g(i))
 UNION ALL SELECT 'WIRE_SEMANTICS' code,a.id::text record_id FROM wire_evidence a WHERE a.semantic_hash<>a.computed_semantic_hash
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
 -- Reverse existence starts from retained messages, not only surviving wire rows.
 UNION ALL SELECT 'MISSING_PHYSICAL_EVIDENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi.fix_attempts a WHERE a.sandbox_id=m.sandbox_id AND a.message_id=m.id)
 UNION ALL SELECT 'MESSAGE_SEQUENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi.fix_bindings b
 JOIN fi.fix_channels ch ON(ch.sandbox_id,ch.id,ch.dealer_id)=(b.sandbox_id,b.channel_id,b.dealer_id)
 JOIN fi.fix_sequence_slots x ON x.sandbox_id=b.sandbox_id AND x.channel_id=b.channel_id AND x.message_id=m.id AND x.epoch=ch.epoch AND x.direction=m.direction
 WHERE b.sandbox_id=m.sandbox_id AND b.order_id=m.order_id AND b.dealer_id=m.dealer_id AND ch.epoch=1)
 -- A receipt must retain its specific attempt, including when another attempt survives.
 -- A wrong message/attempt reference already fails this exact body; matching references use their receipt cohort.
 UNION ALL SELECT 'RECORD_EVIDENCE',c.id::text FROM record_history c
 LEFT JOIN record_graph a ON a.sandbox_id=c.sandbox_id AND a.id::text=c.attempt_ref
 WHERE NOT COALESCE(c.http_status=201 AND c.is_object AND a.evidence_valid
 AND c.request_hash=a.record_request_hash AND c.response_body=jsonb_build_object(
 'order_id',a.order_id,'message_id',a.message_id,'attempt_id',a.id,'semantic_hash',a.semantic_hash,
 'logical_duplicate',c.first_message_seq<c.command_seq,
 'physical_duplicate',c.first_attempt_seq<c.command_seq,
 'raw_hash',a.raw_hash,'financial_applied',false,'delivery_state','NOT_IMPLEMENTED'),false)
 UNION ALL SELECT 'MISSING_OUTBOX',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.direction='OUT' AND NOT EXISTS(SELECT 1 FROM fi.fix_outbox o WHERE o.sandbox_id=m.sandbox_id AND o.message_id=m.id AND o.order_id=m.order_id)
 UNION ALL SELECT 'OUTBOX_REFERENCE',o.message_id::text FROM fi.fix_outbox o WHERE o.sandbox_id=$1 AND (o.delivery_state IS DISTINCT FROM 'NOT_IMPLEMENTED' OR NOT EXISTS(SELECT 1 FROM fi.fix_messages m WHERE m.sandbox_id=o.sandbox_id AND m.id=o.message_id AND m.order_id=o.order_id AND m.direction='OUT'))
 UNION ALL SELECT 'LANE_SEQUENCE',w.id::text FROM fi.fix_work w WHERE w.sandbox_id=$1 AND w.lane_seq<>(SELECT count(*) FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<=w.lane_seq)
 UNION ALL SELECT 'PREPARED_NON_HEAD',p.work_id::text FROM fi.fix_prepared p JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id) WHERE p.sandbox_id=$1 AND EXISTS(SELECT 1 FROM fi.fix_work x WHERE x.sandbox_id=w.sandbox_id AND x.order_id=w.order_id AND x.lane_seq<w.lane_seq AND NOT EXISTS(SELECT 1 FROM fi.fix_outcomes o WHERE o.sandbox_id=x.sandbox_id AND o.work_id=x.id))
 UNION ALL SELECT 'UNAUTHORIZED_FINANCIAL_REFERENCE',o.work_id::text FROM fi.fix_outcomes o WHERE o.sandbox_id=$1 AND (o.outcome<>'METADATA_ONLY' OR o.financial_command_id IS NOT NULL OR o.financial_command_seq IS NOT NULL)
 UNION ALL SELECT 'PREPARED_FINGERPRINT',p.work_id::text FROM fi.fix_prepared p WHERE p.sandbox_id=$1 AND (p.request_hash<>encode(sha256(convert_to(p.payload::text,'UTF8')),'hex') OR p.payload->>'order_id'<>p.order_id::text OR NOT EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE k.sandbox_id=p.sandbox_id AND k.idempotency_key=p.financial_key AND k.domain='FIX_PREPARED'))
 UNION ALL SELECT 'CAPACITY_RESERVATION',b.order_id::text FROM bindings b JOIN fi.fix_lanes l USING(sandbox_id,order_id) LEFT JOIN fi_control.fix_reservations r USING(sandbox_id,order_id) WHERE r.order_id IS NULL OR r.commands<>25 OR r.events<>43 OR (r.released_at IS NOT NULL)<>(l.closed_at IS NOT NULL)
 UNION ALL SELECT 'PROTOCOL_AUDIT',c.id::text FROM receipts c
 CROSS JOIN LATERAL(SELECT count(*) AS event_count FROM fi.fix_events e
 WHERE e.sandbox_id=$1 AND e.command_seq=c.command_seq OFFSET 0) e
 WHERE c.command_seq<>c.command_ordinal OR e.event_count<>1

 UNION ALL SELECT 'DEALER_CORRELATION',d.order_id::text FROM fi.fix_dealer_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.message_type<>'8' OR m.direction<>'IN' OR m.order_id<>d.order_id OR m.dealer_id<>d.dealer_id OR m.fields->>'37' IS DISTINCT FROM d.dealer_order_id)
 UNION ALL SELECT 'DEALER_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '37' AND NOT EXISTS(SELECT 1 FROM fi.fix_dealer_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.dealer_id=m.dealer_id AND d.dealer_order_id=m.fields->>'37')
 UNION ALL SELECT 'CANCEL_CORRELATION',d.cl_ord_id::text FROM fi.fix_cancel_correlations d LEFT JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(d.sandbox_id,d.first_message_id) WHERE d.sandbox_id=$1 AND (m.id IS NULL OR m.order_id<>d.order_id OR m.fields->>'11' IS DISTINCT FROM d.cl_ord_id::text OR m.fields->>'41' IS DISTINCT FROM d.orig_cl_ord_id::text OR d.orig_cl_ord_id<>d.order_id)
 UNION ALL SELECT 'CANCEL_MESSAGE_REFERENCE',m.id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1 AND m.fields ? '41' AND NOT EXISTS(SELECT 1 FROM fi.fix_cancel_correlations d WHERE d.sandbox_id=m.sandbox_id AND d.order_id=m.order_id AND d.cl_ord_id::text=m.fields->>'11' AND d.orig_cl_ord_id::text=m.fields->>'41')
 UNION ALL SELECT 'SEQUENCE_CORRELATION',x.message_id::text FROM fi.fix_sequence_slots x WHERE x.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM sequence_evidence a WHERE a.sandbox_id=x.sandbox_id AND a.message_id=x.message_id
 AND a.channel_id=x.channel_id AND x.epoch=1 AND a.direction=x.direction AND a.message_seq=x.message_seq::text)
 UNION ALL SELECT 'MISSING_SEQUENCE',a.attempt_id::text FROM sequence_evidence a WHERE NOT EXISTS(
 SELECT 1 FROM fi.fix_sequence_slots x WHERE x.sandbox_id=a.sandbox_id AND x.message_id=a.message_id
 AND x.channel_id=a.channel_id AND x.direction=a.direction AND x.message_seq::text=a.message_seq)
 UNION ALL SELECT 'WORK_OPERATION',w.id::text FROM fi.fix_work w JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) WHERE w.sandbox_id=$1 AND w.operation IS DISTINCT FROM CASE m.message_type WHEN 'F' THEN 'REQUEST_CANCEL' WHEN '9' THEN 'REJECT_CANCEL' WHEN '8' THEN CASE m.fields->>'150' WHEN '0' THEN 'ACK_ORDER' WHEN '8' THEN 'REJECT_ORDER' WHEN 'F' THEN 'EXECUTE_ORDER' WHEN '4' THEN 'ACK_CANCEL' WHEN '6' THEN 'PROTOCOL_ONLY' END END
 UNION ALL SELECT 'PREPARED_REFERENCE',p.work_id::text FROM fi.fix_prepared p JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id) JOIN fi.fix_messages m ON(m.sandbox_id,m.id)=(w.sandbox_id,w.message_id) JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(p.sandbox_id,p.order_id) WHERE p.sandbox_id=$1 AND (p.operation<>w.operation OR p.prepared_fence>l.fence OR p.payload IS DISTINCT FROM (jsonb_build_object('order_id',w.order_id,'expected_version','1')||CASE WHEN w.operation='EXECUTE_ORDER' THEN jsonb_build_object('execution_id',m.execution_id,'source_event_id',m.source_event_id,'par_amount',m.fields->>'32') WHEN w.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN jsonb_build_object('cancel_id',m.fields->>'11') ELSE '{}'::jsonb END))
 UNION ALL SELECT 'OUTCOME_ELIGIBILITY',o.work_id::text FROM fi.fix_outcomes o JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(o.sandbox_id,o.work_id) WHERE o.sandbox_id=$1 AND (w.operation<>'PROTOCOL_ONLY' OR NOT EXISTS(SELECT 1 FROM fi.fix_prepared p WHERE p.sandbox_id=o.sandbox_id AND p.work_id=o.work_id))
 UNION ALL SELECT 'AUDIT_CORRESPONDENCE',c.id::text FROM fi.fix_commands c
 JOIN LATERAL(SELECT e.* FROM fi.fix_events e WHERE e.sandbox_id=$1 AND e.sandbox_id=c.sandbox_id
 AND e.command_seq=c.command_seq OFFSET 0) e ON true WHERE c.sandbox_id=$1 AND (
 e.event_type<>c.operation OR e.order_id::text IS DISTINCT FROM c.response_body->>'order_id'
 OR e.payload IS DISTINCT FROM jsonb_build_object('financial_applied',false,'record',CASE WHEN jsonb_typeof(c.response_body)='object' THEN c.response_body-'payload' ELSE NULL::jsonb END))
 -- Every accepted operation has its exact response/status and an independently reconstructed request fingerprint.
 UNION ALL SELECT CASE c.operation WHEN 'BIND' THEN 'BIND_EVIDENCE' WHEN 'CLAIM' THEN 'CLAIM_EVIDENCE'
 WHEN 'QUEUE' THEN 'QUEUE_EVIDENCE' WHEN 'PREPARE' THEN 'PREPARE_EVIDENCE'
 WHEN 'RESOLVE_METADATA' THEN 'RESOLVE_METADATA_EVIDENCE' WHEN 'RELEASE' THEN 'RELEASE_EVIDENCE' ELSE 'PROTOCOL_OPERATION' END,c.id::text
 FROM control_expected c WHERE NOT COALESCE(c.is_object AND c.effect_valid AND c.response_body=c.expected_body
 AND c.http_status=CASE WHEN c.operation IN('BIND','QUEUE','PREPARE') THEN 201 ELSE 200 END
 AND c.request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',c.sandbox_id,'operation',c.operation,'payload',c.expected_request)::text,'UTF8')),'hex'),false)
 UNION ALL SELECT 'BIND_GRAPH',b.order_id::text FROM fi.fix_bindings b WHERE b.sandbox_id=$1 AND (
 NOT EXISTS(SELECT 1 FROM fi.orders o WHERE(o.sandbox_id,o.id)=(b.sandbox_id,b.order_id))
 OR NOT EXISTS(SELECT 1 FROM fi.order_states o WHERE(o.sandbox_id,o.order_id)=(b.sandbox_id,b.order_id))
 OR NOT EXISTS(SELECT 1 FROM fi.fix_channels ch WHERE(ch.sandbox_id,ch.id,ch.dealer_id)=(b.sandbox_id,b.channel_id,b.dealer_id) AND ch.epoch=1)
 OR NOT EXISTS(SELECT 1 FROM fi.fix_lanes l WHERE(l.sandbox_id,l.order_id)=(b.sandbox_id,b.order_id))
 OR NOT EXISTS(SELECT 1 FROM fi_control.fix_reservations r WHERE(r.sandbox_id,r.order_id)=(b.sandbox_id,b.order_id)))
 UNION ALL SELECT 'BIND_GRAPH',l.order_id::text FROM fi.fix_lanes l WHERE l.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.fix_bindings b WHERE(b.sandbox_id,b.order_id)=(l.sandbox_id,l.order_id))
 UNION ALL SELECT 'BIND_GRAPH',r.order_id::text FROM fi_control.fix_reservations r WHERE r.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.fix_bindings b WHERE(b.sandbox_id,b.order_id)=(r.sandbox_id,r.order_id))
 UNION ALL SELECT 'BIND_GRAPH',ch.id::text FROM fi.fix_channels ch WHERE ch.sandbox_id=$1 AND NOT EXISTS(SELECT 1 FROM fi.fix_bindings b WHERE(b.sandbox_id,b.channel_id,b.dealer_id)=(ch.sandbox_id,ch.id,ch.dealer_id))
 UNION ALL SELECT 'MISSING_BIND_RECEIPT',b.order_id::text FROM fi.fix_bindings b WHERE b.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.operation='BIND' AND c.body->'order_id'=to_jsonb(b.order_id::text))
 UNION ALL SELECT 'MISSING_RECORD_RECEIPT',a.id::text FROM attempt_receipts a WHERE a.first_record_seq IS NULL
 UNION ALL SELECT 'MISSING_QUEUE_RECEIPT',w.id::text FROM fi.fix_work w WHERE w.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.operation='QUEUE' AND c.body->'work_id'=to_jsonb(w.id::text))
 UNION ALL SELECT 'MISSING_PREPARE_RECEIPT',p.work_id::text FROM fi.fix_prepared p WHERE p.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.operation='PREPARE' AND c.body->'work_id'=to_jsonb(p.work_id::text))
 UNION ALL SELECT 'MISSING_RESOLVE_RECEIPT',o.work_id::text FROM fi.fix_outcomes o WHERE o.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.operation='RESOLVE_METADATA' AND c.body->'work_id'=to_jsonb(o.work_id::text))
 UNION ALL SELECT 'MISSING_RELEASE_RECEIPT',l.order_id::text FROM fi.fix_lanes l
 LEFT JOIN fi_control.fix_reservations r ON(r.sandbox_id,r.order_id)=(l.sandbox_id,l.order_id)
 WHERE l.sandbox_id=$1 AND (l.closed_at IS NOT NULL OR r.released_at IS NOT NULL) AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.operation='RELEASE' AND c.body->'order_id'=to_jsonb(l.order_id::text))
 UNION ALL SELECT 'COMMAND_KEY',c.id::text FROM receipts c WHERE NOT EXISTS(
 SELECT 1 FROM fi_control.command_keys k WHERE(k.sandbox_id,k.idempotency_key,k.domain)=(c.sandbox_id,c.idempotency_key,'FIX'))
 UNION ALL SELECT 'COMMAND_KEY',k.idempotency_key FROM fi_control.command_keys k WHERE k.sandbox_id=$1 AND k.domain='FIX'
 AND NOT EXISTS(SELECT 1 FROM receipts c WHERE c.idempotency_key=k.idempotency_key)
 UNION ALL SELECT 'PREPARED_KEY',p.work_id::text FROM fi.fix_prepared p WHERE p.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi_control.command_keys k WHERE(k.sandbox_id,k.idempotency_key,k.domain)=(p.sandbox_id,p.financial_key,'FIX_PREPARED'))
 UNION ALL SELECT 'PREPARED_KEY',k.idempotency_key FROM fi_control.command_keys k WHERE k.sandbox_id=$1 AND k.domain='FIX_PREPARED'
 AND NOT EXISTS(SELECT 1 FROM fi.fix_prepared p WHERE(p.sandbox_id,p.financial_key)=(k.sandbox_id,k.idempotency_key))
 UNION ALL SELECT 'ORPHAN_PROTOCOL_EVENT',e.command_seq::text FROM fi.fix_events e WHERE e.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM receipts c WHERE c.command_seq=e.command_seq)
 UNION ALL SELECT 'LANE_LINEAGE',l.order_id::text FROM fi.fix_lanes l JOIN lane_history h USING(sandbox_id,order_id)
 JOIN fi.sandboxes s ON s.id=l.sandbox_id WHERE l.fence<>h.claim_count+h.release_count
 OR (h.claim_id IS NULL AND (l.owner_id IS NOT NULL OR l.actor_id IS NOT NULL OR l.capability_generation IS NOT NULL OR l.lease_expires_at IS NOT NULL))
 OR (h.claim_id IS NOT NULL AND NOT COALESCE(
 to_jsonb(l.owner_id::text)=h.claim_body->'owner_id' AND l.actor_id=h.claim_actor
 AND l.capability_generation BETWEEN 1 AND s.generation AND l.lease_expires_at IS NOT NULL
 AND l.lease_expires_at=CASE WHEN pg_input_is_valid(h.claim_body->>'lease_expires_at','timestamp with time zone') THEN (h.claim_body->>'lease_expires_at')::timestamptz END,false))
 UNION ALL SELECT 'LANE_RETIREMENT',l.order_id::text FROM fi.fix_lanes l JOIN lane_history h USING(sandbox_id,order_id)
 LEFT JOIN fi_control.fix_reservations r USING(sandbox_id,order_id) WHERE l.sandbox_id=$1
 AND (l.closed_at IS NOT NULL OR r.released_at IS NOT NULL OR h.release_count>0) AND (
 l.closed_at IS NULL OR r.released_at IS NULL OR h.release_count<>1 OR l.lease_expires_at>l.closed_at
 OR EXISTS(SELECT 1 FROM fi.fix_messages m WHERE(m.sandbox_id,m.order_id)=(l.sandbox_id,l.order_id))
 OR EXISTS(SELECT 1 FROM receipts c JOIN receipts x ON x.operation='RELEASE'
 AND x.body->'order_id'=to_jsonb(l.order_id::text) WHERE c.body->'order_id'=to_jsonb(l.order_id::text) AND c.command_seq>x.command_seq))
 UNION ALL SELECT 'MESSAGE_IDENTITY',m.id::text FROM canonical_messages m
 WHERE m.identity_kind IS DISTINCT FROM m.canonical_kind OR m.identity_value IS DISTINCT FROM m.canonical_value
 UNION ALL SELECT 'DUPLICATE_MESSAGE_IDENTITY',m.id::text FROM canonical_messages m WHERE EXISTS(
 SELECT 1 FROM canonical_messages x WHERE x.id<>m.id AND(x.dealer_id,x.canonical_kind,x.canonical_value)=(m.dealer_id,m.canonical_kind,m.canonical_value))
 UNION ALL SELECT 'ATTEMPT_SEQUENCE',a.id::text FROM fi.fix_attempts a
 LEFT JOIN attempt_order h ON(h.sandbox_id,h.id)=(a.sandbox_id,a.id) WHERE a.sandbox_id=$1 AND (
 a.attempt_no<>(SELECT count(*) FROM fi.fix_attempts x WHERE(x.sandbox_id,x.message_id)=(a.sandbox_id,a.message_id) AND x.attempt_no<=a.attempt_no)
 OR (h.complete_history AND a.attempt_no<>h.receipt_ordinal)
 OR NOT EXISTS(SELECT 1 FROM fi.fix_messages m WHERE(m.sandbox_id,m.id)=(a.sandbox_id,a.message_id) AND a.state=CASE m.direction WHEN 'IN' THEN 'RECEIVED' ELSE 'STAGED' END))
 UNION ALL SELECT 'WORK_REFERENCE',w.id::text FROM fi.fix_work w WHERE w.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi.fix_messages m WHERE(m.sandbox_id,m.id,m.order_id)=(w.sandbox_id,w.message_id,w.order_id) AND m.message_type<>'D')
 -- CLAIM does not retain historical generation. Check positive/current bounds without inventing cross-stream time order.
 UNION ALL SELECT 'PREPARED_LINEAGE',p.work_id::text FROM fi.fix_prepared p JOIN fi.sandboxes s ON s.id=p.sandbox_id
 LEFT JOIN fi.fix_lanes l ON(l.sandbox_id,l.order_id)=(p.sandbox_id,p.order_id)
 WHERE p.sandbox_id=$1 AND (p.prepared_generation NOT BETWEEN 1 AND s.generation OR p.prepared_generation>l.capability_generation OR (p.prepared_fence=l.fence AND p.prepared_generation IS DISTINCT FROM l.capability_generation) OR p.prepared_fence<=0 OR p.prepared_fence>l.fence
 OR EXISTS(SELECT 1 FROM control_expected c WHERE c.operation='PREPARE' AND c.body->'work_id'=to_jsonb(p.work_id::text)
 AND(c.claim_id IS NULL OR p.prepared_fence IS DISTINCT FROM c.claim_fence OR c.actor_id IS DISTINCT FROM c.claim_actor)))
 UNION ALL SELECT DISTINCT 'PREPARED_ORDERING',p.work_id::text FROM fi.fix_prepared p
 JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(p.sandbox_id,p.work_id)
 JOIN receipts c ON c.operation='PREPARE' AND c.body->'work_id'=to_jsonb(p.work_id::text)
 WHERE p.sandbox_id=$1 AND (
 NOT EXISTS(SELECT 1 FROM receipts q WHERE q.operation='QUEUE' AND q.body->'work_id'=to_jsonb(w.id::text) AND q.command_seq<c.command_seq)
 OR EXISTS(SELECT 1 FROM fi.fix_work x WHERE(x.sandbox_id,x.order_id)=(w.sandbox_id,w.order_id) AND x.lane_seq<w.lane_seq
 AND NOT EXISTS(SELECT 1 FROM receipts r JOIN fi.fix_outcomes o ON o.sandbox_id=r.sandbox_id AND r.body->'work_id'=to_jsonb(o.work_id::text)
 WHERE r.operation='RESOLVE_METADATA' AND o.work_id=x.id AND r.command_seq<c.command_seq)))
 UNION ALL SELECT 'DUPLICATE_EFFECT_RECEIPT',c.id::text FROM receipts c
 WHERE c.operation IN('BIND','QUEUE','PREPARE','RESOLVE_METADATA','RELEASE') AND (
 SELECT count(*) FROM receipts x WHERE x.operation=c.operation
 AND CASE WHEN c.operation IN('BIND','RELEASE') THEN x.body->'order_id'=c.body->'order_id' ELSE x.body->'work_id'=c.body->'work_id' END)>1
 UNION ALL SELECT 'OPERATION_ORDERING',c.id::text FROM control_context c WHERE c.operation<>'BIND' AND c.order_id IS NOT NULL AND (
 NOT EXISTS(SELECT 1 FROM receipts b WHERE b.operation='BIND' AND b.body->'order_id'=c.body->'order_id' AND b.command_seq<c.command_seq)
 OR (c.operation='QUEUE' AND c.work_id IS NOT NULL AND (
 c.lane_seq<>(SELECT count(*) FROM receipts q WHERE q.operation='QUEUE' AND q.body->'order_id'=c.body->'order_id' AND q.command_seq<=c.command_seq)
 OR NOT EXISTS(SELECT 1 FROM receipts r WHERE r.operation='RECORD' AND r.body->'message_id'=to_jsonb(c.message_id::text) AND r.command_seq<c.command_seq)))
 OR (c.operation='RESOLVE_METADATA' AND c.work_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM receipts p WHERE p.operation='PREPARE' AND p.body->'work_id'=to_jsonb(c.work_id::text) AND p.body->'order_id'=c.body->'order_id' AND p.command_seq<c.command_seq)))
 UNION ALL SELECT 'PROTOCOL_OPERATION',c.id::text FROM receipts c WHERE c.operation<>'CLAIM' AND c.command_seq>960
 UNION ALL SELECT 'PREPARED_REFERENCE',p.work_id::text FROM fi.fix_prepared p WHERE p.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi.fix_work w JOIN fi.fix_messages m ON(m.sandbox_id,m.id,m.order_id)=(w.sandbox_id,w.message_id,w.order_id)
 WHERE(w.sandbox_id,w.id,w.order_id)=(p.sandbox_id,p.work_id,p.order_id))
 UNION ALL SELECT 'OUTCOME_ELIGIBILITY',o.work_id::text FROM fi.fix_outcomes o WHERE o.sandbox_id=$1 AND NOT EXISTS(
 SELECT 1 FROM fi.fix_work w JOIN fi.fix_prepared p ON(p.sandbox_id,p.work_id,p.order_id)=(w.sandbox_id,w.id,w.order_id)
 WHERE(w.sandbox_id,w.id)=(o.sandbox_id,o.work_id) AND w.operation='PROTOCOL_ONLY')
 -- Stored fields belong to the first physical observation; later retransmission headers may differ.
 UNION ALL SELECT 'MESSAGE_FIELDS',m.id::text FROM fi.fix_messages m JOIN wire_evidence a
 ON(a.sandbox_id,a.message_id)=(m.sandbox_id,m.id) AND a.attempt_no=1
 WHERE m.sandbox_id=$1 AND m.fields IS DISTINCT FROM a.decoded
 -- A correlation belongs to its first retained RECORD observation, not an arbitrary later matching message.
 UNION ALL SELECT 'DEALER_CORRELATION',d.order_id::text FROM fi.fix_dealer_correlations d WHERE d.sandbox_id=$1
 AND d.first_message_id <> (
 SELECT m.id FROM fi.fix_messages m JOIN receipts c ON c.operation='RECORD' AND c.message_ref=m.id::text
 WHERE(m.sandbox_id,m.order_id,m.dealer_id)=(d.sandbox_id,d.order_id,d.dealer_id) AND m.fields->>'37'=d.dealer_order_id
 ORDER BY c.command_seq LIMIT 1)
 UNION ALL SELECT 'CANCEL_CORRELATION',d.cl_ord_id::text FROM fi.fix_cancel_correlations d WHERE d.sandbox_id=$1
 AND d.first_message_id <> (
 SELECT m.id FROM fi.fix_messages m JOIN receipts c ON c.operation='RECORD' AND c.message_ref=m.id::text
 WHERE(m.sandbox_id,m.order_id)=(d.sandbox_id,d.order_id) AND m.fields->>'11'=d.cl_ord_id::text AND m.fields->>'41'=d.orig_cl_ord_id::text
 ORDER BY c.command_seq LIMIT 1)
 -- Admission bounds remain independently visible even when a complete graph was forged coherently.
 UNION ALL SELECT 'PROTOCOL_CAPACITY',s.id::text FROM fi.sandboxes s WHERE s.id=$1 AND (
 (SELECT count(*) FROM fi.fix_bindings b WHERE b.sandbox_id=s.id)>4
 OR (SELECT count(*) FROM fi.commands c WHERE c.sandbox_id=s.id)
  +COALESCE((SELECT sum(r.commands) FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL),0)>512
 OR (SELECT count(*) FROM fi.audit_events e WHERE e.sandbox_id=s.id)
  +COALESCE((SELECT sum(r.events) FROM fi_control.fix_reservations r WHERE r.sandbox_id=s.id AND r.released_at IS NULL),0)>1024)
 UNION ALL SELECT 'PROTOCOL_CAPACITY',m.order_id::text FROM fi.fix_messages m WHERE m.sandbox_id=$1
 GROUP BY m.order_id HAVING count(*)>40
 -- A later PossDup observation retains the original first observation's time, including first-observed PossDup.
 UNION ALL SELECT 'RETRANSMISSION_EVIDENCE',a.id::text FROM wire_evidence a
 JOIN fi.fix_messages m ON m.sandbox_id=$1 AND (m.sandbox_id,m.id)=(a.sandbox_id,a.message_id)
 WHERE a.attempt_no>1 AND a.decoded->>'43'='Y'
 AND a.decoded->>'122' IS DISTINCT FROM COALESCE(m.fields->>'122',m.fields->>'52')
 -- Header values, required/allowed business fields and event dates are checked on every observation.
 UNION ALL SELECT e.code,e.record_id FROM profile_evidence e JOIN profile_rules r USING(message_type)
 WHERE NOT COALESCE(jsonb_typeof(e.f)='object' AND e.f->>'35'=e.message_type
 AND e.f ?& (ARRAY['8','9','10','35','49','56','34','52']||r.required)
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(e.f) f WHERE jsonb_typeof(f.value)<>'string'
 OR NOT f.key=ANY(ARRAY['8','9','10','35','49','56','34','43','52','122']||r.allowed))
 AND CASE WHEN e.f->>'34' ~ '^[1-9][0-9]{0,9}$' THEN (e.f->>'34')::bigint BETWEEN 1 AND 2147483647 ELSE false END
 AND (NOT(e.f ? '43') OR e.f->>'43' IN('Y','N'))
 AND CASE WHEN e.f->>'43'='Y' THEN e.f ? '122' AND rpad(e.f->>'122',21,'.000')<=rpad(e.f->>'52',21,'.000') ELSE NOT(e.f ? '122') END
 AND (NOT(e.f ? '75') OR (e.f->>'75' ~ '^[0-9]{8}$' AND e.f->>'75'=substring(e.f->>'60',1,8)))
 AND (NOT(e.f ? '58') OR e.f->>'58' IN('SYNTHETIC_REJECTION','SYNTHETIC_CANCEL_REJECT','SYNTHETIC_CANCEL_REQUEST')),false)
 UNION ALL SELECT code,record_id FROM profile_times WHERE NOT COALESCE(valid_time,false)
 UNION ALL SELECT 'MANUAL_FIX_WRITER',c.id::text FROM fi.commands c JOIN fi.fix_bindings b ON(b.sandbox_id,b.order_id::text)=(c.sandbox_id,c.response_body->>'order_id') WHERE c.sandbox_id=$1 AND c.created_at>b.created_at AND c.operation IN ('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL')
),
issues AS (SELECT DISTINCT code,record_id FROM raw_issues)
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
