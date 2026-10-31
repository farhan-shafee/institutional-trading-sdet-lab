GRANT SELECT ON fi_control.compatibility,fi_control.schema_migrations TO tf_reconciler;
-- Reconciliation control records deliberately do not mutate the financial ledger being checked.
CREATE TABLE fi_control.command_keys (
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id) DEFERRABLE INITIALLY DEFERRED,
 idempotency_key text NOT NULL, domain text NOT NULL CHECK(domain IN ('FINANCIAL','RECONCILIATION')),
 PRIMARY KEY(sandbox_id,idempotency_key)
);
ALTER TABLE fi_control.command_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi_control.command_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON fi_control.command_keys TO tf_owner USING(true) WITH CHECK(true);
INSERT INTO fi_control.command_keys SELECT sandbox_id,idempotency_key,'FINANCIAL' FROM fi.commands;
CREATE FUNCTION fi_control.reserve_command_key() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 -- All application writers serialize on their owned sandbox; this guard also covers privileged direct inserts.
 PERFORM 1 FROM fi.sandboxes WHERE id=NEW.sandbox_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=NEW.sandbox_id AND idempotency_key=NEW.idempotency_key) THEN
 RAISE EXCEPTION USING ERRCODE='TF409',MESSAGE='IDEMPOTENCY_KEY_REUSED'; END IF;
 INSERT INTO fi_control.command_keys VALUES(NEW.sandbox_id,NEW.idempotency_key,CASE TG_TABLE_NAME WHEN 'commands' THEN 'FINANCIAL' ELSE 'RECONCILIATION' END);
 RETURN NEW;
