-- Phase3B1: durable metadata only. No FIX financial application or delivery operation.
CREATE TABLE fi.fix_channels(
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id),id uuid NOT NULL,dealer_id text NOT NULL CHECK(dealer_id IN ('ATLAS','BIRCH','CEDAR')),epoch integer NOT NULL DEFAULT 1 CHECK(epoch=1),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,id,dealer_id)
);
CREATE TABLE fi.fix_bindings(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,dealer_id text NOT NULL,cl_ord_id uuid NOT NULL,
 contract_hash text NOT NULL CHECK(contract_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,order_id),UNIQUE(sandbox_id,cl_ord_id),UNIQUE(sandbox_id,order_id,dealer_id),
 FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.orders(sandbox_id,id),FOREIGN KEY(sandbox_id,channel_id,dealer_id) REFERENCES fi.fix_channels(sandbox_id,id,dealer_id),CHECK(cl_ord_id=order_id)
);
CREATE TABLE fi_control.fix_reservations(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,commands integer NOT NULL DEFAULT 25 CHECK(commands=25),events integer NOT NULL DEFAULT 43 CHECK(events=43),released_at timestamptz,
 PRIMARY KEY(sandbox_id,order_id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id)
);
CREATE TABLE fi.fix_lanes(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,owner_id uuid,actor_id uuid,capability_generation bigint,fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),lease_expires_at timestamptz,closed_at timestamptz,
 PRIMARY KEY(sandbox_id,order_id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id),
 CHECK((owner_id IS NULL)=(lease_expires_at IS NULL))
);
CREATE TABLE fi.fix_messages(
 sandbox_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,dealer_id text NOT NULL,identity_kind text NOT NULL CHECK(identity_kind IN ('ORDER','CANCEL','EXEC_REPORT','CANCEL_REJECT')),identity_value text NOT NULL CHECK(octet_length(identity_value) BETWEEN 1 AND 64),
 direction text NOT NULL CHECK(direction IN ('IN','OUT')),message_type text NOT NULL CHECK(message_type IN ('D','8','F','9')),fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object' AND octet_length(fields::text)<=16384),
 semantic_hash text NOT NULL CHECK(semantic_hash ~ '^[a-f0-9]{64}$'),execution_id uuid,source_event_id uuid,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,dealer_id,identity_kind,identity_value),UNIQUE(sandbox_id,order_id,id),UNIQUE(sandbox_id,source_event_id),UNIQUE(sandbox_id,execution_id),
 FOREIGN KEY(sandbox_id,order_id,dealer_id) REFERENCES fi.fix_bindings(sandbox_id,order_id,dealer_id),
 CHECK((execution_id IS NOT NULL)=(source_event_id IS NOT NULL)),CHECK((execution_id IS NOT NULL)=(message_type='8' AND fields->>'150'='F'))
);
CREATE TABLE fi.fix_sequence_slots(
 sandbox_id uuid NOT NULL,channel_id uuid NOT NULL,epoch integer NOT NULL CHECK(epoch=1),direction text NOT NULL CHECK(direction IN ('IN','OUT')),message_seq bigint NOT NULL CHECK(message_seq BETWEEN 1 AND 2147483647),message_id uuid NOT NULL,
 PRIMARY KEY(sandbox_id,channel_id,epoch,direction,message_seq),FOREIGN KEY(sandbox_id,channel_id) REFERENCES fi.fix_channels(sandbox_id,id),FOREIGN KEY(sandbox_id,message_id) REFERENCES fi.fix_messages(sandbox_id,id)
);
CREATE TABLE fi.fix_attempts(
 sandbox_id uuid NOT NULL,id uuid NOT NULL,message_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 4),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes) BETWEEN 1 AND 8192),raw_hash text NOT NULL CHECK(raw_hash=encode(sha256(raw_bytes),'hex')),state text NOT NULL CHECK(state IN ('RECEIVED','STAGED')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,message_id,attempt_no),FOREIGN KEY(sandbox_id,message_id) REFERENCES fi.fix_messages(sandbox_id,id)
);
CREATE TABLE fi.fix_outbox(
 sandbox_id uuid NOT NULL,message_id uuid NOT NULL,order_id uuid NOT NULL,delivery_state text NOT NULL DEFAULT 'NOT_IMPLEMENTED' CHECK(delivery_state='NOT_IMPLEMENTED'),
 PRIMARY KEY(sandbox_id,message_id),FOREIGN KEY(sandbox_id,order_id,message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id)
);
CREATE TABLE fi.fix_dealer_correlations(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,dealer_id text NOT NULL,dealer_order_id text NOT NULL CHECK(octet_length(dealer_order_id) BETWEEN 1 AND 64),first_message_id uuid NOT NULL,
 PRIMARY KEY(sandbox_id,order_id),UNIQUE(sandbox_id,dealer_id,dealer_order_id),FOREIGN KEY(sandbox_id,order_id,dealer_id) REFERENCES fi.fix_bindings(sandbox_id,order_id,dealer_id),FOREIGN KEY(sandbox_id,order_id,first_message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id)
);
CREATE TABLE fi.fix_cancel_correlations(
 sandbox_id uuid NOT NULL,cl_ord_id uuid NOT NULL,order_id uuid NOT NULL,orig_cl_ord_id uuid NOT NULL,first_message_id uuid NOT NULL,
 PRIMARY KEY(sandbox_id,cl_ord_id),CHECK(cl_ord_id<>orig_cl_ord_id AND orig_cl_ord_id=order_id),
 FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id),FOREIGN KEY(sandbox_id,order_id,first_message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id)
);
CREATE TABLE fi.fix_work(
 sandbox_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,message_id uuid NOT NULL,lane_seq integer NOT NULL CHECK(lane_seq BETWEEN 1 AND 40),operation text NOT NULL CHECK(operation IN ('ACK_ORDER','REJECT_ORDER','EXECUTE_ORDER','REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL','PROTOCOL_ONLY')),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,order_id,lane_seq),UNIQUE(sandbox_id,message_id),UNIQUE(sandbox_id,order_id,id),FOREIGN KEY(sandbox_id,order_id,message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id)
);
CREATE TABLE fi.fix_prepared(
 sandbox_id uuid NOT NULL,work_id uuid NOT NULL,order_id uuid NOT NULL,financial_key text NOT NULL CHECK(financial_key ~ '^[A-Za-z0-9_-]{8,128}$'),operation text NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),request_hash text NOT NULL CHECK(request_hash=encode(sha256(convert_to(payload::text,'UTF8')),'hex')),
 prepared_fence bigint NOT NULL,prepared_generation bigint NOT NULL,prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,work_id),UNIQUE(sandbox_id,financial_key),FOREIGN KEY(sandbox_id,order_id,work_id) REFERENCES fi.fix_work(sandbox_id,order_id,id)
);
CREATE TABLE fi.fix_outcomes(
 sandbox_id uuid NOT NULL,work_id uuid NOT NULL,outcome text NOT NULL CHECK(outcome='METADATA_ONLY'),financial_command_id uuid,financial_command_seq bigint,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,work_id),FOREIGN KEY(sandbox_id,work_id) REFERENCES fi.fix_work(sandbox_id,id),FOREIGN KEY(sandbox_id,financial_command_id,financial_command_seq) REFERENCES fi.commands(sandbox_id,id,command_seq),
 CHECK(financial_command_id IS NULL AND financial_command_seq IS NULL)
);
CREATE TABLE fi.fix_commands(
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id),id uuid NOT NULL,idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),operation text NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),command_seq integer NOT NULL CHECK(command_seq BETWEEN 1 AND 1024),http_status integer NOT NULL CHECK(http_status IN (200,201)),response_body jsonb NOT NULL CHECK(octet_length(response_body::text)<=16384),actor_id uuid NOT NULL,
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,idempotency_key),UNIQUE(sandbox_id,command_seq)
);
CREATE TABLE fi.fix_events(
 sandbox_id uuid NOT NULL,command_seq integer NOT NULL,event_index integer NOT NULL CHECK(event_index=0),event_type text NOT NULL,order_id uuid NOT NULL,payload jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,command_seq,event_index),FOREIGN KEY(sandbox_id,command_seq) REFERENCES fi.fix_commands(sandbox_id,command_seq),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id)
);
CREATE TABLE fi_control.fix_writer_context(sandbox_id uuid NOT NULL,transaction_id xid8 NOT NULL,kind text NOT NULL CHECK(kind='ROTATION'),PRIMARY KEY(sandbox_id,transaction_id));
SET CONSTRAINTS fi_control.command_keys_sandbox_id_fkey IMMEDIATE;
ALTER TABLE fi_control.command_keys DROP CONSTRAINT command_keys_domain_check;
ALTER TABLE fi_control.command_keys ADD CHECK(domain IN ('FINANCIAL','RECONCILIATION','FIX','FIX_PREPARED'));
SET CONSTRAINTS fi_control.command_keys_sandbox_id_fkey DEFERRED;
CREATE OR REPLACE FUNCTION fi_control.reserve_command_key() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM fi.sandboxes WHERE id=NEW.sandbox_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=NEW.sandbox_id AND idempotency_key=NEW.idempotency_key) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='IDEMPOTENCY_KEY_REUSED';END IF;
 INSERT INTO fi_control.command_keys VALUES(NEW.sandbox_id,NEW.idempotency_key,CASE TG_TABLE_NAME WHEN 'commands' THEN 'FINANCIAL' WHEN 'fix_commands' THEN 'FIX' ELSE 'RECONCILIATION' END);RETURN NEW;
