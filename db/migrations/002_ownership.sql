ALTER FUNCTION fi_control.ledger_consistent() SECURITY DEFINER;

CREATE FUNCTION fi_control.capacity_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (SELECT retained_count FROM fi_control.service_capacity WHERE singleton)
     <> (SELECT count(*) FROM fi.sandboxes) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Inconsistent retained capacity';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER capacity_complete AFTER UPDATE ON fi_control.service_capacity
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.capacity_consistent();
CREATE CONSTRAINT TRIGGER sandbox_capacity_complete AFTER INSERT OR DELETE ON fi.sandboxes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.capacity_consistent();

CREATE FUNCTION fi_control.result(p_status integer,p_body jsonb,p_replayed boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('status',p_status,'body',p_body,'replayed',p_replayed)
$$;
CREATE FUNCTION fi_control.failure(p_status integer,p_code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT fi_control.result(p_status,jsonb_build_object('error',jsonb_build_object(
    'code',p_code,'message','The fixed-income workflow request could not be completed.')))
$$;
CREATE FUNCTION fi_control.sandbox_body(p_id uuid,p_scope text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('sandbox',jsonb_build_object(
    'id',id,'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'write_expires_at',to_char(write_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'retained_until',to_char(retained_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'generation',generation::text,'commit_seq',commit_seq::text,
    'read_only',clock_timestamp() >= write_expires_at),'scope',p_scope)
  FROM fi.sandboxes WHERE id=p_id
$$;
CREATE FUNCTION fi_control.proof_valid(p_id uuid,p_digest text,p_scope text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM fi_control.sandbox_access a JOIN fi.sandboxes s ON s.id=a.sandbox_id
    WHERE s.id=p_id AND clock_timestamp()<s.retained_until
      AND ((p_scope='trade' AND a.trade_digest=p_digest) OR (p_scope='read' AND a.read_digest=p_digest)))
$$;

CREATE FUNCTION fi_control.record_command(p_id uuid,p_key text,p_hash text,p_operation text,
  p_status integer,p_code text,p_actor uuid,p_decided timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE; command_id uuid := gen_random_uuid(); body jsonb; event text;
BEGIN
  SELECT * INTO STRICT s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
  IF s.command_count>=512 OR s.event_count>=1024 THEN RETURN fi_control.failure(429,'SANDBOX_QUOTA_REACHED'); END IF;
  UPDATE fi.sandboxes SET command_count=command_count+1,event_count=event_count+1,commit_seq=commit_seq+1
    WHERE id=p_id RETURNING * INTO s;
  IF p_code IS NULL THEN
    body := fi_control.sandbox_body(p_id,'trade');
    event := CASE WHEN p_operation='CREATE_SANDBOX' THEN 'SANDBOX_CREATED' ELSE 'CAPABILITIES_ROTATED' END;
  ELSE
    body := fi_control.failure(p_status,p_code)->'body';
    event := 'COMMAND_REJECTED';
  END IF;
  INSERT INTO fi.audit_events(sandbox_id,command_id,command_seq,event_type,aggregate_version,actor_id,decided_at,payload)
    VALUES(p_id,command_id,s.commit_seq,event,CASE WHEN p_code IS NULL THEN s.generation ELSE NULL END,
      p_actor,p_decided,CASE WHEN p_code IS NULL THEN jsonb_build_object('generation',s.generation::text)
      ELSE jsonb_build_object('code',p_code) END);
  INSERT INTO fi.commands(sandbox_id,id,idempotency_key,operation,request_hash,command_seq,result_kind,http_status,response_body)
    VALUES(p_id,command_id,p_key,p_operation,p_hash,s.commit_seq,
      CASE WHEN p_code IS NULL THEN 'APPLIED' ELSE 'REJECTED' END,p_status,body);
  RETURN fi_control.result(p_status,body);
END $$;

CREATE FUNCTION fi_control.create_sandbox(p_id uuid,p_read text,p_trade text,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; a fi_control.sandbox_access%ROWTYPE;
  capacity fi_control.service_capacity%ROWTYPE; receipt fi.commands%ROWTYPE; decided timestamptz;
BEGIN
  IF p_read !~ '^[a-f0-9]{64}$' OR p_trade !~ '^[a-f0-9]{64}$' OR p_read=p_trade
     OR p_hash !~ '^[a-f0-9]{64}$' OR p_key !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_id IS NULL OR p_read IS NULL OR p_trade IS NULL OR p_hash IS NULL OR p_key IS NULL OR p_actor IS NULL THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
  SELECT * INTO capacity FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
  IF EXISTS (SELECT 1 FROM fi_control.purged_sandboxes WHERE id=p_id) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
  SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
  decided := clock_timestamp();
  IF FOUND THEN
    SELECT * INTO a FROM fi_control.sandbox_access WHERE sandbox_id=p_id;
    IF NOT fi_control.proof_valid(p_id,p_trade,'trade') OR a.read_digest<>p_read THEN
      RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');
    END IF;
    SELECT * INTO receipt FROM fi.commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
    IF FOUND THEN
      IF receipt.operation<>'CREATE_SANDBOX' OR receipt.request_hash<>p_hash THEN
        RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');
      END IF;
      RETURN fi_control.result(receipt.http_status,receipt.response_body,true);
    END IF;
    RETURN fi_control.failure(409,'SANDBOX_ALREADY_EXISTS');
  END IF;
  IF capacity.retained_count>=capacity.capacity_limit THEN RETURN fi_control.failure(503,'SANDBOX_CAPACITY_REACHED'); END IF;
  INSERT INTO fi.sandboxes(id,created_at,write_expires_at,retained_until)
    VALUES(p_id,decided,decided+interval '7 days',decided+interval '30 days');
  INSERT INTO fi_control.sandbox_access VALUES(p_id,p_read,p_trade,p_hash);
  UPDATE fi_control.service_capacity SET retained_count=retained_count+1 WHERE singleton;
  RETURN fi_control.record_command(p_id,p_key,p_hash,'CREATE_SANDBOX',201,NULL,p_actor,decided);
END $$;

CREATE FUNCTION fi_control.read_sandbox(p_id uuid,p_digest text,p_scope text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
BEGIN
  IF NOT fi_control.proof_valid(p_id,p_digest,p_scope) THEN RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND'); END IF;
  RETURN fi_control.result(200,fi_control.sandbox_body(p_id,p_scope));
END $$;

CREATE FUNCTION fi_control.rotate_capabilities(p_id uuid,p_proof text,p_binding_generation bigint,
  p_expected_generation bigint,p_read text,p_trade text,p_hash text,p_key text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; a fi_control.sandbox_access%ROWTYPE;
  receipt fi.commands%ROWTYPE; decided timestamptz; failure text;
BEGIN
  IF p_read !~ '^[a-f0-9]{64}$' OR p_trade !~ '^[a-f0-9]{64}$' OR p_read=p_trade
     OR p_hash !~ '^[a-f0-9]{64}$' OR p_key !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_id IS NULL OR p_proof IS NULL OR p_binding_generation IS NULL OR p_expected_generation IS NULL
     OR p_read IS NULL OR p_trade IS NULL OR p_hash IS NULL OR p_key IS NULL OR p_actor IS NULL THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
  SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR NOT fi_control.proof_valid(p_id,p_proof,'trade') OR s.generation<>p_binding_generation THEN
    RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');
  END IF;
  SELECT * INTO receipt FROM fi.commands WHERE sandbox_id=p_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.operation<>'ROTATE_CAPABILITIES' OR receipt.request_hash<>p_hash THEN
      RETURN fi_control.failure(409,'IDEMPOTENCY_KEY_REUSED');
    END IF;
    RETURN fi_control.result(receipt.http_status,receipt.response_body,true);
  END IF;
  decided := clock_timestamp();
  IF decided>=s.write_expires_at THEN RETURN fi_control.failure(409,'SANDBOX_EXPIRED'); END IF;
  IF s.command_count>=512 OR s.event_count>=1024 THEN RETURN fi_control.failure(429,'SANDBOX_QUOTA_REACHED'); END IF;
  SELECT * INTO a FROM fi_control.sandbox_access WHERE sandbox_id=p_id;
  IF s.generation<>p_expected_generation THEN failure := 'GENERATION_CONFLICT';
  ELSIF p_read=a.read_digest OR p_trade=a.trade_digest THEN failure := 'CAPABILITY_REUSE';
  ELSIF s.generation>=1000000000 THEN failure := 'GENERATION_LIMIT_REACHED';
  END IF;
  IF failure IS NOT NULL THEN
    RETURN fi_control.record_command(p_id,p_key,p_hash,'ROTATE_CAPABILITIES',409,failure,p_actor,decided);
  END IF;
  UPDATE fi_control.sandbox_access SET read_digest=p_read,trade_digest=p_trade WHERE sandbox_id=p_id;
  UPDATE fi.sandboxes SET generation=generation+1 WHERE id=p_id;
  RETURN fi_control.record_command(p_id,p_key,p_hash,'ROTATE_CAPABILITIES',200,NULL,p_actor,decided);
END $$;

GRANT EXECUTE ON FUNCTION fi_control.create_sandbox(uuid,text,text,text,text,uuid),
  fi_control.read_sandbox(uuid,text,text),
  fi_control.rotate_capabilities(uuid,text,bigint,bigint,text,text,text,text,uuid) TO tf_app;
