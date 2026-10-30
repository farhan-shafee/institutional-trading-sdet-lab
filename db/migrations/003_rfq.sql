-- Additive Phase 2B. Migrations 001/002 remain byte-for-byte unchanged.
ALTER TABLE fi.commands DROP CONSTRAINT commands_operation_check;
ALTER TABLE fi.commands ADD CHECK (operation IN ('CREATE_SANDBOX','ROTATE_CAPABILITIES','CREATE_RFQ','RESPOND_DEALER','WITHDRAW_QUOTE','ACCEPT_QUOTE'));
ALTER TABLE fi.commands ADD UNIQUE (sandbox_id,id,command_seq);
ALTER TABLE fi.audit_events DROP CONSTRAINT audit_events_event_index_check;
ALTER TABLE fi.audit_events ADD CHECK (event_index BETWEEN 0 AND 2);
ALTER TABLE fi.audit_events DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE fi.audit_events ADD CHECK (event_type IN ('SANDBOX_CREATED','CAPABILITIES_ROTATED','COMMAND_REJECTED','RFQ_CREATED','DEALER_RESPONDED','DEALER_DECLINED','QUOTE_PUBLISHED','QUOTE_WITHDRAWN','RFQ_EXPIRED','QUOTE_ACCEPTED','RFQ_ACCEPTED','ORDER_CREATED'));
ALTER TABLE fi.audit_events DROP CONSTRAINT audit_events_sandbox_id_aggregate_version_key;
ALTER TABLE fi.audit_events DROP CONSTRAINT audit_events_check;
ALTER TABLE fi.audit_events ADD CHECK ((event_type='COMMAND_REJECTED') = (aggregate_version IS NULL));
CREATE UNIQUE INDEX ownership_generation ON fi.audit_events(sandbox_id,aggregate_version)
  WHERE event_type IN ('SANDBOX_CREATED','CAPABILITIES_ROTATED');
ALTER TABLE fi.audit_events ADD FOREIGN KEY (sandbox_id,command_id,command_seq)
  REFERENCES fi.commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE fi.dealers (
  id text PRIMARY KEY CHECK (id IN ('ATLAS','BIRCH','CEDAR')),
  name text NOT NULL,
  ordinal integer NOT NULL UNIQUE CHECK (ordinal BETWEEN 0 AND 2)
);
INSERT INTO fi.dealers VALUES ('ATLAS','Fictional Atlas Securities',0),('BIRCH','Fictional Birch Markets',1),('CEDAR','Fictional Cedar Capital',2);
CREATE TRIGGER dealer_immutable BEFORE UPDATE OR DELETE ON fi.dealers FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();

