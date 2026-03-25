#!/bin/bash
# ATS Optimizer — deploy script
# Usage: ./deploy.sh "commit message"
set -e

MSG="${1:-Update}"
cd "$(dirname "$0")"

echo "📦 Committing..."
git add -A
git commit -m "$MSG" || echo "Nothing to commit"

echo "🚀 Pushing to GitHub..."
git push origin main

echo "☁️  Deploying to Cloudflare Pages..."
rm -rf .wrangler/cache
npx wrangler pages deploy public --project-name ats-optimizer --commit-dirty=true

echo "✅ Done! Live at https://ats-optimizer.pages.dev"
