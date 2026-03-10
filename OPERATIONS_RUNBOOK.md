# Proof-of-Build Widget — Operations Runbook

## Release Scope
This runbook covers the production release that hardens auth-gated reveal, claim conflict denial, profile redirects, and embed alias normalization.

## Monitoring Watch Window (first 24–48h)
Track:
- Auth failures (`401` / `403`) on API and widget/profile routes
- Claim denied events (`/api/workspace/projects/claim`)
- Generate funnel stages: requested → auth gated → authed → revealed

## Rollback Trigger Thresholds (explicit)
Trigger rollback if **any** of the following persist for 10+ minutes:
1. `401` rate on generate/reveal routes > **20%** of requests (excluding unauthenticated expected traffic baselines).
2. `403` rate on authenticated routes > **5%** of authenticated requests.
3. Claim-denied events spike to > **3x** trailing 7-day hourly baseline.
4. Generate funnel reveal conversion drops by > **30%** vs trailing 7-day baseline.
5. Error budget impact: p95 API error rate > **2%** across release endpoints.

## On-Call Ownership (fill before prod)
- Primary on-call owner: **<TEAM_MEMBER_PRIMARY>**
- Secondary on-call owner: **<TEAM_MEMBER_SECONDARY>**
- Escalation channel: **<SLACK_OR_PAGER_CHANNEL>**

## Immediate Rollback Steps
1. Announce rollback in incident channel.
2. Revert to previous backend release artifact/tag.
3. Verify `/health`, `/api/metrics` (gated), `/api/workspace/projects/claim` behavior.
4. Confirm 401/403 and claim-denied metrics return to baseline.
5. Post incident summary and action items.
