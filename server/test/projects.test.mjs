import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from '../src/config.js';
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

// `projects.js` loads the registry once and keeps it, so every scenario here
// needs a module that has not loaded yet. A query suffix gives one: the
// specifier differs, so Node evaluates a fresh copy of *this* module, while its
// own imports (`config.js`, `keys.js`) resolve to the instances already loaded.
// The alternative — a `resetForTests()` export — would be production API that
// exists only for the tests.
const FILE = path.join(DATA_DIR, 'projects.json');
let seq = 0;

/**
 * Loads a fresh registry over a given `projects.json`; `undefined` means the
 * file is absent, which is the shape of every board today.
 */
function withProjectsFile(contents) {
  if (contents === undefined) rmSync(FILE, { force: true });
  else writeFileSync(FILE, JSON.stringify(contents, null, 2), 'utf8');
  seq += 1;
  return import(`../src/projects.js?case=${seq}`);
}

const entry = (over = {}) => ({
  id: 'beta',
  name: 'External App B',
  repoPath: '/tmp/beta',
  worktreeRoot: '/tmp/beta-wt',
  repo: 'eterceros/app-b',
  assignee: 'eterceros',
  reviewer: 'reviewer-user',
  overrides: {},
  ...over,
});

/** Runs `fn` with `console.log` captured, and returns what it printed. */
async function capturingLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

// --- the seed --------------------------------------------------------------

test('sin projects.json el registro se siembra del config, y no escribe nada', async () => {
  const { listProjects, projectOf } = await withProjectsFile(undefined);

  const list = listProjects();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: DEFAULT_PROJECT_ID,
    name: 'hfs',
    repoPath: config.project.repoPath,
    worktreeRoot: config.project.worktreeRoot,
    repo: config.github.repo ?? null,
    assignee: config.github.assignee,
    reviewer: config.github.reviewer,
    overrides: {},
  });
  assert.deepEqual(projectOf(DEFAULT_PROJECT_ID), list[0]);

  // La siembra es en memoria: haberla leído no crea el archivo.
  assert.equal(existsSync(FILE), false, 'cargar el registro no escribe projects.json');
});

test('sin projects.json y sin checkout en el config, el registro empieza vacío y el primer import se guarda', async (t) => {
  const saved = config.project.repoPath;
  t.after(() => { config.project.repoPath = saved; rmSync(FILE, { force: true }); });
  config.project.repoPath = '';
  const { listProjects, saveProjects } = await withProjectsFile(undefined);

  assert.deepEqual(listProjects(), [], 'un hfs sin repoPath no es un proyecto: no se siembra');
  // Lo que hace el import: la lista de ahora más el nuevo. Antes fallaba con
  // `projects[0].repoPath: expected a non-empty string, not ""`.
  assert.deepEqual(saveProjects([...listProjects(), entry()]).map((p) => p.id), ['beta']);
});

test('projectOf devuelve undefined para un id que nadie registró', async () => {
  const { projectOf } = await withProjectsFile(undefined);
  assert.equal(projectOf('no-existe'), undefined);
  assert.equal(projectOf(undefined), undefined);
});

// --- configFor -------------------------------------------------------------

test('configFor aplica los overrides encima y NO muta el config global', async () => {
  const before = structuredClone(config);
  const { configFor } = await withProjectsFile([
    entry({ overrides: { limits: { defaultMaxActiveTasks: 99 }, port: 7777 } }),
  ]);

  const merged = configFor('beta');
  assert.equal(merged.limits.defaultMaxActiveTasks, 99);
  assert.equal(merged.port, 7777);
  // Lo que no se sobrescribe sigue estando.
  assert.equal(merged.github.assignee, config.github.assignee);

  assert.deepEqual(config, before, 'el config global quedó intacto');
  assert.notEqual(config.limits.defaultMaxActiveTasks, 99);
});

