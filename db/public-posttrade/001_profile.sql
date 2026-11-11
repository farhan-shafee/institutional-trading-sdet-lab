-- Fresh public synthetic post-trade profile; original migrations 001–010 remain unchanged.
CREATE TABLE fi_control.public_demo_profile (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  profile_name text NOT NULL CHECK (profile_name='public-posttrade-v1'),
  profile_version integer NOT NULL CHECK (profile_version=1),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  database_name text NOT NULL CHECK (database_name=current_database())
);
CREATE TABLE fi_control.public_demo_sandboxes (
  sandbox_id uuid PRIMARY KEY REFERENCES fi.sandboxes(id) ON DELETE CASCADE
);
GRANT SELECT ON fi_control.public_demo_profile TO tf_app,tf_reconciler,tf_maintenance;

-- Keep the original four raw-workflow verification queries, while binding their
-- reports to this physical schema10/profile. Never pretend they verify Phase4 P&L.
ALTER FUNCTION fi_control.valid_reconciliation_metadata(jsonb)
  RENAME TO valid_reconciliation_metadata_public_base;
CREATE FUNCTION fi_control.valid_reconciliation_metadata(p jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,fi_control AS $$
 SELECT COALESCE(jsonb_typeof(p)='object' AND octet_length(p::text)<=8192
 AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p) key)=ARRAY[
   'conventions','engine_version','financial_source','public_profile','public_profile_checksum',
   'query_hashes','quotation_model','schema_checksums','schema_revision','source_revision',
   'source_state','source_tree','valuation_model','verification_scope']::text[]
 AND p->>'engine_version'='reconciliation-public-posttrade-v1'
 AND jsonb_typeof(p->'schema_revision')='number'
 AND p->>'schema_revision'='10' AND p->>'verification_scope'='RAW_WORKFLOW_BASE_8'
 AND p->>'public_profile'='public-posttrade-v1'
 AND EXISTS (SELECT 1 FROM fi_control.public_demo_profile
   WHERE singleton AND profile_name='public-posttrade-v1' AND profile_version=1
     AND database_name=current_database() AND source_checksum=p->>'public_profile_checksum')
 AND jsonb_typeof(p->'schema_checksums')='array'
 AND jsonb_array_length(p->'schema_checksums')=10
 AND p->'schema_checksums'=(SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)
   FROM fi_control.schema_migrations)
 AND fi_control.valid_reconciliation_metadata_public_base(
   (p-'verification_scope'-'public_profile'-'public_profile_checksum') ||
   jsonb_build_object('engine_version','reconciliation-v4','schema_revision',8,
     'schema_checksums',(p->'schema_checksums')-9-8)),false)
$$;
REVOKE ALL ON FUNCTION fi_control.valid_reconciliation_metadata(jsonb) FROM PUBLIC;

CREATE FUNCTION fi_control.create_public_demo_sandbox(
  p_id uuid,p_read text,p_trade text,p_hash text,p_key text,p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE s fi.sandboxes%ROWTYPE; a fi_control.sandbox_access%ROWTYPE;
  capacity fi_control.service_capacity%ROWTYPE; receipt fi.commands%ROWTYPE; decided timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fi_control.public_demo_profile
      WHERE singleton AND profile_name='public-posttrade-v1' AND profile_version=1
        AND database_name=current_database()) THEN
    RETURN fi_control.failure(503,'PUBLIC_DEMO_PROFILE_UNAVAILABLE');
  END IF;
  IF p_read !~ '^[a-f0-9]{64}$' OR p_trade !~ '^[a-f0-9]{64}$' OR p_read=p_trade
     OR p_hash !~ '^[a-f0-9]{64}$' OR p_key !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_id IS NULL OR p_read IS NULL OR p_trade IS NULL OR p_hash IS NULL OR p_key IS NULL OR p_actor IS NULL THEN
    RETURN fi_control.failure(400,'VALIDATION_ERROR');
  END IF;
  PERFORM set_config('tradeflow.sandbox_id',p_id::text,true);
  SELECT * INTO capacity FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
  IF EXISTS (SELECT 1 FROM fi_control.purged_sandboxes WHERE id=p_id) THEN
    RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');
  END IF;
  SELECT * INTO s FROM fi.sandboxes WHERE id=p_id FOR UPDATE;
  decided := clock_timestamp();
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM fi_control.public_demo_sandboxes WHERE sandbox_id=p_id) THEN
      RETURN fi_control.failure(404,'SANDBOX_NOT_FOUND');
    END IF;
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
  IF capacity.retained_count>=capacity.capacity_limit THEN
    RETURN fi_control.failure(503,'SANDBOX_CAPACITY_REACHED');
  END IF;
  INSERT INTO fi.sandboxes(id,created_at,write_expires_at,retained_until)
    VALUES(p_id,decided,decided+interval '30 minutes',decided+interval '60 minutes');
  INSERT INTO fi_control.public_demo_sandboxes(sandbox_id) VALUES(p_id);
  INSERT INTO fi_control.sandbox_access VALUES(p_id,p_read,p_trade,p_hash);
  UPDATE fi_control.service_capacity SET retained_count=retained_count+1 WHERE singleton;
  RETURN fi_control.record_command(p_id,p_key,p_hash,'CREATE_SANDBOX',201,NULL,p_actor,decided);
END $$;

CREATE FUNCTION fi_control.purge_public_demo_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE candidates uuid[]; removed integer;
BEGIN
  PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM fi_control.public_demo_profile
      WHERE singleton AND profile_name='public-posttrade-v1' AND profile_version=1
        AND database_name=current_database())
     OR EXISTS (SELECT 1 FROM fi.sandboxes s WHERE NOT EXISTS
       (SELECT 1 FROM fi_control.public_demo_sandboxes p WHERE p.sandbox_id=s.id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Dedicated public demo profile required';
  END IF;
  SELECT coalesce(array_agg(s.id),ARRAY[]::uuid[]) INTO candidates
    FROM fi.sandboxes s JOIN fi_control.public_demo_sandboxes p ON p.sandbox_id=s.id;
  -- Capture the bounded public graph set before purge samples its later clock.
  -- A graph crossing retention between statements must not leave a tombstone.
  -- Retains the existing complete-graph purge, active-lease checks and capacity accounting.
  removed := fi_control.purge_expired();
  -- Public ownership cannot outlive its <=30-minute session or choose/recover a UUID.
  -- Remove only tombstones just issued for these expired public graphs, keeping legacy
  -- tombstones untouched. A still-leased graph has no tombstone and remains unchanged.
  DELETE FROM fi_control.purged_sandboxes WHERE id=ANY(candidates);
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION fi_control.create_public_demo_sandbox(uuid,text,text,text,text,uuid),
  fi_control.purge_public_demo_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fi_control.create_public_demo_sandbox(uuid,text,text,text,text,uuid) TO tf_app;
GRANT EXECUTE ON FUNCTION fi_control.purge_public_demo_expired() TO tf_maintenance;
