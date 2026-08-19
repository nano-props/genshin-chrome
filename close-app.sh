#!/usr/bin/env bash
set -euo pipefail

APP_NAME='Genshin Chrome'

if ! pgrep -x "$APP_NAME" >/dev/null; then
  exit 0
fi

echo "$APP_NAME is running, trying to close..."
pkill -TERM -x "$APP_NAME"

for _ in {1..10}; do
  if ! pgrep -x "$APP_NAME" >/dev/null; then
    echo "$APP_NAME closed"
    exit 0
  fi
  sleep 0.5
done

echo "Force killing $APP_NAME..."
pkill -KILL -x "$APP_NAME"

for _ in {1..10}; do
  if ! pgrep -x "$APP_NAME" >/dev/null; then
    exit 0
  fi
  sleep 0.1
done

echo "Failed to close $APP_NAME" >&2
exit 1
