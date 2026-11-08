-- Owned-only additive post-trade profile. Original migration bytes remain authoritative.
CREATE TABLE fi.posttrade_books (
 sandbox_id uuid PRIMARY KEY REFERENCES fi.sandboxes(id) ON DELETE CASCADE,
 economic_start_date date NOT NULL CHECK(economic_start_date>='2025-01-15' AND economic_start_date<'2031-01-15'),
 economic_end_date date NOT NULL CHECK(economic_end_date>economic_start_date),
 command_count integer NOT NULL DEFAULT 0 CHECK(command_count BETWEEN 0 AND 97),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 161),
 cash_cents bigint NOT NULL DEFAULT 0 CHECK(cash_cents>=0),
 counterparty_cash_cents bigint NOT NULL DEFAULT 0 CHECK(counterparty_cash_cents=-cash_cents),
 last_processing_date date,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fi.posttrade_security_balances (
 sandbox_id uuid NOT NULL REFERENCES fi.posttrade_books(sandbox_id) ON DELETE CASCADE,
 instrument_revision text NOT NULL REFERENCES fi.instrument_versions(id)
 CHECK(instrument_revision IN ('phase1-ust-1','phase1-corp-1')),
 available_par numeric(14,2) NOT NULL DEFAULT 0 CHECK(available_par>=0),
 counterparty_par numeric(14,2) NOT NULL DEFAULT 0 CHECK(counterparty_par=-available_par),
 PRIMARY KEY(sandbox_id,instrument_revision)
);
CREATE TABLE fi.posttrade_roots (
 sandbox_id uuid NOT NULL REFERENCES fi.posttrade_books(sandbox_id) ON DELETE CASCADE,
 execution_id uuid NOT NULL,raw_command_seq bigint NOT NULL,
 instrument_revision text NOT NULL CHECK(instrument_revision IN ('phase1-ust-1','phase1-corp-1')),
 side text NOT NULL CHECK(side IN ('BUY','SELL')),
 par_amount numeric(12,2) NOT NULL CHECK(par_amount BETWEEN 0.01 AND 1000000000),
 settlement_date date NOT NULL,original_clean_price text NOT NULL,
 original_consideration_cents bigint NOT NULL CHECK(original_consideration_cents>0),
 registration_seq bigint NOT NULL CHECK(registration_seq BETWEEN 2 AND 97),
 raw_recorded_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,execution_id),
 FOREIGN KEY(sandbox_id,execution_id) REFERENCES fi.executions(sandbox_id,id) ON DELETE CASCADE
);
CREATE TABLE fi.posttrade_revisions (
 sandbox_id uuid NOT NULL,execution_id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2),
 clean_price text NOT NULL CHECK(clean_price ~ '^[0-9]{1,5}\.[0-9]{12}$'),
 consideration_cents bigint NOT NULL CHECK(consideration_cents BETWEEN 0 AND 10002000000000),
 command_seq bigint NOT NULL CHECK(command_seq BETWEEN 2 AND 97),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,execution_id,revision),
 FOREIGN KEY(sandbox_id,execution_id) REFERENCES fi.posttrade_roots(sandbox_id,execution_id) ON DELETE CASCADE
);
CREATE TABLE fi.posttrade_busts (
 sandbox_id uuid NOT NULL,execution_id uuid NOT NULL,revision integer NOT NULL,
 command_seq bigint NOT NULL CHECK(command_seq BETWEEN 2 AND 97),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,execution_id),
 FOREIGN KEY(sandbox_id,execution_id,revision) REFERENCES fi.posttrade_revisions(sandbox_id,execution_id,revision) ON DELETE CASCADE
);
CREATE TABLE fi.posttrade_settlement_outcomes (
 sandbox_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 execution_id uuid NOT NULL,revision integer NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('FAILED','SETTLED','REVERSED')),
 processing_date date NOT NULL CHECK(extract(isodow FROM processing_date)<=5),
 reason text,posting_id uuid,
 command_seq bigint NOT NULL CHECK(command_seq BETWEEN 2 AND 97),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),
 FOREIGN KEY(sandbox_id,execution_id,revision) REFERENCES fi.posttrade_revisions(sandbox_id,execution_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(sandbox_id,posting_id) REFERENCES fi.posttrade_settlement_outcomes(sandbox_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((outcome='REVERSED')=(posting_id IS NOT NULL)),
 CHECK((outcome='FAILED')=(reason IS NOT NULL))
);
CREATE UNIQUE INDEX posttrade_post_once ON fi.posttrade_settlement_outcomes(sandbox_id,execution_id,revision) WHERE outcome='SETTLED';
CREATE UNIQUE INDEX posttrade_reverse_once ON fi.posttrade_settlement_outcomes(sandbox_id,execution_id,revision) WHERE outcome='REVERSED';
CREATE TABLE fi.posttrade_commands (
 sandbox_id uuid NOT NULL REFERENCES fi.posttrade_books(sandbox_id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(),idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 operation text NOT NULL CHECK(operation IN ('INITIALIZE','REGISTER','CORRECT','BUST','SETTLE','REVERSE')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 command_seq bigint NOT NULL CHECK(command_seq BETWEEN 1 AND 97),
 capability_generation bigint NOT NULL CHECK(capability_generation BETWEEN 1 AND 1000000000),
 actor_id uuid NOT NULL,http_status integer NOT NULL CHECK(http_status IN (200,201,409)),
 response_body jsonb NOT NULL CHECK(jsonb_typeof(response_body)='object' AND octet_length(response_body::text)<=8192),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,idempotency_key),UNIQUE(sandbox_id,command_seq)
);
CREATE TABLE fi.posttrade_events (
 sandbox_id uuid NOT NULL,command_seq bigint NOT NULL,event_index integer NOT NULL CHECK(event_index BETWEEN 0 AND 1),
 event_type text NOT NULL CHECK(event_type IN ('FUNDING','REGISTERED','COMPENSATE','REPLACEMENT','BUST','SETTLEMENT_FAILED','CASH_POSTED','SECURITY_POSTED','CASH_REVERSED','SECURITY_REVERSED')),
 execution_id uuid,instrument_revision text REFERENCES fi.instrument_versions(id),
 economic_cash_cents bigint NOT NULL DEFAULT 0,economic_par_amount numeric(14,2) NOT NULL DEFAULT 0,
 cash_cents bigint NOT NULL DEFAULT 0,par_amount numeric(14,2) NOT NULL DEFAULT 0,
 counterparty_cash_cents bigint GENERATED ALWAYS AS (-cash_cents) STORED,
 counterparty_par numeric(14,2) GENERATED ALWAYS AS (-par_amount) STORED,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,command_seq,event_index),
 FOREIGN KEY(sandbox_id,command_seq) REFERENCES fi.posttrade_commands(sandbox_id,command_seq) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(sandbox_id,execution_id) REFERENCES fi.posttrade_roots(sandbox_id,execution_id) ON DELETE CASCADE,
 CHECK(instrument_revision IS NOT NULL OR (par_amount=0 AND economic_par_amount=0))
);
DO $secure$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['posttrade_books','posttrade_security_balances','posttrade_roots','posttrade_revisions','posttrade_busts','posttrade_settlement_outcomes','posttrade_commands','posttrade_events'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('REVOKE ALL ON fi.%I FROM PUBLIC,tf_app,tf_reconciler,tf_maintenance',t);
 IF t NOT IN ('posttrade_books','posttrade_security_balances') THEN
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);
 END IF;
 END LOOP;
END $secure$;

-- Retain 007's prepared-key transfer and private transaction context verbatim.
ALTER TABLE fi_control.command_keys DROP CONSTRAINT command_keys_domain_check;
ALTER TABLE fi_control.command_keys ADD CONSTRAINT command_keys_domain_check CHECK(domain IN ('FINANCIAL','RECONCILIATION','FIX','FIX_PREPARED','POSTTRADE'));
DO $patch$ DECLARE d text;old_text text:='WHEN ''fix_commands'' THEN ''FIX'' ELSE ''RECONCILIATION''';
BEGIN
 SELECT pg_get_functiondef('fi_control.reserve_command_key()'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,old_text,'')))<>length(old_text) OR position('fi_control.fix_apply_context' IN d)=0
 THEN RAISE EXCEPTION 'Unexpected Phase3B2 key transfer source';END IF;
 EXECUTE replace(d,old_text,'WHEN ''fix_commands'' THEN ''FIX'' WHEN ''posttrade_commands'' THEN ''POSTTRADE'' ELSE ''RECONCILIATION''');
