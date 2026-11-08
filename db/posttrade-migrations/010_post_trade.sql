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
 operation text NOT NULL CHECK(operation IN ('INITIALIZE','REGISTER','CORRECT_PRICE','BUST','SETTLE','REVERSE')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object' AND octet_length(request_payload::text)<=2048),
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
 WHEN 'CORRECT_PRICE' THEN ARRAY['COMPENSATE','REPLACEMENT'] WHEN 'BUST' THEN ARRAY['BUST']
 WHEN 'REVERSE' THEN ARRAY['CASH_REVERSED','SECURITY_REVERSED']
 WHEN 'SETTLE' THEN CASE WHEN c.http_status=409 THEN ARRAY['SETTLEMENT_FAILED'] ELSE ARRAY['CASH_POSTED','SECURITY_POSTED'] END END)
 OR EXISTS(SELECT 1 FROM fi.posttrade_revisions v JOIN fi.posttrade_commands c USING(sandbox_id,command_seq)
 WHERE v.sandbox_id=sid AND c.operation<>CASE WHEN v.revision=0 THEN 'REGISTER' ELSE 'CORRECT_PRICE' END)
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
 CASE WHEN c.operation IN ('CORRECT_PRICE','REVERSE') OR (c.operation='SETTLE' AND c.http_status=200) THEN 2 ELSE 1 END)
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

