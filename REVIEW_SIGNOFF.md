# Review: proof-of-build-widget

Monica here.

- **Verdict**: 🔄 Changes Requested

## What I reviewed
- Code paths: `src/server.js`, `src/github.js`, `src/db.js`, `public/app.js`
- Test status: re-ran `npm run lint` and `npm test` locally (both pass: 5 tests, 0 failures)
- Handoff/security context: `QA_HANDOFF.md`, `SECURITY_AUDIT.md`

## Strengths
- This is good, but the fundamentals are solid: clean module boundaries and readable API/DB flow.
- Lint and unit checks are green and deterministic.
- Parameterized SQL and write-token gate are in place.

## Blocking issues
1. **XSS risk in widget rendering remains unresolved (blocker)**
   - I’d push back on this because dynamic values are still interpolated directly into HTML in `GET /widget/:owner/:repo`:
     - `${commits}`, `${lastCommit}`, `${uptime}`, `${owner}`, `${repo}` in `src/server.js`
   - No HTML escaping/safe templating is applied, so crafted input can inject markup/script.
   - This was the prior blocking security finding and is still present.

2. **Missing regression test for HTML/script payload escaping**
   - QA tests currently validate DB/GitHub logic only; there is no test proving malicious payloads are rendered as text in widget HTML.

## Required for approval
- Implement output escaping for all user/external dynamic fields in widget HTML response.
- Add at least one regression test demonstrating script/HTML payloads are escaped and non-executable.

Once those are in and green, I can approve quickly.