END $patch$;
CREATE TRIGGER shared_idempotency_key BEFORE INSERT ON fi.posttrade_commands FOR EACH ROW EXECUTE FUNCTION fi_control.reserve_command_key();

-- Book allocation stays 97/161: used plus unused reservation, never a fresh ledger quota.
CREATE FUNCTION fi_control.posttrade_capacity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid;s fi.sandboxes%ROWTYPE;c integer;e integer;h integer;pc integer;pe integer;rotation boolean:=false;
BEGIN
 IF TG_TABLE_NAME='sandboxes' THEN sid:=NEW.id;ELSE sid:=NEW.sandbox_id;END IF;
 SELECT * INTO STRICT s FROM fi.sandboxes WHERE id=sid FOR UPDATE;
 IF TG_TABLE_NAME='posttrade_books' THEN pc:=97;pe:=161;
 ELSIF EXISTS(SELECT 1 FROM fi.posttrade_books WHERE sandbox_id=sid) THEN pc:=97;pe:=161;
 ELSE RETURN NEW;END IF;
 SELECT commands,events,security_headroom INTO c,e,h FROM fi_control.fix_capacity_remaining(sid);
 IF c=0 AND e=0 THEN h:=0;END IF;
 IF TG_TABLE_NAME='sandboxes' THEN
  rotation:=EXISTS(SELECT 1 FROM fi_control.fix_writer_context WHERE sandbox_id=sid AND transaction_id=pg_current_xact_id());
  IF NEW.command_count<=OLD.command_count AND NEW.event_count<=OLD.event_count THEN RETURN NEW;END IF;
  s.command_count:=NEW.command_count;s.event_count:=NEW.event_count;
 ELSIF TG_TABLE_NAME='fix_reservations' THEN
  c:=c+NEW.commands;e:=e+NEW.events;
  SELECT greatest(2-count(*),0)::integer INTO h FROM fi.commands x WHERE x.sandbox_id=sid AND x.operation='ROTATE_CAPABILITIES'
  AND x.created_at >= (SELECT min(b.created_at) FROM fi.fix_bindings b WHERE b.sandbox_id=sid);
 END IF;
 IF s.command_count+pc+c+ (CASE WHEN rotation THEN 0 ELSE h END)>512
 OR s.event_count+pe+e+ (CASE WHEN rotation THEN 0 ELSE h END)>1024
 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='PROTECTED_FINANCIAL_CAPACITY';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER posttrade_global_capacity BEFORE UPDATE ON fi.sandboxes FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_capacity_guard();
