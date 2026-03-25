# ATS Optimizer — Project Rules

## Stack
- **Frontend:** `public/index.html` — landing page
- **Tool:** `public/tool/index.html` — the ATS analyzer UI
- **Backend:** `functions/analyze.js` — Cloudflare Pages Function (POST /analyze)
- **Hosting:** Cloudflare Pages (`ats-optimizer.pages.dev`)
- **Repo:** `git@github.com:daryltaylor72/ats-optimizer.git`

## Deploying
After making any code changes, ALWAYS run the deploy script:

```bash
cd /Users/daryltaylor/Projects/ats-optimizer-web
./deploy.sh "describe what you changed"
```

This will:
1. Commit and push to GitHub
2. Deploy to Cloudflare Pages

The live URL is **https://ats-optimizer.pages.dev** — changes go live in ~30 seconds.

## Environment
- `ANTHROPIC_API_KEY` is set as a Cloudflare Pages secret (already configured)
- Model: `claude-opus-4-6`
- Wrangler auth: OAuth token in `~/.wrangler/config/default.toml` (auto-refreshes)

## API Endpoint
- `POST /analyze` — accepts multipart form with `resume` (PDF/DOCX), `job_description` (text), `include_rewrite` (bool)
- Returns JSON: score, grade, summary, categories, critical_issues, recommendations, keyword_gaps, optimized_resume (only if include_rewrite=true)