END $$;
CREATE TRIGGER shared_idempotency_key BEFORE INSERT ON fi.fix_commands FOR EACH ROW EXECUTE FUNCTION fi_control.reserve_command_key();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['fix_channels','fix_bindings','fix_lanes','fix_messages','fix_sequence_slots','fix_attempts','fix_outbox','fix_dealer_correlations','fix_cancel_correlations','fix_work','fix_prepared','fix_outcomes','fix_commands','fix_events'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING(sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING(true)',t);
 EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
 IF t<>'fix_lanes' THEN EXECUTE format('CREATE TRIGGER fix_immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['fix_reservations','fix_writer_context'] LOOP
 EXECUTE format('ALTER TABLE fi_control.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE fi_control.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi_control.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION fi_control.protect_fix_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c integer;e integer;rotation boolean;
BEGIN
 IF NEW.command_count<=OLD.command_count AND NEW.event_count<=OLD.event_count THEN RETURN NEW;END IF;
 SELECT COALESCE(sum(commands),0),COALESCE(sum(events),0) INTO c,e FROM fi_control.fix_reservations WHERE sandbox_id=NEW.id AND released_at IS NULL;
 IF c=0 THEN RETURN NEW;END IF;
 rotation:=EXISTS(SELECT 1 FROM fi_control.fix_writer_context WHERE sandbox_id=NEW.id AND transaction_id=pg_current_xact_id());
 IF NEW.command_count+c+(CASE WHEN rotation THEN 0 ELSE 2 END)>512 OR NEW.event_count+e+(CASE WHEN rotation THEN 0 ELSE 2 END)>1024 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='PROTECTED_FINANCIAL_CAPACITY';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_fix_capacity BEFORE UPDATE ON fi.sandboxes FOR EACH ROW EXECUTE FUNCTION fi_control.protect_fix_capacity();
DO $copy$ DECLARE d text;BEGIN SELECT pg_get_functiondef('fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure) INTO d;EXECUTE replace(d,'FUNCTION fi_control.order_command(','FUNCTION fi_control.order_command_kernel(');END $copy$;
REVOKE ALL ON FUNCTION fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid) FROM tf_app,PUBLIC;
CREATE FUNCTION fi_control.order_input_valid(p_id uuid,p_proof text,p_generation bigint,p_action text,p jsonb,p_hash text,p_key text,p_actor uuid) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE allowed text[];dummy uuid;q numeric;
BEGIN
 IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_action IS NULL OR p IS NULL OR jsonb_typeof(p)<>'object' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p_actor IS NULL THEN RETURN false;END IF;
 allowed:=CASE WHEN p_action IN ('ACK_ORDER','REJECT_ORDER') THEN ARRAY['order_id','expected_version'] WHEN p_action='EXECUTE_ORDER' THEN ARRAY['order_id','expected_version','execution_id','source_event_id','par_amount'] WHEN p_action IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN ARRAY['order_id','expected_version','cancel_id'] END;
 IF allowed IS NULL OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(allowed) OR NOT(p ?& allowed) OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') OR p->>'expected_version' !~ '^[1-9][0-9]{0,2}$' THEN RETURN false;END IF;
 dummy:=(p->>'order_id')::uuid;
 IF p_action='EXECUTE_ORDER' THEN dummy:=(p->>'execution_id')::uuid;dummy:=(p->>'source_event_id')::uuid;IF p->>'par_amount' !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN RETURN false;END IF;q:=(p->>'par_amount')::numeric;IF q NOT BETWEEN 0.01 AND 1000000000 THEN RETURN false;END IF;
 ELSIF p_action IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN dummy:=(p->>'cancel_id')::uuid;END IF;RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
CREATE OR REPLACE FUNCTION fi_control.order_command(p_id uuid,p_proof text,p_generation bigint,p_action text,p jsonb,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;r fi.commands%ROWTYPE;
BEGIN
 IF NOT fi_control.order_input_valid(p_id,p_proof,p_generation,p_action,p,p_hash,p_key,p_actor) THEN RETURN fi_control.order_command_kernel(p_id,p_proof,p_generation,p_action,p,p_hash,p_key,p_actor);END IF;
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation IS DISTINCT FROM p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO r FROM fi.commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF FOUND THEN RETURN fi_control.order_command_kernel(p_id,p_proof,p_generation,p_action,p,p_hash,p_key,p_actor);END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_bindings WHERE sandbox_id=p_id AND order_id=(p->>'order_id')::uuid) THEN RETURN fi_control.failure(409,'FIX_DRIVER_OWNS_ORDER');END IF;
 RETURN fi_control.order_command_kernel(p_id,p_proof,p_generation,p_action,p,p_hash,p_key,p_actor);
EXCEPTION WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'PROTECTED_FINANCIAL_CAPACITY');END $$;
GRANT EXECUTE ON FUNCTION fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid) TO tf_app;
DO $copy$ DECLARE d text;BEGIN SELECT pg_get_functiondef('fi_control.rotate_capabilities(uuid,text,bigint,bigint,text,text,text,text,uuid)'::regprocedure) INTO d;EXECUTE replace(d,'FUNCTION fi_control.rotate_capabilities(','FUNCTION fi_control.rotate_capabilities_kernel(');END $copy$;
REVOKE ALL ON FUNCTION fi_control.rotate_capabilities_kernel(uuid,text,bigint,bigint,text,text,text,text,uuid) FROM tf_app,PUBLIC;
CREATE OR REPLACE FUNCTION fi_control.rotate_capabilities(p_id uuid,p_proof text,p_binding_generation bigint,p_expected_generation bigint,p_read text,p_trade text,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb;
BEGIN
 IF p_id IS NULL THEN RETURN fi_control.rotate_capabilities_kernel(p_id,p_proof,p_binding_generation,p_expected_generation,p_read,p_trade,p_hash,p_key,p_actor);END IF;
 -- The private context is never controlled by an application GUC.
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);PERFORM 1 FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 INSERT INTO fi_control.fix_writer_context VALUES(p_id,pg_current_xact_id(),'ROTATION');
 r:=fi_control.rotate_capabilities_kernel(p_id,p_proof,p_binding_generation,p_expected_generation,p_read,p_trade,p_hash,p_key,p_actor);
 DELETE FROM fi_control.fix_writer_context WHERE sandbox_id=p_id AND transaction_id=pg_current_xact_id();RETURN r;
EXCEPTION WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'PROTECTED_FINANCIAL_CAPACITY');END $$;
GRANT EXECUTE ON FUNCTION fi_control.rotate_capabilities(uuid,text,bigint,bigint,text,text,text,text,uuid) TO tf_app;
CREATE FUNCTION fi_control.fix_time(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF v IS NULL OR v !~ '^[0-9]{8}-([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?$' OR substring(v,1,4)::int NOT BETWEEN 1900 AND 2199 THEN RETURN false;END IF;
 PERFORM make_date(substring(v,1,4)::int,substring(v,5,2)::int,substring(v,7,2)::int);RETURN true;
EXCEPTION WHEN datetime_field_overflow THEN RETURN false;END $$;
CREATE FUNCTION fi_control.fix_fields(raw bytea) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a text[];part text;tag text;v text;f jsonb:='{}';i integer;n integer;total integer:=0;headers text[];idx integer:=3;
BEGIN
 n:=octet_length(raw);IF n NOT BETWEEN 1 AND 8192 THEN RETURN NULL;END IF;
 FOR i IN 0..n-1 LOOP IF get_byte(raw,i)<>1 AND get_byte(raw,i) NOT BETWEEN 32 AND 126 THEN RETURN NULL;END IF;END LOOP;
 a:=string_to_array(convert_from(raw,'SQL_ASCII'),chr(1));IF a[array_length(a,1)]<>'' OR array_length(a,1)>65 THEN RETURN NULL;END IF;
 IF a[1]<>'8=FIX.4.4' OR a[2] !~ '^9=[1-9][0-9]{0,4}$' OR a[3] !~ '^35=[D8F9]$' OR a[array_length(a,1)-1] !~ '^10=[0-9]{3}$' THEN RETURN NULL;END IF;
 IF substring(a[2],3)::int<>n-7-length(a[1])-length(a[2])-2 THEN RETURN NULL;END IF;
 FOR i IN 0..n-8 LOOP total:=total+get_byte(raw,i);END LOOP;
 IF substring(a[array_length(a,1)-1],4)::int<>total%256 THEN RETURN NULL;END IF;
 FOREACH part IN ARRAY a[1:array_length(a,1)-1] LOOP
 IF part !~ '^[1-9][0-9]{0,4}=[ -~]+$' THEN RETURN NULL;END IF;
 tag:=split_part(part,'=',1);v:=substring(part,length(tag)+2);IF f ? tag OR length(v)>256 THEN RETURN NULL;END IF;f:=f||jsonb_build_object(tag,v);
 END LOOP;
 headers:=ARRAY['35','49','56','34','43','52','122'];FOREACH tag IN ARRAY headers LOOP
 IF f ? tag THEN IF split_part(a[idx],'=',1)<>tag THEN RETURN NULL;END IF;idx:=idx+1;END IF;END LOOP;
 IF NOT(f ?& ARRAY['49','56','34','52']) OR f->>'34' !~ '^[1-9][0-9]{0,9}$' OR (f->>'34')::bigint>2147483647 OR NOT fi_control.fix_time(f->>'52') THEN RETURN NULL;END IF;
 IF f ? '43' AND f->>'43' NOT IN ('Y','N') THEN RETURN NULL;END IF;
 IF f->>'43'='Y' THEN IF NOT fi_control.fix_time(f->>'122') OR rpad(f->>'122',21,'.000')>rpad(f->>'52',21,'.000') THEN RETURN NULL;END IF;
 ELSIF f ? '122' THEN RETURN NULL;END IF;
 RETURN f;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;END $$;
CREATE FUNCTION fi_control.fix_terms_valid(f jsonb,o jsonb,dealer text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE mt text:=f->>'35';allowed text[];required text[];q numeric;c numeric;l numeric;x text;st text;tag text;terms text[]:=ARRAY['55','167','54','854','38','40','59','423','44','15','64'];
BEGIN
 allowed:=ARRAY['8','9','10','35','49','56','34','43','52','122'];required:=ARRAY['11','60'];
 IF mt='D' THEN required:=required||terms;allowed:=allowed||required||ARRAY['75'];
 ELSIF mt='8' THEN required:=required||terms||ARRAY['37','17','150','39','14','151','6'];allowed:=allowed||required||ARRAY['41','32','31','75','103','58'];
 ELSIF mt='F' THEN required:=required||ARRAY['41','37','55','167','54','38'];allowed:=allowed||required||ARRAY['58'];
 ELSIF mt='9' THEN required:=required||ARRAY['37','41','39','434','102'];allowed:=allowed||required||ARRAY['58'];
 ELSE RETURN false;END IF;
 IF NOT(f ?& required) OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE NOT k=ANY(allowed)) OR NOT fi_control.fix_time(f->>'60') THEN RETURN false;END IF;
 IF mt IN ('D','F') THEN IF f->>'49'<>'TRADEFLOW' OR f->>'56'<>dealer THEN RETURN false;END IF;
 ELSE IF f->>'49'<>dealer OR f->>'56'<>'TRADEFLOW' THEN RETURN false;END IF;END IF;
 FOREACH tag IN ARRAY ARRAY['37','17'] LOOP IF f ? tag AND (f->>tag !~ ('^'||dealer||'-[A-Z0-9-]{1,48}$')) THEN RETURN false;END IF;END LOOP;
 IF f->>'11' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 IF f ? '41' AND (f->>'41'<>o->>'order_id' OR f->>'11'=f->>'41') THEN RETURN false;END IF;
 IF mt='D' OR (mt='8' AND f->>'150' NOT IN ('6','4')) THEN IF f->>'11'<>o->>'order_id' THEN RETURN false;END IF;
 ELSE IF NOT f ? '41' THEN RETURN false;END IF;END IF;
 IF f ? '75' AND f->>'75'<>substring(f->>'60',1,8) THEN RETURN false;END IF;
 IF f ? '58' AND f->>'58' NOT IN ('SYNTHETIC_REJECTION','SYNTHETIC_CANCEL_REJECT','SYNTHETIC_CANCEL_REQUEST') THEN RETURN false;END IF;
 IF mt<>'9' AND (f->>'55'<>o->>'instrument_id' OR f->>'167'<>(CASE o->>'instrument_id' WHEN 'SYN-UST-2031' THEN 'TNOTE' ELSE 'CORP' END) OR f->>'54'<>(CASE o->>'side' WHEN 'BUY' THEN '1' ELSE '2' END) OR f->>'38'<>o->>'par_amount') THEN RETURN false;END IF;
 IF mt IN ('D','8') AND (f->>'854'<>'0' OR f->>'40'<>'2' OR f->>'59'<>'1' OR f->>'423'<>'1' OR f->>'15'<>'USD' OR f->>'44'<>o->>'clean_price' OR f->>'64'<>replace(o->>'settlement_date','-','')) THEN RETURN false;END IF;
 IF mt='8' THEN
 x:=f->>'150';st:=f->>'39';IF x NOT IN ('0','8','F','6','4') THEN RETURN false;END IF;
 FOREACH tag IN ARRAY ARRAY['14','151','32'] LOOP IF f ? tag AND (f->>tag !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$') THEN RETURN false;END IF;END LOOP;
 q:=(f->>'38')::numeric;c:=(f->>'14')::numeric;l:=(f->>'151')::numeric;
 IF c>q OR l>q OR f->>'6'<>(CASE WHEN c=0 THEN '0.000000000000' ELSE f->>'44' END) THEN RETURN false;END IF;
 IF x='F' THEN IF NOT(f ?& ARRAY['31','32']) OR f ? '41' OR f->>'31'<>f->>'44' OR (f->>'32')::numeric NOT BETWEEN 0.01 AND c OR c<=0 OR c+l<>q OR st NOT IN ('1','2','6') OR (st='1' AND c=q) OR (st='2' AND c<>q) THEN RETURN false;END IF;
 ELSE IF f ? '31' OR f ? '32' OR st<>x THEN RETURN false;END IF;
 IF (x='0' AND (c<>0 OR l<>q)) OR (x='8' AND (c<>0 OR l<>0)) OR (x='4' AND (l<>0 OR c=q)) OR (x='6' AND c+l<>q) THEN RETURN false;END IF;
 END IF;
 IF (x='8' AND (NOT f ? '103' OR f->>'103' NOT IN ('6','99'))) OR (x<>'8' AND f ? '103') THEN RETURN false;END IF;
 ELSIF mt='9' AND (f->>'434'<>'1' OR f->>'39' NOT IN ('0','1','2') OR f->>'102' NOT IN ('0','99') OR ((f->>'102'='0')<>(f->>'39'='2'))) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
CREATE FUNCTION fi_control.fix_command(p_id uuid,p_proof text,p_generation bigint,p_action text,p jsonb,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;b fi.fix_bindings%ROWTYPE;lane fi.fix_lanes%ROWTYPE;m fi.fix_messages%ROWTYPE;w fi.fix_work%ROWTYPE;r fi.fix_commands%ROWTYPE;
 life fi.order_states%ROWTYPE;oid uuid;mid uuid;aid uuid;wid uuid;owner uuid;f jsonb;raw bytea;semantic jsonb;h text;rh text;identity text;kind text;wire_direction text;known text;op text;body jsonb;payload jsonb;allowed text[];n integer;seq integer;fence bigint;head uuid;outcome text;http_code integer:=200;c integer;e integer;
BEGIN
 IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_action IS NULL OR p_actor IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>32768 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 allowed:=CASE p_action WHEN 'BIND' THEN ARRAY['order_id','dealer_id','channel_id'] WHEN 'RECORD' THEN ARRAY['order_id','raw_hex','attempt_id'] WHEN 'CLAIM' THEN ARRAY['order_id','owner_id'] WHEN 'QUEUE' THEN ARRAY['order_id','message_id','work_id'] WHEN 'PREPARE' THEN ARRAY['order_id','owner_id','fence','work_id','financial_key'] WHEN 'RESOLVE_METADATA' THEN ARRAY['order_id','owner_id','fence','work_id'] WHEN 'RELEASE' THEN ARRAY['order_id'] END;
 IF allowed IS NULL OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(allowed) OR NOT(p ?& allowed) OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 FOREACH known IN ARRAY ARRAY['order_id','channel_id','owner_id','message_id','attempt_id','work_id'] LOOP IF p ? known THEN p:=jsonb_set(p,ARRAY[known],to_jsonb((p->>known)::uuid::text));END IF;END LOOP;
 IF p ? 'fence' AND p->>'fence' !~ '^[1-9][0-9]{0,15}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 oid:=(p->>'order_id')::uuid;rh:=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',p_id,'operation',p_action,'payload',p)::text,'UTF8')),'hex');
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation IS DISTINCT FROM p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO r FROM fi.fix_commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF FOUND THEN IF r.operation<>p_action OR r.request_hash<>rh THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;RETURN fi_control.result(r.http_status,r.response_body,true);END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=p_id AND idempotency_key=p_key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 IF clock_timestamp()>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=p_id;
 IF seq>(CASE WHEN p_action='CLAIM' THEN 1024 ELSE 960 END) THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END IF;
 IF p_action='BIND' THEN
 IF EXISTS(SELECT 1 FROM fi.fix_bindings WHERE sandbox_id=p_id AND order_id=oid) THEN RETURN fi_control.failure(409,'FIX_BINDING_EXISTS');END IF;
 SELECT contract||jsonb_build_object('order_id',id) INTO f FROM fi.orders WHERE sandbox_id=p_id AND id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'ORDER_NOT_FOUND');END IF;
 IF f->>'dealer_id'<>p->>'dealer_id' THEN RETURN fi_control.failure(409,'FIX_DEALER_CONFLICT');END IF;
 PERFORM 1 FROM fi.order_states WHERE sandbox_id=p_id AND order_id=oid AND order_states.status='PENDING_ACK' AND version=1 AND execution_count=0 AND pending_cancel_id IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN fi_control.failure(409,'FIX_REQUIRES_PRISTINE_ORDER');END IF;
 SELECT COALESCE(sum(commands),0),COALESCE(sum(events),0) INTO c,e FROM fi_control.fix_reservations WHERE sandbox_id=p_id AND released_at IS NULL;
 IF (SELECT count(*) FROM fi.fix_bindings WHERE sandbox_id=p_id)>=4 OR s.command_count+c+25+2>512 OR s.event_count+e+43+2>1024 THEN RETURN fi_control.failure(429,'FIX_RESERVATION_CAPACITY');END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_channels WHERE sandbox_id=p_id AND id=(p->>'channel_id')::uuid AND dealer_id<>p->>'dealer_id') THEN RETURN fi_control.failure(409,'FIX_CHANNEL_CONFLICT');END IF;
 INSERT INTO fi.fix_channels VALUES(p_id,(p->>'channel_id')::uuid,p->>'dealer_id',1) ON CONFLICT DO NOTHING;
 INSERT INTO fi.fix_bindings VALUES(p_id,oid,(p->>'channel_id')::uuid,p->>'dealer_id',oid,encode(sha256(convert_to((f-'order_id')::text,'UTF8')),'hex'),clock_timestamp());
 INSERT INTO fi_control.fix_reservations(sandbox_id,order_id) VALUES(p_id,oid);INSERT INTO fi.fix_lanes(sandbox_id,order_id) VALUES(p_id,oid);
 body:=jsonb_build_object('order_id',oid,'cl_ord_id',oid,'dealer_order_id',NULL,'reserved_commands',25,'reserved_events',43,'financial_applied',false);http_code:=201;
 ELSE
 SELECT * INTO b FROM fi.fix_bindings WHERE sandbox_id=p_id AND order_id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_BINDING_NOT_FOUND');END IF;
 SELECT * INTO STRICT lane FROM fi.fix_lanes WHERE sandbox_id=p_id AND order_id=oid FOR UPDATE;
 IF lane.closed_at IS NOT NULL THEN RETURN fi_control.failure(409,'FIX_BINDING_CLOSED');END IF;
 IF p_action='RECORD' THEN
 IF octet_length(p->>'raw_hex') NOT BETWEEN 2 AND 16384 OR octet_length(p->>'raw_hex')%2<>0 OR p->>'raw_hex' !~ '^[a-f0-9]+$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 raw:=decode(p->>'raw_hex','hex');f:=fi_control.fix_fields(raw);
 SELECT contract||jsonb_build_object('order_id',id) INTO payload FROM fi.orders WHERE sandbox_id=p_id AND id=oid;
 IF f IS NULL OR NOT COALESCE(fi_control.fix_terms_valid(f,payload,b.dealer_id),false) THEN RETURN fi_control.failure(400,'FIX_PROFILE_VIOLATION');END IF;
 wire_direction:=CASE WHEN f->>'35' IN ('D','F') THEN 'OUT' ELSE 'IN' END;
 kind:=CASE f->>'35' WHEN 'D' THEN 'ORDER' WHEN 'F' THEN 'CANCEL' WHEN '8' THEN 'EXEC_REPORT' ELSE 'CANCEL_REJECT' END;
 identity:=CASE WHEN f->>'35'='8' THEN f->>'17' ELSE f->>'11' END;
 semantic:=f-ARRAY['8','9','10','34','43','52','122'];h:=encode(sha256(convert_to(semantic::text,'UTF8')),'hex');
 SELECT * INTO m FROM fi.fix_messages WHERE sandbox_id=p_id AND dealer_id=b.dealer_id AND identity_kind=kind AND identity_value=identity;
 IF FOUND THEN IF m.order_id<>oid OR m.semantic_hash<>h THEN RETURN fi_control.failure(409,'FIX_IDENTITY_CONFLICT');END IF;mid:=m.id;
 ELSE
 IF (SELECT count(*) FROM fi.fix_messages WHERE sandbox_id=p_id AND order_id=oid)>=40 THEN RETURN fi_control.failure(429,'FIX_MESSAGE_QUOTA');END IF;
 mid:=gen_random_uuid();INSERT INTO fi.fix_messages VALUES(p_id,mid,oid,b.dealer_id,kind,identity,wire_direction,f->>'35',f,h,CASE WHEN f->>'150'='F' THEN gen_random_uuid() END,CASE WHEN f->>'150'='F' THEN gen_random_uuid() END,clock_timestamp());
 END IF;
 IF f ? '41' THEN
 IF EXISTS(SELECT 1 FROM fi.fix_cancel_correlations WHERE sandbox_id=p_id AND cl_ord_id=(f->>'11')::uuid AND order_id<>oid) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_CANCEL_CORRELATION_CONFLICT';END IF;
 INSERT INTO fi.fix_cancel_correlations VALUES(p_id,(f->>'11')::uuid,oid,(f->>'41')::uuid,mid) ON CONFLICT DO NOTHING;
 END IF;
 SELECT dealer_order_id INTO known FROM fi.fix_dealer_correlations WHERE sandbox_id=p_id AND order_id=oid;
 IF f ? '37' THEN
 IF known IS NOT NULL AND known<>f->>'37' THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_DEALER_ORDER_CONFLICT';END IF;
 IF known IS NULL THEN
 IF f->>'35'<>'8' THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_DEALER_ORDER_UNKNOWN';END IF;
 INSERT INTO fi.fix_dealer_correlations VALUES(p_id,oid,b.dealer_id,f->>'37',mid);
 END IF;END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_sequence_slots WHERE sandbox_id=p_id AND channel_id=b.channel_id AND epoch=1 AND fix_sequence_slots.direction=wire_direction AND message_seq=(f->>'34')::bigint AND message_id<>mid) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_SEQUENCE_IDENTITY_CONFLICT';END IF;
 INSERT INTO fi.fix_sequence_slots VALUES(p_id,b.channel_id,1,wire_direction,(f->>'34')::bigint,mid) ON CONFLICT DO NOTHING;
 IF f->>'43'='Y' AND EXISTS(SELECT 1 FROM fi.fix_attempts a JOIN fi.fix_messages x ON (x.sandbox_id,x.id)=(a.sandbox_id,a.message_id) WHERE a.sandbox_id=p_id AND a.message_id=mid AND f->>'122'<>COALESCE(x.fields->>'122',x.fields->>'52')) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_ORIGINAL_TIME_CONFLICT';END IF;
 aid:=(p->>'attempt_id')::uuid;
 IF EXISTS(SELECT 1 FROM fi.fix_attempts WHERE sandbox_id=p_id AND id=aid AND (message_id<>mid OR raw_hash<>encode(sha256(raw),'hex'))) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_ATTEMPT_CONFLICT';END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_attempts WHERE sandbox_id=p_id AND id=aid) THEN
 SELECT count(*)+1 INTO n FROM fi.fix_attempts WHERE sandbox_id=p_id AND message_id=mid;IF n>4 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='FIX_ATTEMPT_QUOTA';END IF;
 INSERT INTO fi.fix_attempts VALUES(p_id,aid,mid,n,raw,encode(sha256(raw),'hex'),CASE wire_direction WHEN 'IN' THEN 'RECEIVED' ELSE 'STAGED' END,clock_timestamp());END IF;
 IF wire_direction='OUT' THEN INSERT INTO fi.fix_outbox VALUES(p_id,mid,oid,'NOT_IMPLEMENTED') ON CONFLICT DO NOTHING;END IF;
 body:=jsonb_build_object('order_id',oid,'message_id',mid,'attempt_id',aid,'semantic_hash',h,'logical_duplicate',m.id IS NOT NULL,'physical_duplicate',n IS NULL,'raw_hash',encode(sha256(raw),'hex'),'financial_applied',false,'delivery_state','NOT_IMPLEMENTED');http_code:=201;
 ELSIF p_action='CLAIM' THEN
 owner:=(p->>'owner_id')::uuid;
 IF lane.lease_expires_at>clock_timestamp() AND lane.capability_generation=p_generation AND (lane.owner_id<>owner OR lane.actor_id<>p_actor) THEN RETURN fi_control.failure(409,'FIX_LANE_LEASED');END IF;
 UPDATE fi.fix_lanes SET owner_id=owner,actor_id=p_actor,capability_generation=p_generation,fence=fix_lanes.fence+1,lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE sandbox_id=p_id AND order_id=oid RETURNING * INTO lane;
 body:=jsonb_build_object('order_id',oid,'owner_id',owner,'fence',lane.fence::text,'lease_expires_at',lane.lease_expires_at);
 ELSIF p_action='QUEUE' THEN
 mid:=(p->>'message_id')::uuid;wid:=(p->>'work_id')::uuid;
 SELECT * INTO m FROM fi.fix_messages WHERE sandbox_id=p_id AND id=mid AND order_id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_MESSAGE_NOT_FOUND');END IF;
 IF m.message_type='D' THEN RETURN fi_control.failure(409,'FIX_NO_FINANCIAL_ORDER_CREATION');END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_work WHERE sandbox_id=p_id AND (id=wid OR message_id=mid)) THEN RETURN fi_control.failure(409,'FIX_WORK_EXISTS');END IF;
 SELECT count(*)+1 INTO n FROM fi.fix_work WHERE sandbox_id=p_id AND order_id=oid;IF n>40 THEN RETURN fi_control.failure(429,'FIX_LANE_QUOTA');END IF;
 op:=CASE m.message_type WHEN 'F' THEN 'REQUEST_CANCEL' WHEN '9' THEN 'REJECT_CANCEL' ELSE CASE m.fields->>'150' WHEN '0' THEN 'ACK_ORDER' WHEN '8' THEN 'REJECT_ORDER' WHEN 'F' THEN 'EXECUTE_ORDER' WHEN '4' THEN 'ACK_CANCEL' ELSE 'PROTOCOL_ONLY' END END;
 INSERT INTO fi.fix_work VALUES(p_id,wid,oid,mid,n,op);body:=jsonb_build_object('order_id',oid,'work_id',wid,'lane_seq',n,'operation',op);http_code:=201;
 ELSIF p_action IN ('PREPARE','RESOLVE_METADATA') THEN
 wid:=(p->>'work_id')::uuid;owner:=(p->>'owner_id')::uuid;fence:=(p->>'fence')::bigint;
 IF lane.owner_id IS DISTINCT FROM owner OR lane.actor_id IS DISTINCT FROM p_actor OR lane.capability_generation IS DISTINCT FROM p_generation OR lane.fence<>fence OR lane.lease_expires_at<=clock_timestamp() THEN RETURN fi_control.failure(409,'FIX_STALE_FENCE');END IF;
 SELECT x.id INTO head FROM fi.fix_work x WHERE x.sandbox_id=p_id AND x.order_id=oid AND NOT EXISTS(SELECT 1 FROM fi.fix_outcomes y WHERE y.sandbox_id=x.sandbox_id AND y.work_id=x.id) ORDER BY lane_seq LIMIT 1;
 IF head IS DISTINCT FROM wid THEN RETURN fi_control.failure(409,'FIX_UNRESOLVED_HEAD');END IF;
 SELECT * INTO STRICT w FROM fi.fix_work WHERE sandbox_id=p_id AND id=wid;
 IF p_action='RESOLVE_METADATA' THEN
 IF w.operation<>'PROTOCOL_ONLY' OR NOT EXISTS(SELECT 1 FROM fi.fix_prepared WHERE sandbox_id=p_id AND work_id=wid) THEN RETURN fi_control.failure(409,'FIX_FINANCIAL_APPLICATION_DISABLED');END IF;
 INSERT INTO fi.fix_outcomes(sandbox_id,work_id,outcome) VALUES(p_id,wid,'METADATA_ONLY');body:=jsonb_build_object('order_id',oid,'work_id',wid,'outcome','METADATA_ONLY','financial_applied',false);
 ELSE
 IF EXISTS(SELECT 1 FROM fi.fix_prepared WHERE sandbox_id=p_id AND work_id=wid) THEN RETURN fi_control.failure(409,'FIX_ALREADY_PREPARED_RETAIN_ORIGINAL');END IF;
 IF p->>'financial_key' !~ '^[A-Za-z0-9_-]{8,128}$' OR EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=p_id AND idempotency_key=p->>'financial_key') OR p->>'financial_key'=p_key THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 SELECT fields INTO f FROM fi.fix_messages WHERE sandbox_id=p_id AND id=w.message_id;
 SELECT * INTO STRICT life FROM fi.order_states WHERE sandbox_id=p_id AND order_id=oid FOR UPDATE;
 IF (w.operation IN ('ACK_ORDER','REJECT_ORDER') AND life.status<>'PENDING_ACK') OR (w.operation IN ('EXECUTE_ORDER','REQUEST_CANCEL') AND life.status NOT IN ('NEW','PARTIALLY_FILLED')) OR (w.operation IN ('ACK_CANCEL','REJECT_CANCEL') AND life.pending_cancel_id IS DISTINCT FROM (f->>'11')::uuid) THEN RETURN fi_control.failure(409,'FIX_PREREQUISITE_UNMET');END IF;
 IF w.operation='EXECUTE_ORDER' AND ((f->>'32')::numeric>life.remaining_par OR life.execution_count>=8 OR (life.execution_count=7 AND (f->>'32')::numeric<>life.remaining_par)) THEN RETURN fi_control.failure(409,'FIX_PREREQUISITE_UNMET');END IF;
 IF w.operation='REQUEST_CANCEL' AND life.pending_cancel_id IS NOT NULL THEN RETURN fi_control.failure(409,'FIX_PREREQUISITE_UNMET');END IF;
 payload:=jsonb_build_object('order_id',oid,'expected_version',life.version::text);
 IF w.operation='EXECUTE_ORDER' THEN SELECT payload||jsonb_build_object('execution_id',execution_id,'source_event_id',source_event_id,'par_amount',fields->>'32') INTO payload FROM fi.fix_messages WHERE sandbox_id=p_id AND id=w.message_id;
 ELSIF w.operation IN ('REQUEST_CANCEL','ACK_CANCEL','REJECT_CANCEL') THEN payload:=payload||jsonb_build_object('cancel_id',f->>'11');END IF;
 INSERT INTO fi_control.command_keys VALUES(p_id,p->>'financial_key','FIX_PREPARED');
 INSERT INTO fi.fix_prepared VALUES(p_id,wid,oid,p->>'financial_key',w.operation,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),fence,p_generation,clock_timestamp());
 body:=jsonb_build_object('order_id',oid,'work_id',wid,'financial_key',p->>'financial_key','payload',payload,'operation',w.operation,'application_state','NOT_IMPLEMENTED','financial_applied',false);http_code:=201;
 END IF;
 ELSIF p_action='RELEASE' THEN
 IF EXISTS(SELECT 1 FROM fi.fix_messages WHERE sandbox_id=p_id AND order_id=oid) OR lane.lease_expires_at>clock_timestamp() THEN RETURN fi_control.failure(409,'FIX_UNRESOLVED_INTENTS');END IF;
 UPDATE fi_control.fix_reservations SET released_at=clock_timestamp() WHERE sandbox_id=p_id AND order_id=oid AND released_at IS NULL;
 UPDATE fi.fix_lanes SET closed_at=clock_timestamp(),fence=fix_lanes.fence+1 WHERE sandbox_id=p_id AND order_id=oid;body:=jsonb_build_object('order_id',oid,'released',true,'financial_applied',false);
 END IF;
 END IF;
 INSERT INTO fi.fix_commands VALUES(p_id,gen_random_uuid(),p_key,p_action,rh,seq,http_code,body,p_actor);
 INSERT INTO fi.fix_events VALUES(p_id,seq,0,p_action,oid,jsonb_build_object('financial_applied',false,'record',body-'payload'),clock_timestamp());
 RETURN fi_control.result(http_code,body);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
 WHEN SQLSTATE 'TF409' OR unique_violation THEN RETURN fi_control.failure(409,'FIX_IDENTITY_CONFLICT');
 WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END $$;
