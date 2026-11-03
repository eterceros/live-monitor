import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { config } from '../src/config.js';
import { saveProjects } from '../src/projects.js';
import { machineFor, machineHostsProject, declaredProject, registerRunnerClient } from '../src/machine.js';
import { RunnerMachine } from '../src/runner-client.js';

const saved = config.machines;
after(() => {
  if (saved === undefined) delete config.machines; else config.machines = saved;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
});

const base = { kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y' };

/** Runners whose user home is known, as if `/info` had already answered. */
const homes = { devbox: '/home/zoe', other: '/Users/ana' };
function useRunners() {
  registerRunnerClient((name, spec) => {
    const m = new RunnerMachine(name, spec);
    m.home = homes[name] ?? null;
    return m;
  });
}

function seedProjects() {
  const who = { assignee: 'a', reviewer: 'r' };
  saveProjects([
    { id: 'hfs', name: 'hfs', ...who, repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot },
    { id: 'ehr', name: 'EHR', ...who, repo: 'eterceros/EHR', repoPath: String.raw`C:\Users\edson\src\EHR`, worktreeRoot: String.raw`C:\Users\edson\src\EHR-wt` },
    { id: 'mp', name: 'MP', ...who, repo: 'EUPG-UMSS/MPSIA_TPOS_ACADEMIASYS', repoPath: 'C:/Users/edson/src/umss/MPSIA-TPOS-ACADEMIASYS', worktreeRoot: 'C:/Users/edson/src/umss/MPSIA-wt' },
  ]);
}

test('sin configurar nada, cada runner usa ~/src de SU usuario, con la carpeta local del proyecto y no el nombre del repo', () => {
  seedProjects();
  config.machines = { devbox: { ...base }, other: { ...base } };
  useRunners();

  assert.deepEqual(declaredProject('devbox', 'ehr'), { repoPath: '/home/zoe/src/EHR', worktreeRoot: '/home/zoe/src/EHR-wt' });
  assert.deepEqual(declaredProject('other', 'ehr'), { repoPath: '/Users/ana/src/EHR', worktreeRoot: '/Users/ana/src/EHR-wt' });
  assert.deepEqual(declaredProject('devbox', 'mp'), { repoPath: '/home/zoe/src/MPSIA-TPOS-ACADEMIASYS', worktreeRoot: '/home/zoe/src/MPSIA-TPOS-ACADEMIASYS-wt' });
  assert.equal(declaredProject('devbox', 'no-existe'), null);
  assert.equal(machineHostsProject('devbox', 'ehr'), true);
  assert.equal(machineFor('devbox', 'ehr').repoPath, '/home/zoe/src/EHR');
  assert.equal(machineFor('devbox', 'hfs').repoPath, '/x');
});

test('projectsRoot puede ser absoluto o llevar ~, y false apaga la convención', () => {
  seedProjects();
  config.machines = {
    devbox: { ...base, projectsRoot: '~/code/' },
    other: { ...base, projectsRoot: '/srv/repos' },
  };
  useRunners();
  assert.equal(declaredProject('devbox', 'ehr').repoPath, '/home/zoe/code/EHR');
  assert.equal(declaredProject('other', 'ehr').repoPath, '/srv/repos/EHR');

  config.machines = { devbox: { ...base, projectsRoot: false } };
  assert.equal(declaredProject('devbox', 'ehr'), null);
  assert.equal(machineHostsProject('devbox', 'ehr'), false);
  assert.throws(() => machineFor('devbox', 'ehr'), /not declared on machine "devbox"/);
});

test('una entrada explícita en projects gana sobre la convención', () => {
  seedProjects();
  config.machines = { devbox: { ...base, projects: { ehr: { repoPath: '/srv/ehr', worktreeRoot: '/srv/ehr-wt' } } } };
  useRunners();
  assert.deepEqual(declaredProject('devbox', 'ehr'), { repoPath: '/srv/ehr', worktreeRoot: '/srv/ehr-wt' });
  assert.equal(declaredProject('devbox', 'mp').repoPath, '/home/zoe/src/MPSIA-TPOS-ACADEMIASYS');
});

test('mientras el runner no ha dicho su home no hay ruta con ~, y info() lo aprende', async () => {
  seedProjects();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ home: '/home/learned', platform: 'linux' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    config.machines = { devbox: { ...base, url: `http://127.0.0.1:${server.address().port}` } };
    registerRunnerClient((name, spec) => new RunnerMachine(name, spec));
    assert.equal(declaredProject('devbox', 'ehr'), null);
    assert.throws(() => machineFor('devbox', 'ehr'), /not declared on machine/);

    await machineFor('devbox', 'hfs').info();
    assert.equal(declaredProject('devbox', 'ehr').repoPath, '/home/learned/src/EHR');
    assert.equal(machineFor('devbox', 'ehr').repoPath, '/home/learned/src/EHR');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
