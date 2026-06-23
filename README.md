# ZenRows Mini Project

Small Node.js project for testing ZenRows Universal Scraper API and Scraping Browser without hardcoding credentials.

## Setup

The API key is stored in `.env`:

```dotenv
ZENROWS_API_KEY=...
ZENROWS_TARGET_URL=https://example.com
ZENROWS_BROWSER_TARGET_URL=https://example.com
FIFA_VISITOR_COUNTRY=Mexico
FIFA_MATCH_CONCURRENCY=6
FIFA_MATCH_JOB_ATTEMPTS=2
FIFA_FAST_POLL_ENABLED=0
FIFA_FAST_FETCH_CONCURRENCY=8
FIFA_FULL_DISCOVERY_EVERY=10
FIFA_DISCOVERY_ATTEMPTS=3
```

`.env` is ignored by `.gitignore`. Use `.env.example` as the safe template.

## Commands

```bash
npm run test:universal
npm run test:browser
npm run test:zenrows
npm run discover:fifa
npm run ticker:fifa
npm run dashboard
```

Outputs are written to `artifacts/`:

- `artifacts/universal-scraper-smoke.json`
- `artifacts/scraping-browser-smoke.json`
- `artifacts/scraping-browser-screenshot.jpeg`
- `artifacts/fifa-availability-snapshot.json`
- `artifacts/fifa-discovered-targets.json`
- `artifacts/fifa-ticket-state.json`
- `artifacts/worldcup.sqlite`

SQLite is the local source of truth for the latest cycle/state. JSON artifacts are still written as backups and inspection snapshots.

## What The Tests Cover

Universal Scraper smoke test:

- raw HTML/text response
- `css_extractor` structured JSON
- `response_type=markdown`
- `js_render=true` plus `json_response=true`
- response headers for request ID, cost, concurrency, content type, and final URL

Scraping Browser smoke test:

- WebSocket/CDP connection to `wss://browser.zenrows.com`
- browser version query
- target creation and page navigation
- DOM extraction through `Runtime.evaluate`
- screenshot capture through `Page.captureScreenshot`

FIFA discovery:

- opens the FIFA hospitality shop through ZenRows Scraping Browser
- selects the buyer/shop context from `FIFA_VISITOR_COUNTRY` (`Mexico` by default)
- discovers every match card exposed by that shop context
- clicks each discovered card through the normal rendered page flow
- captures `/next-api/lounges` through CDP network events
- normalizes every package/seating section row, not only Suite Essentials

FIFA ticker:

- runs discovery independently on `FIFA_DISCOVERY_INTERVAL_MS`
- stores each discovery run in SQLite
- creates one durable match job per purchasable/clickable match card exposed by the selected shop context
- lets workers claim jobs through SQLite leases and retry failed jobs
- runs match workers in parallel, bounded by `FIFA_MATCH_CONCURRENCY`
- each job opens its match and captures all ticket-type rows through the rendered FIFA flow
- stores normalized rows and raw ticket-type/seating-section data
- stores per-row freshness fields such as `checkedAt`, `becameAvailableAt`, `lastChangedAt`, and `availabilityFreshness`
- stores alert events when a ticket row becomes available or quantity increases
- stores latest state, jobs, discovery runs, ticket rows, and alert events in SQLite

The selected country is the FIFA buyer/shop context, not a match-location filter. Discovery scans every purchasable/clickable match card exposed by that shop, regardless of where the match is played. Cards explicitly routed to another country shop, marked currently unavailable, or disabled are skipped. `FIFA_DISCOVERY_ATTEMPTS` controls retries before a no-card page state is treated as a failed discovery.

The main path is discovery plus durable match jobs. Fast target polling is not used as the primary freshness signal because direct `/next-api/lounges` requests can return `401`; discovery is the source of truth for newly listed matches.

The local dashboard process runs two internal loops: a discovery loop and a worker loop. SQLite locks prevent duplicate discovery coordinators, and SQLite job leases let multiple processes claim different match jobs without stepping on each other. `FIFA_MATCH_JOB_ATTEMPTS` controls in-browser retries during a job; `FIFA_QUEUE_JOB_ATTEMPTS` controls how many times a durable queued job can be retried after a failed lease attempt.

Dashboard:

- local URL: `http://localhost:5177`
- shows games first, then ticket types inside each game, with freshness and availability as the main view
- keeps cycle/job events and debug configuration in the system drawer
- auto-starts the interval ticker by default through `DASHBOARD_AUTOSTART_TICKER=1`
- can launch one cycle for debugging or start/stop the interval ticker locally

See `docs/zenrows-capabilities.md` for the compact feature reference.
