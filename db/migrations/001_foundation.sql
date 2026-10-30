CREATE SCHEMA fi AUTHORIZATION tf_owner;
CREATE SCHEMA fi_control AUTHORIZATION tf_owner;
REVOKE ALL ON SCHEMA fi, fi_control FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE fi_control.schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fi_control.compatibility (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  financial_source text NOT NULL CHECK (financial_source = '6016fb700840d081fe1fba651c918f0a7e709383')
);
INSERT INTO fi_control.compatibility VALUES (true, 1, '6016fb700840d081fe1fba651c918f0a7e709383');
CREATE TABLE fi_control.service_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  retained_count integer NOT NULL DEFAULT 0 CHECK (retained_count >= 0),
  capacity_limit integer NOT NULL DEFAULT 50 CHECK (capacity_limit BETWEEN 1 AND 50),
  CHECK (retained_count <= capacity_limit)
);
INSERT INTO fi_control.service_capacity(singleton) VALUES (true);
-- Non-sensitive tombstones outlive business retention so bootstrap retries can never recycle an ID.
CREATE TABLE fi_control.purged_sandboxes (
  id uuid PRIMARY KEY,
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE fi.sandboxes (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  write_expires_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 1000000000),
  commit_seq bigint NOT NULL DEFAULT 0 CHECK (commit_seq >= 0),
  command_count integer NOT NULL DEFAULT 0 CHECK (command_count BETWEEN 0 AND 512),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 1024),
  CHECK (created_at < write_expires_at AND write_expires_at < retained_until),
  CHECK (commit_seq = command_count)
);
CREATE INDEX sandboxes_retention ON fi.sandboxes(retained_until);
CREATE TABLE fi_control.sandbox_access (
  sandbox_id uuid PRIMARY KEY REFERENCES fi.sandboxes(id),
  read_digest text NOT NULL UNIQUE CHECK (read_digest ~ '^[a-f0-9]{64}$'),
  trade_digest text NOT NULL UNIQUE CHECK (trade_digest ~ '^[a-f0-9]{64}$'),
  creation_fingerprint text NOT NULL CHECK (creation_fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK (read_digest <> trade_digest)
);
CREATE TABLE fi.commands (
  sandbox_id uuid NOT NULL REFERENCES fi.sandboxes(id),
  id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  operation text NOT NULL CHECK (operation IN ('CREATE_SANDBOX','ROTATE_CAPABILITIES')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  command_seq bigint NOT NULL CHECK (command_seq > 0),
  result_kind text NOT NULL CHECK (result_kind IN ('APPLIED','REJECTED')),
  http_status integer NOT NULL CHECK (http_status IN (200,201,409)),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body)='object' AND octet_length(response_body::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sandbox_id,id),
  UNIQUE (sandbox_id,idempotency_key),
  UNIQUE (sandbox_id,command_seq)
);
CREATE TABLE fi.audit_events (
  sandbox_id uuid NOT NULL,
  command_id uuid NOT NULL,
  command_seq bigint NOT NULL,
  event_index integer NOT NULL DEFAULT 0 CHECK (event_index = 0),
  event_type text NOT NULL CHECK (event_type IN ('SANDBOX_CREATED','CAPABILITIES_ROTATED','COMMAND_REJECTED')),
  aggregate_version bigint,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL DEFAULT 'CLIENT' CHECK (actor_kind = 'CLIENT'),
  decided_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text) <= 1024),
  PRIMARY KEY (sandbox_id,command_seq,event_index),
  FOREIGN KEY (sandbox_id,command_id) REFERENCES fi.commands(sandbox_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (sandbox_id,command_seq) REFERENCES fi.commands(sandbox_id,command_seq) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (sandbox_id,aggregate_version),
  CHECK ((event_type='COMMAND_REJECTED') = (aggregate_version IS NULL))
);
CREATE INDEX audit_command ON fi.audit_events(sandbox_id,command_id);

CREATE TABLE fi.instrument_versions (
  id text PRIMARY KEY,
  instrument_id text NOT NULL,
  revision integer NOT NULL CHECK (revision = 1),
  financial_source text NOT NULL,
  terms jsonb NOT NULL,
  UNIQUE (instrument_id,revision)
);
INSERT INTO fi.instrument_versions VALUES
('phase1-ust-1','SYN-UST-2031',1,'6016fb700840d081fe1fba651c918f0a7e709383',
 '{"currency":"USD","dated_date":"2025-01-15","first_coupon_date":"2025-07-15","maturity_date":"2031-01-15","coupon_rate":"0.04","frequency":2,"day_count":"ACT_ACT_ICMA"}'),
