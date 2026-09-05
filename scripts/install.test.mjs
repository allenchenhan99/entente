import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const write = (file, text) => { fs.writeFileSync(file, text, { mode: 0o755 }); };

function fixture(t, { fail = false, brokenSmoke = false } = {}) {
  // macOS temp paths can start with /var, while cwd/pwd -P resolve /private/var.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "entente install's ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const tools = path.join(root, 'tools');
  const app = path.join(root, 'app');
  const project = path.join(root, 'my project');
  for (const dir of [bin, tools, project]) fs.mkdirSync(dir);
  const log = path.join(root, 'calls');
  write(path.join(tools, 'git'), `#!/bin/sh
if [ "$1" = clone ]; then
  for dest; do :; done
  mkdir -p "$dest/bin"
  cat > "$dest/bin/entente.mjs" <<'JS'
${brokenSmoke ? 'process.exit(7);' : 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));'}
JS
elif [ "$3" = rev-parse ]; then printf '0123456789012345678901234567890123456789\\n';
else exit 93; fi
`);
  write(path.join(tools, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*" >> ${quote(log)}
${fail ? 'exit 42' : 'exit 0'}
`);
  write(path.join(tools, 'cargo'), `#!/bin/sh
printf 'cargo %s\\n' "$*" >> ${quote(log)}
mkdir -p "$CARGO_TARGET_DIR/release"
printf '#!/bin/sh\\nexit 0\\n' > "$CARGO_TARGET_DIR/release/termd"
cp "$CARGO_TARGET_DIR/release/termd" "$CARGO_TARGET_DIR/release/relay-tui"
chmod 755 "$CARGO_TARGET_DIR/release/termd" "$CARGO_TARGET_DIR/release/relay-tui"
exit 0
`);
  // Tests never download a toolchain or invoke a model; unexpected network fails.
  write(path.join(tools, 'curl'), '#!/bin/sh\necho "Unexpected network" >&2\nexit 99\n');
  const env = { ...process.env, HOME: root, PATH: `${tools}:${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, ENTENTE_INSTALL_DIR: app, ENTENTE_BIN_DIR: bin };
  const install = args => spawnSync('sh', [installer, ...(args ?? [])], { cwd: project, env, encoding: 'utf8' });
  return { root, bin, tools, app, project, log, env, install };
}

test('installs a command usable from another project; preserves arguments and builds native by default', t => {
  const f = fixture(t);
  const result = f.install();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const launched = spawnSync('entente', ['--repo', 'nested path', '--port', '8123'], { cwd: f.project, env: f.env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), { cwd: f.project, args: ['--repo', 'nested path', '--port', '8123'] });
  assert.match(fs.readFileSync(f.log, 'utf8'), /cargo build --release --locked -p termd -p relay-tui/);
  assert.deepEqual(fs.readdirSync(f.project), []);
  assert.ok(!fs.existsSync(path.join(f.app, '.install-lock')));
});

test('an unsuccessful update preserves the installed command and release', t => {
  const f = fixture(t);
  assert.equal(f.install().status, 0);
  const command = path.join(f.bin, 'entente');
  const before = fs.readFileSync(command, 'utf8');
  const releases = fs.readdirSync(path.join(f.app, 'releases'));
  write(path.join(f.tools, 'npm'), '#!/bin/sh\nexit 42\n');
  assert.notEqual(f.install().status, 0);
  assert.equal(fs.readFileSync(command, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(f.app, 'releases')), releases);
  assert.ok(!fs.readdirSync(f.app).some(name => name.startsWith('.stage.')));
});

test('rejects a broken build before installing a command', t => {
  const f = fixture(t, { brokenSmoke: true });
  assert.notEqual(f.install().status, 0);
  assert.ok(!fs.existsSync(path.join(f.bin, 'entente')));
});

test('does not replace an unrelated command or use a populated application directory', t => {
  const f = fixture(t);
  write(path.join(f.bin, 'entente'), '#!/bin/sh\necho another tool\n');
  assert.match(f.install().stderr, /unrelated command/);
  assert.match(fs.readFileSync(path.join(f.bin, 'entente'), 'utf8'), /another tool/);
  const another = path.join(f.root, 'existing project');
  fs.mkdirSync(another); fs.writeFileSync(path.join(another, 'important.txt'), 'keep');
  const result = spawnSync('sh', [installer], { env: { ...f.env, ENTENTE_INSTALL_DIR: another }, encoding: 'utf8' });
  assert.match(result.stderr, /unmanaged directory/);
  assert.equal(fs.readFileSync(path.join(another, 'important.txt'), 'utf8'), 'keep');
});

test('requires the chosen command directory on PATH rather than claiming immediate usability', t => {
  const f = fixture(t);
  const result = spawnSync('sh', [installer], { env: { ...f.env, ENTENTE_BIN_DIR: path.join(f.root, 'not on path') }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PATH before installing/);
});

test('--no-native is explicit and skips the Rust build', t => {
  const f = fixture(t);
  assert.equal(f.install(['--no-native']).status, 0);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /cargo/);
});

test('unknown options fail before creating any installation files', t => {
  const f = fixture(t);
  assert.notEqual(f.install(['--wat']).status, 0);
  assert.ok(!fs.existsSync(f.app));
});

test('a piped installer uses the default application directory and an existing user PATH directory', t => {
  const f = fixture(t);
  const env = { ...f.env, PATH: `${f.bin}:${f.env.PATH}` };
  delete env.ENTENTE_INSTALL_DIR;
  delete env.ENTENTE_BIN_DIR;
  const result = spawnSync('sh', [], { cwd: f.project, env, input: fs.readFileSync(installer, 'utf8'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(f.root, '.local/share/entente/releases')));
  const launched = spawnSync('entente', [], { cwd: f.project, env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), { cwd: f.project, args: [] });
  assert.ok(!fs.existsSync(path.join(f.root, '.profile')));
});

test('does not remove another installation lock', t => {
  const f = fixture(t);
  fs.mkdirSync(f.app);
  fs.writeFileSync(path.join(f.app, '.entente-install'), '');
  fs.mkdirSync(path.join(f.app, '.install-lock'));
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another installation is running/);
  assert.ok(fs.existsSync(path.join(f.app, '.install-lock')));
  assert.ok(!fs.existsSync(path.join(f.bin, 'entente')));
});

test('does not silently install without native binaries after an incomplete native build', t => {
  const f = fixture(t);
  write(path.join(f.tools, 'cargo'), '#!/bin/sh\nexit 0\n');
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native build did not produce both terminal binaries/);
  assert.ok(!fs.existsSync(path.join(f.bin, 'entente')));
});

function fakeNodeDownload(f, checksumValid = true) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const name = `node-v22.0.0-${platform}-${process.arch}`;
  const download = path.join(f.root, 'download');
  const bundle = path.join(download, name, 'bin');
  fs.mkdirSync(bundle, { recursive: true });
  write(path.join(bundle, 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`);
  fs.copyFileSync(path.join(f.tools, 'npm'), path.join(bundle, 'npm'));
  fs.chmodSync(path.join(bundle, 'npm'), 0o755);
  const archive = path.join(f.root, `${name}.tar.gz`);
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', download, name]).status, 0);
  const checksum = path.join(f.root, 'SHASUMS256.txt');
  fs.writeFileSync(checksum, `${checksumValid ? createHash('sha256').update(fs.readFileSync(archive)).digest('hex') : '0'.repeat(64)}  ${name}.tar.gz\n`);
  write(path.join(f.tools, 'node'), '#!/bin/sh\nexit 1\n');
  write(path.join(f.tools, 'curl'), `#!/bin/sh
for dest; do :; done
case "$*" in
  *SHASUMS256.txt*) cp ${quote(checksum)} "$dest" ;;
  *${name}.tar.gz*) cp ${quote(archive)} "$dest" ;;
  *) echo 'Unexpected network' >&2; exit 99 ;;