test('configSectionFor da lo mismo que configFor(id)[sección], y también es nuevo cada vez', async () => {
  const { configFor, configSectionFor } = await withProjectsFile([
    entry({ overrides: { limits: { defaultMaxActiveTasks: 5 }, stack: { servers: [] } } }),
    entry({ id: 'gamma', overrides: {} }),
  ]);
  for (const id of ['beta', 'gamma']) {
    for (const section of ['limits', 'stack', 'github', 'claude', 'e2e', 'noExiste']) {
      assert.deepEqual(configSectionFor(id, section), configFor(id)[section], `${id}.${section}`);
    }
  }
  const a = configSectionFor('beta', 'limits');
  a.defaultMaxActiveTasks = 1;
  assert.equal(configSectionFor('beta', 'limits').defaultMaxActiveTasks, 5, 'tocar uno no toca al siguiente');
  assert.notEqual(config.limits.defaultMaxActiveTasks, 1, 'ni al config global');
  assert.throws(() => configSectionFor('nadie', 'stack'), /no project is registered/);
});

test('dos llamadas a configFor devuelven objetos distintos, hasta en las ramas', async () => {
  const { configFor } = await withProjectsFile([entry({ overrides: { limits: { defaultMaxActiveTasks: 3 } } })]);

  const a = configFor('beta');
  const b = configFor('beta');
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.limits, b.limits, 'el clon es profundo, no superficial');
  assert.notStrictEqual(a.github, b.github);

  a.limits.defaultMaxActiveTasks = 1234;
  assert.equal(b.limits.defaultMaxActiveTasks, 3, 'tocar uno no toca al otro');
  assert.notEqual(config.limits.defaultMaxActiveTasks, 1234);
});

test('configFor lanza para un proyecto que no existe, en vez de servir el config global', async () => {
  const { configFor } = await withProjectsFile(undefined);
  assert.throws(() => configFor('fantasma'), /no project is registered as/);
});

// --- los secretos ----------------------------------------------------------

test('FORBIDDEN_OVERRIDES es la lista del contrato', async () => {
  const { FORBIDDEN_OVERRIDES } = await withProjectsFile(undefined);
  assert.equal(FORBIDDEN_OVERRIDES.length, 2);
  assert.equal(FORBIDDEN_OVERRIDES[0], 'access.token');
  assert.ok(FORBIDDEN_OVERRIDES[1] instanceof RegExp);
  assert.ok(FORBIDDEN_OVERRIDES[1].test('machines.runner-1.token'));
  assert.equal(FORBIDDEN_OVERRIDES[1].test('machines.token'), false);
});

test('assertOverridesAllowed rechaza cada forma prohibida, nombrando la ruta', async () => {
  const { assertOverridesAllowed } = await withProjectsFile(undefined);

  assert.throws(
    () => assertOverridesAllowed({ access: { token: 'secreto' } }),
    (e) => e.message === 'overrides.access.token: keys holding secrets cannot be overridden per project',
  );
  assert.throws(
    () => assertOverridesAllowed({ machines: { 'runner-1': { token: 'secreto' } } }),
    (e) => e.message === 'overrides.machines.runner-1.token: keys holding secrets cannot be overridden per project',
  );
  assert.throws(
    () => assertOverridesAllowed({ machines: { local: { token: 'x' }, 'runner-1': { host: 'x' } } }),
    /overrides\.machines\.local\.token/,
  );
  // Un objeto en la ruta prohibida tampoco pasa: la comprobación mira la rama,
  // no solo las hojas.
  assert.throws(() => assertOverridesAllowed({ access: { token: { value: 'x' } } }), /overrides\.access\.token:/);

  // Y lo vecino sí pasa.
  assert.doesNotThrow(() => assertOverridesAllowed({}));
  assert.doesNotThrow(() => assertOverridesAllowed({ access: { trustedTailscaleUsers: ['a'] } }));
  assert.doesNotThrow(() => assertOverridesAllowed({ machines: { 'runner-1': { host: 'h' } } }));
});

