# Production Smoke Test Checklist (No staged rollout)

1. **Generate is gated**
   - `GET /api/metrics?repoUrl=https://github.com/nodejs/node` without session returns `401` + `RESULTS_AUTH_REQUIRED`.
2. **Auth and reveal**
   - Sign up/login; repeat generate call with session and confirm success payload.
   - `GET /widget/:owner/:repo` returns `200` for authorized user.
3. **Claim conflict safety**
   - User A owns repo; User B tries `/api/workspace/projects/claim` and gets `403`.
4. **Profile routing**
   - `/p/:owner/:repo` works for granted user.
   - `/u/:username` redirects to `/p/...` when one project, renders list when multiple.
5. **Embed alias normalization**
   - `/api/embeds/v2/:owner/:repo?theme=midnight|aurora|glass-ice` maps to `dark|light|sunset`.
6. **Ops telemetry sanity**
   - `GET /api/ops/metrics` (with `x-write-token`) shows non-zero counters for expected exercised paths (`auth401/auth403`, `claimDenied`, `generateFunnel`).