CREATE TRIGGER posttrade_initial_capacity BEFORE INSERT ON fi.posttrade_books FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_capacity_guard();
CREATE TRIGGER posttrade_fix_capacity BEFORE INSERT ON fi_control.fix_reservations FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_capacity_guard();

CREATE FUNCTION fi_control.posttrade_window_end(d date) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE y integer;candidate date;
BEGIN
 IF d<'2025-01-15' OR d>='2031-01-15' OR d IS NULL THEN RETURN NULL;END IF;
 y:=extract(year FROM d);
 candidate:=make_date(y,1,15);
 IF candidate>d THEN RETURN candidate;END IF;
 candidate:=make_date(y,7,15);
 IF candidate>d THEN RETURN candidate;END IF;
 RETURN make_date(y+1,1,15);
END $$;
CREATE FUNCTION fi_control.posttrade_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid;b fi.posttrade_books%ROWTYPE;
BEGIN
 sid:=NEW.sandbox_id;
 SELECT * INTO b FROM fi.posttrade_books WHERE sandbox_id=sid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF b.economic_end_date IS DISTINCT FROM fi_control.posttrade_window_end(b.economic_start_date)

 OR NOT EXISTS(SELECT 1 FROM fi.posttrade_commands c JOIN fi.posttrade_events e
 ON(e.sandbox_id,e.command_seq)=(c.sandbox_id,c.command_seq)
 WHERE c.sandbox_id=sid AND c.command_seq=1 AND c.operation='INITIALIZE' AND c.http_status=201
 AND e.event_type='FUNDING' AND e.event_index=0 AND e.cash_cents=10000000000 AND e.par_amount=0
 AND e.economic_cash_cents=0 AND e.economic_par_amount=0 AND e.execution_id IS NULL AND e.instrument_revision IS NULL
 AND c.response_body->'window'=jsonb_build_object('start',b.economic_start_date,'end',b.economic_end_date))
 OR EXISTS(SELECT 1 FROM fi.posttrade_commands c WHERE c.sandbox_id=sid AND
 (SELECT array_agg(event_type ORDER BY event_index) FROM fi.posttrade_events e WHERE e.sandbox_id=sid AND e.command_seq=c.command_seq)
 IS DISTINCT FROM CASE c.operation WHEN 'INITIALIZE' THEN ARRAY['FUNDING'] WHEN 'REGISTER' THEN ARRAY['REGISTERED']
 WHEN 'CORRECT' THEN ARRAY['COMPENSATE','REPLACEMENT'] WHEN 'BUST' THEN ARRAY['BUST']
 WHEN 'REVERSE' THEN ARRAY['CASH_REVERSED','SECURITY_REVERSED']
 WHEN 'SETTLE' THEN CASE WHEN c.http_status=409 THEN ARRAY['SETTLEMENT_FAILED'] ELSE ARRAY['CASH_POSTED','SECURITY_POSTED'] END END)
 OR EXISTS(SELECT 1 FROM fi.posttrade_revisions v JOIN fi.posttrade_commands c USING(sandbox_id,command_seq)
 WHERE v.sandbox_id=sid AND c.operation<>CASE WHEN v.revision=0 THEN 'REGISTER' ELSE 'CORRECT' END)
 OR EXISTS(SELECT 1 FROM fi.posttrade_roots r JOIN fi.posttrade_commands c ON(c.sandbox_id,c.command_seq)=(r.sandbox_id,r.registration_seq)
 WHERE r.sandbox_id=sid AND c.operation<>'REGISTER')
 OR b.command_count<>(SELECT count(*) FROM fi.posttrade_commands WHERE sandbox_id=sid)
 OR b.command_count<>(SELECT COALESCE(max(command_seq),0) FROM fi.posttrade_commands WHERE sandbox_id=sid)
 OR b.event_count<>(SELECT count(*) FROM fi.posttrade_events WHERE sandbox_id=sid)
 OR b.cash_cents<>(SELECT COALESCE(sum(cash_cents),0) FROM fi.posttrade_events WHERE sandbox_id=sid)
 OR EXISTS(SELECT 1 FROM fi.posttrade_security_balances x WHERE x.sandbox_id=sid AND
 x.available_par<>(SELECT COALESCE(sum(e.par_amount),0) FROM fi.posttrade_events e WHERE e.sandbox_id=sid AND e.instrument_revision=x.instrument_revision))
 OR (SELECT count(*) FROM fi.posttrade_security_balances WHERE sandbox_id=sid)<>2
 OR (SELECT count(*) FROM fi.posttrade_roots WHERE sandbox_id=sid)>8
 OR EXISTS(SELECT 1 FROM fi.posttrade_commands c WHERE c.sandbox_id=sid AND
 (SELECT count(*) FROM fi.posttrade_events e WHERE e.sandbox_id=sid AND e.command_seq=c.command_seq)<>
 CASE WHEN c.operation IN ('CORRECT','REVERSE') OR (c.operation='SETTLE' AND c.http_status=200) THEN 2 ELSE 1 END)
 OR EXISTS(SELECT 1 FROM fi.posttrade_commands c LEFT JOIN fi_control.command_keys k USING(sandbox_id,idempotency_key)
 WHERE c.sandbox_id=sid AND k.domain IS DISTINCT FROM 'POSTTRADE')
 OR EXISTS(SELECT 1 FROM fi.posttrade_roots r JOIN fi.executions x ON (x.sandbox_id,x.id)=(r.sandbox_id,r.execution_id)
 WHERE r.sandbox_id=sid AND (r.raw_command_seq,r.instrument_revision,r.side,r.par_amount,r.settlement_date,r.original_clean_price,r.original_consideration_cents,r.raw_recorded_at)
 IS DISTINCT FROM (x.command_seq,x.instrument_revision,x.side,x.par_amount,x.settlement_date,x.clean_price,x.consideration_cents,x.recorded_at))
 OR EXISTS(SELECT 1 FROM fi.posttrade_roots r WHERE r.sandbox_id=sid AND NOT EXISTS(
 SELECT 1 FROM fi.posttrade_revisions v WHERE (v.sandbox_id,v.execution_id,v.revision,v.clean_price,v.consideration_cents,v.command_seq)=
 (r.sandbox_id,r.execution_id,0,r.original_clean_price,r.original_consideration_cents,r.registration_seq)))
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete post-trade ledger';END IF;
 RETURN NULL;