CREATE FUNCTION fi_control.record_posttrade(sid uuid,p_key text,p_hash text,p_op text,p_generation bigint,p_actor uuid,p_status integer,p_body jsonb,p_events jsonb,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE seq bigint;item jsonb;i integer:=0;n integer;
BEGIN
 n:=jsonb_array_length(p_events);
 IF n NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Invalid post-trade event cost';END IF;
 UPDATE fi.posttrade_books SET command_count=command_count+1,event_count=event_count+n
 WHERE sandbox_id=sid RETURNING command_count INTO STRICT seq;
 INSERT INTO fi.posttrade_commands(sandbox_id,idempotency_key,operation,request_hash,request_payload,command_seq,capability_generation,actor_id,http_status,response_body)
 VALUES(sid,p_key,p_op,p_hash,p_payload,seq,p_generation,p_actor,p_status,p_body);
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


-- Integer comparisons certify the original periodic-yield quote bracket;
-- no floating point or transcendental approximation determines cash admission.
CREATE FUNCTION fi_control.posttrade_integer_power(n numeric,e integer) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result numeric:=1;base numeric:=n;k integer:=e;
BEGIN
 IF n<0 OR n<>trunc(n) OR e<0 OR e>184 OR n IS NULL OR e IS NULL THEN RAISE EXCEPTION 'Invalid bounded integer power';END IF;
 WHILE k>0 LOOP
 IF k%2=1 THEN result:=result*base;END IF;
 k:=k/2;IF k>0 THEN base:=base*base;END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION fi_control.posttrade_quote_valid(contract jsonb,quote text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a integer[];following date;n integer;i integer;j integer;bn integer;bd integer;
 an numeric;ad numeric;tn numeric;td numeric;c numeric;left_value numeric;right_value numeric;
BEGIN
 IF quote IS NULL OR quote !~ '^(0|[1-9][0-9]{0,4})\.[0-9]{12}$' THEN RETURN false;END IF;
 a:=fi_control.execution_accrual(contract);
 following:=fi_control.posttrade_window_end((contract->>'settlement_date')::date);
 n:=1+((2031-extract(year FROM following)::integer)*12+1-extract(month FROM following)::integer)/6;
 IF n NOT BETWEEN 1 AND 12 THEN RETURN false;END IF;
 c:=quote::numeric*1000000000000;td:=1000000000000::numeric*a[2];
 FOR j IN 1..2 LOOP
 bn:=CASE WHEN j=1 THEN 3 ELSE 19 END;bd:=CASE WHEN j=1 THEN 2 ELSE 20 END;
 an:=0;
 FOR i IN 0..n-1 LOOP
 an:=an+(CASE WHEN i=n-1 THEN 102 ELSE 2 END)*
 fi_control.posttrade_integer_power(bd,i)*fi_control.posttrade_integer_power(bn,n-1-i);
 END LOOP;
 ad:=fi_control.posttrade_integer_power(bn,n-1);
 tn:=c*a[2]+2*a[1]*1000000000000::numeric+(CASE WHEN j=1 THEN 50 ELSE -50 END)*a[2];
 IF tn<=0 THEN IF j=1 THEN RETURN false;ELSE CONTINUE;END IF;END IF;
 left_value:=fi_control.posttrade_integer_power(an*td,a[2])*fi_control.posttrade_integer_power(bd,a[2]-a[1]);
 right_value:=fi_control.posttrade_integer_power(ad*tn,a[2])*fi_control.posttrade_integer_power(bn,a[2]-a[1]);
 IF (j=1 AND left_value>right_value) OR (j=2 AND left_value<right_value) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION fi_control.posttrade_command(p_id uuid,p_proof text,p_generation bigint,p_operation text,p_payload jsonb,p_key text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE;b fi.posttrade_books%ROWTYPE;receipt fi.posttrade_commands%ROWTYPE;
 r fi.posttrade_roots%ROWTYPE;v fi.posttrade_revisions%ROWTYPE;original_contract jsonb;quote text;corrected_cash bigint;recorded timestamptz;
 process_date date;posting fi.posttrade_settlement_outcomes%ROWTYPE;cash_delta bigint;par_delta numeric;security_par numeric;failure_code text;outcome_id uuid;
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
 body:=jsonb_build_object('model_version','OWNED_POSTTRADE_SOURCE_V1','settlement_model_version','SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1','sandbox_id',p_id,'window',jsonb_build_object('start',start_date,'end',end_date),'opening_cash_cents','10000000000','posttrade_command_seq','1');
 events:=jsonb_build_array(jsonb_build_object('event_type','FUNDING','cash_cents','10000000000'));
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,201,body,events,p_payload);
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
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,201,body,events,p_payload);
 END IF;

 IF p_operation IN ('CORRECT_PRICE','BUST') THEN
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key)
 IS DISTINCT FROM (CASE WHEN p_operation='CORRECT_PRICE' THEN ARRAY['clean_price','execution_id','expected_revision'] ELSE ARRAY['execution_id','expected_revision'] END)
 OR jsonb_typeof(p_payload->'execution_id')<>'string'
 OR p_payload->>'execution_id' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 OR jsonb_typeof(p_payload->'expected_revision')<>'number' OR p_payload->>'expected_revision' !~ '^[0-2]$'
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 IF p_operation='CORRECT_PRICE' AND (jsonb_typeof(p_payload->'clean_price')<>'string'
 OR p_payload->>'clean_price' !~ '^(0|[1-9][0-9]{0,4})\.[0-9]{12}$')
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 SELECT * INTO r FROM fi.posttrade_roots WHERE sandbox_id=p_id AND execution_id=(p_payload->>'execution_id')::uuid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'EXECUTION_NOT_REGISTERED');END IF;
 SELECT * INTO v FROM fi.posttrade_revisions WHERE sandbox_id=p_id AND execution_id=r.execution_id ORDER BY revision DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM fi.posttrade_busts WHERE sandbox_id=p_id AND execution_id=r.execution_id)
 THEN RETURN fi_control.failure(409,'EXECUTION_BUSTED');END IF;
 IF v.revision<>(p_payload->>'expected_revision')::integer THEN RETURN fi_control.failure(409,'ADJUSTMENT_REVISION_CONFLICT');END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes so WHERE (so.sandbox_id,so.execution_id,so.revision)=(p_id,r.execution_id,v.revision) AND so.outcome='SETTLED')
 AND NOT EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes so WHERE (so.sandbox_id,so.execution_id,so.revision)=(p_id,r.execution_id,v.revision) AND so.outcome='REVERSED')
 THEN RETURN fi_control.failure(409,'SETTLEMENT_REVERSAL_REQUIRED');END IF;
 seq:=b.command_count+1;sign:=CASE WHEN r.side='BUY' THEN 1 ELSE -1 END;
 IF p_operation='CORRECT_PRICE' THEN
 IF v.revision>=2 THEN RETURN fi_control.failure(409,'CORRECTION_LIMIT_REACHED');END IF;
 SELECT o.contract INTO STRICT original_contract FROM fi.orders o JOIN fi.executions e ON(e.sandbox_id,e.order_id)=(o.sandbox_id,o.id)
 WHERE e.sandbox_id=p_id AND e.id=r.execution_id;
 quote:=p_payload->>'clean_price';
 IF NOT fi_control.posttrade_quote_valid(original_contract,quote) THEN RETURN fi_control.failure(400,'QUOTE_OUTSIDE_PRICING_RANGE');END IF;
 corrected_cash:=fi_control.execution_cents(original_contract||jsonb_build_object('clean_price',quote),r.par_amount);
 INSERT INTO fi.posttrade_revisions(sandbox_id,execution_id,revision,clean_price,consideration_cents,command_seq)
 VALUES(p_id,r.execution_id,v.revision+1,quote,corrected_cash,seq) RETURNING recorded_at INTO recorded;
 events:=jsonb_build_array(jsonb_build_object('event_type','COMPENSATE','execution_id',r.execution_id,'instrument_revision',r.instrument_revision,
 'economic_cash_cents',(sign*v.consideration_cents)::text,'economic_par_amount',(-sign*r.par_amount)::text),
 jsonb_build_object('event_type','REPLACEMENT','execution_id',r.execution_id,'instrument_revision',r.instrument_revision,
 'economic_cash_cents',(-sign*corrected_cash)::text,'economic_par_amount',(sign*r.par_amount)::text));
 body:=jsonb_build_object('execution_id',r.execution_id,'revision',v.revision+1,'clean_price',quote,'consideration_cents',corrected_cash::text,
 'posttrade_command_seq',seq::text,'recorded_at',to_char(recorded AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 ELSE
 INSERT INTO fi.posttrade_busts(sandbox_id,execution_id,revision,command_seq)
 VALUES(p_id,r.execution_id,v.revision,seq) RETURNING recorded_at INTO recorded;
 events:=jsonb_build_array(jsonb_build_object('event_type','BUST','execution_id',r.execution_id,'instrument_revision',r.instrument_revision,
 'economic_cash_cents',(sign*v.consideration_cents)::text,'economic_par_amount',(-sign*r.par_amount)::text));
 body:=jsonb_build_object('execution_id',r.execution_id,'revision',v.revision,'busted',true,'posttrade_command_seq',seq::text,
 'recorded_at',to_char(recorded AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 END IF;
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,201,body,events,p_payload);
 END IF;

 IF p_operation IN ('SETTLE','REVERSE') THEN
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key)
 IS DISTINCT FROM ARRAY['execution_id','expected_revision','processing_date']::text[]
 OR jsonb_typeof(p_payload->'execution_id')<>'string'
 OR p_payload->>'execution_id' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 OR jsonb_typeof(p_payload->'expected_revision')<>'number' OR p_payload->>'expected_revision' !~ '^[0-2]$'
 OR jsonb_typeof(p_payload->'processing_date')<>'string'
 OR p_payload->>'processing_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 BEGIN process_date:=(p_payload->>'processing_date')::date;
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END;
 IF extract(isodow FROM process_date)>5 THEN RETURN fi_control.failure(400,'PROCESSING_DATE_NOT_WEEKDAY');END IF;
 SELECT * INTO r FROM fi.posttrade_roots WHERE sandbox_id=p_id AND execution_id=(p_payload->>'execution_id')::uuid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'EXECUTION_NOT_REGISTERED');END IF;
 SELECT * INTO v FROM fi.posttrade_revisions WHERE sandbox_id=p_id AND execution_id=r.execution_id ORDER BY revision DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM fi.posttrade_busts WHERE sandbox_id=p_id AND execution_id=r.execution_id)
 THEN RETURN fi_control.failure(409,'EXECUTION_BUSTED');END IF;
 IF v.revision<>(p_payload->>'expected_revision')::integer THEN RETURN fi_control.failure(409,'ADJUSTMENT_REVISION_CONFLICT');END IF;
 IF process_date<r.settlement_date OR process_date<b.economic_start_date OR process_date>=b.economic_end_date
 OR process_date<b.last_processing_date THEN RETURN fi_control.failure(409,'PROCESSING_DATE_CONFLICT');END IF;
 SELECT * INTO posting FROM fi.posttrade_settlement_outcomes so
 WHERE(so.sandbox_id,so.execution_id,so.revision)=(p_id,r.execution_id,v.revision) AND so.outcome='SETTLED';
 IF p_operation='SETTLE' AND posting.id IS NOT NULL THEN
 RETURN fi_control.failure(409,CASE WHEN EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes so
 WHERE(so.sandbox_id,so.execution_id,so.revision)=(p_id,r.execution_id,v.revision) AND so.outcome='REVERSED')
 THEN 'SETTLEMENT_ALREADY_REVERSED' ELSE 'SETTLEMENT_ALREADY_POSTED' END);END IF;
 IF p_operation='REVERSE' THEN
 IF posting.id IS NULL THEN RETURN fi_control.failure(409,'SETTLEMENT_NOT_POSTED');END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes so
 WHERE(so.sandbox_id,so.execution_id,so.revision)=(p_id,r.execution_id,v.revision) AND so.outcome='REVERSED')
 THEN RETURN fi_control.failure(409,'SETTLEMENT_ALREADY_REVERSED');END IF;
 IF process_date<posting.processing_date THEN RETURN fi_control.failure(409,'PROCESSING_DATE_CONFLICT');END IF;
 END IF;
 sign:=CASE WHEN r.side='BUY' THEN 1 ELSE -1 END;
 cash_delta:=-sign*v.consideration_cents;par_delta:=sign*r.par_amount;
 IF p_operation='REVERSE' THEN cash_delta:=-cash_delta;par_delta:=-par_delta;END IF;
 SELECT available_par INTO STRICT security_par FROM fi.posttrade_security_balances
 WHERE sandbox_id=p_id AND instrument_revision=r.instrument_revision;
 failure_code:=CASE WHEN b.cash_cents+cash_delta<0 THEN 'INSUFFICIENT_CASH'
 WHEN security_par+par_delta<0 THEN 'INSUFFICIENT_SECURITIES' END;
 IF failure_code IS NOT NULL AND p_operation='REVERSE' THEN RETURN fi_control.failure(409,failure_code);END IF;
 seq:=b.command_count+1;
 IF failure_code IS NOT NULL THEN
 IF (SELECT count(*) FROM fi.posttrade_settlement_outcomes so WHERE so.sandbox_id=p_id AND so.execution_id=r.execution_id AND so.outcome='FAILED')>=2
 THEN RETURN fi_control.failure(429,'SETTLEMENT_FAILURE_LIMIT');END IF;
 INSERT INTO fi.posttrade_settlement_outcomes(sandbox_id,execution_id,revision,outcome,processing_date,reason,command_seq)
 VALUES(p_id,r.execution_id,v.revision,'FAILED',process_date,failure_code,seq) RETURNING id,recorded_at INTO outcome_id,recorded;
 UPDATE fi.posttrade_books SET last_processing_date=process_date WHERE sandbox_id=p_id;
 body:=jsonb_build_object('execution_id',r.execution_id,'revision',v.revision,'settlement_state','FAILED','settlement_model_version','SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1','reason',failure_code,
 'processing_date',process_date,'outcome_id',outcome_id,'posttrade_command_seq',seq::text,
 'recorded_at',to_char(recorded AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 events:=jsonb_build_array(jsonb_build_object('event_type','SETTLEMENT_FAILED','execution_id',r.execution_id,'instrument_revision',r.instrument_revision));
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,409,body,events,p_payload);
 END IF;
 INSERT INTO fi.posttrade_settlement_outcomes(sandbox_id,execution_id,revision,outcome,processing_date,posting_id,command_seq)
 VALUES(p_id,r.execution_id,v.revision,CASE WHEN p_operation='SETTLE' THEN 'SETTLED' ELSE 'REVERSED' END,
 process_date,CASE WHEN p_operation='REVERSE' THEN posting.id END,seq) RETURNING id,recorded_at INTO outcome_id,recorded;
 UPDATE fi.posttrade_books SET last_processing_date=process_date WHERE sandbox_id=p_id;
 events:=jsonb_build_array(jsonb_build_object('event_type',CASE WHEN p_operation='SETTLE' THEN 'CASH_POSTED' ELSE 'CASH_REVERSED' END,
 'execution_id',r.execution_id,'instrument_revision',r.instrument_revision,'cash_cents',cash_delta::text),
 jsonb_build_object('event_type',CASE WHEN p_operation='SETTLE' THEN 'SECURITY_POSTED' ELSE 'SECURITY_REVERSED' END,
 'execution_id',r.execution_id,'instrument_revision',r.instrument_revision,'par_amount',par_delta::text));
 body:=jsonb_build_object('execution_id',r.execution_id,'revision',v.revision,
 'settlement_state',CASE WHEN p_operation='SETTLE' THEN 'SETTLED' ELSE 'REVERSED' END,'settlement_model_version','SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1',
 'processing_date',process_date,'outcome_id',outcome_id,'posttrade_command_seq',seq::text,
 'recorded_at',to_char(recorded AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 RETURN fi_control.record_posttrade(p_id,p_key,hash,p_operation,p_generation,p_actor,200,body,events,p_payload);
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
 'busted',bu.execution_id IS NOT NULL,'settlement_state',CASE WHEN r.execution_id IS NULL THEN NULL WHEN bu.execution_id IS NOT NULL THEN 'VOIDED' ELSE COALESCE(o.outcome,'PENDING') END
 ) ORDER BY x.command_seq,x.id),'[]'::jsonb) INTO roots
 FROM fi.executions x JOIN fi.instrument_versions iv ON iv.id=x.instrument_revision
 LEFT JOIN fi.posttrade_roots r ON (r.sandbox_id,r.execution_id)=(x.sandbox_id,x.id) AND r.registration_seq<=post_seq
 LEFT JOIN LATERAL(SELECT * FROM fi.posttrade_revisions rv WHERE (rv.sandbox_id,rv.execution_id)=(r.sandbox_id,r.execution_id) AND rv.command_seq<=post_seq ORDER BY rv.revision DESC LIMIT 1) v ON true
 LEFT JOIN fi.posttrade_busts bu ON (bu.sandbox_id,bu.execution_id)=(r.sandbox_id,r.execution_id) AND bu.command_seq<=post_seq
 LEFT JOIN LATERAL(SELECT outcome FROM fi.posttrade_settlement_outcomes so WHERE (so.sandbox_id,so.execution_id,so.revision)=(r.sandbox_id,r.execution_id,v.revision) AND so.command_seq<=post_seq ORDER BY command_seq DESC LIMIT 1) o ON true
 WHERE x.sandbox_id=p_id AND x.command_seq<=raw_seq AND raw_count<=8;
 RETURN fi_control.result(200,jsonb_build_object('model_version','OWNED_POSTTRADE_SOURCE_V1','settlement_model_version','SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1','sandbox_id',p_id,'generation',s.generation::text,
 'raw_command_seq',raw_seq::text,'last_execution_command_seq',(SELECT COALESCE(max(command_seq),0)::text FROM fi.executions WHERE sandbox_id=p_id AND command_seq<=raw_seq),
 'posttrade_command_seq',post_seq::text,'last_adjustment_seq',(SELECT COALESCE(max(command_seq),0)::text FROM fi.posttrade_commands WHERE sandbox_id=p_id AND command_seq<=post_seq AND operation IN ('CORRECT_PRICE','BUST')),
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


CREATE FUNCTION fi_control.posttrade_adjustments_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid:=NEW.sandbox_id;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fi.posttrade_books WHERE sandbox_id=sid) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_revisions WHERE sandbox_id=sid GROUP BY execution_id HAVING count(*)<>max(revision)+1)
 OR EXISTS(SELECT 1 FROM fi.posttrade_busts bu JOIN fi.posttrade_revisions v USING(sandbox_id,execution_id)
 WHERE bu.sandbox_id=sid AND (v.revision>bu.revision OR v.command_seq>bu.command_seq))
 OR EXISTS(SELECT 1 FROM fi.posttrade_revisions v JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 JOIN fi.executions x ON(x.sandbox_id,x.id)=(r.sandbox_id,r.execution_id)
 JOIN fi.orders o ON(o.sandbox_id,o.id)=(x.sandbox_id,x.order_id)
 WHERE v.sandbox_id=sid AND v.revision>0 AND (NOT fi_control.posttrade_quote_valid(o.contract,v.clean_price)
 OR v.consideration_cents<>fi_control.execution_cents(o.contract||jsonb_build_object('clean_price',v.clean_price),r.par_amount)))
 OR (SELECT COALESCE(sum(economic_cash_cents),0) FROM fi.posttrade_events WHERE sandbox_id=sid)<>
 (SELECT COALESCE(sum(CASE WHEN r.side='BUY' THEN -v.consideration_cents ELSE v.consideration_cents END),0)
 FROM fi.posttrade_roots r JOIN LATERAL(SELECT * FROM fi.posttrade_revisions v WHERE (v.sandbox_id,v.execution_id)=(r.sandbox_id,r.execution_id) ORDER BY revision DESC LIMIT 1) v ON true
 WHERE r.sandbox_id=sid AND NOT EXISTS(SELECT 1 FROM fi.posttrade_busts bu WHERE (bu.sandbox_id,bu.execution_id)=(r.sandbox_id,r.execution_id)))
 OR EXISTS(SELECT 1 FROM fi.instrument_versions iv WHERE iv.id IN ('phase1-ust-1','phase1-corp-1') AND
 (SELECT COALESCE(sum(economic_par_amount),0) FROM fi.posttrade_events WHERE sandbox_id=sid AND instrument_revision=iv.id)<>
 (SELECT COALESCE(sum(CASE WHEN r.side='BUY' THEN r.par_amount ELSE -r.par_amount END),0) FROM fi.posttrade_roots r WHERE r.sandbox_id=sid AND r.instrument_revision=iv.id
 AND NOT EXISTS(SELECT 1 FROM fi.posttrade_busts bu WHERE (bu.sandbox_id,bu.execution_id)=(r.sandbox_id,r.execution_id))))
 OR EXISTS(SELECT 1 FROM fi.posttrade_events e LEFT JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 WHERE e.sandbox_id=sid AND (
 (e.event_type<>'FUNDING' AND (r.execution_id IS NULL OR e.instrument_revision IS DISTINCT FROM r.instrument_revision))
 OR (e.event_type IN ('REGISTERED','COMPENSATE','REPLACEMENT','BUST') AND (e.cash_cents<>0 OR e.par_amount<>0))
 OR (e.event_type NOT IN ('REGISTERED','COMPENSATE','REPLACEMENT','BUST') AND (e.economic_cash_cents<>0 OR e.economic_par_amount<>0))))
 OR EXISTS(SELECT 1 FROM fi.posttrade_events e JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 JOIN fi.posttrade_revisions v ON(v.sandbox_id,v.execution_id,v.command_seq)=(e.sandbox_id,e.execution_id,e.command_seq)
 WHERE e.sandbox_id=sid AND e.event_type IN ('REGISTERED','REPLACEMENT') AND
 (e.economic_cash_cents,e.economic_par_amount) IS DISTINCT FROM
 (CASE WHEN r.side='BUY' THEN -v.consideration_cents ELSE v.consideration_cents END,
 CASE WHEN r.side='BUY' THEN r.par_amount ELSE -r.par_amount END))
 OR EXISTS(SELECT 1 FROM fi.posttrade_events e JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 JOIN fi.posttrade_revisions v ON(v.sandbox_id,v.execution_id,v.command_seq)=(e.sandbox_id,e.execution_id,e.command_seq)
 JOIN fi.posttrade_revisions prior_v ON(prior_v.sandbox_id,prior_v.execution_id,prior_v.revision)=(v.sandbox_id,v.execution_id,v.revision-1)
 WHERE e.sandbox_id=sid AND e.event_type='COMPENSATE' AND
 (e.economic_cash_cents,e.economic_par_amount) IS DISTINCT FROM
 (CASE WHEN r.side='BUY' THEN prior_v.consideration_cents ELSE -prior_v.consideration_cents END,
 CASE WHEN r.side='BUY' THEN -r.par_amount ELSE r.par_amount END))
 OR EXISTS(SELECT 1 FROM fi.posttrade_events e JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 JOIN fi.posttrade_busts bu ON(bu.sandbox_id,bu.execution_id,bu.command_seq)=(e.sandbox_id,e.execution_id,e.command_seq)
 JOIN fi.posttrade_revisions v ON(v.sandbox_id,v.execution_id,v.revision)=(bu.sandbox_id,bu.execution_id,bu.revision)
 WHERE e.sandbox_id=sid AND e.event_type='BUST' AND
 (e.economic_cash_cents,e.economic_par_amount) IS DISTINCT FROM
 (CASE WHEN r.side='BUY' THEN v.consideration_cents ELSE -v.consideration_cents END,
 CASE WHEN r.side='BUY' THEN -r.par_amount ELSE r.par_amount END))
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Inconsistent immutable post-trade adjustments';END IF;
 RETURN NULL;
