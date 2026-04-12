#!/bin/bash
# ATS Optimizer — deploy script
# Usage: ./deploy.sh "commit message"
# GitHub Actions handles the Cloudflare Pages deploy automatically on push. For an immediate production deploy, run: wrangler pages deploy public --project-name=ats-optimizer.
set -e

MSG="${1:-Update}"
cd "$(dirname "$0")"

echo "📦 Committing..."
git add -A
git commit -m "$MSG" || echo "Nothing to commit"

echo "🚀 Pushing to GitHub..."
git push origin main

echo "⚡ Deploying via GitHub Actions — live in ~60s"
echo "   Watch: https://github.com/daryltaylor72/ats-optimizer/actions"
echo "   Live:  https://atscore.ai"
