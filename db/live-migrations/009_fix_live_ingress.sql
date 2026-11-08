-- Opt-in schema9 live profile. Default schema8 migration discovery is unchanged.
-- Exact raw framing and generic business syntax only; this parser grants no
-- ownership, callback eligibility, financial application or delivery authority.
CREATE FUNCTION fi_control.fix_live_fields(raw bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a text[];part text;tag text;v text;f jsonb:='{}';n integer;i integer;total integer:=0;headers text[];mt text;model jsonb;
BEGIN
 n:=octet_length(raw);
 IF n NOT BETWEEN 1 AND 8192 OR get_byte(raw,n-1)<>1 THEN RETURN NULL;END IF;
 FOR i IN 0..n-1 LOOP IF get_byte(raw,i)<>1 AND get_byte(raw,i) NOT BETWEEN 32 AND 126 THEN RETURN NULL;END IF;END LOOP;
 a:=string_to_array(convert_from(raw,'SQL_ASCII'),chr(1));
 IF COALESCE(array_length(a,1),0) NOT BETWEEN 9 AND 65 OR a[1] IS DISTINCT FROM '8=FIX.4.4' OR a[array_length(a,1)] IS DISTINCT FROM '' THEN RETURN NULL;END IF;
 IF a[2] !~ '^9=[1-9][0-9]{0,4}$' OR a[3] !~ '^35=[D8F9]$' OR a[array_length(a,1)-1] !~ '^10=[0-9]{3}$' THEN RETURN NULL;END IF;
 IF substring(a[2],3)::integer<>n-7-length(a[1])-length(a[2])-2 THEN RETURN NULL;END IF;
 FOR i IN 0..n-8 LOOP total:=total+get_byte(raw,i);END LOOP;
 IF substring(a[array_length(a,1)-1],4)::integer<>total%256 THEN RETURN NULL;END IF;
 FOREACH part IN ARRAY a[1:array_length(a,1)-1] LOOP
 IF part !~ '^[1-9][0-9]{0,4}=[ -~]+$' THEN RETURN NULL;END IF;
 tag:=split_part(part,'=',1);v:=substring(part,length(tag)+2);
 IF f ? tag OR length(v)>256 THEN RETURN NULL;END IF;f:=f||jsonb_build_object(tag,v);
 END LOOP;
 IF (f ? '43' AND f->>'43'<>'Y') OR (f ? '43')<>(f ? '122') THEN RETURN NULL;END IF;
 headers:=CASE WHEN f ? '43' THEN ARRAY['8','9','35','34','43','49','52','56','122'] ELSE ARRAY['8','9','35','34','49','52','56'] END;
 FOR i IN 1..cardinality(headers) LOOP IF split_part(a[i],'=',1) IS DISTINCT FROM headers[i] THEN RETURN NULL;END IF;END LOOP;
 IF f->>'34' !~ '^[1-9][0-9]{0,9}$' OR (f->>'34')::bigint>2147483647 OR f->>'52' !~ '^[0-9]{8}-[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$' OR NOT fi_control.fix_time(f->>'52') THEN RETURN NULL;END IF;
 IF f ? '122' AND (f->>'122' !~ '^[0-9]{8}-[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$' OR NOT fi_control.fix_time(f->>'122') OR f->>'122'>f->>'52') THEN RETURN NULL;END IF;
 mt:=f->>'35';
 IF mt IN ('D','F') THEN IF f->>'49'<>'TRADEFLOW' OR f->>'56'<>'ATLAS' THEN RETURN NULL;END IF;
 ELSE IF f->>'49'<>'ATLAS' OR f->>'56'<>'TRADEFLOW' THEN RETURN NULL;END IF;END IF;
 IF mt='D' THEN IF f->>'21' IS DISTINCT FROM '1' THEN RETURN NULL;END IF;
 ELSIF f ? '21' THEN RETURN NULL;END IF;
 FOREACH tag IN ARRAY ARRAY['11','41'] LOOP
 IF f ? tag AND f->>tag !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN NULL;END IF;
 END LOOP;
 IF mt<>'9' THEN
 IF f->>'38' IS NULL OR f->>'38' !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RETURN NULL;END IF;
 IF (f->>'38')::numeric NOT BETWEEN 1 AND 1000000000 OR f->>'55' NOT IN ('SYN-UST-2031','SYN-CORP-2031') OR f->>'54' NOT IN ('1','2') THEN RETURN NULL;END IF;
 END IF;
 IF mt IN ('D','8') THEN
 IF f->>'44' IS NULL OR f->>'44' !~ '^(0|[1-9][0-9]{0,4})\.[0-9]{12}$' THEN RETURN NULL;END IF;
 IF (f->>'44')::numeric<=0 OR f->>'64' IS NULL OR f->>'64' !~ '^[0-9]{8}$' OR f->>'64'<'20250115' OR f->>'64'>='20310115' OR NOT fi_control.fix_time((f->>'64')||'-00:00:00') THEN RETURN NULL;END IF;
 END IF;
 -- This self-model validates only generic cross-field syntax. Later ingress
 -- must independently compare the parsed fields with the real owned order.
 model:=jsonb_build_object('order_id',COALESCE(f->>'41',f->>'11'),'instrument_id',f->>'55','side',CASE f->>'54' WHEN '1' THEN 'BUY' ELSE 'SELL' END,'par_amount',f->>'38','clean_price',f->>'44','settlement_date',substring(f->>'64',1,4)||'-'||substring(f->>'64',5,2)||'-'||substring(f->>'64',7,2));
 IF NOT COALESCE(fi_control.fix_terms_valid(CASE WHEN mt='D' THEN f-'21' ELSE f END,model,'ATLAS'),false) THEN RETURN NULL;END IF;
 RETURN f;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION fi_control.fix_live_fields(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fi_control.fix_live_fields(bytea) TO tf_app,tf_reconciler;

CREATE TABLE fi.fix_live_sessions(
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id),id uuid NOT NULL,store_id uuid NOT NULL,
 runtime_hash text NOT NULL CHECK(runtime_hash ~ '^[a-f0-9]{64}$'),store_hash text NOT NULL CHECK(store_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,store_id)
);
CREATE TABLE fi.fix_live_bindings(
 sandbox_id uuid NOT NULL,order_id uuid NOT NULL,session_id uuid NOT NULL,profile text NOT NULL DEFAULT 'live-fix-ingress-v1' CHECK(profile='live-fix-ingress-v1'),
 PRIMARY KEY(sandbox_id,order_id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_bindings(sandbox_id,order_id),FOREIGN KEY(sandbox_id,session_id) REFERENCES fi.fix_live_sessions(sandbox_id,id)
);
CREATE TABLE fi.fix_live_connections(
 sandbox_id uuid NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,actor_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>=1),connection_no integer NOT NULL CHECK(connection_no BETWEEN 1 AND 8),go_pid integer NOT NULL CHECK(go_pid>0),java_pid integer NOT NULL CHECK(java_pid>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,session_id,connection_no),FOREIGN KEY(sandbox_id,session_id) REFERENCES fi.fix_live_sessions(sandbox_id,id)
);
CREATE TABLE fi.fix_live_observations(
 sandbox_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,connection_id uuid NOT NULL,direction text NOT NULL CHECK(direction IN ('IN','OUT')),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes) BETWEEN 1 AND 8192),raw_hash text NOT NULL CHECK(raw_hash=encode(sha256(raw_bytes),'hex')),profile_valid boolean NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),FOREIGN KEY(sandbox_id,order_id) REFERENCES fi.fix_live_bindings(sandbox_id,order_id),FOREIGN KEY(sandbox_id,connection_id) REFERENCES fi.fix_live_connections(sandbox_id,id),UNIQUE(sandbox_id,id,order_id,connection_id)
);
CREATE TABLE fi.fix_live_callbacks(
 sandbox_id uuid NOT NULL,observation_id uuid NOT NULL,order_id uuid NOT NULL,connection_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('java','go')),event_seq integer NOT NULL CHECK(event_seq BETWEEN 1 AND 1024),
 callback_bytes bytea NOT NULL CHECK(octet_length(callback_bytes) BETWEEN 1 AND 8192),callback_hash text NOT NULL CHECK(callback_hash=encode(sha256(callback_bytes),'hex')),message_id uuid NOT NULL,accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,observation_id),UNIQUE(sandbox_id,connection_id,role,event_seq),FOREIGN KEY(sandbox_id,observation_id,order_id,connection_id) REFERENCES fi.fix_live_observations(sandbox_id,id,order_id,connection_id),FOREIGN KEY(sandbox_id,order_id,message_id) REFERENCES fi.fix_messages(sandbox_id,order_id,id),FOREIGN KEY(sandbox_id,observation_id) REFERENCES fi.fix_attempts(sandbox_id,id)
);
CREATE TABLE fi.fix_live_sequence_slots(
 sandbox_id uuid NOT NULL,store_id uuid NOT NULL,direction text NOT NULL CHECK(direction IN ('IN','OUT')),message_seq bigint NOT NULL CHECK(message_seq BETWEEN 1 AND 2147483647),message_id uuid NOT NULL,first_observation_id uuid NOT NULL,
 PRIMARY KEY(sandbox_id,store_id,direction,message_seq),FOREIGN KEY(sandbox_id,store_id) REFERENCES fi.fix_live_sessions(sandbox_id,store_id),FOREIGN KEY(sandbox_id,message_id) REFERENCES fi.fix_messages(sandbox_id,id),FOREIGN KEY(sandbox_id,first_observation_id) REFERENCES fi.fix_live_observations(sandbox_id,id)
);
CREATE TABLE fi.fix_live_requests(
 sandbox_id uuid NOT NULL,idempotency_key text NOT NULL,action text NOT NULL,request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=24576),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(sandbox_id,idempotency_key),FOREIGN KEY(sandbox_id,idempotency_key) REFERENCES fi.fix_commands(sandbox_id,idempotency_key)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['fix_live_sessions','fix_live_bindings','fix_live_connections','fix_live_observations','fix_live_callbacks','fix_live_sequence_slots','fix_live_requests'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING(sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING(true)',t);
 EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
 EXECUTE format('CREATE TRIGGER fix_immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);
 END LOOP;
END $$;
-- Preserve proven bodies exactly as private snapshots. Original public OIDs,
-- validation, proof checks and replay logic remain; only live binding admission
-- is inserted after authorization and before the original receipt lookup.
DO $guard$ DECLARE name text;signature text;d text;needle text;sid text;key_name text;private_name text;BEGIN
 FOREACH name IN ARRAY ARRAY['fix_command','apply_fix','ingest_fix'] LOOP
 signature:=CASE name WHEN 'fix_command' THEN '(uuid,text,bigint,text,jsonb,text,uuid)' WHEN 'apply_fix' THEN '(uuid,text,bigint,jsonb,text,uuid)' ELSE '(uuid,text,bigint,jsonb,text,uuid,boolean)' END;
 private_name:=name||'_legacy_v8';SELECT pg_get_functiondef(('fi_control.'||name||signature)::regprocedure) INTO d;
 EXECUTE replace(d,'FUNCTION fi_control.'||name||'(','FUNCTION fi_control.'||private_name||'(');
 EXECUTE 'REVOKE ALL ON FUNCTION fi_control.'||private_name||signature||' FROM PUBLIC,tf_app';
 sid:=CASE name WHEN 'fix_command' THEN 'p_id' ELSE 'sid' END;key_name:=CASE name WHEN 'fix_command' THEN 'p_key' ELSE 'key' END;
 needle:=' SELECT * INTO r FROM fi.fix_commands WHERE sandbox_id='||sid||' AND idempotency_key='||key_name||';';
 IF (length(d)-length(replace(d,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Unexpected legacy authorization/replay boundary';END IF;
 EXECUTE replace(d,needle,' IF EXISTS(SELECT 1 FROM fi.fix_live_bindings WHERE sandbox_id='||sid||' AND order_id=oid) THEN RETURN fi_control.failure(409,''FIX_LIVE_PROFILE_REQUIRED'');END IF;'||chr(10)||needle);
 END LOOP;
END $guard$;

CREATE FUNCTION fi_control.fix_live_hash(sid uuid,action text,p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('version',1,'profile','live-fix-ingress-v1','sandbox',sid,'operation',action,'payload',p)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION fi_control.fix_live_hash(uuid,text,jsonb) FROM PUBLIC,tf_app;
CREATE FUNCTION fi_control.fix_live_authorize(sid uuid,proof text,generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actual bigint;
BEGIN
 IF sid IS NULL OR proof IS NULL OR generation IS NULL THEN RETURN false;END IF;
 PERFORM set_config('tradeflow.sandbox_id',sid::text,true);SELECT s.generation INTO actual FROM fi.sandboxes s WHERE id=sid FOR UPDATE;
 RETURN FOUND AND actual=generation AND fi_control.proof_valid(sid,proof,'trade');
END $$;
REVOKE ALL ON FUNCTION fi_control.fix_live_authorize(uuid,text,bigint) FROM PUBLIC,tf_app;
CREATE FUNCTION fi_control.fix_live_receipt(sid uuid,actor uuid,action text,p jsonb,key text,http_status integer,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE seq integer;rh text:=fi_control.fix_live_hash(sid,action,p);
BEGIN
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=sid;
 IF seq>960 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='FIX_METADATA_QUOTA';END IF;
 INSERT INTO fi.fix_commands VALUES(sid,gen_random_uuid(),key,'LIVE_'||action,rh,seq,http_status,body,actor);
 INSERT INTO fi.fix_events VALUES(sid,seq,0,'LIVE_'||action,(p->>'order_id')::uuid,jsonb_build_object('profile','live-fix-ingress-v1','financial_applied',false,'record',body),clock_timestamp());
 INSERT INTO fi.fix_live_requests VALUES(sid,key,action,p,rh);
 RETURN fi_control.result(http_status,body);
END $$;
REVOKE ALL ON FUNCTION fi_control.fix_live_receipt(uuid,uuid,text,jsonb,text,integer,jsonb) FROM PUBLIC,tf_app;

CREATE FUNCTION fi_control.fix_live_command(sid uuid,proof text,p_generation bigint,p_action text,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed text[];tag text;oid uuid;aid uuid;mid uuid;conn_id uuid;store uuid;session uuid;rh text;seq integer;pid_go integer;pid_java integer;
 b fi.fix_bindings%ROWTYPE;lb fi.fix_live_bindings%ROWTYPE;c fi.fix_live_connections%ROWTYPE;o fi.fix_live_observations%ROWTYPE;m fi.fix_messages%ROWTYPE;
 runtime fi.fix_live_sessions%ROWTYPE;request_row fi.fix_live_requests%ROWTYPE;receipt fi.fix_commands%ROWTYPE;
 result jsonb;body jsonb;f jsonb;cf jsonb;terms jsonb;raw bytea;callback bytea;semantic jsonb;h text;identity text;kind text;wire_direction text;known text;n integer;duplicate boolean;valid boolean;
BEGIN
 IF sid IS NULL OR proof IS NULL OR p_generation IS NULL OR p_action IS NULL OR actor IS NULL OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{8,128}$' OR p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>24576 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 allowed:=CASE p_action WHEN 'BIND' THEN ARRAY['order_id','dealer_id','channel_id','session_id','store_id','connection_id','runtime_hash','store_hash','go_pid','java_pid'] WHEN 'CONNECT' THEN ARRAY['order_id','connection_id','go_pid','java_pid'] WHEN 'OBSERVE' THEN ARRAY['order_id','observation_id','connection_id','direction','raw_hex'] WHEN 'ACCEPT' THEN ARRAY['order_id','observation_id','connection_id','role','event_seq','callback_hex'] WHEN 'CLAIM' THEN ARRAY['order_id','owner_id'] WHEN 'QUEUE' THEN ARRAY['order_id','message_id','work_id'] WHEN 'PREPARE' THEN ARRAY['order_id','owner_id','fence','work_id','financial_key'] WHEN 'RESOLVE_METADATA' THEN ARRAY['order_id','owner_id','fence','work_id'] WHEN 'RELEASE' THEN ARRAY['order_id'] END;
 IF allowed IS NULL OR NOT(p ?& allowed) OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(allowed) OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 FOREACH tag IN ARRAY ARRAY['order_id','channel_id','session_id','store_id','connection_id','observation_id','owner_id','message_id','work_id'] LOOP
 IF p ? tag THEN p:=jsonb_set(p,ARRAY[tag],to_jsonb((p->>tag)::uuid::text));END IF;END LOOP;
 FOREACH tag IN ARRAY ARRAY['raw_hex','callback_hex'] LOOP
 IF p ? tag AND (octet_length(p->>tag) NOT BETWEEN 2 AND 16384 OR octet_length(p->>tag)%2<>0 OR p->>tag !~ '^[a-f0-9]+$') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;END LOOP;
 oid:=(p->>'order_id')::uuid;rh:=fi_control.fix_live_hash(sid,p_action,p);
 IF NOT fi_control.fix_live_authorize(sid,proof,p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO request_row FROM fi.fix_live_requests WHERE sandbox_id=sid AND idempotency_key=key;
 IF FOUND THEN
 IF request_row.action<>p_action OR request_row.request_hash<>rh THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 SELECT * INTO receipt FROM fi.fix_commands WHERE sandbox_id=sid AND idempotency_key=key;
 IF NOT FOUND THEN RETURN fi_control.failure(409,'FIX_LIVE_RECEIPT_UNRESOLVED');END IF;
 RETURN fi_control.result(receipt.http_status,receipt.response_body,true);
 END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=sid AND idempotency_key=key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 IF EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=sid AND write_expires_at<=clock_timestamp()) THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 SELECT COALESCE(max(command_seq),0)+1 INTO seq FROM fi.fix_commands WHERE sandbox_id=sid;
 IF seq>(CASE WHEN p_action='CLAIM' THEN 1024 ELSE 960 END) THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');END IF;
 IF p_action IN ('BIND','CONNECT') THEN
 IF p->>'go_pid' !~ '^[1-9][0-9]{0,9}$' OR p->>'java_pid' !~ '^[1-9][0-9]{0,9}$' OR (p->>'go_pid')::bigint>2147483647 OR (p->>'java_pid')::bigint>2147483647 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 pid_go:=(p->>'go_pid')::integer;pid_java:=(p->>'java_pid')::integer;
 END IF;
 IF p_action='BIND' THEN
 IF p->>'dealer_id'<>'ATLAS' OR p->>'runtime_hash' !~ '^[a-f0-9]{64}$' OR p->>'store_hash' !~ '^[a-f0-9]{64}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 session:=(p->>'session_id')::uuid;store:=(p->>'store_id')::uuid;conn_id:=(p->>'connection_id')::uuid;
 IF EXISTS(SELECT 1 FROM fi.fix_live_sessions WHERE sandbox_id=sid AND store_id=store AND id<>session) THEN RETURN fi_control.failure(409,'FIX_LIVE_RUNTIME_CONFLICT');END IF;
 SELECT * INTO runtime FROM fi.fix_live_sessions WHERE sandbox_id=sid AND id=session;
 IF FOUND THEN IF runtime.store_id<>store OR runtime.runtime_hash<>p->>'runtime_hash' OR runtime.store_hash<>p->>'store_hash' THEN RETURN fi_control.failure(409,'FIX_LIVE_RUNTIME_CONFLICT');END IF;
 ELSE IF (SELECT count(*) FROM fi.fix_live_sessions WHERE sandbox_id=sid)>=4 THEN RETURN fi_control.failure(429,'FIX_LIVE_RUNTIME_QUOTA');END IF;END IF;
 SELECT * INTO c FROM fi.fix_live_connections WHERE sandbox_id=sid AND id=conn_id;
 IF FOUND THEN IF c.session_id<>session OR c.actor_id<>actor OR c.generation<>p_generation OR c.go_pid<>pid_go OR c.java_pid<>pid_java THEN RETURN fi_control.failure(409,'FIX_LIVE_CONNECTION_CONFLICT');END IF;
 ELSE IF (SELECT count(*) FROM fi.fix_live_connections WHERE sandbox_id=sid AND session_id=session)>=8 THEN RETURN fi_control.failure(429,'FIX_LIVE_CONNECTION_QUOTA');END IF;END IF;
 result:=fi_control.fix_command_legacy_v8(sid,proof,p_generation,'BIND',p-ARRAY['session_id','store_id','connection_id','runtime_hash','store_hash','go_pid','java_pid'],key,actor);
 IF (result->>'status')::integer NOT IN (200,201) THEN RETURN result;END IF;
 INSERT INTO fi.fix_live_sessions(sandbox_id,id,store_id,runtime_hash,store_hash) VALUES(sid,session,store,p->>'runtime_hash',p->>'store_hash') ON CONFLICT DO NOTHING;
 INSERT INTO fi.fix_live_bindings VALUES(sid,oid,session,'live-fix-ingress-v1');
 INSERT INTO fi.fix_live_connections(sandbox_id,id,session_id,actor_id,generation,connection_no,go_pid,java_pid) VALUES(sid,conn_id,session,actor,p_generation,(SELECT COALESCE(max(connection_no),0)+1 FROM fi.fix_live_connections WHERE sandbox_id=sid AND session_id=session),pid_go,pid_java) ON CONFLICT DO NOTHING;
 INSERT INTO fi.fix_live_requests VALUES(sid,key,p_action,p,rh);RETURN result;
 END IF;
 SELECT * INTO lb FROM fi.fix_live_bindings WHERE sandbox_id=sid AND order_id=oid;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'FIX_LIVE_BINDING_NOT_FOUND');END IF;
 SELECT * INTO STRICT b FROM fi.fix_bindings WHERE sandbox_id=sid AND order_id=oid;
 IF EXISTS(SELECT 1 FROM fi.fix_lanes WHERE sandbox_id=sid AND order_id=oid AND closed_at IS NOT NULL) THEN RETURN fi_control.failure(409,'FIX_BINDING_CLOSED');END IF;
 IF p_action='CONNECT' THEN
 conn_id:=(p->>'connection_id')::uuid;
 IF EXISTS(SELECT 1 FROM fi.fix_live_connections WHERE sandbox_id=sid AND id=conn_id) THEN RETURN fi_control.failure(409,'FIX_LIVE_CONNECTION_CONFLICT');END IF;
 IF (SELECT count(*) FROM fi.fix_live_connections WHERE sandbox_id=sid AND session_id=lb.session_id)>=8 THEN RETURN fi_control.failure(429,'FIX_LIVE_CONNECTION_QUOTA');END IF;
 INSERT INTO fi.fix_live_connections(sandbox_id,id,session_id,actor_id,generation,connection_no,go_pid,java_pid) VALUES(sid,conn_id,lb.session_id,actor,p_generation,(SELECT COALESCE(max(connection_no),0)+1 FROM fi.fix_live_connections WHERE sandbox_id=sid AND session_id=lb.session_id),pid_go,pid_java);
 RETURN fi_control.fix_live_receipt(sid,actor,p_action,p,key,201,jsonb_build_object('order_id',oid,'connection_id',conn_id,'financial_applied',false));
 END IF;
 IF p_action IN ('OBSERVE','ACCEPT') THEN
 conn_id:=(p->>'connection_id')::uuid;
 SELECT * INTO c FROM fi.fix_live_connections WHERE sandbox_id=sid AND id=conn_id AND session_id=lb.session_id;
 IF NOT FOUND OR c.actor_id<>actor OR c.generation<>p_generation OR c.connection_no<>(SELECT max(connection_no) FROM fi.fix_live_connections WHERE sandbox_id=sid AND session_id=lb.session_id) THEN RETURN fi_control.failure(409,'FIX_LIVE_STALE_CONNECTION');END IF;
 END IF;
 IF p_action='OBSERVE' THEN
 IF p->>'direction' NOT IN ('IN','OUT') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 IF (SELECT count(*) FROM fi.fix_live_observations WHERE sandbox_id=sid AND order_id=oid)>=160 OR
 (SELECT count(*) FROM fi.fix_live_observations x WHERE x.sandbox_id=sid AND x.order_id=oid AND NOT EXISTS(SELECT 1 FROM fi.fix_live_callbacks y WHERE y.sandbox_id=sid AND y.observation_id=x.id))>=8 THEN RETURN fi_control.failure(429,'FIX_LIVE_OBSERVATION_QUOTA');END IF;
 aid:=(p->>'observation_id')::uuid;raw:=decode(p->>'raw_hex','hex');f:=fi_control.fix_live_fields(raw);
 SELECT contract||jsonb_build_object('order_id',id) INTO terms FROM fi.orders WHERE sandbox_id=sid AND id=oid;
 valid:=f IS NOT NULL AND COALESCE(fi_control.fix_terms_valid(CASE WHEN f->>'35'='D' THEN f-'21' ELSE f END,terms,'ATLAS'),false) AND p->>'direction'=(CASE WHEN f->>'35' IN ('D','F') THEN 'OUT' ELSE 'IN' END);
 -- Independent arrival freshness closes native engine resend-state exceptions.
 IF valid THEN
 valid:=abs(extract(epoch FROM (clock_timestamp()-(substring(f->>'52',1,4)||'-'||substring(f->>'52',5,2)||'-'||substring(f->>'52',7,2)||' '||substring(f->>'52',10)||'+00')::timestamptz)))<120;
 END IF;
 INSERT INTO fi.fix_live_observations(sandbox_id,id,order_id,connection_id,direction,raw_bytes,raw_hash,profile_valid) VALUES(sid,aid,oid,conn_id,p->>'direction',raw,encode(sha256(raw),'hex'),COALESCE(valid,false));
 body:=jsonb_build_object('order_id',oid,'observation_id',aid,'raw_hash',encode(sha256(raw),'hex'),'profile_valid',COALESCE(valid,false),'accepted',false,'unresolved',true,'financial_applied',false);
 RETURN fi_control.fix_live_receipt(sid,actor,p_action,p,key,201,body);
 ELSIF p_action='ACCEPT' THEN
 IF p->>'role' NOT IN ('java','go') OR p->>'event_seq' !~ '^[1-9][0-9]{0,3}$' OR (p->>'event_seq')::integer>1024 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 aid:=(p->>'observation_id')::uuid;
 SELECT * INTO o FROM fi.fix_live_observations WHERE sandbox_id=sid AND id=aid AND order_id=oid AND connection_id=conn_id;
 IF NOT FOUND OR NOT o.profile_valid THEN RETURN fi_control.failure(409,'FIX_LIVE_OBSERVATION_UNRESOLVED');END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_live_callbacks WHERE sandbox_id=sid AND observation_id=aid) THEN RETURN fi_control.failure(409,'FIX_LIVE_CALLBACK_EXISTS');END IF;
 callback:=decode(p->>'callback_hex','hex');cf:=fi_control.fix_live_fields(callback);f:=fi_control.fix_live_fields(o.raw_bytes);
 IF cf IS NULL OR (cf-ARRAY['8','9','10']) IS DISTINCT FROM (f-ARRAY['8','9','10']) OR p->>'role'<>(CASE o.direction WHEN 'IN' THEN 'java' ELSE 'go' END) THEN RETURN fi_control.failure(409,'FIX_LIVE_CALLBACK_CORRESPONDENCE');END IF;
 raw:=o.raw_bytes;wire_direction:=o.direction;kind:=CASE f->>'35' WHEN 'D' THEN 'ORDER' WHEN 'F' THEN 'CANCEL' WHEN '8' THEN 'EXEC_REPORT' ELSE 'CANCEL_REJECT' END;
 identity:=CASE WHEN f->>'35'='8' THEN f->>'17' ELSE f->>'11' END;
 semantic:=f-ARRAY['8','9','10','34','43','52','122'];h:=encode(sha256(convert_to(semantic::text,'UTF8')),'hex');
 SELECT * INTO m FROM fi.fix_messages WHERE sandbox_id=sid AND dealer_id='ATLAS' AND identity_kind=kind AND identity_value=identity;
 duplicate:=FOUND;
 IF duplicate THEN IF m.order_id<>oid OR m.semantic_hash<>h THEN RETURN fi_control.failure(409,'FIX_IDENTITY_CONFLICT');END IF;mid:=m.id;
 ELSE
 IF (SELECT count(*) FROM fi.fix_messages WHERE sandbox_id=sid AND order_id=oid)>=40 THEN RETURN fi_control.failure(429,'FIX_MESSAGE_QUOTA');END IF;
 mid:=gen_random_uuid();INSERT INTO fi.fix_messages VALUES(sid,mid,oid,'ATLAS',kind,identity,wire_direction,f->>'35',f,h,CASE WHEN f->>'150'='F' THEN gen_random_uuid() END,CASE WHEN f->>'150'='F' THEN gen_random_uuid() END,clock_timestamp());
 END IF;
 IF f ? '41' THEN
 IF EXISTS(SELECT 1 FROM fi.fix_cancel_correlations WHERE sandbox_id=sid AND cl_ord_id=(f->>'11')::uuid AND order_id<>oid) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_CANCEL_CORRELATION_CONFLICT';END IF;
 INSERT INTO fi.fix_cancel_correlations VALUES(sid,(f->>'11')::uuid,oid,(f->>'41')::uuid,mid) ON CONFLICT DO NOTHING;
 END IF;
 SELECT dealer_order_id INTO known FROM fi.fix_dealer_correlations WHERE sandbox_id=sid AND order_id=oid;
 IF f ? '37' THEN
 IF known IS NOT NULL AND known<>f->>'37' THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_DEALER_ORDER_CONFLICT';END IF;
 IF known IS NULL THEN IF f->>'35'<>'8' THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_DEALER_ORDER_UNKNOWN';END IF;
 INSERT INTO fi.fix_dealer_correlations VALUES(sid,oid,'ATLAS',f->>'37',mid);END IF;END IF;
 SELECT store_id INTO STRICT store FROM fi.fix_live_sessions WHERE sandbox_id=sid AND id=lb.session_id;
 IF EXISTS(SELECT 1 FROM fi.fix_live_sequence_slots x WHERE x.sandbox_id=sid AND x.store_id=store AND x.direction=wire_direction AND x.message_seq=(f->>'34')::bigint AND x.message_id<>mid) THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_SEQUENCE_IDENTITY_CONFLICT';END IF;
 INSERT INTO fi.fix_live_sequence_slots VALUES(sid,store,wire_direction,(f->>'34')::bigint,mid,aid) ON CONFLICT DO NOTHING;
 IF f->>'43'='Y' AND m.id IS NOT NULL AND f->>'122'<>COALESCE(m.fields->>'122',m.fields->>'52') THEN RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='FIX_ORIGINAL_TIME_CONFLICT';END IF;
 SELECT count(*)+1 INTO n FROM fi.fix_attempts WHERE sandbox_id=sid AND message_id=mid;
 IF n>4 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='FIX_ATTEMPT_QUOTA';END IF;
 INSERT INTO fi.fix_attempts VALUES(sid,aid,mid,n,raw,encode(sha256(raw),'hex'),CASE wire_direction WHEN 'IN' THEN 'RECEIVED' ELSE 'STAGED' END,clock_timestamp());
 IF wire_direction='OUT' THEN INSERT INTO fi.fix_outbox VALUES(sid,mid,oid,'NOT_IMPLEMENTED') ON CONFLICT DO NOTHING;END IF;
 INSERT INTO fi.fix_live_callbacks(sandbox_id,observation_id,order_id,connection_id,role,event_seq,callback_bytes,callback_hash,message_id) VALUES(sid,aid,oid,conn_id,p->>'role',(p->>'event_seq')::integer,callback,encode(sha256(callback),'hex'),mid);
 body:=jsonb_build_object('order_id',oid,'message_id',mid,'attempt_id',aid,'observation_id',aid,'raw_hash',encode(sha256(raw),'hex'),'callback_hash',encode(sha256(callback),'hex'),'logical_duplicate',duplicate,'accepted',true,'financial_applied',false,'delivery_verified',false);
 RETURN fi_control.fix_live_receipt(sid,actor,p_action,p,key,201,body);
 END IF;
 IF p_action IN ('QUEUE','PREPARE','RESOLVE_METADATA') THEN
 IF EXISTS(SELECT 1 FROM fi.fix_live_observations x WHERE x.sandbox_id=sid AND x.order_id=oid AND NOT EXISTS(SELECT 1 FROM fi.fix_live_callbacks y WHERE y.sandbox_id=sid AND y.observation_id=x.id)) THEN RETURN fi_control.failure(409,'FIX_LIVE_OBSERVATION_UNRESOLVED');END IF;
 IF p_action='QUEUE' THEN mid:=(p->>'message_id')::uuid;
 ELSE SELECT message_id INTO mid FROM fi.fix_work WHERE sandbox_id=sid AND id=(p->>'work_id')::uuid AND order_id=oid;END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_live_callbacks WHERE sandbox_id=sid AND order_id=oid AND message_id=mid) THEN RETURN fi_control.failure(409,'FIX_LIVE_CALLBACK_REQUIRED');END IF;
 ELSIF p_action='RELEASE' AND EXISTS(SELECT 1 FROM fi.fix_live_observations WHERE sandbox_id=sid AND order_id=oid) THEN RETURN fi_control.failure(409,'FIX_UNRESOLVED_INTENTS');END IF;
 result:=fi_control.fix_command_legacy_v8(sid,proof,p_generation,p_action,p,key,actor);
 IF (result->>'status')::integer IN (200,201) THEN INSERT INTO fi.fix_live_requests VALUES(sid,key,p_action,p,rh);END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
 WHEN SQLSTATE 'TF409' OR unique_violation THEN RETURN fi_control.failure(409,'FIX_LIVE_IDENTITY_CONFLICT');
 WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'FIX_METADATA_QUOTA');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.fix_live_command(uuid,text,bigint,text,jsonb,text,uuid) TO tf_app;

CREATE FUNCTION fi_control.apply_live_fix(sid uuid,proof text,p_generation bigint,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE oid uuid;wid uuid;rh text;request_row fi.fix_live_requests%ROWTYPE;receipt fi.fix_commands%ROWTYPE;result jsonb;
BEGIN
 IF sid IS NULL OR proof IS NULL OR p_generation IS NULL OR actor IS NULL OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{8,128}$' OR p IS NULL OR jsonb_typeof(p)<>'object' OR NOT(p ?& ARRAY['order_id','owner_id','fence','work_id']) OR (SELECT count(*) FROM jsonb_object_keys(p))<>4 OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value)<>'string') OR p->>'fence' !~ '^[1-9][0-9]{0,15}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 oid:=(p->>'order_id')::uuid;wid:=(p->>'work_id')::uuid;
 p:=jsonb_build_object('order_id',oid,'owner_id',(p->>'owner_id')::uuid,'fence',p->>'fence','work_id',wid);rh:=fi_control.fix_live_hash(sid,'APPLY',p);
 IF NOT fi_control.fix_live_authorize(sid,proof,p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT * INTO request_row FROM fi.fix_live_requests WHERE sandbox_id=sid AND idempotency_key=key;
 IF FOUND THEN
 IF request_row.action<>'APPLY' OR request_row.request_hash<>rh THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 SELECT * INTO receipt FROM fi.fix_commands WHERE sandbox_id=sid AND idempotency_key=key;
 IF NOT FOUND THEN RETURN fi_control.failure(409,'FIX_LIVE_RECEIPT_UNRESOLVED');END IF;
 RETURN fi_control.result(receipt.http_status,receipt.response_body,true);END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=sid AND idempotency_key=key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_live_bindings WHERE sandbox_id=sid AND order_id=oid) THEN RETURN fi_control.failure(404,'FIX_LIVE_BINDING_NOT_FOUND');END IF;
 IF EXISTS(SELECT 1 FROM fi.fix_live_observations x WHERE x.sandbox_id=sid AND x.order_id=oid AND NOT EXISTS(SELECT 1 FROM fi.fix_live_callbacks y WHERE y.sandbox_id=sid AND y.observation_id=x.id)) THEN RETURN fi_control.failure(409,'FIX_LIVE_OBSERVATION_UNRESOLVED');END IF;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_work w JOIN fi.fix_live_callbacks c ON c.sandbox_id=w.sandbox_id AND c.message_id=w.message_id AND c.order_id=w.order_id WHERE w.sandbox_id=sid AND w.id=wid AND w.order_id=oid) THEN RETURN fi_control.failure(409,'FIX_LIVE_CALLBACK_REQUIRED');END IF;
 -- This is the exact proven application body. Kernel effect, reservation
 -- consumption, old protocol receipt and the new context commit together.
 result:=fi_control.apply_fix_legacy_v8(sid,proof,p_generation,p,key,actor);
 IF (result->>'status')::integer IN (200,201) AND EXISTS(SELECT 1 FROM fi.fix_commands WHERE sandbox_id=sid AND idempotency_key=key) THEN INSERT INTO fi.fix_live_requests VALUES(sid,key,'APPLY',p,rh);END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
 WHEN SQLSTATE 'TF409' OR unique_violation THEN RETURN fi_control.failure(409,'FIX_LIVE_IDENTITY_CONFLICT');
 WHEN SQLSTATE 'TF429' THEN RETURN fi_control.failure(429,'PROTECTED_FINANCIAL_CAPACITY');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.apply_live_fix(uuid,text,bigint,jsonb,text,uuid) TO tf_app;

-- Read uses the original proof/scope/generation policy, then requires live
-- provenance before adding this profile label. Legacy receipts stay legacy.
CREATE FUNCTION fi_control.read_live_fix(sid uuid,proof text,scope text,generation bigint,kind text,ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;body jsonb;oid uuid;
BEGIN
 result:=fi_control.read_fix(sid,proof,scope,generation,kind,ref);
 IF (result->>'status')::integer<>200 THEN RETURN result;END IF;
 IF kind='RECEIPT' THEN
 IF NOT EXISTS(SELECT 1 FROM fi.fix_live_requests WHERE sandbox_id=sid AND idempotency_key=ref) THEN RETURN fi_control.failure(404,'FIX_LIVE_RECEIPT_UNRESOLVED');END IF;
 ELSIF kind='STATE' THEN
 oid:=ref::uuid;
 IF NOT EXISTS(SELECT 1 FROM fi.fix_live_bindings WHERE sandbox_id=sid AND order_id=oid) THEN RETURN fi_control.failure(404,'FIX_LIVE_BINDING_NOT_FOUND');END IF;
 ELSE RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 body:=result->'body'||jsonb_build_object('profile','live-fix-ingress-v1','delivery_verified',false,'external_completeness_verified',false);
 IF kind='STATE' THEN
 body:=body||jsonb_build_object('live_binding',(SELECT to_jsonb(b) FROM fi.fix_live_bindings b WHERE b.sandbox_id=sid AND b.order_id=oid),'observations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'connection_id',o.connection_id,'direction',o.direction,'raw_hash',o.raw_hash,'profile_valid',o.profile_valid,'accepted',c.observation_id IS NOT NULL,'message_id',c.message_id) ORDER BY o.observed_at,o.id) FROM fi.fix_live_observations o LEFT JOIN fi.fix_live_callbacks c ON(c.sandbox_id,c.observation_id)=(o.sandbox_id,o.id) WHERE o.sandbox_id=sid AND o.order_id=oid),'[]'::jsonb));
 END IF;
 RETURN fi_control.result(200,body);
EXCEPTION WHEN invalid_text_representation THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;
REVOKE ALL ON FUNCTION fi_control.read_live_fix(uuid,text,text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fi_control.read_live_fix(uuid,text,text,bigint,text,text) TO tf_app;

-- Purge only the complete expired owned graph, under the original maintenance
-- locks, capability checks and protected-lease policy. No selective live repair.
DO $purge$ DECLARE d text;needle text:='DELETE FROM fi.fix_unresolved_ingest WHERE sandbox_id=target;';BEGIN
 SELECT pg_get_functiondef('fi_control.purge_expired()'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Unexpected owned purge body';END IF;
 EXECUTE replace(d,needle,'DELETE FROM fi.fix_live_requests WHERE sandbox_id=target; DELETE FROM fi.fix_live_callbacks WHERE sandbox_id=target; DELETE FROM fi.fix_live_sequence_slots WHERE sandbox_id=target; DELETE FROM fi.fix_live_observations WHERE sandbox_id=target; DELETE FROM fi.fix_live_connections WHERE sandbox_id=target; DELETE FROM fi.fix_live_bindings WHERE sandbox_id=target; DELETE FROM fi.fix_live_sessions WHERE sandbox_id=target; '||needle);
END $purge$;