END $$;
DO $integrity$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['posttrade_roots','posttrade_revisions','posttrade_busts','posttrade_commands','posttrade_events'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER adjustment_complete AFTER INSERT ON fi.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_adjustments_consistent()',t);
 END LOOP;
END $integrity$;


CREATE FUNCTION fi_control.posttrade_payloads_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid;
BEGIN
 IF TG_TABLE_NAME='command_keys' THEN
 IF TG_OP='DELETE' THEN
 IF OLD.domain<>'POSTTRADE' THEN RETURN NULL;END IF;sid:=OLD.sandbox_id;
 ELSE
 IF NEW.domain<>'POSTTRADE' AND (TG_OP='INSERT' OR OLD.domain<>'POSTTRADE') THEN RETURN NULL;END IF;sid:=NEW.sandbox_id;
 END IF;
 ELSE sid:=NEW.sandbox_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.posttrade_books WHERE sandbox_id=sid) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM fi.posttrade_commands c WHERE c.sandbox_id=sid AND
 (c.request_hash<>encode(sha256(convert_to(jsonb_build_object('version','OWNED_POSTTRADE_COMMAND_V1','sandbox_id',c.sandbox_id,'operation',c.operation,'payload',c.request_payload)::text,'UTF8')),'hex')
 OR c.response_body->>'posttrade_command_seq' IS DISTINCT FROM c.command_seq::text
 OR NOT EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE (k.sandbox_id,k.idempotency_key,k.domain)=(c.sandbox_id,c.idempotency_key,'POSTTRADE'))))
 OR EXISTS(SELECT 1 FROM fi_control.command_keys k WHERE k.sandbox_id=sid AND k.domain='POSTTRADE'
 AND NOT EXISTS(SELECT 1 FROM fi.posttrade_commands c WHERE(c.sandbox_id,c.idempotency_key)=(k.sandbox_id,k.idempotency_key)))
 OR EXISTS(SELECT 1 FROM fi.posttrade_revisions v JOIN fi.posttrade_commands c USING(sandbox_id,command_seq)
 WHERE v.sandbox_id=sid AND ((c.request_payload->>'execution_id')::uuid IS DISTINCT FROM v.execution_id
 OR (c.response_body->>'execution_id')::uuid IS DISTINCT FROM v.execution_id
 OR (c.response_body->>'revision')::integer IS DISTINCT FROM v.revision
 OR (v.revision>0 AND (c.request_payload->>'clean_price' IS DISTINCT FROM v.clean_price
 OR (c.request_payload->>'expected_revision')::integer IS DISTINCT FROM v.revision-1
 OR c.response_body->>'clean_price' IS DISTINCT FROM v.clean_price
 OR c.response_body->>'consideration_cents' IS DISTINCT FROM v.consideration_cents::text))))
 OR EXISTS(SELECT 1 FROM fi.posttrade_busts bu JOIN fi.posttrade_commands c USING(sandbox_id,command_seq)
 WHERE bu.sandbox_id=sid AND (c.operation<>'BUST'
 OR (c.request_payload->>'execution_id')::uuid IS DISTINCT FROM bu.execution_id
 OR (c.request_payload->>'expected_revision')::integer IS DISTINCT FROM bu.revision
 OR (c.response_body->>'execution_id')::uuid IS DISTINCT FROM bu.execution_id
 OR c.response_body->'busted' IS DISTINCT FROM 'true'::jsonb))
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Inconsistent original-key post-trade receipt';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payload_complete AFTER INSERT ON fi.posttrade_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_payloads_consistent();
CREATE CONSTRAINT TRIGGER posttrade_registry_complete AFTER INSERT OR UPDATE OR DELETE ON fi_control.command_keys DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_payloads_consistent();


