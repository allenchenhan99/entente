#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 [--force] <target-dir>" >&2
  exit 2
}

force=false
target_input=''

for argument in "$@"; do
  case "$argument" in
    --force)
      force=true
      ;;
    --*)
      usage
      ;;
    *)
      if [[ -n "$target_input" ]]; then
        usage
      fi
      target_input=$argument
      ;;
  esac
done

if [[ -z "$target_input" || "$target_input" == '/' ]]; then
  usage
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_dir=$(cd -- "$script_dir/.." && pwd -P)
target_parent=$(dirname -- "$target_input")
target_name=$(basename -- "$target_input")

mkdir -p -- "$target_parent"
target_parent=$(cd -- "$target_parent" && pwd -P)
target_dir="$target_parent/$target_name"

case "$target_dir/" in
  "$source_dir/"* | /)
    echo "Refusing unsafe target: $target_dir" >&2
    exit 1
    ;;
esac

case "$source_dir/" in
  "$target_dir/"*)
    echo "Refusing unsafe target: $target_dir" >&2
    exit 1
    ;;
esac

if [[ -e "$target_dir" && ! -d "$target_dir" ]]; then
  if [[ "$force" != true ]]; then
    echo "Target exists and is not an empty directory: $target_dir" >&2
    exit 1
  fi
  rm -- "$target_dir"
fi

mkdir -p -- "$target_dir"

if [[ -n "$(find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  if [[ "$force" != true ]]; then
    echo "Target directory is not empty: $target_dir" >&2
    exit 1
  fi
  find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi

(
  cd -- "$source_dir"
  tar \
    --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./scripts' \
    -cf - .
) | (
  cd -- "$target_dir"
  tar -xf -
)

git -C "$target_dir" init -b main >/dev/null
git -C "$target_dir" add -A
git -C "$target_dir" \
  -c user.name='RelayGraph Demo' \
  -c user.email='demo@relaygraph.local' \
  commit -m 'Initial demo app (no auth)' >/dev/null

printf '%s\n' "$target_dir"
