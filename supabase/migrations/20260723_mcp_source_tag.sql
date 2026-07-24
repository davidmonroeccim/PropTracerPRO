-- Tag the origin of a trace so MCP-initiated spend is auditable and (optionally) capped.
-- Additive columns on PRE-EXISTING tables: no new GRANTs needed (PTP CLAUDE.md migration rule).
ALTER TABLE public.trace_jobs ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.trace_history ADD COLUMN IF NOT EXISTS source text;
COMMENT ON COLUMN public.trace_jobs.source IS 'Origin of the job, e.g. ''mcp'' for Suite MCP submissions; NULL for existing web/API traffic.';
COMMENT ON COLUMN public.trace_history.source IS 'Origin of the trace row, e.g. ''mcp''; NULL for existing web/API traffic.';
