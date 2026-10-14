#!/bin/zsh
cd "$HOME/morrow-finance-hub" || exit 1
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
npm start
