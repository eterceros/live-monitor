import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './isolate.mjs';
import { tempDir } from './teardown.mjs';

// The production window is 3 s; the tests drive the writes by hand.
process.env.HFSMON_PERSIST_DELAY_MS = '60000';
process.env.HFSMON_SWEEP_INTERVAL_MS = '0';
const { store } = await import('../src/store.js');
const { writeChunksAtomic, writeAtomicSync, objectChunks, SerCache } = await import('../src/persistcache.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DATA_DIR, 'tasks.json');
const onDisk = () => JSON.parse(readFileSync(FILE, 'utf8'));
/** What memory says the file must hold: the same JSON round trip the writer does. */
const inMemory = () => Object.fromEntries(Object.values(store.tasks)
  .filter((t) => t.project === 'hfs').map((t) => [t.issue, JSON.parse(JSON.stringify(t))]));
after(() => store.flush());

const issue = (n) => ({ number: n, title: `prueba ${n}`, labels: [], url: 'x', closed: false });

/** A store with some weight: logs and chats like the real ones, only smaller. */
function seed(count, lines, msgs) {
  for (let n = 1; n <= count; n++) {
    const t = store.addTask(issue(n), 'hfs');
    for (let i = 0; i < lines; i++) store.addLog(t, 'tool', `línea ${i} de la tarea ${n} ${'x'.repeat(80)}`);
    for (let i = 0; i < msgs; i++) store.addChat(t, null, i % 2 ? 'assistant' : 'user', `mensaje ${i} ñandú 🔧 ${'y'.repeat(600)}`);
  }
  store.flush();
}
seed(25, 400, 120);

/** Runs persist-child.mjs on `dir`. */
function runChild(dir, mode, { onLine } = {}) {
  const child = spawn(process.execPath, [path.join(HERE, 'persist-child.mjs'), mode], {
    env: { ...process.env, HFSMON_DATA_DIR: dir, HFSMON_PERSIST_DELAY_MS: '5', HFSMON_SWEEP_INTERVAL_MS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; onLine?.(child, buf); });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out: buf })));
}

test('ida y vuelta: cargar -> mutar -> flush -> cargar da lo mismo que memoria', async () => {
  assert.deepEqual(onDisk(), inMemory(), 'el archivo sembrado coincide con memoria');

  const t3 = store.get(3);
  store.addLog(t3, 'estado', 'cambio uno');
  store.addChat(t3, null, 'user', 'otro mensaje');
  store.get(7).title = 'título nuevo';
  store.touch(store.get(7));
  store.setState(store.get(9), 'error', { error: 'a propósito' });
  await store.flushAsync();
  assert.deepEqual(onDisk(), inMemory(), 'camino asíncrono (caché por tarea)');

  store.addLog(store.get(11), 'estado', 'y por el camino de salida');
  store.flush();
  assert.deepEqual(onDisk(), inMemory(), 'camino síncrono');

  // Un proceso nuevo que carga ese archivo y lo reescribe: el arranque añade
  // los campos que le faltan a una tarea (migrateTask) y nada más. Log y chats
  // quedan idénticos, y un segundo arranque ya no cambia nada.
  const dir = tempDir('hfsmon-persist-rt-');
  const copy = path.join(dir, 'tasks.json');
  copyFileSync(FILE, copy);
  assert.equal((await runChild(dir, 'boot')).code, 0);
  const boot1 = JSON.parse(readFileSync(copy, 'utf8'));
  const orig = onDisk();
  assert.deepEqual(Object.keys(boot1), Object.keys(orig));
  for (const [k, t] of Object.entries(orig)) {
    assert.deepEqual(boot1[k].log, t.log, `log de ${k}`);
    // The boot may add fields to a chat (migrateChat); its messages are untouched.
    assert.deepEqual(boot1[k].chats.map((c) => [c.id, c.messages]), t.chats.map((c) => [c.id, c.messages]), `chats de ${k}`);
    for (const [f, v] of Object.entries(t)) if (f !== 'log' && f !== 'chats') assert.deepEqual(boot1[k][f], v, `${f} de ${k}`);
  }
  assert.equal((await runChild(dir, 'boot')).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(copy, 'utf8')), boot1, 'segundo arranque: punto fijo');
});

test('el texto de la caché es el de JSON.stringify del objeto entero', () => {
  const cache = new SerCache();
  const a = { x: 1, s: 'ñ"\n', n: [1, { y: null }] };
  const b = { z: [] };
  const entries = [['b', a], ['a', b], ['k', { u: undefined, v: 1 }]];
  const text = objectChunks(cache, entries).join('');
  assert.equal(text, JSON.stringify(Object.fromEntries(entries)));
});

