#!/bin/sh
# ntfy with access control (docs/plan.md, Appendix D "ntfy"; measured with ntfy 2.29.0):
# - nobody may publish but UCAP's server, which holds a token (secret ntfy_token, made by `npm run setup`);
# - phones read their own up* topics without an account: a topic's random name is its secret, and every payload is
#   end-to-end encrypted (RFC 8291), so a reader without the device's key learns nothing;
# - everything else is denied.
# The account's password is random on every start: nothing ever logs in with it, only the token is used.
set -eu
token=$(cat /run/secrets/ntfy_token)
pw=$(head -c 24 /dev/urandom | base64)
hash=$(printf '%s\n%s\n' "$pw" "$pw" | ntfy user hash 2>/dev/null | awk '{print $NF}')
export NTFY_AUTH_FILE=/var/cache/ntfy/user.db
export NTFY_AUTH_DEFAULT_ACCESS=deny-all
export NTFY_AUTH_USERS="ucap:${hash}:user"
export NTFY_AUTH_TOKENS="ucap:${token}:ucap-server"
export NTFY_AUTH_ACCESS="ucap:up*:write-only,everyone:up*:read-only"
exec ntfy serve
