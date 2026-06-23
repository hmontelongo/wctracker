# ZenRows Capabilities

This project focuses on the two ZenRows surfaces we need first: Universal Scraper API and Scraping Browser.

## Universal Scraper API

- Endpoint: `GET https://api.zenrows.com/v1/`
- Authentication: `apikey` query parameter. Keep it in `.env`; do not hardcode it in scripts.
- Required request parameters: `apikey`, `url`.
- Default response shape: the target page body, usually HTML/text, with useful ZenRows headers.
- Important response headers: `Concurrency-Limit`, `Concurrency-Remaining`, `X-Request-Cost`, `X-Request-Id`, `Zr-Final-Url`.

Core controls:

- `mode=auto`: Adaptive Stealth Mode. ZenRows chooses the cheapest successful setup and may escalate to JavaScript rendering or premium proxies. Do not combine it with manual `js_render` or `premium_proxy`.
- `js_render=true`: render the page in a browser before returning content. Use for SPAs, AJAX-loaded content, Cloudflare-style JavaScript checks, and browser-fingerprint checks.
- `premium_proxy=true`: route through residential proxies. Use when datacenter IPs are blocked or geo-sensitive access matters.
- `proxy_country=<country>`: country-level proxy targeting. Use with premium proxies or with `mode=auto` when localization matters.
- `custom_headers=true`: lets the request pass custom HTTP headers such as cookies, referer, authorization, or language preferences.
- `session_id=<integer>`: keep the same IP for related requests for a short session window.
- `original_status=true`: expose the target site's original HTTP status for debugging.
- `allowed_status_codes=404,500`: return target error pages instead of failing them.
- `wait=<milliseconds>` and `wait_for=<css selector>`: wait for slow or asynchronous content while using browser rendering.
- `block_resources=<types>`: block assets such as images or fonts to reduce bandwidth and speed up browser-rendered requests.
- `js_instructions=<json array>`: run sequential browser actions after render, such as click, wait, fill, check, select, scroll, evaluate JavaScript, iframe actions, and CAPTCHA-related actions. Requires `js_render=true`.

Output controls:

- `css_extractor=<json object>`: return structured JSON extracted by CSS selectors or XPath, including text and attributes like `a @href`.
- `autoparse=true`: ask ZenRows to infer structured data automatically.
- `json_response=true`: return a JSON object with rendered HTML plus captured XHR/fetch/network metadata. Requires `js_render=true`.
- `response_type=markdown`: return Markdown text.
- `response_type=plaintext`: return plain text.
- `response_type=pdf`: return a PDF render.
- `screenshot=true`: return a screenshot binary. Requires `js_render=true`.
- `screenshot_fullpage=true`: full page screenshot.
- `screenshot_selector=<selector>`: screenshot one element.
- `screenshot_format=png|jpeg`, `screenshot_quality=1..100`: screenshot format controls.
- `outputs=<filters>`: extract selected output types from the page.
- File downloads: ZenRows can download files and pictures through the same scraping pipeline.

Pricing behavior to remember:

- Basic request: 1x.
- JavaScript rendering: 5x.
- Premium proxies: 10x.
- JavaScript rendering plus premium proxies: 25x.
- `mode=auto` charges for the successful configuration, not failed internal attempts.

## Scraping Browser

- Endpoint: `wss://browser.zenrows.com?apikey=<key>`
- Protocol: Chrome DevTools Protocol over WebSocket, used through Playwright `chromium.connectOverCDP`, Puppeteer `connect`, the ZenRows Browser SDK, or direct CDP.
- Best for workflows that need real browser automation beyond one API request: multi-step navigation, complex interactions, screenshots, network interception, downloads, long waits, tabs, and Playwright/Puppeteer APIs.

Connection parameters:

- `apikey`: required.
- `proxy_region=<region>`: region-level targeting.
- `proxy_country=<country>`: country-level targeting when region is global/default.
- `session_ttl=<seconds>`: browser session lifetime, 60 to 900 seconds.

Response format:

- There is no single HTTP response body. You receive CDP command results and events.
- Common examples: `Runtime.evaluate` returns JSON-serializable values; `Page.captureScreenshot` returns base64 image data; Playwright/Puppeteer wraps these into familiar `page.title()`, `page.screenshot()`, `page.locator()`, request interception, and download APIs.

Operational notes:

- Close pages/browser sessions when done.
- Keep sessions short because billing is time and bandwidth based, with session time billed in 30-second increments.
- Set navigation and selector timeouts explicitly.
- Reuse a session for multiple operations on the same target when it reduces setup cost.
- Use Universal Scraper for one-shot extraction and Scraping Browser for longer browser workflows.

## FIFA Availability Monitor Notes

- Default URL: `https://fifaworldcup26.hospitality.fifa.com/mx/en/choose-matches?src=home_hero_browse_matches`.
- Default buyer/shop context: `Mexico`, configured by `FIFA_VISITOR_COUNTRY`.
- Each ticker cycle uses the normal rendered page flow: accept cookies, choose the buyer/shop country, collect every purchasable match card exposed by that shop, click each match card, and capture public `/next-api/lounges` responses.
- The local job system has a coordinator stage and bounded parallel match-job stage. `FIFA_MATCH_CONCURRENCY` controls how many match browser jobs run at the same time.
- The normalized row is ticket-type/seating-level, not match-card-level. Each row includes match code, performance ID, ticket type/package ID, title, seating code, price, `available`, `availableQuantity`, and raw API fields for the ticket type and seating section.
- The monitor does not automate checkout, cart, login, payment, CAPTCHA, queue bypass, or session cookie/header extraction.
- The selected country is not a match-location filter. Each cycle scans every purchasable/clickable match card exposed by that shop context, regardless of venue country. Cards explicitly routed to another country shop, marked currently unavailable, or disabled are skipped. `FIFA_DISCOVERY_ATTEMPTS` retries bad no-card page states before failing the cycle.

Useful commands:

```bash
FIFA_VISITOR_COUNTRY=Mexico npm run discover:fifa
FIFA_VISITOR_COUNTRY=Mexico FIFA_TICKER_MAX_TICKS=1 npm run ticker:fifa
npm run dashboard
```

Use another country later by changing `FIFA_VISITOR_COUNTRY`, for example:

```bash
FIFA_VISITOR_COUNTRY="United States" npm run discover:fifa
```