GRANT EXECUTE ON FUNCTION fi_control.fix_command(uuid,text,bigint,text,jsonb,text,uuid) TO tf_app;
CREATE FUNCTION fi_control.read_fix(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_kind text,p_ref text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;body jsonb;
BEGIN
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=p_id;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR s.generation IS DISTINCT FROM p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 IF p_kind='RECEIPT' THEN SELECT jsonb_build_object('operation',operation,'request_hash',request_hash,'status',http_status,'body',response_body) INTO body FROM fi.fix_commands WHERE sandbox_id=p_id AND idempotency_key=p_ref;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_OUTCOME_UNRESOLVED');END IF;
 ELSIF p_kind='STATE' THEN SELECT jsonb_build_object('binding',to_jsonb(b),'lane',to_jsonb(l),'work',COALESCE((SELECT jsonb_agg(to_jsonb(w)||jsonb_build_object('prepared',(SELECT to_jsonb(p) FROM fi.fix_prepared p WHERE p.sandbox_id=w.sandbox_id AND p.work_id=w.id),'outcome',(SELECT to_jsonb(o) FROM fi.fix_outcomes o WHERE o.sandbox_id=w.sandbox_id AND o.work_id=w.id))) FROM fi.fix_work w WHERE w.sandbox_id=b.sandbox_id AND w.order_id=b.order_id),'[]'::jsonb),'financial_applied',false,'delivery_verified',false) INTO body FROM fi.fix_bindings b JOIN fi.fix_lanes l USING(sandbox_id,order_id) WHERE b.sandbox_id=p_id AND b.order_id::text=p_ref;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_BINDING_NOT_FOUND');END IF;
 ELSE RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 RETURN fi_control.result(200,body);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_fix(uuid,text,text,bigint,text,text) TO tf_app;
-- Cleanup is serialized on sandbox ownership. Retention ends all future admission;
-- no active lease may be purged, and no metadata is deleted independently.
CREATE OR REPLACE FUNCTION fi_control.purge_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE target uuid; removed integer:=0;
BEGIN
 PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
 FOR target IN SELECT s.id FROM fi.sandboxes s WHERE retained_until<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM fi.reconciliation_runs r WHERE r.sandbox_id=s.id AND ((r.state='RUNNING' AND r.lease_expires_at>clock_timestamp()) OR (r.state='REQUESTED' AND r.requested_at+interval '15 seconds'>clock_timestamp()))) AND NOT EXISTS(SELECT 1 FROM fi.fix_lanes l WHERE l.sandbox_id=s.id AND l.lease_expires_at>clock_timestamp()) ORDER BY s.id FOR UPDATE LOOP
 INSERT INTO fi_control.purged_sandboxes(id) VALUES(target);
 DELETE FROM fi_control.fix_writer_context WHERE sandbox_id=target;
 DELETE FROM fi.fix_events WHERE sandbox_id=target;
 DELETE FROM fi.fix_commands WHERE sandbox_id=target;
 DELETE FROM fi.fix_outcomes WHERE sandbox_id=target;
 DELETE FROM fi.fix_prepared WHERE sandbox_id=target;
 DELETE FROM fi.fix_work WHERE sandbox_id=target;
 DELETE FROM fi.fix_cancel_correlations WHERE sandbox_id=target;
 DELETE FROM fi.fix_dealer_correlations WHERE sandbox_id=target;
 DELETE FROM fi.fix_outbox WHERE sandbox_id=target;
 DELETE FROM fi.fix_attempts WHERE sandbox_id=target;
 DELETE FROM fi.fix_sequence_slots WHERE sandbox_id=target;
 DELETE FROM fi.fix_messages WHERE sandbox_id=target;
 DELETE FROM fi_control.fix_reservations WHERE sandbox_id=target;
 DELETE FROM fi.fix_lanes WHERE sandbox_id=target;
 DELETE FROM fi.fix_bindings WHERE sandbox_id=target;
 DELETE FROM fi.fix_channels WHERE sandbox_id=target;
 DELETE FROM fi.reconciliation_findings WHERE sandbox_id=target; DELETE FROM fi.reconciliation_events WHERE sandbox_id=target; DELETE FROM fi.reconciliation_runs WHERE sandbox_id=target; DELETE FROM fi.reconciliation_commands WHERE sandbox_id=target; DELETE FROM fi_control.reconciliation_capacity WHERE sandbox_id=target;
 DELETE FROM fi.positions WHERE sandbox_id=target; DELETE FROM fi.order_history WHERE sandbox_id=target; DELETE FROM fi.cancellation_outcomes WHERE sandbox_id=target; DELETE FROM fi.cancellation_requests WHERE sandbox_id=target; DELETE FROM fi.executions WHERE sandbox_id=target; DELETE FROM fi.order_states WHERE sandbox_id=target;
 DELETE FROM fi.orders WHERE sandbox_id=target; DELETE FROM fi.quotes WHERE sandbox_id=target; DELETE FROM fi.invitations WHERE sandbox_id=target; DELETE FROM fi.rfqs WHERE sandbox_id=target;
 DELETE FROM fi.audit_events WHERE sandbox_id=target; DELETE FROM fi.commands WHERE sandbox_id=target; DELETE FROM fi_control.sandbox_access WHERE sandbox_id=target; DELETE FROM fi_control.command_keys WHERE sandbox_id=target; DELETE FROM fi.sandboxes WHERE id=target;removed:=removed+1;
 END LOOP;
 UPDATE fi_control.service_capacity SET retained_count=retained_count-removed WHERE singleton;RETURN removed;