CREATE TABLE fi.rfqs (
  sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id), id uuid NOT NULL,
  instrument_revision text NOT NULL REFERENCES fi.instrument_versions(id),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  par_amount numeric(12,2) NOT NULL CHECK (par_amount BETWEEN 1 AND 1000000000),
  settlement_date date NOT NULL CHECK (settlement_date >= DATE '2025-01-15' AND settlement_date < DATE '2031-01-15'),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ACCEPTED','EXPIRED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  accepted_quote_id uuid,
  PRIMARY KEY(sandbox_id,id),
  CHECK ((state='ACCEPTED') = (accepted_quote_id IS NOT NULL))
);
CREATE TABLE fi.invitations (
  sandbox_id uuid NOT NULL, rfq_id uuid NOT NULL, dealer_id text NOT NULL REFERENCES fi.dealers(id),
  state text NOT NULL DEFAULT 'INVITED' CHECK (state IN ('INVITED','QUOTED','DECLINED','WITHDRAWN')),
  PRIMARY KEY(sandbox_id,rfq_id,dealer_id),
  FOREIGN KEY(sandbox_id,rfq_id) REFERENCES fi.rfqs(sandbox_id,id)
);
CREATE TABLE fi.quotes (
  sandbox_id uuid NOT NULL, id uuid NOT NULL, rfq_id uuid NOT NULL, dealer_id text NOT NULL,
  bid_clean_price text NOT NULL CHECK (bid_clean_price ~ '^[0-9]{1,5}\.[0-9]{12}$'),
  ask_clean_price text NOT NULL CHECK (ask_clean_price ~ '^[0-9]{1,5}\.[0-9]{12}$'),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=4096),
  PRIMARY KEY(sandbox_id,id), UNIQUE(sandbox_id,rfq_id,id), UNIQUE(sandbox_id,rfq_id,dealer_id),
  FOREIGN KEY(sandbox_id,rfq_id,dealer_id) REFERENCES fi.invitations(sandbox_id,rfq_id,dealer_id),
  CHECK (bid_clean_price::numeric>0 AND ask_clean_price::numeric>bid_clean_price::numeric AND expires_at>created_at)
);
ALTER TABLE fi.rfqs ADD FOREIGN KEY(sandbox_id,id,accepted_quote_id) REFERENCES fi.quotes(sandbox_id,rfq_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE fi.orders (
  sandbox_id uuid NOT NULL, id uuid NOT NULL, rfq_id uuid NOT NULL, quote_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_ACK' CHECK (status='PENDING_ACK'),
  created_at timestamptz NOT NULL,
  contract jsonb NOT NULL CHECK (jsonb_typeof(contract)='object' AND octet_length(contract::text)<=4096),
  PRIMARY KEY(sandbox_id,id), UNIQUE(sandbox_id,rfq_id), UNIQUE(sandbox_id,quote_id),
  FOREIGN KEY(sandbox_id,rfq_id,quote_id) REFERENCES fi.quotes(sandbox_id,rfq_id,id)
);
CREATE TRIGGER quote_immutable BEFORE UPDATE OR DELETE ON fi.quotes FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();
CREATE TRIGGER order_immutable BEFORE UPDATE OR DELETE ON fi.orders FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['rfqs','invitations','quotes','orders'] LOOP
    EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING (sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
    EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING (true) WITH CHECK (true)',t);
    EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING (true)',t);
    EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
  END LOOP;
END $$;
GRANT SELECT ON fi.dealers TO tf_app,tf_reconciler;

CREATE FUNCTION fi_control.rfq_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fi.rfqs r LEFT JOIN fi.orders o ON (o.sandbox_id,o.rfq_id)=(r.sandbox_id,r.id)
    LEFT JOIN fi.quotes q ON (q.sandbox_id,q.id)=(o.sandbox_id,o.quote_id)
    WHERE r.sandbox_id=NEW.sandbox_id AND (
      (r.state='ACCEPTED') IS DISTINCT FROM (o.id IS NOT NULL)
      OR (o.id IS NOT NULL AND (r.accepted_quote_id IS DISTINCT FROM o.quote_id OR o.contract IS DISTINCT FROM
        (q.snapshot || jsonb_build_object('clean_price',CASE r.side WHEN 'BUY' THEN q.ask_clean_price ELSE q.bid_clean_price END)))))) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Incomplete RFQ acceptance';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rfq_acceptance_complete AFTER INSERT OR UPDATE ON fi.rfqs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.rfq_consistent();
CREATE CONSTRAINT TRIGGER order_acceptance_complete AFTER INSERT ON fi.orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.rfq_consistent();

CREATE FUNCTION fi_control.rfq_body(p_sandbox uuid,p_rfq uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('rfq',jsonb_build_object(
    'id',r.id,'instrument_revision',r.instrument_revision,'instrument_id',iv.instrument_id,'side',r.side,
    'par_amount',r.par_amount::text,'settlement_date',r.settlement_date::text,
    'version',r.version::text,'state',CASE WHEN r.state='OPEN' AND p_now>=r.expires_at THEN 'EXPIRED' ELSE r.state END,
    'accepted_quote_id',r.accepted_quote_id,
    'created_at',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expires_at',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'invitations',COALESCE((SELECT jsonb_agg(jsonb_build_object('dealer_id',dealer_id,'state',state) ORDER BY dealer_id)
      FROM fi.invitations WHERE sandbox_id=p_sandbox AND rfq_id=p_rfq),'[]'::jsonb),
    'quotes',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'rfq_id',q.rfq_id,'dealer_id',q.dealer_id,
      'bid_clean_price',q.bid_clean_price,'ask_clean_price',q.ask_clean_price,'snapshot',q.snapshot,
      'created_at',to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'expires_at',to_char(q.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'status',CASE WHEN r.accepted_quote_id=q.id THEN 'ACCEPTED' WHEN i.state='WITHDRAWN' THEN 'WITHDRAWN'
        WHEN p_now>=q.expires_at OR p_now>=r.expires_at THEN 'EXPIRED' WHEN r.state<>'OPEN' THEN 'UNAVAILABLE' ELSE 'QUOTED' END)
      ORDER BY q.dealer_id) FROM fi.quotes q JOIN fi.invitations i USING(sandbox_id,rfq_id,dealer_id)
      WHERE q.sandbox_id=p_sandbox AND q.rfq_id=p_rfq),'[]'::jsonb),
    'order',(SELECT jsonb_build_object('id',o.id,'rfq_id',o.rfq_id,'quote_id',o.quote_id,'status',o.status,'contract',o.contract,
      'created_at',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM fi.orders o WHERE o.sandbox_id=p_sandbox AND o.rfq_id=p_rfq))
  FROM fi.rfqs r JOIN fi.instrument_versions iv ON iv.id=r.instrument_revision
  WHERE r.sandbox_id=p_sandbox AND r.id=p_rfq
