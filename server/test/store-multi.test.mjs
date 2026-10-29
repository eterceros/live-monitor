import './isolate.mjs';
// Un archivo de tareas por proyecto, un solo store.
//
// Lo que se comprueba aquí es justo lo que `keys.js` promete en «The store
// stays one object, and one event emitter»: la unión, la clave compuesta, un
// archivo por proyecto y el `project` al final de los eventos. Y, sobre todo,
// que nada de eso obliga a mover el `tasks.json` que ya existe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readTasksFileMerged } from '../src/splitfmt.js';
import { DATA_DIR } from './isolate.mjs';

// Escrito ANTES de importar el store: es el archivo que el tablero se encuentra
// al arrancar, con la forma de siempre — `{ "<issue>": tarea }`, sin `project`.
const VIEJO = {
  7: { issue: 7, title: 'de antes de los proyectos', labels: [], url: 'x', state: 'pr_draft', log: [], chats: [] },
};
const TASKS = path.join(DATA_DIR, 'tasks.json');
const OTRO = path.join(DATA_DIR, 'tasks.app-b.json');
writeFileSync(TASKS, JSON.stringify(VIEJO, null, 2), 'utf8');

const { store } = await import('../src/store.js');
after(() => store.flush());

const issue = (n) => ({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false });
const enDisco = (file) => readTasksFileMerged(file);

test('un tasks.json de antes se adopta tal cual: se carga y se le estampa el proyecto', () => {
  const t = store.get(7);
  assert.ok(t, 'la forma vieja sigue cargando');
  assert.equal(t.project, 'hfs', 'el proyecto se pone al cargar, no al usarse');
  assert.equal(t.title, 'de antes de los proyectos', 'y nada más se toca');

  store.flush();
  const guardado = enDisco(TASKS);
  assert.deepEqual(Object.keys(guardado), ['7'],
    'el archivo sigue indexado por el número de issue pelado: adoptado, no migrado');
  assert.equal(guardado['7'].project, 'hfs', 'el `project` viaja con él, que es aditivo');
});

test('get acepta el número pelado, la cadena y la clave canónica: la misma tarea', () => {
  const task = store.addTask(issue(12), 'hfs');
  assert.equal(task.project, 'hfs', 'sin decir nada, el proyecto por defecto');
  assert.equal(store.get(12), task);
  assert.equal(store.get('12'), task);
  assert.equal(store.get('hfs#12'), task);
  assert.equal(store.get('hfs#012'), undefined, 'la clave canónica no admite ceros a la izquierda');
  assert.equal(store.get('basura'), undefined);
  assert.equal(store.get(null), undefined);
});

test('dos proyectos con el mismo issue #12 no se pisan', () => {
  const mio = store.get(12);
  const suyo = store.addTask(issue(12), 'app-b');

  assert.notEqual(suyo, mio, 'antes el segundo sobrescribía al primero en silencio');
  assert.equal(store.get('app-b#12'), suyo);
  assert.equal(store.get('hfs#12'), mio, 'y el primero sigue donde estaba');
  assert.equal(store.get(12), mio, 'el número pelado sigue significando el proyecto por defecto');

  const doce = store.all().filter((t) => t.issue === 12);
  assert.deepEqual(doce.map((t) => t.project), ['app-b', 'hfs'],
    'la unión los trae a los dos, con el proyecto desempatando');
  assert.deepEqual(store.all().map((t) => `${t.project}#${t.issue}`), ['app-b#12', 'hfs#12', 'hfs#7'],
    'ordenada por issue descendente');
});

test('flush escribe un archivo por proyecto, y cada uno solo lo suyo', () => {
  store.flush();
  assert.ok(existsSync(OTRO), 'el proyecto nuevo estrena su propio archivo');

  assert.deepEqual(Object.keys(enDisco(OTRO)), ['12']);
  assert.equal(enDisco(OTRO)['12'].project, 'app-b');
  assert.deepEqual(Object.keys(enDisco(TASKS)).sort(), ['12', '7'],
    'y el de por defecto se queda con los suyos, sin rastro del otro');
});

test('un cambio en un proyecto no reescribe el archivo del otro', async () => {
  store.flush();
  const antes = readFileSync(OTRO, 'utf8');
  store.addLog(store.get('hfs#12'), 'prueba', 'solo esta tarea cambia');
  store.flush();
  assert.equal(readFileSync(OTRO, 'utf8'), antes, 'solo se escribe el proyecto sucio');
  assert.equal(enDisco(TASKS)['12'].log.at(-1).line, 'solo esta tarea cambia');
});

test('los eventos conservan sus argumentos y ganan `project` al final', () => {
  const vistos = { log: [], chat: [], update: [] };
  const onLog = (...args) => vistos.log.push(args);
  const onChat = (...args) => vistos.chat.push(args);
  const onUpdate = (...args) => vistos.update.push(args);
  store.on('log', onLog);
  store.on('chat', onChat);
  store.on('chat-update', onUpdate);

  const task = store.get('app-b#12');
  store.addLog(task, 'fase', 'una línea');
  const chat = task.chats[0];
  const message = store.addChat(task, null, 'user', 'hola');
  store.updateChat(task, chat, message, { patch: { delivery: 'inline' } });

  store.off('log', onLog);
  store.off('chat', onChat);
  store.off('chat-update', onUpdate);

  const [issueLog, entrada, proyectoLog] = vistos.log.at(-1);
  assert.equal(issueLog, 12, 'el issue sigue siendo el primer argumento');
  assert.equal(entrada.line, 'una línea');
  assert.equal(proyectoLog, 'app-b', 'y el proyecto llega el último');

  const [issueChat, chatId, mensaje, proyectoChat] = vistos.chat.at(-1);
  assert.deepEqual([issueChat, chatId, mensaje.text, proyectoChat], [12, chat.id, 'hola', 'app-b']);

  const [issueUp, chatIdUp, update, proyectoUp] = vistos.update.at(-1);
  assert.deepEqual([issueUp, chatIdUp, update.messageId, proyectoUp],
    [12, chat.id, message.id, 'app-b']);
});

test('addTask exige un proyecto que pueda ser clave', () => {
  assert.throws(() => store.addTask(issue(13), 'NO VALE'), /no tiene 'project' v\u00e1lido/);
  assert.equal(store.get('hfs#13'), undefined, 'y no deja la tarea a medias en el store');
});

test('addTask y keyFor sin proyecto fallan en vez de caer en hfs', () => {
  assert.throws(() => store.addTask(issue(14)), /missing project in addTask/);
  assert.throws(() => store.keyFor(14), /missing project in keyFor/);
  assert.equal(store.get('hfs#14'), undefined);
});
