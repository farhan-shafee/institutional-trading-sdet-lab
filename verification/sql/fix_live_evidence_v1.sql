-- Immutable live snapshot. No application financial helper or writer is invoked.
SELECT 'fix-live-evidence-v1' AS profile,9 AS physical_schema_revision,
 pg_current_snapshot()::text AS snapshot_id,$1::uuid::text AS sandbox_id,
 COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.order_id) FROM fi.fix_live_bindings b WHERE b.sandbox_id=$1),'[]'::jsonb) AS bindings,
 COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM fi.fix_live_sessions s WHERE s.sandbox_id=$1),'[]'::jsonb) AS sessions,
 COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.session_id,c.connection_no) FROM fi.fix_live_connections c WHERE c.sandbox_id=$1),'[]'::jsonb) AS connections,
 COALESCE((SELECT jsonb_agg((to_jsonb(o)-'raw_bytes')||jsonb_build_object('raw_hex',encode(o.raw_bytes,'hex')) ORDER BY o.observed_at,o.id) FROM fi.fix_live_observations o WHERE o.sandbox_id=$1),'[]'::jsonb) AS observations,
 COALESCE((SELECT jsonb_agg((to_jsonb(c)-'callback_bytes')||jsonb_build_object('callback_hex',encode(c.callback_bytes,'hex')) ORDER BY c.connection_id,c.role,c.event_seq) FROM fi.fix_live_callbacks c WHERE c.sandbox_id=$1),'[]'::jsonb) AS callbacks,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.store_id,x.direction,x.message_seq) FROM fi.fix_live_sequence_slots x WHERE x.sandbox_id=$1),'[]'::jsonb) AS slots,
 COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM fi.fix_live_requests r WHERE r.sandbox_id=$1),'[]'::jsonb) AS requests,
 COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.received_at,m.id) FROM fi.fix_messages m JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(m.sandbox_id,m.order_id) WHERE m.sandbox_id=$1),'[]'::jsonb) AS messages,
 COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.order_id,w.lane_seq) FROM fi.fix_work w JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(w.sandbox_id,w.order_id) WHERE w.sandbox_id=$1),'[]'::jsonb) AS work,
 COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.order_id,p.work_id) FROM fi.fix_prepared p JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(p.sandbox_id,p.order_id) WHERE p.sandbox_id=$1),'[]'::jsonb) AS prepared,
 COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.protocol_command_seq,a.work_id) FROM fi.fix_applications a JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(a.sandbox_id,a.order_id) WHERE a.sandbox_id=$1),'[]'::jsonb) AS applications,
 COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.order_id,o.work_id) FROM fi.fix_protocol_observations o JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(o.sandbox_id,o.order_id) WHERE o.sandbox_id=$1),'[]'::jsonb) AS protocol_observations,
 COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.order_id,c.work_id) FROM fi.fix_consumptions c JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(c.sandbox_id,c.order_id) WHERE c.sandbox_id=$1),'[]'::jsonb) AS consumptions,
 COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('signed_par',p.signed_par::text,'signed_cash_cents',p.signed_cash_cents::text,'last_command_seq',p.last_command_seq::text) ORDER BY p.instrument_revision) FROM fi.positions p WHERE p.sandbox_id=$1),'[]'::jsonb) AS positions,
 COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('par_amount',e.par_amount::text,'consideration_cents',e.consideration_cents::text) ORDER BY e.command_seq,e.fill_sequence) FROM fi.executions e WHERE e.sandbox_id=$1),'[]'::jsonb) AS ledger_executions,
 COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'order',jsonb_build_object('id',o.id,'contract',o.contract),
  'lifecycle',to_jsonb(l)||jsonb_build_object('filled_par',l.filled_par::text,'remaining_par',l.remaining_par::text,'executed_cents',l.executed_cents::text,'version',l.version::text),
  'executions',COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('par_amount',e.par_amount::text,'consideration_cents',e.consideration_cents::text) ORDER BY e.fill_sequence) FROM fi.executions e WHERE(e.sandbox_id,e.order_id)=(o.sandbox_id,o.id)),'[]'::jsonb)
 ) ORDER BY o.id) FROM fi.orders o JOIN fi.fix_live_bindings b ON(b.sandbox_id,b.order_id)=(o.sandbox_id,o.id) JOIN fi.order_states l ON(l.sandbox_id,l.order_id)=(o.sandbox_id,o.id) WHERE o.sandbox_id=$1),'[]'::jsonb) AS orders;
