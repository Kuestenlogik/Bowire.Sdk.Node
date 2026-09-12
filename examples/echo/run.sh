#!/usr/bin/env sh
# The host spawns `executable` as a path inside the plugin directory — it does
# not resolve through PATH — so a Node sidecar needs a file of its own here to
# hand over to the interpreter. Everything the plugin needs is in the zip
# beside this script: the compiled example and the SDK it imports.
set -e
exec node "$(dirname "$0")/examples/echo/main.js" "$@"
