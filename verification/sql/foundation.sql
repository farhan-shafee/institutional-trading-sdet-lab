-- Independent Phase 2A ledger reconstruction. No application functions or projections compute the expected values.
WITH command_totals AS (
  SELECT sandbox_id,count(*) AS commands,max(command_seq) AS last_seq,
         count(*) FILTER (WHERE result_kind='APPLIED' AND operation IN ('CREATE_SANDBOX','ROTATE_CAPABILITIES')) AS applied
  FROM fi.commands GROUP BY sandbox_id
), event_totals AS (
  SELECT sandbox_id,count(*) AS events,max(aggregate_version) FILTER (WHERE event_type IN ('SANDBOX_CREATED','CAPABILITIES_ROTATED')) AS generation
  FROM fi.audit_events GROUP BY sandbox_id
), violations AS (
  SELECT s.id AS sandbox_id,'SANDBOX_LEDGER_MISMATCH' AS invariant
  FROM fi.sandboxes s
  LEFT JOIN command_totals c ON c.sandbox_id=s.id
  LEFT JOIN event_totals e ON e.sandbox_id=s.id
  WHERE s.command_count IS DISTINCT FROM c.commands
     OR s.event_count IS DISTINCT FROM e.events
     OR s.commit_seq IS DISTINCT FROM c.last_seq
     OR s.generation IS DISTINCT FROM c.applied
     OR s.generation IS DISTINCT FROM e.generation
  UNION ALL
  SELECT c.sandbox_id,'COMMAND_EVENT_MISMATCH'
  FROM fi.commands c LEFT JOIN fi.audit_events e
    ON e.sandbox_id=c.sandbox_id AND e.command_id=c.id
  GROUP BY c.sandbox_id,c.id,c.command_seq
  HAVING count(e.command_id) NOT BETWEEN 1 AND 3 OR min(e.command_seq)<>c.command_seq
     OR min(e.event_index)<>0 OR max(e.event_index)<>count(e.command_id)-1
     OR (c.operation IN ('CREATE_SANDBOX','ROTATE_CAPABILITIES') AND count(e.command_id)<>1)
)
SELECT sandbox_id,invariant FROM violations ORDER BY sandbox_id,invariant;
