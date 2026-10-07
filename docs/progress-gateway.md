# Ledger — docs/superpowers/plans/2026-10-07-gateway.md

Ruling: explicit user request to fork and add already specified features authorizes inline work; no repeat skill approval gates (developer instruction priority).
Ruling: fresh clone on feature branch provides isolation; parent workspace is non-Git, avoid additional worktree checkout.
Ruling: upstream test command is a placeholder, skip meaningless baseline; only targeted tests and one staged real integration (user fewer-tests request).
Preflight: normalized alias/key contracts feed MySQL store/router; worker and legacy rule path use shared tasks; UI uses original admin x-auth-token.

Task1 complete: two focused model checks RED missing module -> GREEN2/2.
Task2/3 complete: staged HTTP/MySQL integration PASS unified/Server酱/legacy rules/scopes/idempotency/ntfy/retries/saved credentials. Initial harness found host sink blocked by network isolation; moved sink inside staging container and synchronized startup. No real recipient messages.
Final review: independent read-only reviewer found four issues: provider token errors swallowed, saved test omitted channel ID, missing rule target invisible, SMTP4xx classified permanent. All corrected in f6ca9d6; saved-credential and missing-target behavior exercised in the bounded integration. No repeated full-suite checks.
Ruling: reviewer retry error propagation fixes inspected directly instead of expanding provider tests, honoring user minimal-tests preference; real provider delivery still pending credentials.