test('un projects.json con un secreto no se carga', async () => {
  const { listProjects } = await withProjectsFile([entry({ overrides: { access: { token: 'x' } } })]);
  assert.throws(() => listProjects(), /overrides\.access\.token:/);
});

// --- las ids ---------------------------------------------------------------

test('un id puramente numérico se rechaza: chocaría con attachments/<issue>/', async () => {
  const { listProjects } = await withProjectsFile([entry({ id: '1447' })]);
  assert.throws(() => listProjects(), /only digits/);
});

test('un id fuera de PROJECT_ID_RE se rechaza igual', async () => {
  for (const bad of ['Beta', '-beta', 'be e', '../x', '']) {
    const { listProjects } = await withProjectsFile([entry({ id: bad })]);
    assert.throws(() => listProjects(), /invalid project id/, bad);
  }
});

test('ids duplicados se rechazan', async () => {
  const { listProjects } = await withProjectsFile([entry(), entry({ name: 'Otro' })]);
  assert.throws(() => listProjects(), /duplicate project id/);
});

// --- el log ----------------------------------------------------------------

test('al cargar dice qué sobrescribe cada proyecto, por sus rutas hoja', async () => {
  const lines = await capturingLog(async () => {
    const { listProjects } = await withProjectsFile([
      entry({ overrides: { limits: { defaultMaxActiveTasks: 2 }, port: 1 } }),
      entry({ id: 'quieto', name: 'Quieto' }),
    ]);
    listProjects();
  });

  assert.deepEqual(lines, ['[projects] beta sobrescribe: limits.defaultMaxActiveTasks, port']);
});

test('la siembra por defecto no sobrescribe nada, así que no dice nada', async () => {
  const lines = await capturingLog(async () => {
    const { listProjects } = await withProjectsFile(undefined);
    listProjects();
  });
  assert.deepEqual(lines, []);
});

// --- saveProjects ----------------------------------------------------------

test('saveProjects es el único que escribe, y valida antes de escribir', async () => {
  const { saveProjects, listProjects } = await withProjectsFile(undefined);

  assert.throws(() => saveProjects([entry({ overrides: { access: { token: 'x' } } })]), /overrides\.access\.token:/);
  // Nada de eso llegó al disco: el registro sigue siendo la siembra.
  assert.deepEqual(listProjects().map((p) => p.id), [DEFAULT_PROJECT_ID]);

  const saved = await capturingLog(async () => saveProjects([entry({ overrides: { port: 1 } })]));
  assert.deepEqual(saved, ['[projects] beta sobrescribe: port']);
  assert.deepEqual(listProjects().map((p) => p.id), ['beta']);

  const onDisk = JSON.parse(readFileSync(FILE, 'utf8'));
  const { listProjects: reloaded } = await withProjectsFile(onDisk);
  assert.deepEqual(reloaded()[0], entry({ overrides: { port: 1 } }));

  rmSync(FILE, { force: true });
});

// --- la siembra sigue al config vivo ---------------------------------------

test('sin projects.json, el proyecto por defecto sigue al config en caliente', async () => {
  const { projectOf } = await withProjectsFile(undefined);
  const { config } = await import('../src/config.js');

  // El README promete que editar el assignee o el reviewer en config.json surte
  // efecto sin reiniciar, y el tablero lo perdió una vez ya con `repo`. Cachear
  // la siembra lo volvería a romper, en silencio: un registro que se congela en
  // la primera lectura deja de ser el config y pasa a ser una foto suya.
  const antes = { ...config.github };
  try {
    config.github.assignee = 'otro-usuario';
    config.github.reviewer = 'otro-revisor';
    assert.equal(projectOf(DEFAULT_PROJECT_ID).assignee, 'otro-usuario');
    assert.equal(projectOf(DEFAULT_PROJECT_ID).reviewer, 'otro-revisor');
  } finally {
    Object.assign(config.github, antes);
  }
  assert.equal(projectOf(DEFAULT_PROJECT_ID).assignee, antes.assignee);
});

// --- las secciones de comandos se reemplazan, no se fusionan ----------------