('phase1-corp-1','SYN-CORP-2031',1,'6016fb700840d081fe1fba651c918f0a7e709383',
 '{"currency":"USD","dated_date":"2025-01-15","first_coupon_date":"2025-07-15","maturity_date":"2031-01-15","coupon_rate":"0.04","frequency":2,"day_count":"THIRTY_360_US"}');

CREATE FUNCTION fi_control.immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND current_user='tf_owner' THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Immutable financial record';
END $$;
CREATE TRIGGER commands_immutable BEFORE UPDATE OR DELETE ON fi.commands
FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON fi.audit_events
FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();
CREATE TRIGGER instrument_immutable BEFORE UPDATE OR DELETE ON fi.instrument_versions
FOR EACH ROW EXECUTE FUNCTION fi_control.immutable_record();

CREATE FUNCTION fi_control.ledger_consistent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s fi.sandboxes%ROWTYPE;
BEGIN
  SELECT * INTO s FROM fi.sandboxes WHERE id=NEW.sandbox_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF s.command_count <> (SELECT count(*) FROM fi.commands WHERE sandbox_id=s.id)
     OR s.event_count <> (SELECT count(*) FROM fi.audit_events WHERE sandbox_id=s.id)
     OR EXISTS (SELECT 1 FROM fi.commands c WHERE c.sandbox_id=s.id AND NOT EXISTS
        (SELECT 1 FROM fi.audit_events a WHERE a.sandbox_id=c.sandbox_id AND a.command_id=c.id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Incomplete command ledger';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER command_ledger_complete AFTER INSERT ON fi.commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.ledger_consistent();
CREATE CONSTRAINT TRIGGER audit_ledger_complete AFTER INSERT ON fi.audit_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fi_control.ledger_consistent();

ALTER TABLE fi.sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi.sandboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_app ON fi.sandboxes TO tf_app
USING (id::text = current_setting('tradeflow.sandbox_id',true));
CREATE POLICY sandbox_owner ON fi.sandboxes TO tf_owner USING (true) WITH CHECK (true);
CREATE POLICY sandbox_reconciliation ON fi.sandboxes FOR SELECT TO tf_reconciler USING (true);
ALTER TABLE fi.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi.commands FORCE ROW LEVEL SECURITY;
CREATE POLICY command_app ON fi.commands TO tf_app
USING (sandbox_id::text = current_setting('tradeflow.sandbox_id',true));
CREATE POLICY command_owner ON fi.commands TO tf_owner USING (true) WITH CHECK (true);
CREATE POLICY command_reconciliation ON fi.commands FOR SELECT TO tf_reconciler USING (true);
ALTER TABLE fi.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fi.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_app ON fi.audit_events TO tf_app
USING (sandbox_id::text = current_setting('tradeflow.sandbox_id',true));
CREATE POLICY audit_owner ON fi.audit_events TO tf_owner USING (true) WITH CHECK (true);
CREATE POLICY audit_reconciliation ON fi.audit_events FOR SELECT TO tf_reconciler USING (true);

CREATE FUNCTION fi_control.purge_expired() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fi_control,fi,pg_temp AS $$
DECLARE target uuid; removed integer := 0;
BEGIN
  PERFORM 1 FROM fi_control.service_capacity WHERE singleton FOR UPDATE;
  FOR target IN SELECT id FROM fi.sandboxes WHERE retained_until <= clock_timestamp() ORDER BY id FOR UPDATE LOOP
    INSERT INTO fi_control.purged_sandboxes(id) VALUES(target);
    DELETE FROM fi.audit_events WHERE sandbox_id=target;
    DELETE FROM fi.commands WHERE sandbox_id=target;
    DELETE FROM fi_control.sandbox_access WHERE sandbox_id=target;
    DELETE FROM fi.sandboxes WHERE id=target;
    removed := removed + 1;
  END LOOP;
  UPDATE fi_control.service_capacity SET retained_count=retained_count-removed WHERE singleton;
  RETURN removed;
END $$;

GRANT USAGE ON SCHEMA fi, fi_control TO tf_app, tf_reconciler;
GRANT USAGE ON SCHEMA fi_control TO tf_maintenance;
GRANT SELECT ON fi.sandboxes, fi.commands, fi.audit_events, fi.instrument_versions TO tf_app, tf_reconciler;
GRANT SELECT ON fi_control.compatibility, fi_control.schema_migrations TO tf_app;
GRANT EXECUTE ON FUNCTION fi_control.purge_expired() TO tf_maintenance;
