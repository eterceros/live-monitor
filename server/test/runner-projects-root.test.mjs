import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

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

test('projectsRoot deduce las rutas del runner desde la carpeta local del proyecto, no desde el nombre del repo', () => {
  saveProjects([
    { id: 'hfs', name: 'hfs', assignee: 'a', reviewer: 'r', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot },
    { id: 'ehr', name: 'EHR', assignee: 'a', reviewer: 'r', repo: 'eterceros/EHR', repoPath: String.raw`C:\Users\edson\src\EHR`, worktreeRoot: String.raw`C:\Users\edson\src\EHR-wt` },
    { id: 'mp', name: 'MP', assignee: 'a', reviewer: 'r', repo: 'EUPG-UMSS/MPSIA_TPOS_ACADEMIASYS', repoPath: 'C:/Users/edson/src/umss/MPSIA-TPOS-ACADEMIASYS', worktreeRoot: 'C:/Users/edson/src/umss/MPSIA-wt' },
  ]);
  config.machines = { devbox: { ...base, projectsRoot: '/home/edson/src/' } };
  registerRunnerClient((name, spec) => new RunnerMachine(name, spec));

  assert.deepEqual(declaredProject('devbox', 'ehr'), { repoPath: '/home/edson/src/EHR', worktreeRoot: '/home/edson/src/EHR-wt' });
  assert.deepEqual(declaredProject('devbox', 'mp'), { repoPath: '/home/edson/src/MPSIA-TPOS-ACADEMIASYS', worktreeRoot: '/home/edson/src/MPSIA-TPOS-ACADEMIASYS-wt' });
  assert.equal(declaredProject('devbox', 'no-existe'), null);
  assert.equal(machineHostsProject('devbox', 'ehr'), true);
  assert.equal(machineFor('devbox', 'ehr').repoPath, '/home/edson/src/EHR');
  assert.equal(machineFor('devbox', 'hfs').repoPath, '/x');
});

test('una entrada explícita en projects gana sobre la convención, y sin projectsRoot no hay deducción', () => {
  config.machines = {
    devbox: { ...base, projectsRoot: '/home/edson/src', projects: { ehr: { repoPath: '/srv/ehr', worktreeRoot: '/srv/ehr-wt' } } },
    plain: { ...base },
  };
  assert.deepEqual(declaredProject('devbox', 'ehr'), { repoPath: '/srv/ehr', worktreeRoot: '/srv/ehr-wt' });
  assert.equal(declaredProject('plain', 'ehr'), null);
  assert.equal(machineHostsProject('plain', 'ehr'), false);
  assert.throws(() => machineFor('plain', 'ehr'), /projectsRoot/);
});