test('un proyecto que declara e2e no hereda el prepareCommand del otro', async () => {
  const { configFor, saveProjects } = await withProjectsFile(undefined);
  const { config } = await import('../src/config.js');

  // La fusión recursiva es lo correcto para un modelo o un límite, y una
  // trampa para una línea de comandos: un proyecto de Python que declarase
  // solo su `testCommand` heredaría el `cargo build --release` de hfs y el
  // tablero lo ejecutaría en un repositorio sin Cargo.toml. Falla en silencio,
  // suena plausible, y ocurre en el repositorio equivocado.
  assert.ok(config.e2e.prepareCommand, 'el config base tiene prepareCommand');

  await capturingLog(async () => saveProjects([
    entry({ id: 'beta', overrides: { e2e: { testCommand: 'pytest -q' } } }),
  ]));

  const cfg = configFor('beta');
  assert.deepEqual(cfg.e2e, { testCommand: 'pytest -q' });
  assert.equal(cfg.e2e.prepareCommand, undefined);
  assert.equal(cfg.e2e.relativeCwd, undefined);
  // Y lo que no es una sección de comandos sí se fusiona, como siempre.
  assert.equal(cfg.port, config.port);

  rmSync(FILE, { force: true });
});

// --- campos opcionales del perfil ---------------------------------------------

test('baseBranch, language, kind, settingSources y lastReviewer son opcionales y se validan', async () => {
  const { saveProjects, projectOf, baseBranchOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'plain' })]));
  assert.equal(Object.hasOwn(projectOf('plain'), 'baseBranch'), false, 'sin declarar, no aparece');
  assert.equal(baseBranchOf('plain'), 'main');
  assert.equal(baseBranchOf('no-existe'), 'main');

  await capturingLog(async () => saveProjects([entry({
    id: 'full', baseBranch: 'develop', language: 'es', kind: 'python',
    settingSources: ['project'], lastReviewer: 'ana', reviewer: null,
  })]));
  const p = projectOf('full');
  assert.equal(p.baseBranch, 'develop');
  assert.equal(p.language, 'es');
  assert.equal(p.kind, 'python');
  assert.deepEqual(p.settingSources, ['project']);
  assert.equal(p.lastReviewer, 'ana');
  assert.equal(p.reviewer, null, 'nunca cae al revisor global');
  assert.equal(baseBranchOf('full'), 'develop');

  await capturingLog(async () => saveProjects([entry({ id: 'guided', kind: 'aidlc' })]));
  assert.equal(projectOf('guided').kind, 'aidlc', 'the registry accepts the aidlc profile');

  const bad = [
    { baseBranch: '--upload-pack=x' }, { baseBranch: 'a b' }, { language: 'Español' },
    { kind: 'cobol' }, { settingSources: ['local'] }, { settingSources: 'user' },
    { settingSources: ['user', 'user'] }, { lastReviewer: '' },
  ];
  for (const over of bad) {
    assert.throws(() => saveProjects([entry(over)]), /\.(baseBranch|language|kind|settingSources|lastReviewer)/, JSON.stringify(over));
  }
  rmSync(FILE, { force: true });
});

test('rememberReviewer escribe lastReviewer por el mismo escritor y valida', async () => {
  const { saveProjects, rememberReviewer, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'beta' }), entry({ id: 'cat' })]));
  await capturingLog(async () => rememberReviewer('cat', 'zoe'));
  assert.equal(projectOf('cat').lastReviewer, 'zoe');
  assert.equal(Object.hasOwn(projectOf('beta'), 'lastReviewer'), false);
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8'))[1].lastReviewer, 'zoe');
  assert.throws(() => rememberReviewer('nadie', 'zoe'), /no project is registered as/);
  assert.throws(() => rememberReviewer('beta', ''), /lastReviewer/);
  assert.throws(() => rememberReviewer('beta', 'a b'), /login/);
  assert.throws(() => rememberReviewer('beta', '-zoe'), /login/);
  rmSync(FILE, { force: true });
});

