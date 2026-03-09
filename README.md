# Proof of Build Widget

Proof of Build Widget generates simple embeddable widgets that show recent build activity for any public GitHub repository.

## Why this exists
Teams that build in public need lightweight and verifiable proof of progress. This project provides a clear widget you can embed on landing pages, docs, or posts.

## Core capabilities
- Analyze a public GitHub repository URL
- Show recent commit activity and latest commit time
- Generate an embeddable HTML snippet
- Provide a clean web interface for quick setup

## Quick start
```bash
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:3000`.

## Usage
1. Paste a public GitHub repository URL
2. Generate widget data
3. Copy the embed snippet
4. Paste it into your site or page

## API overview
- `GET /api/metrics` returns repository activity metrics
- `POST /api/metrics` updates metric data through an authenticated endpoint
- `GET /widget/:owner/:repo` renders the embeddable widget
- `GET /health` returns service status

## Security
The project includes request validation, authenticated write operations, output escaping for rendered widget content, and automated regression tests.

## License
MIT