END $$;
DO $integrity$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['posttrade_books','posttrade_security_balances','posttrade_roots','posttrade_revisions','posttrade_busts','posttrade_settlement_outcomes','posttrade_commands','posttrade_events'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER complete AFTER INSERT OR UPDATE ON fi.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_consistent()',t);
 END LOOP;
END $integrity$;

CREATE FUNCTION fi_control.record_posttrade(sid uuid,p_key text,p_hash text,p_op text,p_generation bigint,p_actor uuid,p_status integer,p_body jsonb,p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE seq bigint;item jsonb;i integer:=0;n integer;
BEGIN
 n:=jsonb_array_length(p_events);
 IF n NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Invalid post-trade event cost';END IF;
 UPDATE fi.posttrade_books SET command_count=command_count+1,event_count=event_count+n
 WHERE sandbox_id=sid RETURNING command_count INTO STRICT seq;
 INSERT INTO fi.posttrade_commands(sandbox_id,idempotency_key,operation,request_hash,command_seq,capability_generation,actor_id,http_status,response_body)
 VALUES(sid,p_key,p_op,p_hash,seq,p_generation,p_actor,p_status,p_body);
 FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
 INSERT INTO fi.posttrade_events(sandbox_id,command_seq,event_index,event_type,execution_id,instrument_revision,economic_cash_cents,economic_par_amount,cash_cents,par_amount)
 VALUES(sid,seq,i,item->>'event_type',(item->>'execution_id')::uuid,item->>'instrument_revision',
 COALESCE((item->>'economic_cash_cents')::bigint,0),COALESCE((item->>'economic_par_amount')::numeric,0),
 COALESCE((item->>'cash_cents')::bigint,0),COALESCE((item->>'par_amount')::numeric,0));
 UPDATE fi.posttrade_books SET cash_cents=cash_cents+COALESCE((item->>'cash_cents')::bigint,0),
 counterparty_cash_cents=counterparty_cash_cents-COALESCE((item->>'cash_cents')::bigint,0) WHERE sandbox_id=sid;
 IF item->>'instrument_revision' IS NOT NULL THEN
 UPDATE fi.posttrade_security_balances SET available_par=available_par+COALESCE((item->>'par_amount')::numeric,0),
 counterparty_par=counterparty_par-COALESCE((item->>'par_amount')::numeric,0)
 WHERE sandbox_id=sid AND instrument_revision=item->>'instrument_revision';
 END IF;
 i:=i+1;
 END LOOP;
 RETURN fi_control.result(p_status,p_body);
END $$;

CREATE FUNCTION fi_control.posttrade_command(p_id uuid,p_proof text,p_generation bigint,p_operation text,p_payload jsonb,p_key text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE;b fi.posttrade_books%ROWTYPE;receipt fi.posttrade_commands%ROWTYPE;
 x fi.executions%ROWTYPE;start_date date;end_date date;hash text;body jsonb;events jsonb;seq bigint;sign integer;
BEGIN
 IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_actor IS NULL OR p_operation IS NULL
 OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p_payload IS NULL
 OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>2048
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
 SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation
 THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 hash:=encode(sha256(convert_to(jsonb_build_object('version','OWNED_POSTTRADE_COMMAND_V1','sandbox_id',p_id,'operation',p_operation,'payload',p_payload)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM fi.posttrade_commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF FOUND THEN
 IF receipt.operation<>p_operation OR receipt.request_hash<>hash THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 RETURN fi_control.result(receipt.http_status,receipt.response_body,true);
 END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=p_id AND idempotency_key=p_key)
 THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 IF clock_timestamp()>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 SELECT * INTO b FROM fi.posttrade_books WHERE sandbox_id=p_id FOR UPDATE;
 IF p_operation='INITIALIZE' THEN
 IF b.sandbox_id IS NOT NULL THEN RETURN fi_control.failure(409,'POSTTRADE_ALREADY_INITIALIZED');END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key) IS DISTINCT FROM ARRAY['economic_start_date']::text[]
 OR jsonb_typeof(p_payload->'economic_start_date')<>'string'
 OR p_payload->>'economic_start_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 BEGIN start_date:=(p_payload->>'economic_start_date')::date;
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END;
 end_date:=fi_control.posttrade_window_end(start_date);
 IF end_date IS NULL THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 INSERT INTO fi.posttrade_books(sandbox_id,economic_start_date,economic_end_date) VALUES(p_id,start_date,end_date);
 INSERT INTO fi.posttrade_security_balances(sandbox_id,instrument_revision) VALUES(p_id,'phase1-ust-1'),(p_id,'phase1-corp-1');
 body:=jsonb_build_object('model_version','OWNED_POSTTRADE_SOURCE_V1','sandbox_id',p_id,'window',jsonb_build_object('start',start_date,'end',end_date),'opening_cash_cents','10000000000','posttrade_command_seq','1');
 events:=jsonb_build_array(jsonb_build_object('event_type','FUNDING','cash_cents','10000000000'));
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,201,body,events);
 END IF;
 IF b.sandbox_id IS NULL THEN RETURN fi_control.failure(409,'POSTTRADE_NOT_INITIALIZED');END IF;
 IF p_operation='REGISTER' THEN
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key) IS DISTINCT FROM ARRAY['execution_id']::text[]
 OR jsonb_typeof(p_payload->'execution_id')<>'string'
 OR p_payload->>'execution_id' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 SELECT * INTO x FROM fi.executions WHERE sandbox_id=p_id AND id=(p_payload->>'execution_id')::uuid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'EXECUTION_NOT_FOUND');END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_roots WHERE sandbox_id=p_id AND execution_id=x.id)
 THEN RETURN fi_control.failure(409,'EXECUTION_ALREADY_REGISTERED');END IF;
 IF (SELECT count(*) FROM fi.posttrade_roots WHERE sandbox_id=p_id)>=8 THEN RETURN fi_control.failure(429,'POSTTRADE_ROOT_LIMIT');END IF;
 IF x.instrument_revision NOT IN ('phase1-ust-1','phase1-corp-1') OR x.settlement_date<b.economic_start_date
 OR x.settlement_date>=b.economic_end_date OR extract(isodow FROM x.settlement_date)>5
 THEN RETURN fi_control.failure(409,'EXECUTION_OUTSIDE_ECONOMIC_WINDOW');END IF;
 seq:=b.command_count+1;sign:=CASE WHEN x.side='BUY' THEN 1 ELSE -1 END;
 INSERT INTO fi.posttrade_roots(sandbox_id,execution_id,raw_command_seq,instrument_revision,side,par_amount,settlement_date,original_clean_price,original_consideration_cents,registration_seq,raw_recorded_at)
 VALUES(p_id,x.id,x.command_seq,x.instrument_revision,x.side,x.par_amount,x.settlement_date,x.clean_price,x.consideration_cents,seq,x.recorded_at);
 INSERT INTO fi.posttrade_revisions(sandbox_id,execution_id,revision,clean_price,consideration_cents,command_seq)
 VALUES(p_id,x.id,0,x.clean_price,x.consideration_cents,seq);
 body:=jsonb_build_object('execution_id',x.id,'revision',0,'posttrade_command_seq',seq::text);
 events:=jsonb_build_array(jsonb_build_object('event_type','REGISTERED','execution_id',x.id,'instrument_revision',x.instrument_revision,
 'economic_cash_cents',(-sign*x.consideration_cents)::text,'economic_par_amount',(sign*x.par_amount)::text));
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,201,body,events);
 END IF;
 RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;