test('setReviewer escribe reviewer por el mismo escritor y valida con LOGIN_RE', async () => {
  const { saveProjects, setReviewer, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'beta' }), entry({ id: 'cat' })]));
  await capturingLog(async () => setReviewer('cat', 'zoe'));
  assert.equal(projectOf('cat').reviewer, 'zoe');
  assert.equal(projectOf('beta').reviewer, 'reviewer-user');
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8'))[1].reviewer, 'zoe');
  assert.throws(() => setReviewer('nadie', 'zoe'), /no project is registered as/);
  assert.throws(() => setReviewer('beta', ''), /reviewer/);
  assert.throws(() => setReviewer('beta', 'a b'), /login/);
  assert.throws(() => setReviewer('beta', '-zoe'), /login/);
  rmSync(FILE, { force: true });
});

test('branchName rejects control chars, a leading slash, a double slash and a trailing dot', async () => {
  const { saveProjects } = await withProjectsFile(undefined);
  const bad = ['a\x00b', 'a\x1fb', 'a\x7fb', '/main', 'a//b', 'main.', 'a/', 'a..b', '+main', '@', '+'];
  for (const baseBranch of bad) {
    assert.throws(() => saveProjects([entry({ baseBranch })]), /baseBranch/, JSON.stringify(baseBranch));
  }
  for (const baseBranch of ['main', 'release/1.2', 'feat/x-y']) {
    await capturingLog(async () => saveProjects([entry({ baseBranch })]));
  }
  rmSync(FILE, { force: true });
});

test('an empty settingSources array is rejected', async () => {
  const { saveProjects } = await withProjectsFile(undefined);
  assert.throws(() => saveProjects([entry({ settingSources: [] })]), /settingSources/);
  rmSync(FILE, { force: true });
});

test('reviewer and lastReviewer must be GitHub logins; LOGIN_RE is exported', async () => {
  const { saveProjects, LOGIN_RE } = await withProjectsFile(undefined);
  assert.ok(LOGIN_RE.test('reviewer-user') && LOGIN_RE.test('a-b') && !LOGIN_RE.test('-a') && !LOGIN_RE.test('a'.repeat(40)));
  for (const over of [{ reviewer: 'a b' }, { reviewer: '-x' }, { reviewer: 'x'.repeat(40) }, { lastReviewer: 'a/b' }, { lastReviewer: '' }]) {
    assert.throws(() => saveProjects([entry(over)]), /\.(reviewer|lastReviewer)/, JSON.stringify(over));
  }
  await capturingLog(async () => saveProjects([entry({ reviewer: null })]));
  rmSync(FILE, { force: true });
});

test('noReviewer is an optional boolean; setReviewer clears it, setNoReviewer clears the reviewer', async () => {
  const { saveProjects, setReviewer, setNoReviewer, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'beta' }), entry({ id: 'cat', noReviewer: true, reviewer: null })]));
  assert.equal(Object.hasOwn(projectOf('beta'), 'noReviewer'), false, 'emitted only when declared');
  assert.equal(projectOf('cat').noReviewer, true);
  for (const bad of ['yes', 1, {}]) {
    assert.throws(() => saveProjects([entry({ id: 'beta', noReviewer: bad })]), /noReviewer/, JSON.stringify(bad));
  }
  await capturingLog(async () => setReviewer('cat', 'zoe'));
  assert.equal(projectOf('cat').reviewer, 'zoe');
  assert.equal(Object.hasOwn(projectOf('cat'), 'noReviewer'), false, 'a reviewer clears «sin revisor»');
  await capturingLog(async () => setNoReviewer('cat', true));
  assert.equal(projectOf('cat').noReviewer, true);
  assert.equal(projectOf('cat').reviewer, null, '«sin revisor» clears the reviewer');
  await capturingLog(async () => setNoReviewer('cat', false));
  assert.equal(Object.hasOwn(projectOf('cat'), 'noReviewer'), false);
  assert.throws(() => setNoReviewer('nadie', true), /no project is registered as/);
  assert.throws(() => setNoReviewer('beta', 'yes'), /expected true or false/);
  rmSync(FILE, { force: true });
});

