-- One capacity definition for BIND and every financial counter writer.
-- Transaction-visible consumption is proved against actual effects by 007's
-- deferred integrity constraints. Do not require the later application row here.
CREATE FUNCTION fi_control.fix_capacity_remaining(p_id uuid)
RETURNS TABLE(commands integer,events integer,security_headroom integer)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT
   COALESCE(sum(r.commands-x.commands),0)::integer,
   COALESCE(sum(r.events-x.events),0)::integer,
   (SELECT greatest(2-count(*),0)::integer FROM fi.commands c
    WHERE c.sandbox_id=p_id AND c.operation='ROTATE_CAPABILITIES'
      AND c.created_at >= (SELECT min(b.created_at) FROM fi.fix_bindings b WHERE b.sandbox_id=p_id))
 FROM fi_control.fix_reservations r
 LEFT JOIN LATERAL(
   SELECT COALESCE(sum(c.commands),0)::integer commands,COALESCE(sum(c.events),0)::integer events
   FROM fi.fix_consumptions c WHERE c.sandbox_id=r.sandbox_id AND c.order_id=r.order_id
 ) x ON true
 WHERE r.sandbox_id=p_id AND r.released_at IS NULL
$$;
REVOKE ALL ON FUNCTION fi_control.fix_capacity_remaining(uuid) FROM PUBLIC,tf_app,tf_reconciler,tf_maintenance;

-- Patch the installed Phase3B2 body, never restore the older 006 definition.
-- Unexpected or duplicated source fails the migration transaction closed.
DO $patch$
DECLARE d text;old_text text:=$old$ SELECT COALESCE(sum(commands),0),COALESCE(sum(events),0) INTO c,e FROM fi_control.fix_reservations WHERE sandbox_id=p_id AND released_at IS NULL;
 IF (SELECT count(*) FROM fi.fix_bindings WHERE sandbox_id=p_id)>=4 OR s.command_count+c+25+2>512 OR s.event_count+e+43+2>1024 THEN RETURN fi_control.failure(429,'FIX_RESERVATION_CAPACITY');END IF;$old$;
new_text text:=$new$ SELECT commands+security_headroom,events+security_headroom INTO c,e FROM fi_control.fix_capacity_remaining(p_id);
 IF (SELECT count(*) FROM fi.fix_bindings WHERE sandbox_id=p_id)>=4 OR s.command_count+c+25>512 OR s.event_count+e+43>1024 THEN RETURN fi_control.failure(429,'FIX_RESERVATION_CAPACITY');END IF;$new$;
BEGIN
 SELECT pg_get_functiondef('fi_control.fix_command(uuid,text,bigint,text,jsonb,text,uuid)'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,old_text,'')))<>length(old_text)
 OR position('fi.fix_protocol_observations' IN d)=0 OR position('fi.fix_applications' IN d)=0
 THEN RAISE EXCEPTION 'Unexpected Phase3B2 FIX command capacity/completion source';END IF;
 EXECUTE replace(d,old_text,new_text);
END $patch$;

-- Preserve the universal trigger, its OID and the private rotation-context guard.
CREATE OR REPLACE FUNCTION fi_control.protect_fix_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c integer;e integer;rotation boolean;headroom integer;
BEGIN
 IF NEW.command_count<=OLD.command_count AND NEW.event_count<=OLD.event_count THEN RETURN NEW;END IF;
 SELECT commands,events,security_headroom INTO c,e,headroom FROM fi_control.fix_capacity_remaining(NEW.id);
 IF c=0 AND e=0 THEN RETURN NEW;END IF;
 rotation:=EXISTS(SELECT 1 FROM fi_control.fix_writer_context WHERE sandbox_id=NEW.id AND transaction_id=pg_current_xact_id());
 IF NEW.command_count+c+(CASE WHEN rotation THEN 0 ELSE headroom END)>512
 OR NEW.event_count+e+(CASE WHEN rotation THEN 0 ELSE headroom END)>1024
 THEN RAISE EXCEPTION USING ERRCODE='TF429',MESSAGE='PROTECTED_FINANCIAL_CAPACITY';END IF;
 RETURN NEW;
END $$;

-- Historical schema5/6/7 reports retain their original validators and meaning.
DO $copy$ DECLARE d text;BEGIN
 SELECT pg_get_functiondef('fi_control.valid_reconciliation_metadata(jsonb)'::regprocedure) INTO d;
 EXECUTE replace(d,'FUNCTION fi_control.valid_reconciliation_metadata(','FUNCTION fi_control.valid_reconciliation_metadata_v3(');
END $copy$;
CREATE OR REPLACE FUNCTION fi_control.valid_reconciliation_metadata(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p->>'engine_version'<>'reconciliation-v4' THEN RETURN fi_control.valid_reconciliation_metadata_v3(p);END IF;
 IF p->>'schema_revision' IS DISTINCT FROM '8' OR jsonb_typeof(p->'schema_checksums') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'schema_checksums')<>8 THEN RETURN false;END IF;
 RETURN fi_control.valid_reconciliation_metadata_v3(p||jsonb_build_object('engine_version','reconciliation-v3','schema_revision',7,'schema_checksums',(p->'schema_checksums')-7));
END $$;
