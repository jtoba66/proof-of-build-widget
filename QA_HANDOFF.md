# QA Handoff — proof-of-build-widget

I added automated **lint** and **test** scripts so QA has verifiable checks.

## What changed
- Added npm scripts in `package.json`:
  - `npm run lint` → runs ESLint across the repo
  - `npm test` → runs Node built-in test suite (`node --test`)
- Added lint config:
  - `eslint.config.cjs`
- Added automated tests:
  - `tests/github.test.js`
    - URL parsing coverage
    - GitHub metrics fetch behavior with mocked `fetch`
    - 404 error mapping coverage
  - `tests/db.test.js`
    - SQLite upsert/get/list flow using isolated temp DB
    - verifies `uptime_text` preservation on null updates
- Added dev dependency:
  - `eslint`

## QA verification commands
Run from project root:

```bash
cd /home/joe/.openclaw/shared/proof-of-build-widget
npm install
npm run lint
npm test
```

## Expected outcome
- `npm run lint` exits 0 with no errors
- `npm test` reports 5 passing tests, 0 failures

## Notes
- Tests are deterministic and do not require network access (GitHub calls are mocked in unit tests).
- DB test uses temporary SQLite path and cleans up after itself.
