#!/usr/bin/bash
set -euo pipefail
# Run from the repository root. No network, display, or clipboard access.
smoke_dir=$(/usr/bin/mktemp -d /tmp/nmp-stdio-smoke.XXXXXX)
/usr/bin/cp -- protocol.js tests/process-smoke.qml tests/stdio-probe.js "$smoke_dir/"
if ! smoke_output=$(/usr/bin/env -i QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$smoke_dir" \
  XDG_CACHE_HOME="$smoke_dir" HOME="$smoke_dir" \
  /usr/bin/quickshell --no-color -p "$smoke_dir/process-smoke.qml" 2>&1); then
  printf '%s\n' "$smoke_output"
  exit 1
fi
printf '%s\n' "$smoke_output"
[[ "$smoke_output" == *STDIN_SMOKE_PASS* && "$smoke_output" != *FAIL:* ]]