$$;

-- Private writer. The caller has already locked/authenticated the sandbox and reserved all event slots.
CREATE FUNCTION fi_control.record_rfq_command(p_id uuid,p_key text,p_hash text,p_operation text,
  p_status integer,p_body jsonb,p_events jsonb,p_actor uuid,p_decided timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE; cid uuid:=gen_random_uuid(); e jsonb; n integer:=0;
BEGIN
  UPDATE fi.sandboxes SET command_count=command_count+1,commit_seq=commit_seq+1,event_count=event_count+jsonb_array_length(p_events)
    WHERE id=p_id RETURNING * INTO STRICT s;
  INSERT INTO fi.commands(sandbox_id,id,idempotency_key,operation,request_hash,command_seq,result_kind,http_status,response_body)
    VALUES(p_id,cid,p_key,p_operation,p_hash,s.commit_seq,CASE WHEN p_status=409 THEN 'REJECTED' ELSE 'APPLIED' END,p_status,p_body);
  FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    INSERT INTO fi.audit_events(sandbox_id,command_id,command_seq,event_index,event_type,aggregate_version,actor_id,decided_at,payload)
      VALUES(p_id,cid,s.commit_seq,n,e->>'type',(e->>'version')::bigint,p_actor,p_decided,e->'payload');
    n:=n+1;
  END LOOP;
  RETURN fi_control.result(p_status,p_body);
END $$;

CREATE FUNCTION fi_control.rfq_command(p_id uuid,p_proof text,p_generation bigint,p_action text,
  p jsonb,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; r fi.rfqs%ROWTYPE; q fi.quotes%ROWTYPE; inv fi.invitations%ROWTYPE;
  receipt fi.commands%ROWTYPE; iv fi.instrument_versions%ROWTYPE; decided timestamptz;
  rid uuid; qid uuid; oid uuid; bid text; ask text; offset_index integer; expiry timestamptz;
  payload jsonb; events jsonb; failure text; allowed text[]; status integer:=200;
BEGIN
  IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_action IS NULL OR p IS NULL
     OR jsonb_typeof(p)<>'object' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
     OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p_actor IS NULL THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  allowed:=CASE p_action WHEN 'CREATE_RFQ' THEN ARRAY['rfq_id','instrument_id','side','par_amount','settlement_date','invited_dealers']
    WHEN 'RESPOND_DEALER' THEN ARRAY['rfq_id','expected_version','dealer_id','response']
    WHEN 'WITHDRAW_QUOTE' THEN ARRAY['rfq_id','expected_version','quote_id']
    WHEN 'ACCEPT_QUOTE' THEN ARRAY['rfq_id','expected_version','quote_id'] END;
  IF allowed IS NULL OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(allowed)
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(allowed))
     OR NOT (p ?& allowed) OR EXISTS(SELECT 1 FROM jsonb_each(p) e WHERE e.value='null'::jsonb) THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  rid:=(p->>'rfq_id')::uuid;
  IF p_action='CREATE_RFQ' THEN
    IF p->>'side' NOT IN ('BUY','SELL') OR p->>'instrument_id' NOT IN ('SYN-UST-2031','SYN-CORP-2031')
      OR p->>'par_amount' !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$'
      OR (p->>'par_amount')::numeric NOT BETWEEN 1 AND 1000000000
      OR p->>'settlement_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR (p->>'settlement_date')::date < DATE '2025-01-15' OR (p->>'settlement_date')::date >= DATE '2031-01-15'
      OR jsonb_typeof(p->'invited_dealers')<>'array' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
    IF jsonb_array_length(p->'invited_dealers') NOT BETWEEN 1 AND 3
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'invited_dealers') d WHERE NOT EXISTS(SELECT 1 FROM fi.dealers WHERE id=d))
      OR (SELECT count(DISTINCT d) FROM jsonb_array_elements_text(p->'invited_dealers') d)<>jsonb_array_length(p->'invited_dealers') THEN
      RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
  ELSIF p->>'expected_version' !~ '^[1-9][0-9]{0,2}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
  ELSIF p_action='RESPOND_DEALER' AND (p->>'dealer_id' NOT IN ('ATLAS','BIRCH','CEDAR') OR p->>'response' NOT IN ('QUOTE','DECLINE')) THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
  SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation THEN
    RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
  SELECT * INTO receipt FROM fi.commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.operation<>p_action OR receipt.request_hash<>p_hash THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED'); END IF;
    RETURN fi_control.result(receipt.http_status,receipt.response_body,true);
  END IF;
  SELECT * INTO r FROM fi.rfqs WHERE sandbox_id=p_id AND id=rid FOR UPDATE;
  IF p_action<>'CREATE_RFQ' AND NOT FOUND THEN RETURN fi_control.failure(404,'RFQ_NOT_FOUND'); END IF;
  IF p_action='RESPOND_DEALER' THEN
    SELECT * INTO inv FROM fi.invitations WHERE sandbox_id=p_id AND rfq_id=rid AND dealer_id=p->>'dealer_id' FOR UPDATE;
  ELSIF p_action IN ('ACCEPT_QUOTE','WITHDRAW_QUOTE') THEN
    SELECT * INTO q FROM fi.quotes WHERE sandbox_id=p_id AND rfq_id=rid AND id=(p->>'quote_id')::uuid;
    IF NOT FOUND THEN RETURN fi_control.failure(404,'QUOTE_NOT_FOUND'); END IF;
    SELECT * INTO inv FROM fi.invitations WHERE sandbox_id=p_id AND rfq_id=rid AND dealer_id=q.dealer_id FOR UPDATE;
  END IF;
  -- Wall clock, after every required lock: transaction_timestamp/Node clocks are not expiry authorities.
  decided:=clock_timestamp();
  IF decided>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED'); END IF;
  IF s.command_count>=512 OR s.event_count+3>1024 THEN RETURN fi_control.failure(429,'SANDBOX_QUOTA_REACHED'); END IF;
  IF p_action='CREATE_RFQ' THEN
    IF r.id IS NOT NULL THEN failure:='RFQ_ALREADY_EXISTS';
    ELSIF (SELECT count(*) FROM fi.rfqs WHERE sandbox_id=p_id)>=50 THEN RETURN fi_control.failure(429,'RFQ_CAPACITY_REACHED'); END IF;
  ELSE
    IF r.state<>'OPEN' THEN failure:='RFQ_NOT_OPEN';
    ELSIF decided>=r.expires_at THEN failure:='RFQ_EXPIRED';
    ELSIF r.version<>(p->>'expected_version')::bigint THEN failure:='RFQ_VERSION_CONFLICT';
    ELSIF p_action='RESPOND_DEALER' AND inv.dealer_id IS NULL THEN failure:='DEALER_NOT_INVITED';
    ELSIF p_action='RESPOND_DEALER' AND inv.state<>'INVITED' THEN failure:='DEALER_ALREADY_RESPONDED';
    ELSIF p_action IN ('ACCEPT_QUOTE','WITHDRAW_QUOTE') AND inv.state<>'QUOTED' THEN failure:='QUOTE_NOT_FIRM';
    ELSIF p_action IN ('ACCEPT_QUOTE','WITHDRAW_QUOTE') AND decided>=q.expires_at THEN failure:='QUOTE_EXPIRED'; END IF;
  END IF;
  events:='[]'::jsonb;
  IF failure IS NOT NULL THEN
    IF failure='RFQ_EXPIRED' THEN
      UPDATE fi.rfqs SET state='EXPIRED',version=version+1 WHERE sandbox_id=p_id AND id=rid RETURNING * INTO r;
      events:=jsonb_build_array(jsonb_build_object('type','RFQ_EXPIRED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text)));
    END IF;
    events:=events||jsonb_build_array(jsonb_build_object('type','COMMAND_REJECTED','payload',jsonb_build_object('code',failure,'rfq_id',rid::text)));
    RETURN fi_control.record_rfq_command(p_id,p_key,p_hash,p_action,409,fi_control.failure(409,failure)->'body',events,p_actor,decided);
  END IF;
  IF p_action='CREATE_RFQ' THEN
    SELECT * INTO STRICT iv FROM fi.instrument_versions WHERE instrument_id=p->>'instrument_id' AND revision=1;
    INSERT INTO fi.rfqs(sandbox_id,id,instrument_revision,side,par_amount,settlement_date,created_at,expires_at)
      VALUES(p_id,rid,iv.id,p->>'side',(p->>'par_amount')::numeric,(p->>'settlement_date')::date,decided,decided+interval '300 seconds') RETURNING * INTO r;
    INSERT INTO fi.invitations(sandbox_id,rfq_id,dealer_id) SELECT p_id,rid,value FROM jsonb_array_elements_text(p->'invited_dealers');
    events:=jsonb_build_array(jsonb_build_object('type','RFQ_CREATED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text)));
    status:=201;
  ELSIF p_action='RESPOND_DEALER' THEN
    UPDATE fi.invitations SET state=CASE p->>'response' WHEN 'QUOTE' THEN 'QUOTED' ELSE 'DECLINED' END
      WHERE sandbox_id=p_id AND rfq_id=rid AND dealer_id=inv.dealer_id;
    UPDATE fi.rfqs SET version=version+1 WHERE sandbox_id=p_id AND id=rid RETURNING * INTO r;
    IF p->>'response'='QUOTE' THEN
      SELECT * INTO STRICT iv FROM fi.instrument_versions WHERE id=r.instrument_revision;
      SELECT ordinal INTO STRICT offset_index FROM fi.dealers WHERE id=inv.dealer_id;
      bid:=to_char((CASE iv.instrument_id WHEN 'SYN-UST-2031' THEN 99.950000000123 ELSE 98.950000000123 END)-offset_index*0.01,'FM99990.000000000000');
      ask:=to_char((CASE iv.instrument_id WHEN 'SYN-UST-2031' THEN 100.050000000123 ELSE 99.050000000123 END)+offset_index*0.01,'FM99990.000000000000');
      qid:=gen_random_uuid(); expiry:=LEAST(r.expires_at,decided+interval '30 seconds');
      payload:=jsonb_build_object('quote_id',qid::text,'rfq_id',rid::text,'dealer_id',inv.dealer_id,
        'instrument_id',iv.instrument_id,'instrument_revision',iv.id,'financial_source',iv.financial_source,'instrument_terms',iv.terms,
        'model_version','synthetic-dealer-grid-v1','currency','USD','price_unit','per 100 par','side',r.side,
        'par_amount',r.par_amount::text,'settlement_date',r.settlement_date::text,'bid_clean_price',bid,'ask_clean_price',ask,
        'quoted_at',to_char(decided AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'expires_at',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
      INSERT INTO fi.quotes VALUES(p_id,qid,rid,inv.dealer_id,bid,ask,decided,expiry,payload);
      events:=jsonb_build_array(jsonb_build_object('type','DEALER_RESPONDED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'dealer_id',inv.dealer_id)),
        jsonb_build_object('type','QUOTE_PUBLISHED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'quote_id',qid::text)));
    ELSE
      events:=jsonb_build_array(jsonb_build_object('type','DEALER_DECLINED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'dealer_id',inv.dealer_id)));
    END IF;
  ELSIF p_action='WITHDRAW_QUOTE' THEN
    UPDATE fi.invitations SET state='WITHDRAWN' WHERE sandbox_id=p_id AND rfq_id=rid AND dealer_id=q.dealer_id;
    UPDATE fi.rfqs SET version=version+1 WHERE sandbox_id=p_id AND id=rid RETURNING * INTO r;
    events:=jsonb_build_array(jsonb_build_object('type','QUOTE_WITHDRAWN','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'quote_id',q.id::text)));
  ELSE
    oid:=gen_random_uuid();
    UPDATE fi.rfqs SET state='ACCEPTED',accepted_quote_id=q.id,version=version+1 WHERE sandbox_id=p_id AND id=rid RETURNING * INTO r;
    INSERT INTO fi.orders VALUES(p_id,oid,rid,q.id,'PENDING_ACK',decided,q.snapshot||jsonb_build_object('clean_price',CASE r.side WHEN 'BUY' THEN q.ask_clean_price ELSE q.bid_clean_price END));
    events:=jsonb_build_array(
      jsonb_build_object('type','QUOTE_ACCEPTED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'quote_id',q.id::text)),
      jsonb_build_object('type','RFQ_ACCEPTED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text)),
      jsonb_build_object('type','ORDER_CREATED','version',r.version::text,'payload',jsonb_build_object('rfq_id',rid::text,'order_id',oid::text)));
    status:=201;
  END IF;
  RETURN fi_control.record_rfq_command(p_id,p_key,p_hash,p_action,status,fi_control.rfq_body(p_id,rid,decided),events,p_actor,decided);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.rfq_command(uuid,text,bigint,text,jsonb,text,text,uuid) TO tf_app;

-- Expose only a capability-checked read function; private body helpers remain uncallable by tf_app.
CREATE FUNCTION fi_control.read_rfqs(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_rfq uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE body jsonb; decided timestamptz:=clock_timestamp();
BEGIN
  IF NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation) THEN
    RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
  IF p_rfq IS NULL THEN
    SELECT jsonb_build_object('rfqs',COALESCE(jsonb_agg(fi_control.rfq_body(p_id,id,decided)->'rfq' ORDER BY created_at,id),'[]'::jsonb)) INTO body FROM fi.rfqs WHERE sandbox_id=p_id;
  ELSE
    body:=fi_control.rfq_body(p_id,p_rfq,decided);
    IF body IS NULL THEN RETURN fi_control.failure(404,'RFQ_NOT_FOUND'); END IF;
  END IF;
  RETURN fi_control.result(200,body);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_rfqs(uuid,text,text,bigint,uuid) TO tf_app;

CREATE OR REPLACE FUNCTION fi_control.purge_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE target uuid; removed integer:=0;
BEGIN
  PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
  FOR target IN SELECT id FROM fi.sandboxes WHERE retained_until<=clock_timestamp() ORDER BY id FOR UPDATE LOOP
    INSERT INTO fi_control.purged_sandboxes(id) VALUES(target);
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
