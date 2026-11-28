// `remote/bootstrap.sh`: a box where gh is logged in but plain git cannot use
// that login. The function is run as the script writes it, with the real git
// against a home of its own and a stand-in for gh. The rest of the script
// (sudo, systemd, the network) is not run.
import './isolate.mjs';   // first: isolates the data directory
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tempDir } from './teardown.mjs';

const script = readFileSync(fileURLToPath(new URL('../../remote/bootstrap.sh', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const skip = process.platform === 'win32' ? 'bootstrap.sh runs on the Linux runners' : false;

/** The text of one function of the script: from its name to the closing brace at column 0. */
function shellFunction(name) {
  const found = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(found, `bootstrap.sh defines ${name}`);
  return found[0];
}

/** Runs `git_github_login` where gh is `gh` (a shell script body); nothing of this machine's git setup is seen. */
function runLogin(gh, env = {}) {
  const root = tempDir('hfsmon-boot-');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const program = [
    'set -euo pipefail',
    'ok() { echo "OK $*"; }',
    'die() { echo "DIE $*" >&2; exit 1; }',
    shellFunction('git_github_login'),
    'git_github_login',
  ].join('\n');
  const r = spawnSync('bash', ['-c', program], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  return { ...r, home };
}

/** gh with a login: `setup-git` registers it as git's helper, which answers with `token` (shell text). */
const ghWithLogin = (token) => `
if [ "$2" = setup-git ]; then
  git config --global credential.https://github.com.helper "!'$0' auth git-credential"
elif [ "$2" = git-credential ] && [ "$3" = get ]; then
  t="${token}"
  if [ -n "$t" ]; then printf 'username=u\\npassword=%s\\n' "$t"; fi
fi`;

test('git is set up to use the gh login, and asked for a credential to prove it', { skip }, () => {
  const r = runLogin(ghWithLogin('stored-token'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK git uses the gh login/);
  assert.ok(existsSync(path.join(r.home, '.gitconfig')), 'the helper stays configured');
  const helper = execFileSync('git', ['config', '--file', path.join(r.home, '.gitconfig'), 'credential.https://github.com.helper'], { encoding: 'utf8' });
  assert.match(helper, /auth git-credential/);
});

test('a setup that leaves git without a credential stops the script and says what to do', { skip }, () => {
  const r = runLogin('exit 0');   // gh says yes to everything and configures nothing
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DIE git cannot use the gh login.*gh auth login/);
  const failed = runLogin('exit 4');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /DIE 'gh auth setup-git' failed/);
});

test('a token that lives only in this shell does not count: the runner service has none', { skip }, () => {
  const r = runLogin(ghWithLogin('$GH_TOKEN'), { GH_TOKEN: 'shell-only' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GH_TOKEN does not reach the runner service/);
});

test('both stages that need it call it: the runner one, and an https project on its own', { skip }, () => {
  assert.match(shellFunction('stage_runner'), /gh auth status[^\n]*\n\s*git_github_login\n/);
  assert.match(shellFunction('stage_project'), /https:\/\/github\.com\/\* \]\] \|\| git_github_login/);
});
