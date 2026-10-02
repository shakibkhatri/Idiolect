#!/usr/bin/env sh
# Refreshes vendored tree-sitter WASM grammars from npm. Edit the table, run, commit.
set -eu
cd "$(dirname "$0")/../packages/core/grammars"
# lang  npm package  version
while read -r lang pkg ver; do
  tgz=$(npm view "$pkg@$ver" dist.tarball)
  curl -sL "$tgz" | tar xz --strip-components=1 -C . "package/tree-sitter-$lang.wasm" "package/LICENSE"
  mv "tree-sitter-$lang.wasm" "$lang.wasm" && mv LICENSE "$lang.LICENSE"
  echo "$lang <- $pkg@$ver"
done <<TABLE
kotlin @tree-sitter-grammars/tree-sitter-kotlin 1.1.0
typescript tree-sitter-typescript 0.23.2
tsx tree-sitter-typescript 0.23.2
TABLE