ALTER TABLE fi.posttrade_settlement_outcomes ADD CHECK(reason IS NULL OR reason IN ('INSUFFICIENT_CASH','INSUFFICIENT_SECURITIES'));
CREATE FUNCTION fi_control.posttrade_settlements_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid:=NEW.sandbox_id;b fi.posttrade_books%ROWTYPE;
BEGIN
 SELECT * INTO b FROM fi.posttrade_books WHERE sandbox_id=sid;IF NOT FOUND THEN RETURN NULL;END IF;
 IF b.last_processing_date IS DISTINCT FROM (SELECT max(processing_date) FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=sid)
 OR EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=sid GROUP BY execution_id
 HAVING count(*) FILTER(WHERE outcome='FAILED')>2 OR count(*) FILTER(WHERE outcome='SETTLED')>3 OR count(*) FILTER(WHERE outcome='REVERSED')>3)
 OR EXISTS(SELECT 1 FROM(SELECT processing_date,lag(processing_date) OVER(ORDER BY command_seq) prior_date
 FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=sid) t WHERE processing_date<prior_date)
 OR EXISTS(SELECT 1 FROM fi.posttrade_commands c WHERE c.sandbox_id=sid AND c.operation IN ('SETTLE','REVERSE')
 AND NOT EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes o WHERE(o.sandbox_id,o.command_seq)=(c.sandbox_id,c.command_seq)))
 OR EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes o JOIN fi.posttrade_roots r USING(sandbox_id,execution_id)
 JOIN fi.posttrade_revisions v USING(sandbox_id,execution_id,revision) JOIN fi.posttrade_commands c ON(c.sandbox_id,c.command_seq)=(o.sandbox_id,o.command_seq)
 WHERE o.sandbox_id=sid AND (
 o.processing_date<r.settlement_date OR o.processing_date<b.economic_start_date OR o.processing_date>=b.economic_end_date
 OR o.command_seq<=v.command_seq
 OR EXISTS(SELECT 1 FROM fi.posttrade_revisions later WHERE(later.sandbox_id,later.execution_id)=(o.sandbox_id,o.execution_id) AND later.revision>o.revision AND later.command_seq<o.command_seq)
 OR EXISTS(SELECT 1 FROM fi.posttrade_busts bu WHERE(bu.sandbox_id,bu.execution_id)=(o.sandbox_id,o.execution_id) AND bu.command_seq<o.command_seq)
 OR c.operation IS DISTINCT FROM CASE WHEN o.outcome='REVERSED' THEN 'REVERSE' ELSE 'SETTLE' END
 OR c.http_status<>CASE WHEN o.outcome='FAILED' THEN 409 ELSE 200 END
 OR (c.request_payload->>'execution_id')::uuid IS DISTINCT FROM o.execution_id
 OR (c.request_payload->>'expected_revision')::integer IS DISTINCT FROM o.revision
 OR (c.request_payload->>'processing_date')::date IS DISTINCT FROM o.processing_date
 OR (c.response_body->>'outcome_id')::uuid IS DISTINCT FROM o.id
 OR (c.response_body->>'execution_id')::uuid IS DISTINCT FROM o.execution_id
 OR (c.response_body->>'revision')::integer IS DISTINCT FROM o.revision
 OR c.response_body->>'settlement_state' IS DISTINCT FROM o.outcome
 OR c.response_body->>'reason' IS DISTINCT FROM o.reason
 OR (c.response_body->>'processing_date')::date IS DISTINCT FROM o.processing_date
 OR (o.outcome='REVERSED' AND NOT EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes original_post
 WHERE(original_post.sandbox_id,original_post.id,original_post.execution_id,original_post.revision,original_post.outcome)=
 (o.sandbox_id,o.posting_id,o.execution_id,o.revision,'SETTLED') AND original_post.command_seq<o.command_seq AND original_post.processing_date<=o.processing_date))
 OR (o.outcome='SETTLED' AND (EXISTS(SELECT 1 FROM fi.posttrade_revisions later WHERE(later.sandbox_id,later.execution_id)=(o.sandbox_id,o.execution_id) AND later.revision>o.revision)
 OR EXISTS(SELECT 1 FROM fi.posttrade_busts bu WHERE(bu.sandbox_id,bu.execution_id)=(o.sandbox_id,o.execution_id)))
 AND NOT EXISTS(SELECT 1 FROM fi.posttrade_settlement_outcomes inverse
 WHERE(inverse.sandbox_id,inverse.execution_id,inverse.revision,inverse.outcome)=(o.sandbox_id,o.execution_id,o.revision,'REVERSED')
 AND inverse.command_seq<COALESCE((SELECT min(later.command_seq) FROM fi.posttrade_revisions later WHERE(later.sandbox_id,later.execution_id)=(o.sandbox_id,o.execution_id) AND later.revision>o.revision),
 (SELECT bu.command_seq FROM fi.posttrade_busts bu WHERE(bu.sandbox_id,bu.execution_id)=(o.sandbox_id,o.execution_id)))))
 OR (o.outcome='FAILED' AND o.reason IS DISTINCT FROM
 CASE WHEN (SELECT COALESCE(sum(cash_cents),0) FROM fi.posttrade_events WHERE sandbox_id=sid AND command_seq<o.command_seq)+
 (CASE WHEN r.side='BUY' THEN -v.consideration_cents ELSE v.consideration_cents END)<0 THEN 'INSUFFICIENT_CASH'
 WHEN (SELECT COALESCE(sum(par_amount),0) FROM fi.posttrade_events WHERE sandbox_id=sid AND command_seq<o.command_seq AND instrument_revision=r.instrument_revision)+
 (CASE WHEN r.side='BUY' THEN r.par_amount ELSE -r.par_amount END)<0 THEN 'INSUFFICIENT_SECURITIES' END)))
 OR EXISTS(SELECT 1 FROM fi.posttrade_events e JOIN fi.posttrade_settlement_outcomes o USING(sandbox_id,command_seq)
 JOIN fi.posttrade_roots r ON(r.sandbox_id,r.execution_id)=(o.sandbox_id,o.execution_id)
 JOIN fi.posttrade_revisions v ON(v.sandbox_id,v.execution_id,v.revision)=(o.sandbox_id,o.execution_id,o.revision)
 WHERE e.sandbox_id=sid AND(
 e.execution_id IS DISTINCT FROM o.execution_id OR e.instrument_revision IS DISTINCT FROM r.instrument_revision
 OR (e.cash_cents,e.par_amount) IS DISTINCT FROM
 (CASE WHEN o.outcome='FAILED' OR e.event_index=1 THEN 0 ELSE
 (CASE WHEN r.side='BUY' THEN -v.consideration_cents ELSE v.consideration_cents END)*(CASE WHEN o.outcome='REVERSED' THEN -1 ELSE 1 END) END,
 CASE WHEN o.outcome='FAILED' OR e.event_index=0 THEN 0::numeric ELSE
 (CASE WHEN r.side='BUY' THEN r.par_amount ELSE -r.par_amount END)*(CASE WHEN o.outcome='REVERSED' THEN -1 ELSE 1 END) END)))
 OR EXISTS(SELECT 1 FROM(SELECT sum(cash_cents) OVER(ORDER BY command_seq,event_index ROWS UNBOUNDED PRECEDING) balance
 FROM fi.posttrade_events WHERE sandbox_id=sid) t WHERE balance<0)
 OR EXISTS(SELECT 1 FROM(SELECT sum(par_amount) OVER(PARTITION BY instrument_revision ORDER BY command_seq,event_index ROWS UNBOUNDED PRECEDING) balance
 FROM fi.posttrade_events WHERE sandbox_id=sid) t WHERE balance<0)
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Inconsistent funded post-trade settlement';END IF;
 RETURN NULL;
