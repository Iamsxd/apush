# aPush fork: unified gateway

This fork of [5hux1n/apush](https://github.com/5hux1n/apush) retains the upstream MIT license, management UI, parser, rule engine, templates and all original channels. Local additions are maintained on `feat/pushhub-gateway`; they are not part of an upstream release. The separate custom PushHub is no longer required.

## Added behavior

- `POST /api/send` with a scoped Bearer key: `{ "title":"Job", "message":"Complete", "level":"normal", "channels":["wecom","ntfy"] }`.
- `GET/POST /SCT<token suffix>.send` accepts `title/desp` (query, form, JSON). Full keys already include SCT. Software must support a custom server URL.
- `GET /api/messages/:request_id` requires the same sender key. Other keys receive 404.
- Linked `/gateway.html` manages sender keys and displays delivery queue state. Uses the existing admin login; raw keys are shown only on creation, stored hashed.
- Channels have stable aliases and enable switches, redacted credentials with blank-preserving edits; ntfy and authenticated custom Webhooks added.
- Both unified sends and legacy webhook rule results persist in MySQL before acknowledgment. Temporary errors retry up to 3 total attempts, interrupted jobs recover, enterprise robot sends are spaced at least 3100ms per Webhook. HTTP requests time out at 10 seconds. SMTP uses Nodemailer with TLS certificate validation.
- Optional `Idempotency-Key` prevents duplicate enqueue per sender; changing content under the same key returns409. Target validation is atomic.

HTTP202 means queued, not phone receipt. Delivery is at least once: external providers may receive duplicates after a crash or uncertain network result. Keys are checked on acceptance; revoking a key does not cancel already accepted messages. Disabling a channel stops later attempts; deleted/disabled targets fail visibly. Existing source Webhook tokens remain separate from gateway keys. API-selected targets use channel templates directly; legacy ingress retains rule filtering and rule template overrides.

## Installation / upgrade

Use upstream setup (`node install.js`) to initialize a fresh MySQL database, configure `.env`, set a nonempty `AUTH_PASSWORD` for any internet-facing instance, then `npm ci` and `node server.js`. Startup performs additive table/column migrations, preserving original records. Use one database per installation; workers elect one sender with a database-namespaced MySQL advisory lock. Back up the database before upgrading. Node22+ and MySQL8+.

Open the original channel editor to fill provider credentials and set aliases. Open “统一接入 · 密钥与队列” to assign sender scopes/defaults. Android notifications arrive through enterprise WeChat, Telegram or the ntfy client; no Android background daemon is bundled. No real provider delivery is claimed until that channel is configured and receipt confirmed.

```bash
curl 'https://push.lovecan.net/api/send' \
  -H 'Authorization: Bearer <full api_key>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Codex","message":"任务已经执行完成","channels":["wecom"]}'

curl --get 'https://push.lovecan.net/<full api_key>.send' \
  --data-urlencode 'title=任务完成' --data-urlencode 'desp=Codex任务执行完毕'
```

Specific deployment details and all credentials are kept outside this repository. The optional `scripts/import-pushhub.js` imports channel configs and hashed keys from a private export; historical PushHub records remain in its preserved database snapshot. Do not commit that export or deployment secrets.

## Validation

`node --test test/gateway-model.test.js` checks scope/normalization and secret editing. `test/staging-gateway.py` is an operator-driven, bounded integration check against MySQL and an internal HTTP sink; it expects this deployment's protected access file. It never sends to real recipients.
