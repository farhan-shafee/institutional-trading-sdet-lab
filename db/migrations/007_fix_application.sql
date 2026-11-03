-- Phase3B2: local, authenticated application only. No transport or financial kernel rewrite.
CREATE TABLE fi.fix_applications(
 sandbox_id uuid NOT NULL,work_id uuid NOT NULL,order_id uuid NOT NULL,message_id uuid NOT NULL,
 financial_key text NOT NULL,financial_command_id uuid NOT NULL,financial_command_seq bigint NOT NULL,
 financial_request_hash text NOT NULL CHECK(financial_request_hash ~ '^[a-f0-9]{64}$'),
 protocol_command_seq integer NOT NULL,applied_fence bigint NOT NULL,applied_generation bigint NOT NULL,
 result jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,work_id),UNIQUE(sandbox_id,financial_key),UNIQUE(sandbox_id,financial_command_id),
 FOREIGN KEY(sandbox_id,order_id,work_id) REFERENCES fi.fix_work(sandbox_id,order_id,id),
 FOREIGN KEY(sandbox_id,order_id,message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id),
 FOREIGN KEY(sandbox_id,work_id) REFERENCES fi.fix_prepared(sandbox_id,work_id),
 FOREIGN KEY(sandbox_id,financial_command_id,financial_command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq),
 FOREIGN KEY(sandbox_id,protocol_command_seq) REFERENCES fi.fix_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi.fix_consumptions(
 sandbox_id uuid NOT NULL,work_id uuid NOT NULL,order_id uuid NOT NULL,commands integer NOT NULL CHECK(commands=1),events integer NOT NULL CHECK(events IN (1,3)),
 PRIMARY KEY(sandbox_id,work_id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi_control.fix_reservations(sandbox_id,order_id),
 FOREIGN KEY(sandbox_id,work_id) REFERENCES fi.fix_applications(sandbox_id,work_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi.fix_protocol_observations(
 sandbox_id uuid NOT NULL,work_id uuid NOT NULL,order_id uuid NOT NULL,cancel_id uuid NOT NULL,
 financial_version bigint NOT NULL,filled_par numeric(12,2) NOT NULL,remaining_par numeric(12,2) NOT NULL,
 protocol_command_seq integer NOT NULL,applied_fence bigint NOT NULL,applied_generation bigint NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,work_id),FOREIGN KEY(sandbox_id,work_id) REFERENCES fi.fix_outcomes(sandbox_id,work_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(sandbox_id,order_id,cancel_id) REFERENCES fi.cancellation_requests(sandbox_id,order_id,id),
 FOREIGN KEY(sandbox_id,protocol_command_seq) REFERENCES fi.fix_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi.fix_unresolved_ingest(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,attempt_id uuid NOT NULL,raw_hash text NOT NULL CHECK(raw_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(reason IN ('FIX_PROFILE_UNSUPPORTED','FIX_CONTRACT_UNRESOLVED','FIX_CORRELATION_UNRESOLVED')),protocol_command_seq integer NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,attempt_id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id),
 FOREIGN KEY(sandbox_id,protocol_command_seq) REFERENCES fi.fix_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi_control.fix_apply_context(
 sandbox_id uuid NOT NULL,transaction_id xid8 NOT NULL,work_id uuid NOT NULL,financial_key text NOT NULL,operation text NOT NULL,request_hash text NOT NULL,
 PRIMARY KEY(sandbox_id,transaction_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['fix_applications','fix_consumptions','fix_protocol_observations','fix_unresolved_ingest'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING(sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING(true)',t);
 EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
 EXECUTE format('CREATE TRIGGER fix_immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);
 END LOOP;
END $$;
ALTER TABLE fi_control.fix_apply_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi_control.fix_apply_context FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON fi_control.fix_apply_context TO tf_owner USING(true) WITH CHECK(true);

-- Compact JSON in the exact OrderService envelope/property order; values are validated strings.
-- This is deliberately NOT SHA256(payload::text), the immutable prepared hash.
CREATE FUNCTION fi_control.fix_financial_hash(sid uuid,op text,p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE body text;
BEGIN
 body:='{"order_id":'||to_json(p->>'order_id')::text||',"expected_version":'||to_json(p->>'expected_version')::text;
 IF op='EXECUTE_ORDER' THEN body:=body||',"execution_id":'||to_json(p->>'execution_id')::text||',"source_event_id":'||to_json(p->>'source_event_id')::text||',"par_amount":'||to_json(p->>'par_amount')::text;
 ELSIF op IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN body:=body||',"cancel_id":'||to_json(p->>'cancel_id')::text;END IF;
 RETURN encode(sha256(convert_to('{"version":1,"method":"POST","operation":'||to_json(op)::text||',"sandbox_id":'||to_json(sid::text)::text||',"payload":'||body||'}}','UTF8')),'hex');
END $$;
CREATE OR REPLACE FUNCTION fi_control.reserve_command_key() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE domain_value text;
BEGIN
 PERFORM 1 FROM fi.sandboxes WHERE id=NEW.sandbox_id FOR UPDATE;
 SELECT domain INTO domain_value FROM fi_control.command_keys WHERE sandbox_id=NEW.sandbox_id AND idempotency_key=NEW.idempotency_key FOR UPDATE;
 IF FOUND THEN
 IF TG_TABLE_NAME='commands' AND domain_value='FIX_PREPARED' AND EXISTS(
 SELECT 1 FROM fi_control.fix_apply_context c JOIN fi.fix_prepared p ON(p.sandbox_id,p.work_id)=(c.sandbox_id,c.work_id)
 WHERE c.sandbox_id=NEW.sandbox_id AND c.transaction_id=pg_current_xact_id() AND c.financial_key=NEW.idempotency_key
 AND p.financial_key=c.financial_key AND p.operation=NEW.operation AND c.operation=NEW.operation AND c.request_hash=NEW.request_hash
 AND c.request_hash=fi_control.fix_financial_hash(p.sandbox_id,p.operation,p.payload)) THEN
 UPDATE fi_control.command_keys SET domain='FINANCIAL' WHERE sandbox_id=NEW.sandbox_id AND idempotency_key=NEW.idempotency_key;
 ELSE RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='IDEMPOTENCY_KEY_REUSED';END IF;
 ELSE INSERT INTO fi_control.command_keys VALUES(NEW.sandbox_id,NEW.idempotency_key,CASE TG_TABLE_NAME WHEN 'commands' THEN 'FINANCIAL' WHEN 'fix_commands' THEN 'FIX' ELSE 'RECONCILIATION' END);END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fi_control.protect_fix_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c integer;e integer;rotation boolean;headroom integer;
BEGIN
 IF NEW.command_count<=OLD.command_count AND NEW.event_count<=OLD.event_count THEN RETURN NEW;END IF;
 SELECT COALESCE(sum(r.commands-x.c),0),COALESCE(sum(r.events-x.e),0) INTO c,e FROM fi_control.fix_reservations r
 LEFT JOIN LATERAL(SELECT count(*)::integer c,COALESCE(sum(events),0)::integer e FROM fi.fix_consumptions WHERE sandbox_id=r.sandbox_id AND order_id=r.order_id) x ON true WHERE r.sandbox_id=NEW.id AND r.released_at IS NULL;
 IF c=0 AND e=0 THEN RETURN NEW;END IF;
 rotation:=EXISTS(SELECT 1 FROM fi_control.fix_writer_context WHERE sandbox_id=NEW.id AND transaction_id=pg_current_xact_id());
 -- Security slots are finite shared headroom, not a fresh two-slot charge after
 -- each rotation. Count real rotation receipts since the first active binding.
 SELECT greatest(2-count(*),0)::integer INTO headroom FROM fi.commands x WHERE x.sandbox_id=NEW.id AND x.operation='ROTATE_CAPABILITIES' AND x.created_at >= (SELECT min(b.created_at) FROM fi.fix_bindings b JOIN fi_control.fix_reservations r USING(sandbox_id,order_id) WHERE b.sandbox_id=NEW.id AND r.released_at IS NULL);
 IF NEW.command_count+c+(CASE WHEN rotation THEN 0 ELSE headroom END)>512 OR NEW.event_count+e+(CASE WHEN rotation THEN 0 ELSE headroom END)>1024 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='PROTECTED_FINANCIAL_CAPACITY';END IF;
 RETURN NEW;
END $$;
-- Preserve old metadata receipts/outcomes, include the new distinct completion source in ordering.
DO $patch$ DECLARE d text;old_text text:='NOT EXISTS(SELECT 1 FROM fi.fix_outcomes y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id)';BEGIN
 SELECT pg_get_functiondef('fi_control.fix_command(uuid,text,bigint,text,jsonb,text,uuid)'::regprocedure) INTO d;
 IF position(old_text IN d)=0 THEN RAISE EXCEPTION 'Unexpected foundation command body';END IF;
 EXECUTE replace(d,old_text,'('||old_text||' OR (x.operation=''PROTOCOL_ONLY'' AND NOT EXISTS(SELECT 1 FROM fi.fix_protocol_observations v WHERE v.sandbox_id=x.sandbox_id AND v.work_id=x.id))) AND NOT EXISTS(SELECT 1 FROM fi.fix_applications z WHERE z.sandbox_id=x.sandbox_id AND z.work_id=x.id)');
END $patch$;

-- No inference: validates the explicit event against the current authoritative state.
CREATE FUNCTION fi_control.fix_application_error(sid uuid,wid uuid) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE w fi.fix_work%ROWTYPE;m fi.fix_messages%ROWTYPE;b fi.fix_bindings%ROWTYPE;o fi.orders%ROWTYPE;l fi.order_states%ROWTYPE;f jsonb;pending boolean;expected_status text;cum numeric;leaves numeric;
BEGIN
 SELECT * INTO STRICT w FROM fi.fix_work WHERE sandbox_id=sid AND id=wid;
 SELECT * INTO STRICT m FROM fi.fix_messages WHERE sandbox_id=sid AND id=w.message_id;
 SELECT * INTO STRICT b FROM fi.fix_bindings WHERE sandbox_id=sid AND order_id=w.order_id;
 SELECT * INTO STRICT o FROM fi.orders WHERE sandbox_id=sid AND id=w.order_id;
 SELECT * INTO STRICT l FROM fi.order_states WHERE sandbox_id=sid AND order_id=w.order_id;
 f:=m.fields;
 IF b.contract_hash<>encode(sha256(convert_to(o.contract::text,'UTF8')),'hex') OR m.dealer_id<>b.dealer_id OR b.dealer_id<>o.contract->>'dealer_id'
 OR NOT COALESCE(fi_control.fix_terms_valid(f,o.contract||jsonb_build_object('order_id',o.id),b.dealer_id),false)
 OR NOT EXISTS(SELECT 1 FROM fi.fix_outbox x JOIN fi.fix_messages y ON(y.sandbox_id,y.id)=(x.sandbox_id,x.message_id) WHERE x.sandbox_id=sid AND x.order_id=o.id AND y.message_type='D')
 OR NOT EXISTS(SELECT 1 FROM fi.fix_dealer_correlations d WHERE d.sandbox_id=sid AND d.order_id=o.id AND d.dealer_id=b.dealer_id AND d.dealer_order_id=f->>'37') THEN RETURN 'FIX_CONTRACT_CORRELATION_UNRESOLVED';END IF;
 IF w.operation='REJECT_ORDER' AND f->>'103'='6' THEN RETURN 'FIX_DUPLICATE_ORDER_UNRESOLVED';END IF;
 IF w.operation='REJECT_ORDER' AND (f->>'103'<>'99' OR f->>'58' IS DISTINCT FROM 'SYNTHETIC_REJECTION') THEN RETURN 'FIX_REJECTION_REASON_UNRESOLVED';END IF;
 IF w.operation IN ('ACK_ORDER','REJECT_ORDER') AND l.status<>'PENDING_ACK' THEN RETURN 'FIX_STATE_UNRESOLVED';END IF;
 IF f ? '41' AND NOT EXISTS(SELECT 1 FROM fi.fix_cancel_correlations c WHERE c.sandbox_id=sid AND c.order_id=o.id AND c.cl_ord_id::text=f->>'11' AND c.orig_cl_ord_id=o.id) THEN RETURN 'FIX_CANCEL_UNRESOLVED';END IF;
 IF w.operation IN ('ACK_CANCEL','REJECT_CANCEL','PROTOCOL_ONLY') AND l.pending_cancel_id IS DISTINCT FROM (f->>'11')::uuid THEN RETURN 'FIX_CANCEL_UNRESOLVED';END IF;
 IF w.operation='REQUEST_CANCEL' AND (l.status NOT IN ('NEW','PARTIALLY_FILLED') OR l.pending_cancel_id IS NOT NULL OR (SELECT count(*) FROM fi.cancellation_requests WHERE sandbox_id=sid AND order_id=o.id)>=8) THEN RETURN 'FIX_CANCEL_UNRESOLVED';END IF;
 pending:=l.pending_cancel_id IS NOT NULL AND EXISTS(SELECT 1 FROM fi.fix_work x JOIN fi.fix_protocol_observations y ON(y.sandbox_id,y.work_id)=(x.sandbox_id,x.id) JOIN fi.fix_messages z ON(z.sandbox_id,z.id)=(x.sandbox_id,x.message_id) WHERE x.sandbox_id=sid AND x.order_id=o.id AND z.fields->>'150'='6' AND z.fields->>'11'=l.pending_cancel_id::text);
 IF w.operation='EXECUTE_ORDER' THEN
 IF l.status NOT IN ('NEW','PARTIALLY_FILLED') OR (f->>'32')::numeric>l.remaining_par OR l.execution_count>=8 OR (l.execution_count=7 AND (f->>'32')::numeric<>l.remaining_par) THEN RETURN 'FIX_FILL_UNRESOLVED';END IF;
 cum:=l.filled_par+(f->>'32')::numeric;leaves:=(o.contract->>'par_amount')::numeric-cum;
 expected_status:=CASE WHEN pending THEN '6' WHEN leaves=0 THEN '2' ELSE '1' END;
 IF (f->>'14')::numeric<>cum OR (f->>'151')::numeric<>leaves OR f->>'39'<>expected_status THEN RETURN 'FIX_TOTALS_UNRESOLVED';END IF;
 ELSIF w.operation='PROTOCOL_ONLY' THEN
 IF f->>'150'<>'6' OR l.status NOT IN ('NEW','PARTIALLY_FILLED') OR (f->>'14')::numeric<>l.filled_par OR (f->>'151')::numeric<>l.remaining_par THEN RETURN 'FIX_PENDING_CANCEL_UNRESOLVED';END IF;
 ELSIF w.operation='ACK_CANCEL' THEN
 IF l.status NOT IN ('NEW','PARTIALLY_FILLED') OR (f->>'14')::numeric<>l.filled_par OR (f->>'151')::numeric<>0 THEN RETURN 'FIX_CANCEL_UNRESOLVED';END IF;
 ELSIF w.operation='REJECT_CANCEL' THEN
 IF (f->>'102'='0' AND (l.status<>'FILLED' OR f->>'39'<>'2')) OR (f->>'102'='99' AND ((l.status='NEW' AND f->>'39'<>'0') OR (l.status='PARTIALLY_FILLED' AND f->>'39'<>'1') OR l.status NOT IN ('NEW','PARTIALLY_FILLED'))) THEN RETURN 'FIX_CANCEL_REJECT_UNRESOLVED';END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION fi_control.apply_fix(sid uuid,proof text,p_generation bigint,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;l fi.fix_lanes%ROWTYPE;w fi.fix_work%ROWTYPE;prepared fi.fix_prepared%ROWTYPE;a fi.fix_applications%ROWTYPE;r fi.fix_commands%ROWTYPE;c fi.commands%ROWTYPE;
 oid uuid;wid uuid;owner uuid;fence bigint;rh text;fh text;error_code text;seq integer;head uuid;result jsonb;body jsonb;event_count integer;before_version bigint;
BEGIN
 IF sid IS NULL OR proof IS NULL OR p_generation IS NULL OR actor IS NULL OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{8,128}$' OR p IS NULL OR jsonb_typeof(p)<>'object'
 OR (SELECT count(*) FROM jsonb_object_keys(p))<>4 OR NOT(p ?& ARRAY['order_id','owner_id','fence','work_id']) OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') OR p->>'fence' !~ '^[1-9][0-9]{0,15}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 oid:=(p->>'order_id')::uuid;wid:=(p->>'work_id')::uuid;owner:=(p->>'owner_id')::uuid;fence:=(p->>'fence')::bigint;
 p:=jsonb_build_object('order_id',oid,'owner_id',owner,'fence',fence::text,'work_id',wid);
 rh:=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',sid,'operation','APPLY','payload',p)::text,'UTF8')),'hex');
 PERFORM set_config('tradeflow.sandbox_id',sid::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=sid FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(sid,proof,'trade') OR s.generation IS DISTINCT FROM p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO r FROM fi.fix_commands WHERE sandbox_id=sid AND idempotency_key=key;
 IF FOUND THEN IF r.operation<>'APPLY' OR r.request_hash<>rh THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;RETURN fi_control.result(r.http_status,r.response_body,true);END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=sid AND idempotency_key=key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 SELECT * INTO l FROM fi.fix_lanes WHERE sandbox_id=sid AND order_id=oid FOR UPDATE;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_BINDING_NOT_FOUND');END IF;
 -- Confirmed outcomes may be recovered by current authorized owners without another economic action.
 SELECT * INTO a FROM fi.fix_applications WHERE sandbox_id=sid AND work_id=wid AND order_id=oid;
 IF FOUND THEN RETURN fi_control.result(200,a.result,true);END IF;
 IF clock_timestamp()>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 IF l.closed_at IS NOT NULL OR l.owner_id IS DISTINCT FROM owner OR l.actor_id IS DISTINCT FROM actor OR l.capability_generation IS DISTINCT FROM p_generation OR l.fence<>fence OR l.lease_expires_at<=clock_timestamp() THEN RETURN fi_control.failure(409,'FIX_STALE_FENCE');END IF;
 SELECT x.id INTO head FROM fi.fix_work x WHERE x.sandbox_id=sid AND x.order_id=oid AND (NOT EXISTS(SELECT 1 FROM fi.fix_outcomes y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id) OR (x.operation='PROTOCOL_ONLY' AND NOT EXISTS(SELECT 1 FROM fi.fix_protocol_observations v WHERE v.sandbox_id=x.sandbox_id AND v.work_id=x.id))) AND NOT EXISTS(SELECT 1 FROM fi.fix_applications y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id) ORDER BY lane_seq LIMIT 1;
 IF head IS DISTINCT FROM wid THEN RETURN fi_control.failure(409,'FIX_UNRESOLVED_HEAD');END IF;
 SELECT * INTO STRICT w FROM fi.fix_work WHERE sandbox_id=sid AND id=wid;
 SELECT * INTO prepared FROM fi.fix_prepared WHERE sandbox_id=sid AND work_id=wid AND order_id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(409,'FIX_NOT_PREPARED');END IF;
 PERFORM 1 FROM fi.order_states WHERE sandbox_id=sid AND order_id=oid FOR UPDATE;
 error_code:=fi_control.fix_application_error(sid,wid);IF error_code IS NOT NULL THEN RETURN fi_control.failure(409,error_code);END IF;
 SELECT version INTO before_version FROM fi.order_states WHERE sandbox_id=sid AND order_id=oid;
 IF prepared.operation<>w.operation OR prepared.payload->>'expected_version'<>before_version::text OR prepared.request_hash<>encode(sha256(convert_to(prepared.payload::text,'UTF8')),'hex') THEN RETURN fi_control.failure(409,'FIX_PREPARED_IDENTITY_UNRESOLVED');END IF;
 IF w.operation='PROTOCOL_ONLY' THEN
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=sid;
 IF seq>960 THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END IF;
 INSERT INTO fi.fix_outcomes(sandbox_id,work_id,outcome) VALUES(sid,wid,'METADATA_ONLY') ON CONFLICT DO NOTHING;
 INSERT INTO fi.fix_protocol_observations SELECT sid,wid,oid,pending_cancel_id,version,filled_par,remaining_par,seq,fence,p_generation,clock_timestamp() FROM fi.order_states WHERE sandbox_id=sid AND order_id=oid;
 body:=jsonb_build_object('order_id',oid,'work_id',wid,'financial_applied',false,'delivery_verified',false,'outcome','METADATA_ONLY','validated_pending_cancel',true);
 INSERT INTO fi.fix_commands VALUES(sid,gen_random_uuid(),key,'APPLY',rh,seq,200,body,actor);
 INSERT INTO fi.fix_events VALUES(sid,seq,0,'APPLY',oid,jsonb_build_object('financial_applied',false,'record',body),clock_timestamp());
 RETURN fi_control.result(200,body);END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_outcomes WHERE sandbox_id=sid AND work_id=wid) THEN RETURN fi_control.failure(409,'FIX_METADATA_ALREADY_FINAL');END IF;
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=sid;
 IF seq>960 THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END IF;
 event_count:=CASE w.operation WHEN 'EXECUTE_ORDER' THEN 3 ELSE 1 END;
 IF NOT EXISTS(SELECT 1 FROM fi_control.fix_reservations WHERE sandbox_id=sid AND order_id=oid AND released_at IS NULL) OR
 (SELECT count(*) FROM fi.fix_consumptions WHERE sandbox_id=sid AND order_id=oid)>=25 OR
 (SELECT COALESCE(sum(events),0) FROM fi.fix_consumptions WHERE sandbox_id=sid AND order_id=oid)+event_count>41 THEN RETURN fi_control.failure(429,'FIX_RESERVATION_EXHAUSTED');END IF;
 fh:=fi_control.fix_financial_hash(sid,prepared.operation,prepared.payload);
 IF NOT EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=sid AND idempotency_key=prepared.financial_key AND domain='FIX_PREPARED') THEN RETURN fi_control.failure(409,'FIX_KEY_PROMOTION_UNRESOLVED');END IF;
 INSERT INTO fi_control.fix_apply_context VALUES(sid,pg_current_xact_id(),wid,prepared.financial_key,prepared.operation,fh);
 INSERT INTO fi.fix_consumptions VALUES(sid,wid,oid,1,event_count);
 result:=fi_control.order_command_kernel(sid,proof,p_generation,prepared.operation,prepared.payload,fh,prepared.financial_key,actor);
 SELECT * INTO c FROM fi.commands WHERE sandbox_id=sid AND idempotency_key=prepared.financial_key;
 IF NOT FOUND OR c.result_kind<>'APPLIED' OR c.operation<>prepared.operation OR c.request_hash<>fh OR (result->>'status')::integer NOT IN (200,201)
 OR (SELECT version FROM fi.order_states WHERE sandbox_id=sid AND order_id=oid)<>before_version+1
 OR (SELECT count(*) FROM fi.audit_events WHERE sandbox_id=sid AND command_id=c.id)<>event_count THEN RAISE EXCEPTION USING ERRCODE='TF412',MESSAGE='FIX_FINANCIAL_EFFECT_UNRESOLVED';END IF;
 body:=jsonb_build_object('order_id',oid,'work_id',wid,'financial_applied',true,'delivery_verified',false,'financial_key',prepared.financial_key,'financial_command_id',c.id,'financial_command_seq',c.command_seq::text,'financial_result',result);
 INSERT INTO fi.fix_applications VALUES(sid,wid,oid,w.message_id,prepared.financial_key,c.id,c.command_seq,fh,seq,fence,p_generation,body,clock_timestamp());
 INSERT INTO fi.fix_commands VALUES(sid,gen_random_uuid(),key,'APPLY',rh,seq,200,body,actor);
 INSERT INTO fi.fix_events VALUES(sid,seq,0,'APPLY',oid,jsonb_build_object('financial_applied',true,'record',body),clock_timestamp());
 DELETE FROM fi_control.fix_apply_context WHERE sandbox_id=sid AND transaction_id=pg_current_xact_id();
 RETURN fi_control.result(200,body);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
 WHEN SQLSTATE 'TF412' THEN RETURN fi_control.failure(409,'FIX_FINANCIAL_EFFECT_UNRESOLVED');
 WHEN SQLSTATE 'TF409' OR unique_violation THEN RETURN fi_control.failure(409,'FIX_APPLICATION_CONFLICT');
 WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'PROTECTED_FINANCIAL_CAPACITY');END $$;
GRANT EXECUTE ON FUNCTION fi_control.apply_fix(uuid,text,bigint,jsonb,text,uuid) TO tf_app;

-- Commit-time proof: no reservation consumption without a committed APPLIED kernel effect,
-- and no FIX financial effect without protocol application and its immutable receipt.
CREATE FUNCTION fi_control.fix_application_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid:=NEW.sandbox_id;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=sid) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_consumptions x LEFT JOIN fi.fix_applications a USING(sandbox_id,work_id) LEFT JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id) WHERE x.sandbox_id=sid AND
 (a.work_id IS NULL OR a.order_id<>x.order_id OR c.id IS NULL OR c.result_kind<>'APPLIED' OR x.commands<>1 OR x.events<>CASE c.operation WHEN 'EXECUTE_ORDER' THEN 3 ELSE 1 END OR x.events<>(SELECT count(*) FROM fi.audit_events e WHERE e.sandbox_id=sid AND e.command_id=c.id))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='FIX capacity without financial effect';END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_applications a JOIN fi.fix_prepared p USING(sandbox_id,work_id) JOIN fi.fix_work w ON(w.sandbox_id,w.id)=(a.sandbox_id,a.work_id) JOIN fi.commands c ON(c.sandbox_id,c.id)=(a.sandbox_id,a.financial_command_id) WHERE a.sandbox_id=sid AND
 (a.order_id<>w.order_id OR a.message_id<>w.message_id OR a.financial_key<>p.financial_key OR p.operation<>w.operation OR c.operation<>p.operation OR c.idempotency_key<>p.financial_key OR c.command_seq<>a.financial_command_seq OR c.request_hash<>a.financial_request_hash OR c.request_hash<>fi_control.fix_financial_hash(sid,p.operation,p.payload)
 OR NOT EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE k.sandbox_id=sid AND k.idempotency_key=p.financial_key AND k.domain='FINANCIAL')
 OR NOT EXISTS(SELECT 1 FROM fi.fix_consumptions x WHERE x.sandbox_id=sid AND x.work_id=a.work_id)
 OR NOT EXISTS(SELECT 1 FROM fi.order_history h WHERE h.sandbox_id=sid AND h.order_id=a.order_id AND h.command_id=c.id AND h.operation=p.operation)
 OR EXISTS(SELECT 1 FROM fi.fix_outcomes x WHERE x.sandbox_id=sid AND x.work_id=a.work_id))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='FIX application reference inconsistent';END IF;
 IF TG_TABLE_NAME IN ('fix_applications','fix_protocol_observations') THEN IF NOT EXISTS(SELECT 1 FROM fi.fix_lanes l JOIN fi.sandboxes s ON s.id=l.sandbox_id WHERE l.sandbox_id=sid AND l.order_id=NEW.order_id AND l.fence=NEW.applied_fence AND l.capability_generation=NEW.applied_generation AND s.generation=NEW.applied_generation AND l.lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='FIX application fence expired before COMMIT';END IF;END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER application_integrity AFTER INSERT ON fi.fix_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.fix_application_integrity();
CREATE CONSTRAINT TRIGGER observation_integrity AFTER INSERT ON fi.fix_protocol_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.fix_application_integrity();
CREATE CONSTRAINT TRIGGER consumption_integrity AFTER INSERT ON fi.fix_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.fix_application_integrity();
-- Preserve cleanup locking/tombstones and remove application graph before parent metadata.
DO $patch$ DECLARE d text;BEGIN
 SELECT pg_get_functiondef('fi_control.purge_expired()'::regprocedure) INTO d;
 EXECUTE replace(d,'DELETE FROM fi_control.fix_writer_context WHERE sandbox_id=target;',
 'DELETE FROM fi.fix_unresolved_ingest WHERE sandbox_id=target; DELETE FROM fi.fix_protocol_observations WHERE sandbox_id=target; DELETE FROM fi_control.fix_apply_context WHERE sandbox_id=target; DELETE FROM fi.fix_consumptions WHERE sandbox_id=target; DELETE FROM fi.fix_applications WHERE sandbox_id=target; DELETE FROM fi_control.fix_writer_context WHERE sandbox_id=target;');
END $patch$;
-- Historical v1/schema5, v2/schema6 remain valid; v3 records exact schema7 coverage.
DO $copy$ DECLARE d text;BEGIN SELECT pg_get_functiondef('fi_control.valid_reconciliation_metadata(jsonb)'::regprocedure) INTO d;EXECUTE replace(d,'FUNCTION fi_control.valid_reconciliation_metadata(','FUNCTION fi_control.valid_reconciliation_metadata_v2(');END $copy$;
CREATE OR REPLACE FUNCTION fi_control.valid_reconciliation_metadata(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p->>'engine_version'<>'reconciliation-v3' THEN RETURN fi_control.valid_reconciliation_metadata_v2(p);END IF;
 IF p->>'schema_revision' IS DISTINCT FROM '7' OR jsonb_typeof(p->'schema_checksums') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'schema_checksums')<>7 THEN RETURN false;END IF;
 RETURN fi_control.valid_reconciliation_metadata_v2(p||jsonb_build_object('engine_version','reconciliation-v2','schema_revision',6,'schema_checksums',(p->'schema_checksums')-6));
END $$;

-- Untrusted/contradictory ingress retains only a hash and a fixed reason, never a
-- trusted message, financial identity, raw payload in errors or fabricated rejection.
CREATE FUNCTION fi_control.ingest_fix(sid uuid,proof text,p_generation bigint,p jsonb,key text,actor uuid,profile_valid boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;r fi.fix_commands%ROWTYPE;oid uuid;aid uuid;raw_hash text;rh text;body jsonb;result jsonb;reason text;seq integer;
BEGIN
 IF sid IS NULL OR proof IS NULL OR p_generation IS NULL OR actor IS NULL OR profile_valid IS NULL OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{8,128}$' OR p IS NULL OR jsonb_typeof(p)<>'object' OR NOT(p ?& ARRAY['order_id','attempt_id','raw_hex']) OR (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') OR octet_length(p->>'raw_hex') NOT BETWEEN 2 AND 16384 OR octet_length(p->>'raw_hex')%2<>0 OR p->>'raw_hex' !~ '^[a-f0-9]+$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 oid:=(p->>'order_id')::uuid;aid:=(p->>'attempt_id')::uuid;p:=p||jsonb_build_object('order_id',oid,'attempt_id',aid);
 raw_hash:=encode(sha256(decode(p->>'raw_hex','hex')),'hex');rh:=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',sid,'operation','INGEST_REJECTED','order_id',oid,'attempt_id',aid,'raw_hash',raw_hash)::text,'UTF8')),'hex');
 PERFORM set_config('tradeflow.sandbox_id',sid::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=sid FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(sid,proof,'trade') OR s.generation IS DISTINCT FROM p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO r FROM fi.fix_commands WHERE sandbox_id=sid AND idempotency_key=key;
 IF FOUND AND r.operation='INGEST_REJECTED' THEN IF r.request_hash<>rh THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;RETURN fi_control.result(r.http_status,r.response_body,true);END IF;
 IF profile_valid THEN result:=fi_control.fix_command(sid,proof,p_generation,'RECORD',p,key,actor);IF (result->>'status')::integer NOT IN (400,409) THEN RETURN result;END IF;END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=sid AND idempotency_key=key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_bindings WHERE sandbox_id=sid AND order_id=oid) THEN RETURN fi_control.failure(404,'FIX_BINDING_NOT_FOUND');END IF;
 IF clock_timestamp()>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=sid;
 IF seq>960 OR (SELECT count(*) FROM fi.fix_unresolved_ingest WHERE sandbox_id=sid AND order_id=oid)>=8 THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_unresolved_ingest WHERE sandbox_id=sid AND attempt_id=aid) THEN RETURN fi_control.failure(409,'FIX_ATTEMPT_CONFLICT');END IF;
 reason:=CASE WHEN NOT profile_valid THEN 'FIX_PROFILE_UNSUPPORTED' WHEN result->>'status'='400' THEN 'FIX_CONTRACT_UNRESOLVED' ELSE 'FIX_CORRELATION_UNRESOLVED' END;
 body:=jsonb_build_object('order_id',oid,'attempt_id',aid,'raw_hash',raw_hash,'reason',reason,'accepted',false,'unresolved',true,'financial_applied',false);
 INSERT INTO fi.fix_unresolved_ingest VALUES(sid,oid,aid,raw_hash,reason,seq,clock_timestamp());
 INSERT INTO fi.fix_commands VALUES(sid,gen_random_uuid(),key,'INGEST_REJECTED',rh,seq,200,body,actor);
 INSERT INTO fi.fix_events VALUES(sid,seq,0,'INGEST_REJECTED',oid,jsonb_build_object('financial_applied',false,'record',body),clock_timestamp());
 RETURN fi_control.result(200,body);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END $$;
GRANT EXECUTE ON FUNCTION fi_control.ingest_fix(uuid,text,bigint,jsonb,text,uuid,boolean) TO tf_app;
