#!/bin/zsh
cd -- "$(dirname -- "$0")"
if [[ -f .runtime/node-path ]]; then
  assistant_node="$(cat .runtime/node-path)"
else
  assistant_node="$(command -v node)"
fi
"$assistant_node" scripts/launch.mjs dev
