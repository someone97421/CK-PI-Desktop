#!/bin/zsh

cd -- "${0:A:h}" || exit 1
export PATH="$PATH:$HOME/.cargo/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin"

exec pnpm dev
