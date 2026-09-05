#!/bin/sh
# Install from the original repository. Run with: curl -fsSL <url>/install.sh | sh
set -eu

say() { printf 'entente: %s\n' "$*"; }
die() { printf 'entente: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Required command missing: $1"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

main() {
  native=1
  for arg in "$@"; do
    case "$arg" in
      --no-native) native=0 ;;
      --help|-h)
        printf '%s\n' 'Usage: sh install.sh [--no-native]' \
          'Installs Entente for macOS, Linux and WSL. Requires Git, curl and tar.' \
          'The default also builds the native terminal and requires a C compiler.' \
          'Missing Node.js and Rust are installed privately for Entente.' \
          'ENTENTE_INSTALL_DIR: application directory (default: ~/.local/share/entente)' \
          'ENTENTE_BIN_DIR: command directory (otherwise choose a directory on PATH)' \
          'ENTENTE_REF: branch or tag to install (default: main)'
        return ;;
      *) die "Unknown option: $arg (see --help)" ;;
    esac
  done

  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) die 'Use macOS, Linux or WSL for install.sh.' ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die 'Supported architectures: x64 and arm64.' ;; esac
  for tool in curl git tar sed mktemp; do need "$tool"; done
  if [ "$native" = 1 ]; then
    command -v cc >/dev/null 2>&1 || die 'A C compiler is needed for the native terminal. Install Xcode Command Line Tools (macOS) or build-essential (Ubuntu), then rerun.'
  fi

  install_root=${ENTENTE_INSTALL_DIR:-"$HOME/.local/share/entente"}
  case "$install_root" in /*) ;; *) die 'ENTENTE_INSTALL_DIR must be an absolute path.' ;; esac
  [ "$install_root" != / ] && [ "$install_root" != "$HOME" ] || die 'Choose a dedicated Entente installation directory.'
  mkdir -p "$install_root"
  install_root=$(cd "$install_root" && pwd -P)
  if [ ! -f "$install_root/.entente-install" ] && [ -n "$(ls -A "$install_root")" ]; then
    die "Refusing to use a nonempty unmanaged directory: $install_root"
  fi
  : > "$install_root/.entente-install"
  mkdir "$install_root/.install-lock" 2>/dev/null || die "Another installation is running (lock: $install_root/.install-lock)."
  stage=''
  launcher_temp=''
  cleanup() {
    if [ -n "$stage" ]; then
      case "$stage" in "$install_root"/.stage.*) rm -rf "$stage" ;; esac
    fi
    [ -z "$launcher_temp" ] || rm -f "$launcher_temp"
    rmdir "$install_root/.install-lock" 2>/dev/null || :
  }
  trap cleanup 0
  trap 'exit 130' 2
  trap 'exit 143' 15
  trap 'exit 129' 1
  stage=$(mktemp -d "$install_root/.stage.XXXXXXXX")

  # Choose a command directory already visible to the caller's shell. A child
  # installer cannot change the parent shell's PATH.
  bin_dir=${ENTENTE_BIN_DIR:-}
  use_sudo=0
  if [ -z "$bin_dir" ]; then
    old_ifs=$IFS
    IFS=:
    for candidate in $PATH; do
      case "$candidate" in
        "$HOME"/*|/usr/local/bin|/opt/homebrew/bin)
          if [ -d "$candidate" ] && [ -w "$candidate" ]; then bin_dir=$candidate; break; fi ;;
      esac
    done
    IFS=$old_ifs
  fi
  if [ -z "$bin_dir" ]; then
    case ":$PATH:" in
      *:/usr/local/bin:*)
        need sudo
        say 'The command will be installed in /usr/local/bin; sudo may request your password.'
        sudo -v || die 'Cannot install the command. Set ENTENTE_BIN_DIR to a writable directory on PATH.'
        bin_dir=/usr/local/bin
        use_sudo=1 ;;
      *) die 'No writable command directory is on PATH. Add ~/.local/bin to PATH, then rerun with ENTENTE_BIN_DIR="$HOME/.local/bin".' ;;
    esac
  fi
  case "$bin_dir" in /*) ;; *) die 'ENTENTE_BIN_DIR must be an absolute path.' ;; esac
  case ":$PATH:" in *:"$bin_dir":*) ;; *) die "Add $bin_dir to PATH before installing, so entente works immediately." ;; esac
  if [ -e "$bin_dir/entente" ] || [ -L "$bin_dir/entente" ]; then
    grep -q '^# Entente managed launcher$' "$bin_dir/entente" 2>/dev/null || die "Refusing to replace an unrelated command: $bin_dir/entente"
  fi

  say 'Downloading Entente from allenchenhan99/entente…'
  git clone --quiet --depth 1 --branch "${ENTENTE_REF:-main}" \
    https://github.com/allenchenhan99/entente.git "$stage/app"
  revision=$(git -C "$stage/app" rev-parse HEAD)

  # Use a compatible installed Node, or a checksum-verified private Node 22.
  node_bin=''
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null && command -v npm >/dev/null 2>&1; then
    node_bin=$(command -v node)
  else
    say 'Installing a private Node.js 22 runtime…'
    node_dist=https://nodejs.org/dist/latest-v22.x
    curl --fail --silent --show-error --location "$node_dist/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
    archive=$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ /^node-v22\./ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$stage/SHASUMS256.txt")
    [ -n "$archive" ] && [ "$(printf '%s\n' "$archive" | wc -l | tr -d ' ')" = 1 ] || die 'Could not identify the Node.js download.'
    curl --fail --silent --show-error --location "$node_dist/$archive" -o "$stage/$archive"
    expected=$(awk -v file="$archive" '$2==file {print $1}' "$stage/SHASUMS256.txt")
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/$archive" | awk '{print $1}');
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$stage/$archive" | awk '{print $1}');
    else die 'SHA-256 verification requires sha256sum or shasum.'; fi
    [ "$actual" = "$expected" ] || die 'Node.js checksum mismatch.'
    mkdir -p "$stage/app/.runtime/node"
    tar -xzf "$stage/$archive" --strip-components=1 -C "$stage/app/.runtime/node"
    node_bin="$stage/app/.runtime/node/bin/node"
    PATH="$stage/app/.runtime/node/bin:$PATH"
    export PATH
  fi

  if [ "$native" = 1 ] && ! command -v cargo >/dev/null 2>&1; then
    say 'Installing a private Rust toolchain for the native terminal…'
    CARGO_HOME="$install_root/toolchain/cargo"
    RUSTUP_HOME="$install_root/toolchain/rustup"
    export CARGO_HOME RUSTUP_HOME
    curl --fail --silent --show-error --location https://sh.rustup.rs -o "$stage/rustup-init.sh"
    sh "$stage/rustup-init.sh" -y --profile minimal --no-modify-path
    PATH="$CARGO_HOME/bin:$PATH"
    export PATH
  fi

  say 'Building Entente (the first native build can take several minutes)…'
  (
    cd "$stage/app"
    npm ci --include=dev
    npm run build
    if [ "$native" = 1 ]; then
      CARGO_TARGET_DIR="$PWD/target" cargo build --release --locked -p termd -p relay-tui
      [ -x target/release/termd ] && [ -x target/release/relay-tui ] || die 'The native build did not produce both terminal binaries.'
    fi
    "$node_bin" bin/entente.mjs --help >/dev/null
  )

  # Immutable installations let a failed update leave the working command intact.
  release_dir="$install_root/releases/$revision-$(date +%s)-$$"
  mkdir -p "$install_root/releases"
  mv "$stage/app" "$release_dir"
  case "$node_bin" in "$stage"/*) node_bin="$release_dir/.runtime/node/bin/node" ;; esac
  launcher_temp=$(mktemp "$install_root/.launcher.XXXXXXXX")
  {
    printf '#!/bin/sh\n# Entente managed launcher\n'
    printf 'ENTENTE_APP=%s\n' "$(quote "$release_dir")"
    printf 'ENTENTE_NODE=%s\n' "$(quote "$node_bin")"
    printf 'PATH=%s:"$PATH"\nexport PATH\n' "$(quote "$(dirname "$node_bin")")"
    printf 'exec "$ENTENTE_NODE" "$ENTENTE_APP/bin/entente.mjs" "$@"\n'
  } > "$launcher_temp"
  chmod 755 "$launcher_temp"
  # --help is safe from any working directory and never launches an agent.
  "$launcher_temp" --help >/dev/null
  if [ "$use_sudo" = 1 ]; then
    sudo mkdir -p "$bin_dir"
    sudo install -m 755 "$launcher_temp" "$bin_dir/entente"
  else
    mkdir -p "$bin_dir"
    cp "$launcher_temp" "$bin_dir/.entente-$$"
    chmod 755 "$bin_dir/.entente-$$"
    mv -f "$bin_dir/.entente-$$" "$bin_dir/entente"
  fi
  say "Installed $revision → $bin_dir/entente"
  printf '\n  cd my-project\n  entente\n\n'
  say 'Log in to Claude Code or Codex before starting a live agent.'
}

# Keep the main call last so a piped script is read before interactive commands run.
main "$@"
