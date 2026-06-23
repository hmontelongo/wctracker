# Telegram notifications

Backend-only notification flow:

1. Scraper cycles persist ticket rows in SQLite.
2. Global availability changes create `alert_events`.
3. User-specific watch rules live in `alert_rules`.
4. Matching global alerts or alert rules create `notification_outbox` rows.
5. The dashboard server runs a Telegram loop that sends pending outbox rows and marks them sent.

Global alerts use `priority = normal`.
Specific watch rules use `priority = high`.

If a specific rule fires for the same ticket event, the normal global notification is skipped to avoid duplicate Telegram messages.
Global card alerts are controlled by the SQLite setting exposed in the dashboard switch. User-specific watch rules do not depend on that switch.

## Environment

Telegram sends when both credentials exist:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_NOTIFY_INTERVAL_MS=3000
TELEGRAM_NOTIFY_BATCH_SIZE=5
TELEGRAM_NOTIFY_LEASE_MS=30000
TELEGRAM_NOTIFY_RETRY_DELAY_MS=30000
TELEGRAM_MAX_ATTEMPTS=5
```

`TELEGRAM_CHAT_ID` is required. The bot token alone is not enough to deliver messages.

## Alert rule API

Create a watch rule:

```http
POST /api/alert-rules
```

```json
{
  "rowKey": "M66|10229203836819|SE|S_STD|100000",
  "matchCode": "M66",
  "performanceId": "10229203836819",
  "loungeId": "SE",
  "seatingCode": "S_STD",
  "packageTitle": "Suites Essentials",
  "seatingName": "Suites Essentials",
  "condition": "becomes_available",
  "label": "Uruguay vs Spain · Suites Essentials"
}
```

Supported conditions:

- `becomes_available`
- `stock_increase`
- `stock_change`
- `price_change`
- `any_change`

List rules:

```http
GET /api/alert-rules
```

Disable a rule:

```http
DELETE /api/alert-rules/:id
```
