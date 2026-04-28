#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/Users/daryltaylor/Projects/ats-optimizer-web"
cd "$REPO_DIR"

# Load local secrets if present. Do not print them.
if [ -f "$HOME/.hermes/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$HOME/.hermes/.env"
  set +a
fi
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
fi

python3 -m pip install -q -r requirements-blog.txt
python3 bin/generate-blog-post.py --deploy