END $$;
CREATE TRIGGER shared_idempotency_key BEFORE INSERT ON fi.commands FOR EACH ROW EXECUTE FUNCTION fi_control.reserve_command_key();
CREATE TABLE fi_control.reconciliation_capacity (
 sandbox_id uuid PRIMARY KEY REFERENCES fi.sandboxes(id), command_count integer NOT NULL DEFAULT 0 CHECK(command_count BETWEEN 0 AND 64),
 recovery_reserved integer NOT NULL DEFAULT 0 CHECK(recovery_reserved BETWEEN 0 AND 1)
);
ALTER TABLE fi_control.reconciliation_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi_control.reconciliation_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON fi_control.reconciliation_capacity TO tf_owner USING(true) WITH CHECK(true);
CREATE TABLE fi.reconciliation_commands (
 sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id), id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 operation text NOT NULL CHECK(operation IN ('CREATE_RECONCILIATION','RECOVER_RECONCILIATION')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), command_seq bigint NOT NULL CHECK(command_seq BETWEEN 1 AND 64),
 http_status integer NOT NULL CHECK(http_status IN (200,201,409)), response_body jsonb NOT NULL CHECK(jsonb_typeof(response_body)='object' AND octet_length(response_body::text)<=8192),
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(sandbox_id,id),UNIQUE(sandbox_id,idempotency_key),UNIQUE(sandbox_id,command_seq),UNIQUE(sandbox_id,id,command_seq)
);
CREATE TRIGGER shared_idempotency_key BEFORE INSERT ON fi.reconciliation_commands FOR EACH ROW EXECUTE FUNCTION fi_control.reserve_command_key();
CREATE TRIGGER reconciliation_command_immutable BEFORE UPDATE OR DELETE ON fi.reconciliation_commands FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();
CREATE FUNCTION fi_control.record_reconciliation_command(p_id uuid,p_cid uuid,p_key text,p_hash text,p_action text,p_status integer,p_body jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 UPDATE fi_control.reconciliation_capacity SET command_count=command_count+1 WHERE sandbox_id=p_id RETURNING command_count INTO STRICT n;
 INSERT INTO fi.reconciliation_commands(sandbox_id,id,idempotency_key,operation,request_hash,command_seq,http_status,response_body,actor_id) VALUES(p_id,p_cid,p_key,p_action,p_hash,n,p_status,p_body,p_actor);
 RETURN fi_control.result(p_status,p_body);
END $$;

CREATE TABLE fi.reconciliation_runs (
 sandbox_id uuid NOT NULL, id uuid NOT NULL, run_no integer NOT NULL CHECK(run_no BETWEEN 1 AND 20),
 state text NOT NULL CHECK(state IN ('REQUESTED','RUNNING','COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS','INCOMPLETE','FAILED')),
 version integer NOT NULL CHECK(version BETWEEN 1 AND 3),
 request_command_id uuid NOT NULL, request_command_seq bigint NOT NULL,
 source_metadata jsonb NOT NULL CHECK(jsonb_typeof(source_metadata)='object' AND octet_length(source_metadata::text)<=8192),
 requested_at timestamptz NOT NULL, started_at timestamptz, lease_expires_at timestamptz, completed_at timestamptz, worker_id uuid,
 snapshot_id text CHECK(octet_length(snapshot_id)<=4096), snapshot_at timestamptz, source_watermark bigint CHECK(source_watermark>=0),
 coverage jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(coverage)='array' AND jsonb_array_length(coverage)<=4 AND octet_length(coverage::text)<=4096),
 complete boolean NOT NULL DEFAULT false, finding_count integer NOT NULL DEFAULT 0 CHECK(finding_count BETWEEN 0 AND 128),
 total_findings integer NOT NULL DEFAULT 0 CHECK(total_findings BETWEEN 0 AND 100000), failure_reason text CHECK(failure_reason IN ('INTERRUPTED_BEFORE_START','INTERRUPTED_SCAN','REQUEST_EXPIRED','LEASE_EXPIRED','FINDING_LIMIT','SQL_FAILURE','DATABASE_UNAVAILABLE','ENGINE_CHANGED','SOURCE_CHANGED','VERIFICATION_TIMEOUT')),
 report_hash text CHECK(report_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(sandbox_id,id), UNIQUE(sandbox_id,run_no), FOREIGN KEY(sandbox_id) REFERENCES fi.sandboxes(id),
 FOREIGN KEY(sandbox_id,request_command_id,request_command_seq) REFERENCES fi.reconciliation_commands(sandbox_id,id,command_seq) DEFERRABLE INITIALLY DEFERRED,
 CHECK(complete=(state IN ('COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS'))),
 CHECK((state IN ('REQUESTED','RUNNING'))=(completed_at IS NULL)),
 CHECK((state IN ('INCOMPLETE','FAILED'))=(failure_reason IS NOT NULL)),
 CHECK(state<>'REQUESTED' OR (version=1 AND worker_id IS NULL AND started_at IS NULL)),
 CHECK(state<>'RUNNING' OR (version=2 AND worker_id IS NOT NULL AND started_at IS NOT NULL AND lease_expires_at>started_at)),
 CHECK(NOT complete OR (snapshot_id IS NOT NULL AND snapshot_at IS NOT NULL AND source_watermark IS NOT NULL AND report_hash IS NOT NULL AND jsonb_array_length(coverage)=4)),
 CHECK(state<>'COMPLETED_CLEAN' OR (finding_count=0 AND total_findings=0)),
 CHECK(state<>'COMPLETED_WITH_FINDINGS' OR (finding_count>0 AND finding_count=total_findings)),
 CHECK(total_findings>=finding_count)
);
CREATE UNIQUE INDEX reconciliation_one_active ON fi.reconciliation_runs(sandbox_id) WHERE state IN ('REQUESTED','RUNNING');
CREATE TABLE fi.reconciliation_events (
 sandbox_id uuid NOT NULL, run_id uuid NOT NULL, event_no integer NOT NULL CHECK(event_no BETWEEN 1 AND 3),
 state text NOT NULL CHECK(state IN ('REQUESTED','RUNNING','COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS','INCOMPLETE','FAILED')),
 decided_at timestamptz NOT NULL, reason text, report_hash text,
 PRIMARY KEY(sandbox_id,run_id,event_no), FOREIGN KEY(sandbox_id,run_id) REFERENCES fi.reconciliation_runs(sandbox_id,id)
);
CREATE TABLE fi.reconciliation_findings (
 sandbox_id uuid NOT NULL, run_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 128),
 category text NOT NULL CHECK(category IN ('FOUNDATION','RFQ_CONTRACT','ORDER_QUANTITY','EXECUTION_FINANCE','POSITION','CANCELLATION','AUDIT_HISTORY','REFERENCE','INSTRUMENT_SOURCE')),
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
 record_kind text NOT NULL CHECK(record_kind IN ('SANDBOX','COMMAND','RFQ','QUOTE','ORDER','EXECUTION','POSITION','CANCELLATION','INSTRUMENT')),
 record_id text NOT NULL CHECK(octet_length(record_id) BETWEEN 1 AND 128),
 related jsonb NOT NULL CHECK(jsonb_typeof(related)='object' AND octet_length(related::text)<=2048),
 expected jsonb NOT NULL CHECK(jsonb_typeof(expected)='object' AND octet_length(expected::text)<=4096),
 observed jsonb NOT NULL CHECK(jsonb_typeof(observed)='object' AND octet_length(observed::text)<=4096),
 PRIMARY KEY(sandbox_id,run_id,ordinal), FOREIGN KEY(sandbox_id,run_id) REFERENCES fi.reconciliation_runs(sandbox_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reconciliation_commands','reconciliation_runs','reconciliation_events','reconciliation_findings'] LOOP
 EXECUTE format('ALTER TABLE fi.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE fi.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY app_scope ON fi.%I TO tf_app USING(sandbox_id::text=current_setting(''tradeflow.sandbox_id'',true))',t);
 EXECUTE format('CREATE POLICY owner_scope ON fi.%I TO tf_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY reconciliation ON fi.%I FOR SELECT TO tf_reconciler USING(true)',t);
 EXECUTE format('GRANT SELECT ON fi.%I TO tf_app,tf_reconciler',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['reconciliation_events','reconciliation_findings'] LOOP
 EXECUTE format('CREATE TRIGGER reconciliation_immutable BEFORE UPDATE OR DELETE ON fi.%I FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record()',t);
 END LOOP;
END $$;
CREATE FUNCTION fi_control.reconciliation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='tf_owner' THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' OR OLD.state NOT IN ('REQUESTED','RUNNING') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Immutable reconciliation result'; END IF;
 IF (NEW.sandbox_id,NEW.id,NEW.run_no,NEW.request_command_id,NEW.request_command_seq,NEW.requested_at,NEW.source_metadata) IS DISTINCT FROM (OLD.sandbox_id,OLD.id,OLD.run_no,OLD.request_command_id,OLD.request_command_seq,OLD.requested_at,OLD.source_metadata)
 OR NEW.version<>OLD.version+1 OR NEW.state IN ('REQUESTED') OR (OLD.state='RUNNING' AND NEW.state='RUNNING') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid reconciliation transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_controlled BEFORE UPDATE OR DELETE ON fi.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION fi_control.reconciliation_guard();
CREATE FUNCTION fi_control.valid_reconciliation_metadata(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(p)='object' AND octet_length(p::text)<=8192 AND p->>'engine_version'='reconciliation-v1'
 AND p->>'source_revision' ~ '^[a-f0-9]{40}$' AND p->>'source_tree' ~ '^[a-f0-9]{40}$' AND p->>'source_state' IN ('CLEAN','DIRTY')
 AND p->>'schema_revision'='5' AND p->>'financial_source'='6016fb700840d081fe1fba651c918f0a7e709383'
 AND p->>'valuation_model'='phase1-regular-coupon-v1' AND p->>'quotation_model'='synthetic-dealer-grid-v1'
 AND p->'conventions'='["ACT_ACT_ICMA","THIRTY_360_US"]'::jsonb AND jsonb_typeof(p->'query_hashes')='object'
 AND p->'query_hashes' ?& ARRAY['foundation','rfq','executions','comparisons']
 AND (SELECT count(*)=4 AND bool_and(value ~ '^[a-f0-9]{64}$') FROM jsonb_each_text(p->'query_hashes')),false)
$$;
CREATE FUNCTION fi_control.reconciliation_body(p_sid uuid,p_run uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (to_jsonb(r)-'sandbox_id'-'worker_id'-'requested_at'-'started_at'-'lease_expires_at'-'completed_at'-'snapshot_at'-'request_command_seq'-'source_watermark')||jsonb_build_object(
 'request_command_seq',r.request_command_seq::text,'source_watermark',r.source_watermark::text,
 'requested_at',to_char(r.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'started_at',to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'lease_expires_at',to_char(r.lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'completed_at',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'snapshot_at',to_char(r.snapshot_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 FROM fi.reconciliation_runs r WHERE sandbox_id=p_sid AND id=p_run
$$;
CREATE FUNCTION fi_control.reconciliation_reference(p_sid uuid,p_run uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('run_id',id,'request_command_seq',request_command_seq::text,'requested_at',to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM fi.reconciliation_runs WHERE sandbox_id=p_sid AND id=p_run
$$;
CREATE FUNCTION fi_control.reconciliation_command(p_id uuid,p_proof text,p_generation bigint,p_action text,p jsonb,p_hash text,p_key text,p_actor uuid,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; r fi.reconciliation_runs%ROWTYPE; c fi.reconciliation_commands%ROWTYPE; rid uuid; cid uuid:=gen_random_uuid(); n integer; seq integer; reserved integer; recovering boolean; decided timestamptz; failure text; status integer:=200;
BEGIN
 IF p_id IS NULL OR p_proof IS NULL OR p_generation IS NULL OR p_actor IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,128}$' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
 OR p_action IS NULL OR p_action NOT IN ('CREATE_RECONCILIATION','RECOVER_RECONCILIATION') OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR p IS NULL OR NOT(p ? 'run_id') OR (SELECT count(*) FROM jsonb_object_keys(p))<>1 OR jsonb_typeof(p->'run_id') IS DISTINCT FROM 'string' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 rid:=(p->>'run_id')::uuid;
 PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 SELECT * INTO c FROM fi.reconciliation_commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF FOUND THEN IF c.operation<>p_action OR c.request_hash<>p_hash THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED'); END IF;RETURN fi_control.result(c.http_status,c.response_body,true); END IF;
 IF EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=p_id AND idempotency_key=p_key) THEN RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');END IF;
 -- NULL metadata is an authenticated receipt-only attempt: never create a run or require a live scanner for replay.
 IF p_action='CREATE_RECONCILIATION' AND p_metadata IS NULL THEN RETURN fi_control.failure(503,'RECONCILER_NOT_CONFIGURED'); END IF;
 IF p_action='CREATE_RECONCILIATION' AND NOT fi_control.valid_reconciliation_metadata(p_metadata) THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 decided:=clock_timestamp();IF decided>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED');END IF;
 INSERT INTO fi_control.reconciliation_capacity(sandbox_id) VALUES(p_id) ON CONFLICT DO NOTHING;
 SELECT command_count+1,recovery_reserved INTO seq,reserved FROM fi_control.reconciliation_capacity WHERE sandbox_id=p_id;
 IF seq>64 THEN RETURN fi_control.failure(429,'RECONCILIATION_QUOTA');END IF;
 SELECT * INTO r FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=rid FOR UPDATE;
 recovering:=p_action='RECOVER_RECONCILIATION' AND ((r.state='REQUESTED' AND decided>=r.requested_at+interval '15 seconds') OR (r.state='RUNNING' AND decided>=r.lease_expires_at));
 -- Reserve one receipt for deterministic interruption recovery, including after rejected commands.
 IF seq+(CASE WHEN recovering THEN 0 ELSE greatest(reserved,CASE WHEN p_action='CREATE_RECONCILIATION' THEN 1 ELSE 0 END) END)>64 THEN RETURN fi_control.failure(429,'RECONCILIATION_QUOTA'); END IF;
 IF p_action='CREATE_RECONCILIATION' THEN
 IF r.id IS NOT NULL THEN failure:='RECONCILIATION_EXISTS';
 ELSIF EXISTS(SELECT 1 FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND state IN ('REQUESTED','RUNNING')) THEN failure:='RECONCILIATION_ACTIVE';
 ELSIF (SELECT count(*) FROM fi.reconciliation_runs WHERE sandbox_id=p_id)>=20 THEN RETURN fi_control.failure(429,'RECONCILIATION_CAPACITY');END IF;
 ELSE
 IF r.id IS NULL THEN RETURN fi_control.failure(404,'RECONCILIATION_NOT_FOUND');END IF;
 IF (r.state='REQUESTED' AND decided<r.requested_at+interval '15 seconds') OR (r.state='RUNNING' AND decided<r.lease_expires_at) THEN failure:='RECONCILIATION_ACTIVE';END IF;
 END IF;
 IF failure IS NOT NULL THEN RETURN fi_control.record_reconciliation_command(p_id,cid,p_key,p_hash,p_action,409,fi_control.failure(409,failure)->'body',p_actor);END IF;
 IF p_action='CREATE_RECONCILIATION' THEN
 SELECT COALESCE(max(run_no),0)+1 INTO n FROM fi.reconciliation_runs WHERE sandbox_id=p_id;
 INSERT INTO fi.reconciliation_runs(sandbox_id,id,run_no,state,version,request_command_id,request_command_seq,source_metadata,requested_at) VALUES(p_id,rid,n,'REQUESTED',1,cid,seq,p_metadata,decided);
 INSERT INTO fi.reconciliation_events VALUES(p_id,rid,1,'REQUESTED',decided,NULL,NULL);status:=201;
 UPDATE fi_control.reconciliation_capacity SET recovery_reserved=1 WHERE sandbox_id=p_id;
 ELSE
 IF r.state IN ('REQUESTED','RUNNING') THEN
 UPDATE fi.reconciliation_runs SET state='INCOMPLETE',version=version+1,completed_at=decided,failure_reason=CASE state WHEN 'REQUESTED' THEN 'INTERRUPTED_BEFORE_START' ELSE 'INTERRUPTED_SCAN' END WHERE sandbox_id=p_id AND id=rid RETURNING * INTO r;
 INSERT INTO fi.reconciliation_events VALUES(p_id,rid,r.version,r.state,decided,r.failure_reason,NULL);
 UPDATE fi_control.reconciliation_capacity SET recovery_reserved=0 WHERE sandbox_id=p_id;
 END IF;
 END IF;
 RETURN fi_control.record_reconciliation_command(p_id,cid,p_key,p_hash,p_action,status,fi_control.reconciliation_reference(p_id,rid),p_actor);
EXCEPTION WHEN invalid_text_representation THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.reconciliation_command(uuid,text,bigint,text,jsonb,text,text,uuid,jsonb) TO tf_app;

CREATE FUNCTION fi_control.claim_reconciliation(p_id uuid,p_proof text,p_generation bigint,p_run uuid,p_worker uuid,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; r fi.reconciliation_runs%ROWTYPE; decided timestamptz;
BEGIN
 SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 SELECT * INTO r FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=p_run FOR UPDATE;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'RECONCILIATION_NOT_FOUND'); END IF;
 IF r.state NOT IN ('REQUESTED') THEN RETURN fi_control.failure(409,'RECONCILIATION_ALREADY_CLAIMED'); END IF;
 IF p_worker IS NULL THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 decided:=clock_timestamp();
 IF r.source_metadata IS DISTINCT FROM p_metadata OR NOT fi_control.valid_reconciliation_metadata(p_metadata) OR decided>=r.requested_at+interval '15 seconds' THEN
 UPDATE fi.reconciliation_runs SET state=CASE WHEN decided>=requested_at+interval '15 seconds' THEN 'INCOMPLETE' ELSE 'FAILED' END,version=2,completed_at=decided,failure_reason=CASE WHEN decided>=requested_at+interval '15 seconds' THEN 'REQUEST_EXPIRED' ELSE 'ENGINE_CHANGED' END WHERE sandbox_id=p_id AND id=p_run RETURNING * INTO r;
 ELSE
 UPDATE fi.reconciliation_runs SET state='RUNNING',version=2,worker_id=p_worker,started_at=decided,lease_expires_at=decided+interval '15 seconds' WHERE sandbox_id=p_id AND id=p_run RETURNING * INTO r;
 END IF;
 IF r.state<>'RUNNING' THEN UPDATE fi_control.reconciliation_capacity SET recovery_reserved=0 WHERE sandbox_id=p_id; END IF;
 INSERT INTO fi.reconciliation_events VALUES(p_id,p_run,r.version,r.state,decided,r.failure_reason,NULL);
 RETURN fi_control.result(200,fi_control.reconciliation_body(p_id,p_run));
END $$;
GRANT EXECUTE ON FUNCTION fi_control.claim_reconciliation(uuid,text,bigint,uuid,uuid,jsonb) TO tf_reconciler;
CREATE FUNCTION fi_control.reconciliation_snapshot_access(p_id uuid,p_proof text,p_generation bigint,p_run uuid,p_worker uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT fi_control.proof_valid(p_id,p_proof,'trade') AND EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation)
 AND EXISTS(SELECT 1 FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=p_run AND state='RUNNING' AND worker_id=p_worker AND lease_expires_at>clock_timestamp())
$$;
GRANT EXECUTE ON FUNCTION fi_control.reconciliation_snapshot_access(uuid,text,bigint,uuid,uuid) TO tf_reconciler;
CREATE FUNCTION fi_control.finish_reconciliation(p_id uuid,p_proof text,p_generation bigint,p_run uuid,p_worker uuid,p_report jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; r fi.reconciliation_runs%ROWTYPE; h text; decided timestamptz; outcome text; failure text; f jsonb; cov jsonb; n integer:=0; total integer; wm bigint; snap jsonb;
BEGIN
 IF p_report IS NULL OR jsonb_typeof(p_report)<>'object' OR octet_length(p_report::text)>1048576 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_generation THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 SELECT * INTO r FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=p_run FOR UPDATE;
 IF NOT FOUND THEN RETURN fi_control.failure(404,'RECONCILIATION_NOT_FOUND'); END IF;
 h:=encode(sha256(convert_to(p_report::text,'UTF8')),'hex');
 IF r.state NOT IN ('REQUESTED','RUNNING') THEN
 IF r.report_hash=h AND r.worker_id=p_worker THEN RETURN fi_control.result(200,fi_control.reconciliation_body(p_id,p_run),true); END IF;
 RETURN fi_control.failure(409,'RECONCILIATION_RESULT_CONFLICT'); END IF;
 IF r.state<>'RUNNING' OR r.worker_id IS DISTINCT FROM p_worker THEN RETURN fi_control.failure(409,'RECONCILIATION_WORKER_CONFLICT'); END IF;
 outcome:=p_report->>'status';failure:=p_report->>'failure_reason';snap:=p_report->'snapshot';cov:=p_report->'coverage';
 IF outcome IS NULL OR outcome NOT IN ('COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS','INCOMPLETE','FAILED') OR jsonb_typeof(p_report->'findings') IS DISTINCT FROM 'array' OR jsonb_typeof(cov) IS DISTINCT FROM 'array' OR jsonb_array_length(cov)<>4 OR jsonb_array_length(p_report->'findings')>128 OR (p_report->>'total_findings') !~ '^[0-9]{1,6}$' THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 total:=(p_report->>'total_findings')::integer;
 IF total<jsonb_array_length(p_report->'findings') OR total>100000 OR (SELECT count(DISTINCT v->>'name') FROM jsonb_array_elements(cov) v)<>4
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(cov) v WHERE v->>'name' NOT IN ('foundation','rfq','executions','comparisons') OR v->>'hash' IS DISTINCT FROM r.source_metadata->'query_hashes'->>(v->>'name') OR COALESCE(v->>'status','') NOT IN ('COMPLETE','FAILED','NOT_RUN') OR COALESCE(v->>'rows','') !~ '^[0-9]{1,6}$') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 IF snap IS NOT NULL AND snap<>'null'::jsonb THEN
 IF jsonb_typeof(snap)<>'object' OR (snap->>'watermark') !~ '^[0-9]{1,3}$' OR (snap->>'id') !~ '^[0-9]+:[0-9]+:[0-9,]*$' OR snap->>'at' IS NULL THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 wm:=(snap->>'watermark')::bigint; IF wm<0 OR wm>512 THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 END IF;
 IF outcome IN ('COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS') AND (wm IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(cov) v WHERE (v->>'status') IS DISTINCT FROM 'COMPLETE') OR failure IS NOT NULL OR total<>jsonb_array_length(p_report->'findings') OR (outcome='COMPLETED_CLEAN')<>(total=0)) THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 IF outcome IN ('INCOMPLETE','FAILED') AND (failure IS NULL OR failure NOT IN ('LEASE_EXPIRED','FINDING_LIMIT','SQL_FAILURE','DATABASE_UNAVAILABLE','ENGINE_CHANGED','SOURCE_CHANGED','VERIFICATION_TIMEOUT')) THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 decided:=clock_timestamp();IF decided>=r.lease_expires_at THEN outcome:='INCOMPLETE';failure:='LEASE_EXPIRED'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p_report->'findings') LOOP
 n:=n+1;
 INSERT INTO fi.reconciliation_findings VALUES(p_id,p_run,n,f->>'category',f->>'code',f->>'record_kind',f->>'record_id',f->'related',f->'expected',f->'observed');
 END LOOP;
 UPDATE fi.reconciliation_runs SET state=outcome,version=3,completed_at=decided,snapshot_id=snap->>'id',snapshot_at=(snap->>'at')::timestamptz,source_watermark=wm,coverage=cov,complete=outcome IN ('COMPLETED_CLEAN','COMPLETED_WITH_FINDINGS'),finding_count=n,total_findings=total,failure_reason=failure,report_hash=h WHERE sandbox_id=p_id AND id=p_run;
 UPDATE fi_control.reconciliation_capacity SET recovery_reserved=0 WHERE sandbox_id=p_id;
 INSERT INTO fi.reconciliation_events VALUES(p_id,p_run,3,outcome,decided,failure,h);
 RETURN fi_control.result(200,fi_control.reconciliation_body(p_id,p_run));
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR check_violation OR not_null_violation THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');
END $$;
GRANT EXECUTE ON FUNCTION fi_control.finish_reconciliation(uuid,text,bigint,uuid,uuid,jsonb) TO tf_reconciler;
CREATE FUNCTION fi_control.reconciliation_consistent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r fi.reconciliation_runs%ROWTYPE; rid uuid;
BEGIN
 IF TG_TABLE_NAME='reconciliation_runs' THEN rid:=NEW.id;ELSE rid:=NEW.run_id;END IF;
 SELECT * INTO r FROM fi.reconciliation_runs WHERE sandbox_id=NEW.sandbox_id AND id=rid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF (SELECT recovery_reserved FROM fi_control.reconciliation_capacity WHERE sandbox_id=r.sandbox_id)<>(SELECT count(*) FROM fi.reconciliation_runs WHERE sandbox_id=r.sandbox_id AND state IN ('REQUESTED','RUNNING')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid reconciliation recovery reservation'; END IF;
 IF r.finding_count<>(SELECT count(*) FROM fi.reconciliation_findings WHERE sandbox_id=r.sandbox_id AND run_id=r.id)
 OR r.version<>(SELECT count(*) FROM fi.reconciliation_events WHERE sandbox_id=r.sandbox_id AND run_id=r.id)
 OR (SELECT state FROM fi.reconciliation_events WHERE sandbox_id=r.sandbox_id AND run_id=r.id AND event_no=r.version) IS DISTINCT FROM r.state
 OR COALESCE((SELECT max(ordinal) FROM fi.reconciliation_findings WHERE sandbox_id=r.sandbox_id AND run_id=r.id),0)<>r.finding_count OR (SELECT max(event_no) FROM fi.reconciliation_events WHERE sandbox_id=r.sandbox_id AND run_id=r.id)<>r.version OR (r.state IN ('REQUESTED','RUNNING') AND r.finding_count<>0) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete reconciliation record';END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['reconciliation_runs','reconciliation_events','reconciliation_findings'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER reconciliation_complete AFTER INSERT OR UPDATE ON fi.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.reconciliation_consistent()',t);
 END LOOP; END $$;
CREATE FUNCTION fi_control.read_reconciliations(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_run uuid,p_kind text,p_after integer,p_asof integer,p_limit integer,p_category text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE body jsonb; upper_bound integer; next_after integer; items jsonb; current_seq bigint; latest uuid;
BEGIN
 IF NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('list','detail','findings') OR p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR (p_asof IS NOT NULL AND p_asof<0) THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;
 SELECT COALESCE(max(command_seq),0) INTO current_seq FROM fi.commands WHERE sandbox_id=p_id;
 SELECT id INTO latest FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND complete ORDER BY run_no DESC LIMIT 1;
 IF p_kind='list' THEN
 SELECT COALESCE(max(run_no),0) INTO upper_bound FROM fi.reconciliation_runs WHERE sandbox_id=p_id;
 IF p_asof IS NOT NULL THEN IF p_asof>upper_bound THEN RETURN fi_control.failure(400,'VALIDATION_ERROR'); END IF;upper_bound:=p_asof;END IF;
 SELECT COALESCE(jsonb_agg(fi_control.reconciliation_body(p_id,id) ORDER BY run_no),'[]'::jsonb),max(run_no) INTO items,next_after FROM(SELECT id,run_no FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND run_no>p_after AND run_no<=upper_bound ORDER BY run_no LIMIT p_limit) page;
 IF NOT EXISTS(SELECT 1 FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND run_no>COALESCE(next_after,p_after) AND run_no<=upper_bound) THEN next_after:=NULL;END IF;
 body:=jsonb_build_object('runs',items,'as_of',upper_bound,'next_after',next_after,'observed_command_seq',current_seq::text,'latest_completed_run_id',latest);
 ELSE
 IF NOT EXISTS(SELECT 1 FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=p_run) THEN RETURN fi_control.failure(404,'RECONCILIATION_NOT_FOUND');END IF;
 IF p_kind='detail' THEN
 body:=jsonb_build_object('run',fi_control.reconciliation_body(p_id,p_run),'events',(SELECT COALESCE(jsonb_agg(to_jsonb(e)-'sandbox_id'-'run_id'-'decided_at'||jsonb_build_object('decided_at',to_char(e.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY event_no),'[]'::jsonb) FROM fi.reconciliation_events e WHERE sandbox_id=p_id AND run_id=p_run),'observed_command_seq',current_seq::text,'latest_completed_run_id',latest);
 ELSE
 IF p_category IS NOT NULL AND p_category NOT IN ('FOUNDATION','RFQ_CONTRACT','ORDER_QUANTITY','EXECUTION_FINANCE','POSITION','CANCELLATION','AUDIT_HISTORY','REFERENCE','INSTRUMENT_SOURCE') THEN RETURN fi_control.failure(400,'VALIDATION_ERROR');END IF;
 SELECT finding_count INTO upper_bound FROM fi.reconciliation_runs WHERE sandbox_id=p_id AND id=p_run;
 SELECT COALESCE(jsonb_agg(to_jsonb(f)-'sandbox_id'-'run_id' ORDER BY ordinal),'[]'::jsonb),max(ordinal) INTO items,next_after FROM(SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=p_id AND run_id=p_run AND ordinal>p_after AND (p_category IS NULL OR category=p_category) ORDER BY ordinal LIMIT p_limit) f;
 IF NOT EXISTS(SELECT 1 FROM fi.reconciliation_findings WHERE sandbox_id=p_id AND run_id=p_run AND ordinal>COALESCE(next_after,p_after) AND (p_category IS NULL OR category=p_category)) THEN next_after:=NULL;END IF;
 body:=jsonb_build_object('run_id',p_run,'findings',items,'as_of',upper_bound,'next_after',next_after);
 END IF;
 END IF;
 RETURN fi_control.result(200,body);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_reconciliations(uuid,text,text,bigint,uuid,text,integer,integer,integer,text) TO tf_app;
CREATE OR REPLACE FUNCTION fi_control.purge_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE target uuid; removed integer:=0;
BEGIN
 PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
 FOR target IN SELECT s.id FROM fi.sandboxes s WHERE retained_until<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM fi.reconciliation_runs r WHERE r.sandbox_id=s.id AND ((r.state='RUNNING' AND r.lease_expires_at>clock_timestamp()) OR (r.state='REQUESTED' AND r.requested_at+interval '15 seconds'>clock_timestamp()))) ORDER BY s.id FOR UPDATE LOOP
 INSERT INTO fi_control.purged_sandboxes(id) VALUES(target);
 DELETE FROM fi.reconciliation_findings WHERE sandbox_id=target; DELETE FROM fi.reconciliation_events WHERE sandbox_id=target; DELETE FROM fi.reconciliation_runs WHERE sandbox_id=target; DELETE FROM fi.reconciliation_commands WHERE sandbox_id=target; DELETE FROM fi_control.reconciliation_capacity WHERE sandbox_id=target;
 DELETE FROM fi.positions WHERE sandbox_id=target; DELETE FROM fi.order_history WHERE sandbox_id=target; DELETE FROM fi.cancellation_outcomes WHERE sandbox_id=target; DELETE FROM fi.cancellation_requests WHERE sandbox_id=target; DELETE FROM fi.executions WHERE sandbox_id=target; DELETE FROM fi.order_states WHERE sandbox_id=target;
 DELETE FROM fi.orders WHERE sandbox_id=target; DELETE FROM fi.quotes WHERE sandbox_id=target; DELETE FROM fi.invitations WHERE sandbox_id=target; DELETE FROM fi.rfqs WHERE sandbox_id=target;
 DELETE FROM fi.audit_events WHERE sandbox_id=target; DELETE FROM fi.commands WHERE sandbox_id=target; DELETE FROM fi_control.sandbox_access WHERE sandbox_id=target; DELETE FROM fi_control.command_keys WHERE sandbox_id=target; DELETE FROM fi.sandboxes WHERE id=target;removed:=removed+1;
 END LOOP;
 UPDATE fi_control.service_capacity SET retained_count=retained_count-removed WHERE singleton;RETURN removed;
END $$;
CREATE FUNCTION fi_control.reconciliation_receipts_consistent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=NEW.sandbox_id) THEN RETURN NULL;END IF;
 IF COALESCE((SELECT command_count FROM fi_control.reconciliation_capacity WHERE sandbox_id=NEW.sandbox_id),-1)<>(SELECT count(*) FROM fi.reconciliation_commands WHERE sandbox_id=NEW.sandbox_id)
 OR (SELECT max(command_seq) FROM fi.reconciliation_commands WHERE sandbox_id=NEW.sandbox_id)<>(SELECT count(*) FROM fi.reconciliation_commands WHERE sandbox_id=NEW.sandbox_id)
 OR EXISTS(SELECT 1 FROM fi.reconciliation_commands c LEFT JOIN fi_control.command_keys k USING(sandbox_id,idempotency_key) WHERE c.sandbox_id=NEW.sandbox_id AND k.domain IS DISTINCT FROM 'RECONCILIATION') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Incomplete reconciliation receipt ledger';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_receipts_complete AFTER INSERT ON fi.reconciliation_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.reconciliation_receipts_consistent();
CREATE FUNCTION fi_control.read_reconciliation_command(p_id uuid,p_proof text,p_scope text,p_generation bigint,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb;
BEGIN
 IF NOT fi_control.proof_valid(p_id,p_proof,p_scope) OR NOT EXISTS(SELECT 1 FROM fi.sandboxes WHERE id=p_id AND generation=p_generation) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');END IF;
 SELECT jsonb_build_object('command',to_jsonb(c)-'sandbox_id'-'request_hash'-'command_seq'-'created_at'||jsonb_build_object('receipt_seq',command_seq::text,'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) INTO body FROM fi.reconciliation_commands c WHERE sandbox_id=p_id AND idempotency_key=p_key;
 IF body IS NULL THEN RETURN fi_control.failure(404,'COMMAND_NOT_FOUND');END IF;RETURN fi_control.result(200,body);
END $$;
GRANT EXECUTE ON FUNCTION fi_control.read_reconciliation_command(uuid,text,text,bigint,text) TO tf_app;
