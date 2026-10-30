import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { globToRegExp, hasScopes, planScopes, describePlan } = await import('../src/testscope.js');
const { settings } = await import('../src/settings.js');
const { store } = await import('../src/store.js');
const { fullTestsWanted } = await import('../src/pipeline.js');

const e2e = {
  ignore: ['**/*.md', 'docs/**'],
  scopes: [
    {
      name: 'ui-e2e', paths: ['crates/ui/**', 'locales/**'], browser: true, cwd: 'crates/ui/e2e',
      prepareCommand: 'cargo build --release', command: 'npm test -- --only-changed=origin/{base}',
    },
    {
      name: 'rust', paths: ['crates/**/*.rs', 'crates/**/Cargo.toml'], crates: '^crates/([^/]+)/',
      cratePrefix: 'helios-', crateOf: { pysof: 'pysof' }, command: 'cargo test {crates}',
    },
  ],
};

test('globs: * se queda en la carpeta y ** la cruza', () => {
  assert.ok(globToRegExp('crates/**/*.rs').test('crates/ui/src/lib.rs'));
  assert.ok(globToRegExp('crates/**/*.rs').test('crates/x.rs'));
  assert.ok(globToRegExp('crates/*/lib.rs').test('crates/a/b/lib.rs') === false);
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('*.md').test('docs/a.md') === false);
  assert.ok(globToRegExp('a.b').test('axb') === false);
});

test('sin scopes configurados no hay plan acotado', () => {
  assert.equal(hasScopes({}), false);
  assert.equal(hasScopes({ scopes: [] }), false);
  assert.equal(hasScopes(e2e), true);
});

test('un cambio en un crate corre solo ese crate, sin navegador', () => {
  const plan = planScopes(e2e, ['crates/persistence/src/lib.rs'], { base: 'main' });
  assert.deepEqual(plan.covered, ['rust']);
  assert.equal(plan.runs[0].command, 'cargo test -p helios-persistence');
  assert.equal(plan.runs[0].browser, false);
});

test('varios crates y la UI: un -p por crate y el e2e con la base', () => {
  const plan = planScopes(e2e, ['crates/ui/src/a.rs', 'crates/sof/src/b.rs', 'crates/sof/Cargo.toml', 'crates/pysof/src/c.rs'], { base: 'develop' });
  assert.deepEqual(plan.covered, ['ui-e2e', 'rust']);
  assert.equal(plan.runs[0].command, 'npm test -- --only-changed=origin/develop');
  assert.equal(plan.runs[0].browser, true);
  assert.equal(plan.runs[1].command, 'cargo test -p helios-ui -p helios-sof -p pysof');
});

test('docs no necesitan test y lo no cubierto se deja a CI: nunca la suite completa', () => {
  const plan = planScopes(e2e, ['README.md', 'docs/a.txt', 'Cargo.lock'], {});
  assert.deepEqual(plan.runs, []);
  assert.deepEqual(plan.ignored, ['README.md', 'docs/a.txt']);
  assert.deepEqual(plan.unmatched, ['Cargo.lock']);
  assert.match(describePlan(plan), /nothing to run/);
});

test('un diff vacío no planea nada', () => {
  assert.deepEqual(planScopes(e2e, []).runs, []);
});

test('fullTests: apagado de serie, la tarjata nace del proyecto y auto sigue al tablero', () => {
  assert.equal(settings.fullTests, false);
  assert.equal(settings.fullTestsFor('p'), false);
  assert.equal(fullTestsWanted({ fullTests: 'on', project: 'p' }), true);
  assert.equal(fullTestsWanted({ fullTests: 'off', project: 'p' }), false);
  assert.equal(fullTestsWanted({ fullTests: 'auto', project: 'p' }), false);
  settings.updateProject('p', { fullTests: true });
  assert.equal(fullTestsWanted({ fullTests: 'auto', project: 'p' }), true);
  assert.equal(fullTestsWanted({ fullTests: 'off', project: 'p' }), false);
  settings.updateProject('p', { fullTests: null });
  assert.equal(settings.fullTestsFor('p'), false);
  assert.ok(store);
});

test('config.example.hfs.json: clippy corre antes que los tests y solo de los crates tocados', async () => {
  const { readFileSync } = await import('node:fs');
  const example = JSON.parse(readFileSync(new URL('../../config.example.hfs.json', import.meta.url), 'utf8')).e2e;
  const plan = planScopes(example, ['crates/persistence/src/lib.rs', 'crates/sof/Cargo.toml'], { base: 'main' });
  assert.deepEqual(plan.covered, ['rust-clippy', 'rust'], 'clippy primero: si hay avisos falla antes de gastar tiempo en los tests');
  assert.match(plan.runs[0].command, /^cargo clippy -p helios-persistence -p helios-sof --all-targets --all-features -- -D warnings /);
  assert.match(plan.runs[0].command, /-A clippy::doc-lazy-continuation$/, 'lleva la lista de permitidos de CONTRIBUTING.md completa');
  assert.equal(plan.runs[1].command, 'cargo test -p helios-persistence -p helios-sof');
  assert.ok(plan.runs.every((r) => r.browser === false), 'ninguno necesita navegador');
  assert.deepEqual(planScopes(example, ['README.md'], {}).runs, [], 'sin Rust tocado no corre ni clippy');
});
