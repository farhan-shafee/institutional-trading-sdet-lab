-- Phase 2C additive ledger. fi.orders and migrations 001--003 stay immutable.
ALTER TABLE fi.commands DROP CONSTRAINT commands_operation_check;
ALTER TABLE fi.commands ADD CHECK(operation IN ('CREATE_SANDBOX','ROTATE_CAPABILITIES','CREATE_RFQ','RESPOND_DEALER','WITHDRAW_QUOTE','ACCEPT_QUOTE','ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL'));
ALTER TABLE fi.audit_events DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE fi.audit_events ADD CHECK(event_type IN ('SANDBOX_CREATED','CAPABILITIES_ROTATED','COMMAND_REJECTED','RFQ_CREATED','DEALER_RESPONDED','DEALER_DECLINED','QUOTE_PUBLISHED','QUOTE_WITHDRAWN','RFQ_EXPIRED','QUOTE_ACCEPTED','RFQ_ACCEPTED','ORDER_CREATED','ORDER_ACKNOWLEDGED','ORDER_REJECTED','EXECUTION_RECORDED','ORDER_STATE_CHANGED','POSITION_UPDATED','EXECUTION_DUPLICATE','CANCEL_REQUESTED','CANCEL_ACKNOWLEDGED','CANCEL_REJECTED'));