test('setReviewerChoice: one write for reviewer / noReviewer / both cleared, validated first', async () => {
  const { saveProjects, setReviewerChoice, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'beta' })]));
  await capturingLog(async () => {
    assert.equal(setReviewerChoice('beta', { reviewer: 'zoe' }).reviewer, 'zoe');
    const none = setReviewerChoice('beta', { noReviewer: true });
    assert.deepEqual([none.reviewer, none.noReviewer], [null, true]);
    const back = setReviewerChoice('beta', { reviewer: 'amy', noReviewer: false });
    assert.deepEqual([back.reviewer, Object.hasOwn(back, 'noReviewer')], ['amy', false]);
    const cleared = setReviewerChoice('beta', { reviewer: null, noReviewer: false });
    assert.deepEqual([cleared.reviewer, Object.hasOwn(cleared, 'noReviewer')], [null, false]);
  });
  const before = JSON.stringify(projectOf('beta'));
  assert.throws(() => setReviewerChoice('beta', { reviewer: 'a b' }), /Invalid GitHub login/);
  assert.throws(() => setReviewerChoice('beta', { reviewer: 7 }), /reviewer/);
  assert.throws(() => setReviewerChoice('beta', { reviewer: '' }), /empty login/);
  assert.throws(() => setReviewerChoice('beta', { reviewer: '  \t', noReviewer: false }), /empty login/);
  assert.equal(projectOf('beta').reviewer ?? null, null, 'a blank login wrote nothing');
  assert.throws(() => setReviewerChoice('beta', { noReviewer: 'x' }), /noReviewer/);
  assert.throws(() => setReviewerChoice('beta', {}), /is missing/);
  assert.throws(() => setReviewerChoice('nadie', { reviewer: 'zoe' }), /no project is registered as/);
  assert.equal(JSON.stringify(projectOf('beta')), before, 'a refused choice writes nothing');
  rmSync(FILE, { force: true });
});

test('design is an optional boolean: absent when undeclared, on by default, setProjectDesign clears it at the default', async () => {
  const { saveProjects, setProjectDesign, projectDesignOf, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([
    entry({ id: 'beta' }), entry({ id: 'off', design: false }), entry({ id: 'on', design: true }),
  ]));
  assert.equal(Object.hasOwn(projectOf('beta'), 'design'), false, 'emitted only when declared');
  assert.equal(projectOf('off').design, false);
  assert.equal(projectOf('on').design, true);
  assert.deepEqual([projectDesignOf('beta'), projectDesignOf('off'), projectDesignOf('on'), projectDesignOf('nadie')], [true, false, true, true]);
  for (const bad of ['yes', 1, {}]) {
    assert.throws(() => saveProjects([entry({ id: 'beta', design: bad })]), /\.design/, JSON.stringify(bad));
  }
  let saved;
  await capturingLog(async () => { saved = setProjectDesign('beta', false); });
  assert.equal(saved.id, 'beta', 'returns the saved entry');
  assert.equal(saved.design, false);
  assert.equal(projectOf('beta').design, false);
  assert.equal(projectDesignOf('beta'), false);
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).find((p) => p.id === 'beta').design, false);
  await capturingLog(async () => setProjectDesign('beta', null));
  assert.equal(Object.hasOwn(projectOf('beta'), 'design'), false, 'null goes back to undeclared');
  await capturingLog(async () => setProjectDesign('off', true));
  assert.equal(Object.hasOwn(projectOf('off'), 'design'), false, 'the default value is not stored');
  const before = JSON.stringify(projectOf('beta'));
  assert.throws(() => setProjectDesign('beta', 'yes'), /expected true or false/);
  assert.throws(() => setProjectDesign('nadie', true), /no project is registered as/);
  assert.equal(JSON.stringify(projectOf('beta')), before, 'a refused change writes nothing');
  rmSync(FILE, { force: true });
});

