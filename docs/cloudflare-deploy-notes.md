# Cloudflare Deploy Notes

Current local shape:

- `dashboard/` is static HTML/CSS/JS.
- `scripts/dashboard-server.mjs` is a local Node HTTP server with SSE and control endpoints.
- `scripts/lib/fifa-job-system.mjs` runs ZenRows browser cycles and writes JSON artifacts.

Cloudflare target shape:

- Static UI: Cloudflare Workers Static Assets or Pages.
- API/state worker: a Worker endpoint that serves latest cycle state to the UI.
- Scheduler: Worker Cron Trigger for periodic cycles.
- Storage: D1 for normalized rows/cycles. Local development now uses SQLite at `artifacts/worldcup.sqlite`, which maps cleanly to D1 later.
- Secrets: ZenRows key stored as a Worker secret, not in source or public env.
- Admin mode: protect `/admin` with Cloudflare Access or an equivalent account-level gate.

Important constraint:

- The current reliable scraper path uses ZenRows Scraping Browser over WebSocket/CDP. Before moving the job runner fully into Cloudflare Workers, validate that the Worker runtime can sustain the CDP/WebSocket flow and execution time. If not, keep the scraper as an external worker process and use Cloudflare for UI, API, storage, scheduler, and notifications.

References:

- Wrangler: https://developers.cloudflare.com/workers/wrangler/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- D1: https://developers.cloudflare.com/d1/
- Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