-- Integer division/remainder: no approximate numeric division at a cent boundary.
CREATE FUNCTION fi_control.half_even(p_n numeric,p_d numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q numeric; r numeric;
BEGIN
 IF p_n<0 OR p_d<=0 OR trunc(p_n)<>p_n OR trunc(p_d)<>p_d THEN RAISE EXCEPTION 'Invalid positive rational'; END IF;
 q:=div(p_n,p_d); r:=mod(p_n,p_d);
 IF 2*r>p_d OR (2*r=p_d AND mod(q,2)=1) THEN q:=q+1; END IF;
 RETURN q::bigint;
END $$;
-- Approved regular Jan15/Jul15 coupons; explicit contract validation prevents drift.
CREATE FUNCTION fi_control.execution_accrual(p_contract jsonb) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d date:=(p_contract->>'settlement_date')::date; y integer; previous date; following date; elapsed integer; period integer;
BEGIN
 IF p_contract->>'valuation_model_version' IS DISTINCT FROM 'phase1-regular-coupon-v1'
 OR p_contract->>'financial_source' IS DISTINCT FROM '6016fb700840d081fe1fba651c918f0a7e709383'
 OR p_contract->'instrument_terms' IS DISTINCT FROM jsonb_build_object('currency','USD','dated_date','2025-01-15','first_coupon_date','2025-07-15','maturity_date','2031-01-15','coupon_rate','0.04','frequency',2,'day_count',CASE p_contract->>'instrument_revision' WHEN 'phase1-ust-1' THEN 'ACT_ACT_ICMA' WHEN 'phase1-corp-1' THEN 'THIRTY_360_US' END)
 OR d<DATE '2025-01-15' OR d>=DATE '2031-01-15' THEN RAISE EXCEPTION 'Unsupported frozen financial contract'; END IF;
 y:=extract(year FROM d)::integer;
 previous:=CASE WHEN d<make_date(y,1,15) THEN make_date(y-1,7,15) WHEN d<make_date(y,7,15) THEN make_date(y,1,15) ELSE make_date(y,7,15) END;
 following:=(previous+interval '6 months')::date;
 IF p_contract->'instrument_terms'->>'day_count'='ACT_ACT_ICMA' THEN elapsed:=d-previous; period:=following-previous;
 ELSE
 -- US 30/360: coupon starts on 15, so February-EOM/conditional-31st start adjustments cannot apply.
 elapsed:=360*(extract(year FROM d)::int-extract(year FROM previous)::int)+30*(extract(month FROM d)::int-extract(month FROM previous)::int)+extract(day FROM d)::int-15;
 period:=180;
 END IF;
 RETURN ARRAY[elapsed,period];
END $$;
CREATE FUNCTION fi_control.execution_cents(p_contract jsonb,p_par numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a integer[]:=fi_control.execution_accrual(p_contract); n numeric; d numeric;
BEGIN
 -- cents = par * (clean per100 + accrued per100). Par has two exact places.
 n:=(p_par*100)*((p_contract->>'clean_price')::numeric*1000000000000*a[2]+2*a[1]*1000000000000);
 d:=100*1000000000000::numeric*a[2];
 RETURN fi_control.half_even(n,d);
END $$;
CREATE TABLE fi.order_states (
 sandbox_id uuid NOT NULL, order_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING_ACK','NEW','REJECTED','PARTIALLY_FILLED','FILLED','CANCELED')),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 512),
 filled_par numeric(12,2) NOT NULL CHECK(filled_par>=0), remaining_par numeric(12,2) NOT NULL CHECK(remaining_par>=0),
 executed_cents bigint NOT NULL CHECK(executed_cents>=0), execution_count integer NOT NULL CHECK(execution_count BETWEEN 0 AND 8),
 pending_cancel_id uuid, decided_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,order_id), FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.orders(sandbox_id,id)
);
CREATE TABLE fi.cancellation_requests (
 sandbox_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, request_sequence integer NOT NULL CHECK(request_sequence BETWEEN 1 AND 8),
 command_id uuid NOT NULL, command_seq bigint NOT NULL, decided_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id), UNIQUE(sandbox_id,order_id,id), UNIQUE(sandbox_id,order_id,request_sequence),
 FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.orders(sandbox_id,id),
 FOREIGN KEY(sandbox_id,command_id,command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi.cancellation_outcomes (
 sandbox_id uuid NOT NULL, cancel_id uuid NOT NULL, order_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('ACKNOWLEDGED','REJECTED')), reason text NOT NULL CHECK(reason IN ('CANCELED_REMAINDER','SIMULATED_REJECTION','TOO_LATE')),
 command_id uuid NOT NULL, command_seq bigint NOT NULL, decided_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,cancel_id), FOREIGN KEY(sandbox_id,order_id,cancel_id) REFERENCES fi.cancellation_requests(sandbox_id,order_id,id),
 FOREIGN KEY(sandbox_id,command_id,command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE fi.order_states ADD FOREIGN KEY(sandbox_id,order_id,pending_cancel_id) REFERENCES fi.cancellation_requests(sandbox_id,order_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE fi.executions (
 sandbox_id uuid NOT NULL, id uuid NOT NULL, source_event_id uuid NOT NULL, order_id uuid NOT NULL,
 fill_sequence integer NOT NULL CHECK(fill_sequence BETWEEN 1 AND 8), par_amount numeric(12,2) NOT NULL CHECK(par_amount BETWEEN 0.01 AND 1000000000),
 clean_price text NOT NULL CHECK(clean_price ~ '^[0-9]{1,5}\.[0-9]{12}$'), instrument_revision text NOT NULL REFERENCES fi.instrument_versions(id),
 settlement_date date NOT NULL, side text NOT NULL CHECK(side IN ('BUY','SELL')),
 accrual_elapsed integer NOT NULL CHECK(accrual_elapsed>=0), accrual_period integer NOT NULL CHECK(accrual_period>0),
 consideration_cents bigint NOT NULL CHECK(consideration_cents>0),
 command_id uuid NOT NULL, command_seq bigint NOT NULL, event_index integer NOT NULL DEFAULT 0 CHECK(event_index=0),
 decided_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id), UNIQUE(sandbox_id,source_event_id), UNIQUE(sandbox_id,order_id,fill_sequence),
 FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.orders(sandbox_id,id),
 FOREIGN KEY(sandbox_id,command_id,command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(sandbox_id,command_seq,event_index) REFERENCES fi.audit_events(sandbox_id,command_seq,event_index) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fi.positions (
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id), instrument_revision text NOT NULL REFERENCES fi.instrument_versions(id),
 signed_par numeric(14,2) NOT NULL, signed_cash_cents bigint NOT NULL, execution_count integer NOT NULL CHECK(execution_count BETWEEN 1 AND 400),
 last_command_seq bigint NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(sandbox_id,instrument_revision)
);
CREATE TABLE fi.order_history (
 sandbox_id uuid NOT NULL, order_id uuid NOT NULL, version bigint NOT NULL, operation text NOT NULL,
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=2048),
 command_id uuid, command_seq bigint, decided_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,order_id,version), FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.orders(sandbox_id,id),
 FOREIGN KEY(sandbox_id,command_id,command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED,
 CHECK((version=1 AND operation='CONTRACT_CREATED' AND command_id IS NULL AND command_seq IS NULL) OR (version>1 AND command_id IS NOT NULL AND command_seq IS NOT NULL AND operation IN ('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL')))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['order_states','cancellation_requests','cancellation_outcomes','executions','positions','order_history'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING(sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING(true)',t);
 EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['executions','cancellation_requests','cancellation_outcomes','order_history'] LOOP
 EXECUTE format('CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);
 END LOOP;
END $$;
CREATE FUNCTION fi_control.lifecycle_body(p_sandbox uuid,p_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',status,'version',version::text,'filled_par',filled_par::text,'remaining_par',remaining_par::text,'executed_cents',executed_cents::text,'execution_count',execution_count,'pending_cancel_id',pending_cancel_id,'decided_at',to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recorded_at',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM fi.order_states WHERE sandbox_id=p_sandbox AND order_id=p_order
$$;
CREATE FUNCTION fi_control.initialize_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO fi.order_states VALUES(NEW.sandbox_id,NEW.id,'PENDING_ACK',1,0,(NEW.contract->>'par_amount')::numeric,0,0,NULL,NEW.created_at,NEW.created_at);
 INSERT INTO fi.order_history(sandbox_id,order_id,version,operation,state,decided_at,recorded_at) VALUES(NEW.sandbox_id,NEW.id,1,'CONTRACT_CREATED',fi_control.lifecycle_body(NEW.sandbox_id,NEW.id),NEW.created_at,NEW.created_at);
 RETURN NEW;
END $$;
CREATE TRIGGER initialize_lifecycle AFTER INSERT ON fi.orders FOR EACH ROW EXECUTE FUNCTION fi_control.initialize_order();
INSERT INTO fi.order_states SELECT sandbox_id,id,'PENDING_ACK',1,0,(contract->>'par_amount')::numeric,0,0,NULL,created_at,created_at FROM fi.orders;
INSERT INTO fi.order_history(sandbox_id,order_id,version,operation,state,decided_at,recorded_at) SELECT sandbox_id,order_id,1,'CONTRACT_CREATED',fi_control.lifecycle_body(sandbox_id,order_id),decided_at,recorded_at FROM fi.order_states;

CREATE FUNCTION fi_control.execution_body(p_sandbox uuid,p_execution uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT to_jsonb(e)-'sandbox_id'-'decided_at'-'recorded_at' || jsonb_build_object('par_amount',par_amount::text,'consideration_cents',consideration_cents::text,'command_seq',command_seq::text,'decided_at',to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recorded_at',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM fi.executions e WHERE sandbox_id=p_sandbox AND id=p_execution
$$;
CREATE FUNCTION fi_control.cancel_body(p_sandbox uuid,p_cancel uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'order_id',r.order_id,'request_sequence',r.request_sequence,'state',COALESCE(o.outcome,'PENDING'),'reason',o.reason,'command_id',r.command_id,'command_seq',r.command_seq::text,'decided_at',to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'outcome_command_id',o.command_id,'outcome_command_seq',o.command_seq::text) FROM fi.cancellation_requests r LEFT JOIN fi.cancellation_outcomes o ON (o.sandbox_id,o.cancel_id)=(r.sandbox_id,r.id) WHERE r.sandbox_id=p_sandbox AND r.id=p_cancel
$$;
CREATE FUNCTION fi_control.order_response(p_sandbox uuid,p_order uuid,p_execution uuid DEFAULT NULL,p_cancel uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('order_id',p_order,'lifecycle',fi_control.lifecycle_body(p_sandbox,p_order)) || CASE WHEN p_execution IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('execution',fi_control.execution_body(p_sandbox,p_execution)) END || CASE WHEN p_cancel IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cancellation',fi_control.cancel_body(p_sandbox,p_cancel)) END
$$;

CREATE FUNCTION fi_control.order_command(p_id uuid,p_proof text,p_generation bigint,p_action text,p jsonb,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; o fi.orders%ROWTYPE; l fi.order_states%ROWTYPE; e fi.executions%ROWTYPE; receipt fi.commands%ROWTYPE;
 allowed text[]; oid uuid; eid uuid; source uuid; cancel uuid; quantity numeric; cash bigint; accrual integer[];
 decided timestamptz; cid uuid:=gen_random_uuid(); seq bigint; failure text; events jsonb; body jsonb; status integer:=200; event_type text; reason text; request_count integer;
BEGIN
 IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_action IS NULL OR p IS NULL OR jsonb_typeof(p)<>'object' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p_actor IS NULL THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 allowed:=CASE WHEN p_action IN ('ACK_ORDER','REJECT_ORDER') THEN ARRAY['order_id','expected_version'] WHEN p_action='EXECUTE_ORDER' THEN ARRAY['order_id','expected_version','execution_id','source_event_id','par_amount'] WHEN p_action IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN ARRAY['order_id','expected_version','cancel_id'] END;
 IF allowed IS NULL OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(allowed) OR NOT(p ?& allowed) OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE value='null'::jsonb) OR p->>'expected_version' !~ '^[1-9][0-9]{0,2}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 oid:=(p->>'order_id')::uuid;
 IF p_action='EXECUTE_ORDER' THEN
 eid:=(p->>'execution_id')::uuid; source:=(p->>'source_event_id')::uuid;
 IF p->>'par_amount' !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 quantity:=(p->>'par_amount')::numeric; IF quantity NOT BETWEEN 0.01 AND 1000000000 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 ELSIF p_action IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN cancel:=(p->>'cancel_id')::uuid; END IF;
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
 SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 SELECT * INTO receipt FROM fi.commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF FOUND THEN
 IF receipt.operation<>p_action OR receipt.request_hash<>p_hash THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED'); END IF;
 RETURN fi_control.result(receipt.http_status,receipt.response_body,true); END IF;
 SELECT * INTO o FROM fi.orders WHERE sandbox_id=p_id AND id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'ORDER_NOT_FOUND'); END IF;
 SELECT * INTO STRICT l FROM fi.order_states WHERE sandbox_id=p_id AND order_id=oid FOR UPDATE;
 decided:=clock_timestamp(); seq:=s.commit_seq+1;
 IF decided>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED'); END IF;
 IF s.command_count>=512 OR s.event_count+3>1024 THEN RETURN fi_control.failure(429,'SANDBOX_QUOTA_REACHED'); END IF;
 IF p_action='EXECUTE_ORDER' THEN
 SELECT * INTO e FROM fi.executions WHERE sandbox_id=p_id AND source_event_id=source;
 IF FOUND THEN
 IF e.id<>eid OR e.order_id<>oid OR e.par_amount<>quantity THEN failure:='SOURCE_EVENT_CONFLICT';
 ELSE
 body:=fi_control.order_response(p_id,oid,e.id);
 RETURN fi_control.record_rfq_command(p_id,p_key,p_hash,p_action,200,body,jsonb_build_array(jsonb_build_object('type','EXECUTION_DUPLICATE','version',l.version::text,'payload',jsonb_build_object('order_id',oid,'execution_id',e.id))),p_actor,decided);
 END IF;
 ELSIF EXISTS(SELECT 1 FROM fi.executions WHERE sandbox_id=p_id AND id=eid) THEN failure:='EXECUTION_ID_CONFLICT'; END IF;
 END IF;
 IF failure IS NULL THEN
 IF l.version<>(p->>'expected_version')::bigint THEN failure:='ORDER_VERSION_CONFLICT';
 ELSIF p_action IN ('ACK_ORDER','REJECT_ORDER') AND l.status<>'PENDING_ACK' THEN failure:='ORDER_NOT_PENDING_ACK';
 ELSIF p_action IN ('EXECUTE_ORDER','REQUEST_CANCEL') AND l.status NOT IN ('NEW','PARTIALLY_FILLED') THEN failure:='ORDER_NOT_EXECUTABLE';
 ELSIF p_action='EXECUTE_ORDER' AND quantity>l.remaining_par THEN failure:='FILL_EXCEEDS_REMAINING';
 ELSIF p_action='EXECUTE_ORDER' AND (l.execution_count>=8 OR (l.execution_count=7 AND quantity<>l.remaining_par)) THEN failure:='FILL_LIMIT_REQUIRES_REMAINDER';
 ELSIF p_action='REQUEST_CANCEL' AND l.pending_cancel_id IS NOT NULL THEN failure:='CANCEL_ALREADY_PENDING';
 ELSIF p_action='REQUEST_CANCEL' AND EXISTS(SELECT 1 FROM fi.cancellation_requests WHERE sandbox_id=p_id AND id=cancel) THEN failure:='CANCEL_ID_CONFLICT';
 ELSIF p_action='REQUEST_CANCEL' AND (SELECT count(*) FROM fi.cancellation_requests WHERE sandbox_id=p_id AND order_id=oid)>=8 THEN failure:='CANCEL_REQUEST_LIMIT';
 ELSIF p_action IN ('ACK_CANCEL','REJECT_CANCEL') AND l.pending_cancel_id IS DISTINCT FROM cancel THEN failure:='CANCEL_NOT_PENDING';
 END IF; END IF;
 IF failure IS NOT NULL THEN
 RETURN fi_control.record_rfq_command(p_id,p_key,p_hash,p_action,409,fi_control.failure(409,failure)->'body',jsonb_build_array(jsonb_build_object('type','COMMAND_REJECTED','payload',jsonb_build_object('order_id',oid,'code',failure))),p_actor,decided);
 END IF;
 l.version:=l.version+1; l.decided_at:=decided; l.recorded_at:=clock_timestamp();
 IF p_action='ACK_ORDER' THEN l.status:='NEW'; event_type:='ORDER_ACKNOWLEDGED';
 ELSIF p_action='REJECT_ORDER' THEN l.status:='REJECTED';l.remaining_par:=0;event_type:='ORDER_REJECTED';
 ELSIF p_action='EXECUTE_ORDER' THEN
 cash:=fi_control.execution_cents(o.contract,quantity); accrual:=fi_control.execution_accrual(o.contract);
 INSERT INTO fi.executions(sandbox_id,id,source_event_id,order_id,fill_sequence,par_amount,clean_price,instrument_revision,settlement_date,side,accrual_elapsed,accrual_period,consideration_cents,command_id,command_seq,decided_at)
 VALUES(p_id,eid,source,oid,l.execution_count+1,quantity,o.contract->>'clean_price',o.contract->>'instrument_revision',(o.contract->>'settlement_date')::date,o.contract->>'side',accrual[1],accrual[2],cash,cid,seq,decided);
 l.filled_par:=l.filled_par+quantity;l.remaining_par:=l.remaining_par-quantity;l.executed_cents:=l.executed_cents+cash;l.execution_count:=l.execution_count+1;l.status:=CASE WHEN l.remaining_par=0 THEN 'FILLED' ELSE 'PARTIALLY_FILLED' END;
 INSERT INTO fi.positions VALUES(p_id,o.contract->>'instrument_revision',CASE WHEN o.contract->>'side'='BUY' THEN quantity ELSE -quantity END,CASE WHEN o.contract->>'side'='BUY' THEN -cash ELSE cash END,1,seq,decided)
 ON CONFLICT(sandbox_id,instrument_revision) DO UPDATE SET signed_par=fi.positions.signed_par+EXCLUDED.signed_par,signed_cash_cents=fi.positions.signed_cash_cents+EXCLUDED.signed_cash_cents,execution_count=fi.positions.execution_count+1,last_command_seq=seq,updated_at=decided;
 event_type:='EXECUTION_RECORDED';status:=201;
 ELSIF p_action='REQUEST_CANCEL' THEN
 SELECT count(*)+1 INTO request_count FROM fi.cancellation_requests WHERE sandbox_id=p_id AND order_id=oid;
 INSERT INTO fi.cancellation_requests(sandbox_id,id,order_id,request_sequence,command_id,command_seq,decided_at) VALUES(p_id,cancel,oid,request_count,cid,seq,decided);
 l.pending_cancel_id:=cancel;event_type:='CANCEL_REQUESTED';status:=201;
 ELSE
 IF p_action='ACK_CANCEL' AND l.status<>'FILLED' THEN
 l.status:='CANCELED';l.remaining_par:=0;reason:='CANCELED_REMAINDER';event_type:='CANCEL_ACKNOWLEDGED';
 ELSE reason:=CASE WHEN l.status='FILLED' THEN 'TOO_LATE' ELSE 'SIMULATED_REJECTION' END;event_type:='CANCEL_REJECTED'; END IF;
 INSERT INTO fi.cancellation_outcomes(sandbox_id,cancel_id,order_id,outcome,reason,command_id,command_seq,decided_at) VALUES(p_id,cancel,oid,CASE WHEN reason='CANCELED_REMAINDER' THEN 'ACKNOWLEDGED' ELSE 'REJECTED' END,reason,cid,seq,decided);
 l.pending_cancel_id:=NULL;
 END IF;
 UPDATE fi.order_states SET status=l.status,version=l.version,filled_par=l.filled_par,remaining_par=l.remaining_par,executed_cents=l.executed_cents,execution_count=l.execution_count,pending_cancel_id=l.pending_cancel_id,decided_at=l.decided_at,recorded_at=l.recorded_at WHERE sandbox_id=p_id AND order_id=oid;
 INSERT INTO fi.order_history VALUES(p_id,oid,l.version,p_action,fi_control.lifecycle_body(p_id,oid),cid,seq,decided,clock_timestamp());
 events:=jsonb_build_array(jsonb_build_object('type',event_type,'version',l.version::text,'payload',jsonb_strip_nulls(jsonb_build_object('order_id',oid,'execution_id',CASE WHEN p_action='EXECUTE_ORDER' THEN eid END,'cancel_id',cancel))));
 IF p_action='EXECUTE_ORDER' THEN events:=events||jsonb_build_array(jsonb_build_object('type','ORDER_STATE_CHANGED','version',l.version::text,'payload',jsonb_build_object('order_id',oid)),jsonb_build_object('type','POSITION_UPDATED','version',l.version::text,'payload',jsonb_build_object('order_id',oid,'instrument_revision',o.contract->>'instrument_revision'))); END IF;
 body:=fi_control.order_response(p_id,oid,CASE WHEN p_action='EXECUTE_ORDER' THEN eid END,cancel);
 UPDATE fi.sandboxes SET command_count=command_count+1,commit_seq=seq,event_count=event_count+jsonb_array_length(events) WHERE id=p_id;
 INSERT INTO fi.commands(sandbox_id,id,idempotency_key,operation,request_hash,command_seq,result_kind,http_status,response_body) VALUES(p_id,cid,p_key,p_action,p_hash,seq,'APPLIED',status,body);
 FOR request_count IN 0..jsonb_array_length(events)-1 LOOP
 INSERT INTO fi.audit_events(sandbox_id,command_id,command_seq,event_index,event_type,aggregate_version,actor_id,decided_at,payload) VALUES(p_id,cid,seq,request_count,events->request_count->>'type',l.version,p_actor,decided,events->request_count->'payload');
 END LOOP;
 RETURN fi_control.result(status,body);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid) TO tf_app;

-- Deferred integrity reconstructs financial totals and validates frozen execution terms.
CREATE FUNCTION fi_control.execution_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid:=NEW.sandbox_id;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=sid) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM fi.orders o LEFT JOIN fi.order_states l ON (l.sandbox_id,l.order_id)=(o.sandbox_id,o.id)
 LEFT JOIN LATERAL(SELECT COALESCE(sum(par_amount),0) par,COALESCE(sum(consideration_cents),0) cash,count(*) n FROM fi.executions WHERE sandbox_id=o.sandbox_id AND order_id=o.id) e ON true
 WHERE o.sandbox_id=sid AND (l.order_id IS NULL OR l.filled_par<>e.par OR l.executed_cents<>e.cash OR l.execution_count<>e.n OR l.filled_par>(o.contract->>'par_amount')::numeric
 OR l.remaining_par<>CASE WHEN l.status IN ('CANCELED','REJECTED') THEN 0 ELSE (o.contract->>'par_amount')::numeric-l.filled_par END
 OR (l.status='FILLED') IS DISTINCT FROM (l.filled_par=(o.contract->>'par_amount')::numeric)
 OR (l.status='PARTIALLY_FILLED' AND l.filled_par=0) OR (l.status IN ('PENDING_ACK','NEW','REJECTED') AND l.filled_par<>0)
 OR (SELECT count(*) FROM fi.order_history WHERE sandbox_id=sid AND order_id=o.id)<>l.version
 OR (SELECT state FROM fi.order_history WHERE sandbox_id=sid AND order_id=o.id AND version=l.version) IS DISTINCT FROM fi_control.lifecycle_body(sid,o.id)
 OR (l.pending_cancel_id IS NOT NULL AND EXISTS(SELECT 1 FROM fi.cancellation_outcomes WHERE sandbox_id=sid AND cancel_id=l.pending_cancel_id)))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Execution lifecycle projection inconsistent'; END IF;
 IF EXISTS(SELECT 1 FROM fi.executions e JOIN fi.orders o ON(o.sandbox_id,o.id)=(e.sandbox_id,e.order_id)
 LEFT JOIN fi.audit_events a ON(a.sandbox_id,a.command_seq,a.event_index)=(e.sandbox_id,e.command_seq,e.event_index)
 WHERE e.sandbox_id=sid AND (e.clean_price IS DISTINCT FROM o.contract->>'clean_price' OR e.instrument_revision IS DISTINCT FROM o.contract->>'instrument_revision'
 OR e.settlement_date IS DISTINCT FROM (o.contract->>'settlement_date')::date OR e.side IS DISTINCT FROM o.contract->>'side'
 OR e.consideration_cents<>fi_control.execution_cents(o.contract,e.par_amount)
 OR ARRAY[e.accrual_elapsed,e.accrual_period] IS DISTINCT FROM fi_control.execution_accrual(o.contract)
 OR e.fill_sequence<>(SELECT count(*) FROM fi.executions x WHERE x.sandbox_id=sid AND x.order_id=e.order_id AND x.fill_sequence<=e.fill_sequence)
 OR a.event_type IS DISTINCT FROM 'EXECUTION_RECORDED' OR a.command_id IS DISTINCT FROM e.command_id
 OR a.payload->>'execution_id' IS DISTINCT FROM e.id::text OR a.payload->>'order_id' IS DISTINCT FROM e.order_id::text)) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Frozen execution inconsistent'; END IF;
 IF EXISTS(WITH ledger AS(SELECT instrument_revision,sum(CASE side WHEN 'BUY' THEN par_amount ELSE -par_amount END) par,sum(CASE side WHEN 'BUY' THEN -consideration_cents ELSE consideration_cents END) cash,count(*) n,max(command_seq) seq FROM fi.executions WHERE sandbox_id=sid GROUP BY instrument_revision)
 SELECT 1 FROM ledger e FULL JOIN (SELECT * FROM fi.positions WHERE sandbox_id=sid) p USING(instrument_revision)
 WHERE p.sandbox_id IS NULL OR e.n IS NULL OR p.signed_par IS DISTINCT FROM e.par OR p.signed_cash_cents IS DISTINCT FROM e.cash OR p.execution_count IS DISTINCT FROM e.n OR p.last_command_seq IS DISTINCT FROM e.seq) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Execution position projection inconsistent'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['order_states','executions','positions','order_history','cancellation_requests','cancellation_outcomes'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER execution_integrity AFTER INSERT OR UPDATE ON fi.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.execution_consistent()',t);
 END LOOP;
END $$;
CREATE FUNCTION fi_control.lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.sandbox_id<>OLD.sandbox_id OR NEW.order_id<>OLD.order_id OR NEW.version<>OLD.version+1 OR NEW.decided_at<OLD.decided_at
 OR OLD.status IN ('CANCELED','REJECTED') OR (OLD.status='FILLED' AND (NEW.status<>'FILLED' OR OLD.pending_cancel_id IS NULL OR NEW.pending_cancel_id IS NOT NULL))
 OR (OLD.status='PENDING_ACK' AND NEW.status NOT IN ('NEW','REJECTED'))
 OR (OLD.status IN ('NEW','PARTIALLY_FILLED') AND NEW.status NOT IN ('NEW','PARTIALLY_FILLED','FILLED','CANCELED'))
 OR NEW.filled_par<OLD.filled_par OR NEW.executed_cents<OLD.executed_cents OR NEW.execution_count<OLD.execution_count THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid lifecycle transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER controlled_lifecycle BEFORE UPDATE ON fi.order_states FOR EACH ROW EXECUTE FUNCTION fi_control.lifecycle_guard();
CREATE FUNCTION fi_control.read_orders(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_order uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE body jsonb;
BEGIN
 IF NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 IF p_order IS NULL THEN
 SELECT jsonb_build_object('orders',COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'rfq_id',o.rfq_id,'lifecycle',fi_control.lifecycle_body(p_id,o.id)) ORDER BY o.created_at,o.id),'[]'::jsonb)) INTO body FROM fi.orders o WHERE o.sandbox_id=p_id;
 ELSE
 SELECT jsonb_build_object('order',jsonb_build_object('id',o.id,'rfq_id',o.rfq_id,'quote_id',o.quote_id,'status',o.status,'contract',o.contract,'created_at',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
 'lifecycle',fi_control.lifecycle_body(p_id,o.id),
 'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',version::text,'operation',operation,'state',state,'command_id',command_id,'command_seq',command_seq::text,'decided_at',to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY version) FROM fi.order_history WHERE sandbox_id=p_id AND order_id=o.id),'[]'::jsonb),
 'executions',COALESCE((SELECT jsonb_agg(fi_control.execution_body(p_id,id) ORDER BY fill_sequence) FROM fi.executions WHERE sandbox_id=p_id AND order_id=o.id),'[]'::jsonb),
 'cancellations',COALESCE((SELECT jsonb_agg(fi_control.cancel_body(p_id,id) ORDER BY request_sequence) FROM fi.cancellation_requests WHERE sandbox_id=p_id AND order_id=o.id),'[]'::jsonb)) INTO body FROM fi.orders o WHERE o.sandbox_id=p_id AND o.id=p_order;
 IF body IS NULL THEN RETURN fi_control.failure(404,'ORDER_NOT_FOUND'); END IF;
 END IF;
 RETURN fi_control.result(200,body);
END $$;
CREATE FUNCTION fi_control.read_positions(p_id uuid,p_proof text,p_scope text,p_generation bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE body jsonb;
BEGIN
 IF NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 SELECT jsonb_build_object('positions',COALESCE(jsonb_agg(jsonb_build_object('instrument_revision',p.instrument_revision,'instrument_id',iv.instrument_id,'signed_par',signed_par::text,'signed_cash_cents',signed_cash_cents::text,'execution_count',execution_count,'last_command_seq',last_command_seq::text,'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY p.instrument_revision),'[]'::jsonb)) INTO body FROM fi.positions p JOIN fi.instrument_versions iv ON iv.id=p.instrument_revision WHERE p.sandbox_id=p_id;
 RETURN fi_control.result(200,body);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_orders(uuid,text,text,bigint,uuid),fi_control.read_positions(uuid,text,text,bigint) TO tf_app;
CREATE OR REPLACE FUNCTION fi_control.purge_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE target uuid; removed integer:=0;
BEGIN
 PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
 FOR target IN SELECT id FROM fi.sandboxes WHERE retained_until<=clock_timestamp() ORDER BY id FOR UPDATE LOOP
 INSERT INTO fi_control.purged_sandboxes(id) VALUES(target);
 DELETE FROM fi.positions WHERE sandbox_id=target;
 DELETE FROM fi.order_history WHERE sandbox_id=target;
 DELETE FROM fi.cancellation_outcomes WHERE sandbox_id=target;
 DELETE FROM fi.cancellation_requests WHERE sandbox_id=target;
 DELETE FROM fi.executions WHERE sandbox_id=target;
 DELETE FROM fi.order_states WHERE sandbox_id=target;
 DELETE FROM fi.orders WHERE sandbox_id=target;
 DELETE FROM fi.quotes WHERE sandbox_id=target;
 DELETE FROM fi.invitations WHERE sandbox_id=target;
 DELETE FROM fi.rfqs WHERE sandbox_id=target;
 DELETE FROM fi.audit_events WHERE sandbox_id=target;
 DELETE FROM fi.commands WHERE sandbox_id=target;
 DELETE FROM fi_control.sandbox_access WHERE sandbox_id=target;
 DELETE FROM fi.sandboxes WHERE id=target;
 removed:=removed+1;
 END LOOP;
 UPDATE fi_control.service_capacity SET retained_count=retained_count-removed WHERE singleton;
 RETURN removed;
END $$;