END $$;

DO $copy$ DECLARE d text;BEGIN SELECT pg_get_functiondef('fi_control.valid_reconciliation_metadata(jsonb)'::regprocedure) INTO d;EXECUTE replace(d,'FUNCTION fi_control.valid_reconciliation_metadata(','FUNCTION fi_control.valid_reconciliation_metadata_v1(');END $copy$;
CREATE OR REPLACE FUNCTION fi_control.valid_reconciliation_metadata(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p->>'engine_version'='reconciliation-v1' THEN RETURN fi_control.valid_reconciliation_metadata_v1(p);END IF;
 IF p->>'engine_version' IS DISTINCT FROM 'reconciliation-v2' OR p->>'schema_revision' IS DISTINCT FROM '6' OR jsonb_typeof(p->'schema_checksums') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'schema_checksums')<>6 THEN RETURN false;END IF;
 RETURN fi_control.valid_reconciliation_metadata_v1(p||'{"engine_version":"reconciliation-v1","schema_revision":5}'::jsonb);
END $$;

GRANT SELECT ON fi_control.fix_reservations,fi_control.command_keys TO tf_reconciler;
CREATE POLICY reconciliation ON fi_control.fix_reservations FOR SELECT TO tf_reconciler USING(true);
CREATE POLICY reconciliation ON fi_control.command_keys FOR SELECT TO tf_reconciler USING(true);
CREATE FUNCTION fi_control.fix_snapshot_access(p_id uuid,p_proof text,p_scope text,p_generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
 RETURN COALESCE(fi_control.proof_valid(p_id,p_proof,p_scope) AND EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation),false);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.fix_snapshot_access(uuid,text,text,bigint) TO tf_reconciler;
