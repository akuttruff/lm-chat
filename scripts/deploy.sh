#!/bin/sh
# Rebuild and restart the persistent instance (launchd: com.amie.lm-chat),
# the one Tailscale serves. `npm run dev` is unaffected.
#
# A restart cuts off any reply being written, so this refuses while one is
# in flight. FORCE=1 npm run deploy restarts anyway.
set -e
cd "$(dirname "$0")/.."
PORT=8010

if [ "${FORCE:-}" != 1 ]; then
  # Replies being written, and the jobs that follow them (summary, title,
  # transit readings): a restart cuts any of them off.
  busy=$(curl -sS -m 2 "http://localhost:$PORT/api/busy" 2>/dev/null | grep '"replies"' || true)
  if [ -n "$busy" ]; then
    if ! printf '%s' "$busy" | grep -q '"replies":0,"background":0'; then
      echo "lm-chat: busy right now ($busy); a restart would cut that off." >&2
      echo "         Wait for it to finish, or run: FORCE=1 npm run deploy" >&2
      exit 1
    fi
  else
    # A server from before /api/busy: the live-updates stream still opens
    # with which chats are mid-reply.
    statuses=$(curl -sS -m 2 "http://localhost:$PORT/api/events" 2>/dev/null | grep -m1 '"type":"statuses"' || true)
    if [ -n "$statuses" ] && ! printf '%s' "$statuses" | grep -q '"payload":\[\]'; then
      echo "lm-chat: a reply is being written right now; a restart would cut it off." >&2
      echo "         Wait for it to finish, or run: FORCE=1 npm run deploy" >&2
      exit 1
    fi
  fi
fi

npm run build
launchctl kickstart -k "gui/$(id -u)/com.amie.lm-chat"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sfo /dev/null "http://localhost:$PORT/"; then echo "lm-chat: deployed"; exit 0; fi
  sleep 1
done
echo "lm-chat: restarted, but not answering on :$PORT -- see ~/Library/Logs/com.amie.lm-chat.log" >&2
exit 1
