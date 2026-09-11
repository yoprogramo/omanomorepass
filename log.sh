#!/bin/bash
# Log de diagnóstico del plugin NoMorePass. Nunca registra secretos:
# el QML redacta los mensajes antes de llamar aquí.
/usr/bin/mkdir -p "$HOME/.local/state/omarchy"
printf '%s %s\n' "$(/usr/bin/date -Is)" "$1" >> "$HOME/.local/state/omarchy/nomorepass.log"