test('una mutación que NO pasa por persist(task) acaba guardada igualmente', async () => {
  const t = store.get(5);
  await store.flushAsync();
  // 1. Mutación silenciosa: nadie avisa. Otra tarea sí avisa, y el archivo se reescribe con la caché.
  t.title = 'sin avisar';
  t.log.push({ ts: 'x', phase: 'silencio', line: 'push directo' });
  store.touch(store.get(6));
  await store.flushAsync();
  assert.notEqual(onDisk()['5'].title, 'sin avisar', 'documentado: la caché no la ve todavía');

  // 2. El barrido la encuentra, avisa y la marca sucia.
  const moved = await store.sweep();
  assert.deepEqual(moved, ['hfs#5']);
  await store.flushAsync();
  assert.equal(onDisk()['5'].title, 'sin avisar');
  assert.equal(onDisk()['5'].log.at(-1).phase, 'silencio');
  assert.deepEqual(onDisk(), inMemory());

  // 3. La salida (flush síncrono) la guarda aunque ningún proyecto esté marcado sucio.
  t.title = 'sin avisar, otra vez';
  store.flush();
  assert.equal(onDisk()['5'].title, 'sin avisar, otra vez');

  // 4. persist() sin tarea invalida todo.
  t.title = 'tercera';
  store.persist();
  await store.flushAsync();
  assert.equal(onDisk()['5'].title, 'tercera');
  assert.deepEqual(onDisk(), inMemory());
});

test('ráfaga de 1000 addLog+touch mientras se escribe: el disco acaba igual que la memoria', async () => {
  const tasks = Object.values(store.tasks);
  for (const t of tasks) store.touch(t);            // todo sucio: la escritura será larga
  const writing = store.flushAsync();
  let n = 0;
  while (n < 1000) {
    for (let i = 0; i < 25; i++, n++) {
      const t = tasks[n % tasks.length];
      store.addLog(t, 'tool', `ráfaga ${n}`);
      store.touch(t);
    }
    await new Promise((r) => setImmediate(r));       // deja avanzar la escritura a medias
  }
  await writing;
  await store.flushAsync();                          // lo que cayó durante la escritura
  assert.deepEqual(onDisk(), inMemory(), 'por el camino asíncrono, sin flush síncrono de rescate');
  assert.equal(store.get(1).log.at(-1).line.startsWith('ráfaga'), true);
});

test('un flush síncrono durante una escritura asíncrona gana: el texto viejo no lo pisa', async () => {
  const t = store.get(2);
  store.touch(t);
  const writing = store.flushAsync();               // instantánea vieja en vuelo
  store.addLog(t, 'estado', 'más nuevo que la instantánea');
  store.flush();                                    // salida: escribe lo nuevo
  await writing;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(onDisk()['2'].log.at(-1).line, 'más nuevo que la instantánea');
  assert.deepEqual(onDisk(), inMemory());
});

test('writeChunksAtomic: un fallo o un descarte deja intacto el archivo y sin temporal', async () => {
  const f = path.join(tempDir('hfsmon-persist-aw-'), 'x.json');
  writeFileSync(f, '{"old":true}');
  assert.equal(await writeChunksAtomic(f, ['{"new"', ':1}'], () => false), false);
  assert.equal(readFileSync(f, 'utf8'), '{"old":true}');
  assert.equal(existsSync(`${f}.tmp`), false);
  assert.equal(await writeChunksAtomic(f, ['{"new"', ':1}']), true);
  assert.equal(readFileSync(f, 'utf8'), '{"new":1}');
  writeAtomicSync(f, ['{"s":', '2}']);
  assert.equal(readFileSync(f, 'utf8'), '{"s":2}');
  assert.equal(existsSync(`${f}.tmp-s`), false);
  // Destino imposible (un directorio): lanza, y el temporal no se queda.
  const dirTarget = path.join(path.dirname(f), 'es-un-dir');
  mkdirSync(dirTarget);
  await assert.rejects(() => writeChunksAtomic(dirTarget, ['{}']));
  assert.equal(existsSync(`${dirTarget}.tmp`), false);
});

test('apagado en mitad de escritura (kill -9): el archivo nunca queda truncado ni corrupto', async () => {
  const names = readdirSync(DATA_DIR).filter((n) => /^tasks.*\.json$/.test(n));
  const expectedIssues = Object.keys(onDisk()).length;
  let killedMidWrite = 0;
  const ROUNDS = 12;
  for (let round = 0; round < ROUNDS; round++) {
    const dir = tempDir('hfsmon-persist-kill-');
    for (const n of names) copyFileSync(path.join(DATA_DIR, n), path.join(dir, n));
    const tmp = path.join(dir, 'tasks.json.tmp');
    let started = false;
    await runChild(dir, 'hammer', {
      onLine: (child, buf) => {
        if (started || !buf.includes('ready')) return;
        started = true;
        // Hunt for the moment a temp file is being written, then kill that instant.
        const hunt = setInterval(() => {
          let size = -1;
          try { size = statSync(tmp).size; } catch { /* not there */ }
          if (size > 0) { clearInterval(hunt); clearTimeout(giveUp); killedMidWrite += 1; child.kill('SIGKILL'); }
        }, 1);
        const giveUp = setTimeout(() => { clearInterval(hunt); child.kill('SIGKILL'); }, 1500);
      },
    });
    // Whatever the moment: the real file is a whole, parseable JSON with every task.
    const parsed = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
    assert.equal(Object.keys(parsed).length, expectedIssues, `ronda ${round}: faltan tareas`);
    for (const t of Object.values(parsed)) assert.ok(t.log.length >= 400 && t.chats[0].messages.length >= 100, `ronda ${round}: tarea truncada`);
  }
  assert.ok(killedMidWrite >= 1, `ningún kill cayó con un temporal a medias (${killedMidWrite}/${ROUNDS}): la prueba no probó nada`);
  process.stderr.write(`[persist-atomic] kills con escritura a medias: ${killedMidWrite}/${ROUNDS}\n`);
});