test('setBaseBranch: live through the single writer, validated first, unknown project refused', async () => {
  const { saveProjects, setBaseBranch, baseBranchOf, projectOf } = await withProjectsFile(undefined);
  await capturingLog(async () => saveProjects([entry({ id: 'beta', baseBranch: 'master' })]));
  assert.equal(baseBranchOf('beta'), 'master');
  const saved = setBaseBranch('beta', 'main');
  assert.equal(saved.baseBranch, 'main');
  assert.equal(baseBranchOf('beta'), 'main', 'no reload needed');
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8'))[0].baseBranch, 'main');
  const before = JSON.stringify(projectOf('beta'));
  for (const bad of ['+main', '@', 'a..b', '-x', '', 'a b', 5]) {
    assert.throws(() => setBaseBranch('beta', bad), /baseBranch/, JSON.stringify(bad));
  }
  assert.throws(() => setBaseBranch('nadie', 'main'), /no project is registered as/);
  assert.equal(JSON.stringify(projectOf('beta')), before, 'a refused change writes nothing');
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8'))[0].baseBranch, 'main');
  rmSync(FILE, { force: true });
});

// --- restricted / removeProject ---------------------------------------------

test('restricted is stored only when true and round-trips; setProjectRestricted toggles it', async () => {
  const { setProjectRestricted, listProjects, saveProjects } = await withProjectsFile([entry(), entry({ id: 'gamma', restricted: false })]);
  assert.equal(Object.hasOwn(listProjects()[1], 'restricted'), false, 'false is not stored');
  assert.throws(() => saveProjects([entry({ restricted: 'yes' })]), /restricted: expected true or false/);

  assert.equal(setProjectRestricted('beta', true).restricted, true);
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8'))[0].restricted, true);
  const reloaded = await withProjectsFile(JSON.parse(readFileSync(FILE, 'utf8')));
  assert.equal(reloaded.projectOf('beta').restricted, true, 'survives a reload');

  const off = reloaded.setProjectRestricted('beta', false);
  assert.equal(Object.hasOwn(off, 'restricted'), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(FILE, 'utf8'))[0], 'restricted'), false);
  assert.throws(() => reloaded.setProjectRestricted('ghost', true), /ghost/);
  assert.throws(() => reloaded.setProjectRestricted('beta', 'x'), /expected true or false/);
  rmSync(FILE, { force: true });
});

test('removeProject drops only that entry, allows an empty registry and honours an explicit []', async () => {
  const { removeProject, listProjects } = await withProjectsFile([entry(), entry({ id: 'gamma' })]);
  removeProject('beta');
  assert.deepEqual(listProjects().map((p) => p.id), ['gamma']);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')).map((p) => p.id), ['gamma']);
  assert.throws(() => removeProject('beta'), /beta/);

  removeProject('gamma');
  assert.deepEqual(listProjects(), []);
  assert.equal(readFileSync(FILE, 'utf8').trim(), '[]');
  const fresh = await withProjectsFile([]);
  assert.deepEqual(fresh.listProjects(), [], 'an explicit empty file does not fall back to the seed');
  rmSync(FILE, { force: true });
});

test('removing the seed (no projects.json) persists an empty list instead of re-seeding', async () => {
  const { removeProject, listProjects } = await withProjectsFile(undefined);
  removeProject(DEFAULT_PROJECT_ID);
  assert.deepEqual(listProjects(), []);
  assert.equal(readFileSync(FILE, 'utf8').trim(), '[]');
  rmSync(FILE, { force: true });
});

test('a removed project can be added again under the same id', async () => {
  const { removeProject, saveProjects, listProjects } = await withProjectsFile([entry(), entry({ id: 'gamma' })]);
  removeProject('beta');
  saveProjects([...listProjects(), entry()]);
  assert.deepEqual(listProjects().map((p) => p.id), ['gamma', 'beta']);
  rmSync(FILE, { force: true });
});