END $$;
DO $integrity$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['posttrade_books','posttrade_security_balances','posttrade_settlement_outcomes','posttrade_revisions','posttrade_busts','posttrade_commands','posttrade_events'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER settlement_complete AFTER INSERT OR UPDATE ON fi.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.posttrade_settlements_consistent()',t);
 END LOOP;
END $integrity$;


-- Bounded read-only RPCs keep new tables private to their owner role.
CREATE FUNCTION fi_control.posttrade_readable(sid uuid,proof text,scope text,generation bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM fi.sandboxes s WHERE s.id=sid AND s.generation=$4
 AND fi_control.proof_valid(sid,proof,scope))
$$;
CREATE FUNCTION fi_control.read_posttrade_command(sid uuid,proof text,scope text,generation bigint,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c fi.posttrade_commands%ROWTYPE;
BEGIN
 IF NOT fi_control.posttrade_readable(sid,proof,scope,generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 SELECT * INTO c FROM fi.posttrade_commands WHERE sandbox_id=sid AND idempotency_key=p_key;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'COMMAND_NOT_FOUND');END IF;
 RETURN fi_control.result(200,jsonb_build_object('command',jsonb_build_object('id',c.id,'idempotency_key',c.idempotency_key,
 'operation',c.operation,'command_seq',c.command_seq::text,'capability_generation',c.capability_generation::text,
 'actor_id',c.actor_id,'http_status',c.http_status,'request_hash',c.request_hash,'request_payload',c.request_payload,
 'response_body',c.response_body,'recorded_at',to_char(c.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
END $$;
CREATE FUNCTION fi_control.read_posttrade_history(sid uuid,proof text,scope text,generation bigint,root_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x fi.executions%ROWTYPE;instrument text;revisions jsonb;outcomes jsonb;bust jsonb;registered boolean;
BEGIN
 IF NOT fi_control.posttrade_readable(sid,proof,scope,generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO x FROM fi.executions WHERE sandbox_id=sid AND id=root_id;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'EXECUTION_NOT_FOUND');END IF;
 SELECT instrument_id INTO STRICT instrument FROM fi.instrument_versions WHERE id=x.instrument_revision;
 registered:=EXISTS(SELECT 1 FROM fi.posttrade_roots WHERE sandbox_id=sid AND execution_id=root_id);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('revision',v.revision,'clean_price',v.clean_price,
 'consideration_cents',v.consideration_cents::text,'posttrade_command_seq',v.command_seq::text,
 'recorded_at',to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY v.revision),'[]') INTO revisions
 FROM fi.posttrade_revisions v WHERE v.sandbox_id=sid AND v.execution_id=root_id;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome_id',o.id,'revision',o.revision,'outcome',o.outcome,
 'processing_date',o.processing_date,'reason',o.reason,'posting_id',o.posting_id,'posttrade_command_seq',o.command_seq::text,
 'recorded_at',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY o.command_seq),'[]') INTO outcomes
 FROM fi.posttrade_settlement_outcomes o WHERE o.sandbox_id=sid AND o.execution_id=root_id;
 SELECT jsonb_build_object('revision',b.revision,'posttrade_command_seq',b.command_seq::text,
 'recorded_at',to_char(b.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) INTO bust
 FROM fi.posttrade_busts b WHERE b.sandbox_id=sid AND b.execution_id=root_id;
 RETURN fi_control.result(200,jsonb_build_object('registered',registered,'original_execution',jsonb_build_object(
 'execution_id',x.id,'source_event_id',x.source_event_id,'order_id',x.order_id,'fill_sequence',x.fill_sequence,
 'raw_command_seq',x.command_seq::text,'instrument_id',instrument,'definition_version',x.instrument_revision,
 'side',x.side,'par_amount',x.par_amount::text,'quoted_settlement_date',x.settlement_date,'original_clean_price',x.clean_price,
 'original_consideration_cents',x.consideration_cents::text,
 'raw_decided_at',to_char(x.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'raw_recorded_at',to_char(x.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
 'revisions',revisions,'bust',bust,'settlement_outcomes',outcomes));
END $$;
CREATE FUNCTION fi_control.read_posttrade_audit(sid uuid,proof text,scope text,generation bigint,
 upper_seq bigint,after_seq bigint,after_index integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_seq bigint;events jsonb;
BEGIN
 IF NOT fi_control.posttrade_readable(sid,proof,scope,generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT command_count INTO current_seq FROM fi.posttrade_books WHERE sandbox_id=sid;
 current_seq:=COALESCE(current_seq,0);
 IF upper_seq IS NULL OR after_seq IS NULL OR after_index IS NULL OR p_limit IS NULL
 OR upper_seq<0 OR upper_seq>current_seq OR after_seq<0 OR after_seq>upper_seq OR after_index NOT BETWEEN -1 AND 1 OR p_limit NOT BETWEEN 1 AND 100
 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 SELECT COALESCE(jsonb_agg(page.body ORDER BY page.command_seq,page.event_index),'[]') INTO events FROM(
 SELECT e.command_seq,e.event_index,jsonb_build_object(
 'command_seq',e.command_seq::text,'event_index',e.event_index,'event_type',e.event_type,'execution_id',e.execution_id,
 'definition_version',e.instrument_revision,'economic_cash_cents',e.economic_cash_cents::text,
 'economic_par_change',e.economic_par_amount::text,'available_cash_cents',e.cash_cents::text,
 'available_par_change',e.par_amount::text,'counterparty_cash_cents',e.counterparty_cash_cents::text,
 'counterparty_par_change',e.counterparty_par::text,'actor_id',c.actor_id,
 'recorded_at',to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) body
 FROM fi.posttrade_events e JOIN fi.posttrade_commands c USING(sandbox_id,command_seq)
 WHERE e.sandbox_id=sid AND e.command_seq<=upper_seq AND(e.command_seq,e.event_index)>(after_seq,after_index)
 ORDER BY e.command_seq,e.event_index LIMIT p_limit+1) page;
 RETURN fi_control.result(200,jsonb_build_object('events',events));
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_posttrade_command(uuid,text,text,bigint,text),
 fi_control.read_posttrade_history(uuid,text,text,bigint,uuid),
 fi_control.read_posttrade_audit(uuid,text,text,bigint,bigint,bigint,integer,integer) TO tf_app;