CREATE FUNCTION fi_control.read_posttrade(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_raw bigint DEFAULT NULL,p_post bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE;b fi.posttrade_books%ROWTYPE;raw_seq bigint;post_seq bigint;roots jsonb;reasons jsonb:='[]';raw_count integer;
BEGIN
 SELECT * INTO s FROM fi.sandboxes WHERE id=p_id;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR p_generation IS NULL OR s.generation<>p_generation
 THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO b FROM fi.posttrade_books WHERE sandbox_id=p_id;
 raw_seq:=COALESCE(p_raw,s.command_count);post_seq:=COALESCE(p_post,b.command_count,0);
 IF raw_seq<0 OR raw_seq>s.command_count OR post_seq<0 OR post_seq>COALESCE(b.command_count,0)
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 IF post_seq=0 THEN b:=NULL;END IF;
 SELECT count(*) INTO raw_count FROM fi.executions WHERE sandbox_id=p_id AND command_seq<=raw_seq;
 IF b.sandbox_id IS NULL THEN reasons:=reasons||'"POSTTRADE_NOT_INITIALIZED"'::jsonb;END IF;
 IF raw_count>8 THEN reasons:=reasons||'"ROOT_LIMIT_EXCEEDED"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_roots WHERE sandbox_id=p_id AND registration_seq<=post_seq AND raw_command_seq>raw_seq)
 THEN reasons:=reasons||'"SOURCE_CUTOFF_INCOHERENT"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM fi.executions x WHERE x.sandbox_id=p_id AND x.command_seq<=raw_seq AND NOT EXISTS(
 SELECT 1 FROM fi.posttrade_roots r WHERE (r.sandbox_id,r.execution_id)=(x.sandbox_id,x.id) AND r.registration_seq<=post_seq))
 THEN reasons:=reasons||'"UNREGISTERED_EXECUTION"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM fi.executions x WHERE x.sandbox_id=p_id AND x.command_seq<=raw_seq AND
 (x.instrument_revision NOT IN ('phase1-ust-1','phase1-corp-1') OR extract(isodow FROM x.settlement_date)>5 OR x.settlement_date<b.economic_start_date OR x.settlement_date>=b.economic_end_date))
 THEN reasons:=reasons||'"EXECUTION_OUTSIDE_ECONOMIC_WINDOW"'::jsonb;END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
 'execution_id',x.id,'command_seq',x.command_seq::text,'instrument_id',iv.instrument_id,'definition_version',x.instrument_revision,
 'side',x.side,'par_amount',x.par_amount::text,'value_date',x.settlement_date,
 'original_consideration_cents',x.consideration_cents::text,'original_clean_price',x.clean_price,
 'raw_recorded_at',x.recorded_at,'registered',r.execution_id IS NOT NULL,
 'registration_seq',r.registration_seq::text,'current_revision',v.revision,
 'active_clean_price',v.clean_price,'active_consideration_cents',v.consideration_cents::text,
 'busted',bu.execution_id IS NOT NULL,'settlement_state',CASE WHEN bu.execution_id IS NOT NULL THEN 'VOIDED' ELSE COALESCE(o.outcome,'PENDING') END
 ) ORDER BY x.command_seq,x.id),'[]'::jsonb) INTO roots
 FROM fi.executions x JOIN fi.instrument_versions iv ON iv.id=x.instrument_revision
 LEFT JOIN fi.posttrade_roots r ON (r.sandbox_id,r.execution_id)=(x.sandbox_id,x.id) AND r.registration_seq<=post_seq
 LEFT JOIN LATERAL(SELECT * FROM fi.posttrade_revisions rv WHERE (rv.sandbox_id,rv.execution_id)=(r.sandbox_id,r.execution_id) AND rv.command_seq<=post_seq ORDER BY rv.revision DESC LIMIT 1) v ON true
 LEFT JOIN fi.posttrade_busts bu ON (bu.sandbox_id,bu.execution_id)=(r.sandbox_id,r.execution_id) AND bu.command_seq<=post_seq
 LEFT JOIN LATERAL(SELECT outcome FROM fi.posttrade_settlement_outcomes so WHERE (so.sandbox_id,so.execution_id,so.revision)=(r.sandbox_id,r.execution_id,v.revision) AND so.command_seq<=post_seq ORDER BY command_seq DESC LIMIT 1) o ON true
 WHERE x.sandbox_id=p_id AND x.command_seq<=raw_seq AND raw_count<=8;
 RETURN fi_control.result(200,jsonb_build_object('model_version','OWNED_POSTTRADE_SOURCE_V1','sandbox_id',p_id,'generation',s.generation::text,
 'raw_command_seq',raw_seq::text,'last_execution_command_seq',(SELECT COALESCE(max(command_seq),0)::text FROM fi.executions WHERE sandbox_id=p_id AND command_seq<=raw_seq),
 'posttrade_command_seq',post_seq::text,'last_adjustment_seq',(SELECT COALESCE(max(command_seq),0)::text FROM fi.posttrade_commands WHERE sandbox_id=p_id AND command_seq<=post_seq AND operation IN ('CORRECT','BUST')),
 'initialized',b.sandbox_id IS NOT NULL,'window',CASE WHEN b.sandbox_id IS NOT NULL THEN jsonb_build_object('start',b.economic_start_date,'end',b.economic_end_date) END,
 'opening_cash_cents',CASE WHEN b.sandbox_id IS NOT NULL THEN '10000000000' END,
 'available_cash_cents',CASE WHEN b.sandbox_id IS NOT NULL THEN (SELECT COALESCE(sum(cash_cents),0)::text FROM fi.posttrade_events WHERE sandbox_id=p_id AND command_seq<=post_seq) END,
 'available_securities',CASE WHEN b.sandbox_id IS NOT NULL THEN (SELECT jsonb_agg(jsonb_build_object('instrument_id',iv.instrument_id,'available_par',COALESCE(e.par,0)::text) ORDER BY iv.id)
 FROM fi.instrument_versions iv LEFT JOIN LATERAL(SELECT sum(par_amount) par FROM fi.posttrade_events WHERE sandbox_id=p_id AND command_seq<=post_seq AND instrument_revision=iv.id) e ON true WHERE iv.id IN ('phase1-ust-1','phase1-corp-1')) END,
 'processing_date_watermark',(SELECT max(processing_date) FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=p_id AND command_seq<=post_seq),
 'raw_execution_count',raw_count,'inventory_truncated',raw_count>8,'roots',roots,'coverage',jsonb_build_object('complete',jsonb_array_length(reasons)=0,'reasons',reasons)));
