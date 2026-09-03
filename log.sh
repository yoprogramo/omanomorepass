#!/bin/bash
# Log de diagnóstico del plugin NoMorePass. Nunca registra secretos:
# el QML redacta los mensajes antes de llamar aquí.
mkdir -p "$HOME/.local/state/omarchy"
printf '%s %s\n' "$(date -Is)" "$1" >> "$HOME/.local/state/omarchy/nomorepass.log"