esac
`);
}

test('a missing/old Node gets a verified private runtime that survives installation relocation', t => {
  const f = fixture(t); fakeNodeDownload(f);
  const result = f.install(['--no-native']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const launched = spawnSync('entente', ['--help'], { cwd: f.project, env: f.env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(JSON.parse(launched.stdout).cwd, f.project);
  assert.match(fs.readFileSync(path.join(f.bin, 'entente'), 'utf8'), /\.runtime\/node\/bin\/node/);
});

test('a Node checksum mismatch fails before executing the downloaded runtime', t => {
  const f = fixture(t); fakeNodeDownload(f, false);
  const result = f.install(['--no-native']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.ok(!fs.existsSync(path.join(f.bin, 'entente')));
  assert.ok(!fs.existsSync(f.log));
});

test('bootstraps missing Rust privately without modifying shell profiles', t => {
  const f = fixture(t);
  const cargoSource = path.join(f.root, 'fake-cargo');
  fs.renameSync(path.join(f.tools, 'cargo'), cargoSource);
  const bootstrap = path.join(f.root, 'rustup-init.sh');
  write(bootstrap, `#!/bin/sh
printf 'rustup %s\\n' "$*" >> ${quote(f.log)}
printf 'cargo-home %s\\n' "$CARGO_HOME" >> ${quote(f.log)}
printf 'rustup-home %s\\n' "$RUSTUP_HOME" >> ${quote(f.log)}
mkdir -p "$CARGO_HOME/bin"
cp ${quote(cargoSource)} "$CARGO_HOME/bin/cargo"
chmod 755 "$CARGO_HOME/bin/cargo"
`);
  write(path.join(f.tools, 'curl'), `#!/bin/sh
for dest; do :; done
case "$*" in *https://sh.rustup.rs*) cp ${quote(bootstrap)} "$dest" ;; *) exit 99 ;; esac
`);
  const result = f.install();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = fs.readFileSync(f.log, 'utf8');
  assert.match(log, /rustup -y --profile minimal --no-modify-path/);
  assert.ok(log.includes(`cargo-home ${f.app}/toolchain/cargo`));
  assert.ok(log.includes(`rustup-home ${f.app}/toolchain/rustup`));
});