END $$;
GRANT EXECUTE ON FUNCTION fi_control.posttrade_command(uuid,text,bigint,text,jsonb,text,uuid),
 fi_control.read_posttrade(uuid,text,text,bigint,bigint,bigint) TO tf_app;

CREATE FUNCTION fi_control.posttrade_book_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.sandbox_id,NEW.economic_start_date,NEW.economic_end_date,NEW.created_at)
 IS DISTINCT FROM (OLD.sandbox_id,OLD.economic_start_date,OLD.economic_end_date,OLD.created_at)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Immutable economic window';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_window BEFORE UPDATE ON fi.posttrade_books FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_book_identity();
ALTER TABLE fi.posttrade_roots ADD UNIQUE(sandbox_id,registration_seq);
ALTER TABLE fi.posttrade_roots ADD FOREIGN KEY(sandbox_id,registration_seq)
 REFERENCES fi.posttrade_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fi.posttrade_revisions ADD UNIQUE(sandbox_id,command_seq);
ALTER TABLE fi.posttrade_revisions ADD FOREIGN KEY(sandbox_id,command_seq)
 REFERENCES fi.posttrade_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fi.posttrade_busts ADD UNIQUE(sandbox_id,command_seq);
ALTER TABLE fi.posttrade_busts ADD FOREIGN KEY(sandbox_id,command_seq)
 REFERENCES fi.posttrade_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fi.posttrade_settlement_outcomes ADD UNIQUE(sandbox_id,command_seq);
ALTER TABLE fi.posttrade_settlement_outcomes ADD FOREIGN KEY(sandbox_id,command_seq)
 REFERENCES fi.posttrade_commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED;
