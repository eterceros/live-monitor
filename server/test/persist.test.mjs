import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTasksFileMerged } from '../src/splitfmt.js';

/**
 * El store es un singleton y `config.js` fija su directorio en la primera
 * importación, así que aquí hay **una** instancia para todo el archivo, sobre un
 * directorio temporal, y cada caso usa su propio número de tarea.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-store-'));
process.env.HFSMON_DATA_DIR = DIR;
// La ventana de producción es de 3 s; estas pruebas esperan la de antes (los tiempos de abajo).
process.env.HFSMON_PERSIST_DELAY_MS = '250';
const FILE = path.join(DIR, 'tasks.json');
const { store } = await import('../src/store.js');
after(() => {
  store.flush();          // y de paso cancela el temporizador pendiente
  rmSync(DIR, { recursive: true, force: true });
});

const issue = (n) => ({ number: n, title: `prueba ${n}`, labels: [], url: 'x', closed: false });
const enDisco = () => readTasksFileMerged(FILE);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('el arranque deja el archivo escrito sin esperar a nada', () => {
  assert.ok(existsSync(FILE), 'el store escribe al construirse');
});

test('una ráfaga de cambios se escribe una sola vez', async () => {
  const task = store.addTask(issue(1), 'hfs');
  await esperar(300);                       // que asiente lo del alta

  // La forma real de un turno: una entrada de log por llamada a herramienta.
  const antes = enDisco()['1'].log.length;
  for (let i = 0; i < 200; i++) store.addLog(task, 'chat', `🔧 Bash: paso ${i}`);

  assert.equal(enDisco()['1'].log.length, antes,
    'mientras dura la ráfaga el disco no se toca: ésa es toda la idea');
  assert.equal(task.log.length, antes + 200, 'aunque en memoria ya esté todo');

  await esperar(400);
  assert.equal(enDisco()['1'].log.length, antes + 200, 'y al asentarse se escribe entero');
});

test('el estado en memoria es la verdad desde el primer instante', () => {
  const task = store.addTask(issue(2), 'hfs');
  store.addChat(task, null, 'user', 'hola');
  assert.equal(store.get(2).chats[0].messages.length, 1);
});

test('los eventos siguen siendo inmediatos', () => {
  const vistos = [];
  const escucha = (n, chatId, m) => { if (n === 3) vistos.push(m.text); };
  store.on('chat', escucha);
  const task = store.addTask(issue(3), 'hfs');
  store.addChat(task, null, 'assistant', 'respuesta');
  store.off('chat', escucha);
  assert.deepEqual(vistos, ['respuesta'], 'la interfaz no espera al disco');
});

test('flush escribe en el acto', () => {
  const task = store.addTask(issue(4), 'hfs');
  store.addChat(task, null, 'user', 'antes de salir');
  store.flush();
  assert.equal(enDisco()['4'].chats[0].messages.length, 1);
});

test('el chat tiene tope, como el log', () => {
  const task = store.addTask(issue(5), 'hfs');
  for (let i = 0; i < 700; i++) store.addChat(task, null, 'user', `mensaje ${i}`);

  const principal = task.chats[0];
  assert.equal(principal.messages.length, 600, 'se queda con los últimos 600');
  assert.equal(principal.messages.at(-1).text, 'mensaje 699');
  assert.equal(principal.messages[0].text, 'mensaje 100');
});

test('un mensaje que cambia en sitio viaja como delta y se persiste igual', async () => {
  const task = store.addTask(issue(9), 'hfs');
  const chat = task.chats[0];
  const updates = [];
  store.on('chat-update', (issue, chatId, u) => updates.push({ issue, chatId, ...u }));

  const bubble = store.addChat(task, null, 'user', 'a mitad de turno');
  assert.ok(bubble.id, 'todo mensaje nace con id');
  const tree = store.pushChat(task, chat, { role: 'activity', items: [] });
  assert.ok(tree.id);

  store.updateChat(task, chat, bubble, { patch: { delivery: 'inline' } });
  const item = { id: 't1', kind: 'tool', name: 'Read', status: 'running' };
  tree.items.push(item);
  store.updateChat(task, chat, tree, { item, parentId: null });

  assert.equal(bubble.delivery, 'inline', 'el parche se aplica al mensaje');
  assert.deepEqual(updates.map((u) => [u.messageId, u.patch, u.item?.id]), [
    [bubble.id, { delivery: 'inline' }, undefined],
    [tree.id, null, 't1'],
  ]);
  assert.equal(updates[1].issue, 9);
  assert.equal(updates[1].chatId, chat.id);

  await esperar(400);
  const guardado = enDisco()['9'].chats[0].messages;
  assert.equal(guardado.find((m) => m.id === bubble.id).delivery, 'inline');
  assert.equal(guardado.find((m) => m.id === tree.id).items[0].id, 't1');
});

test('las tareas nuevas nacen en la máquina por defecto del tablero, que tiene que existir', async () => {
  const { settings } = await import('../src/settings.js');
  assert.equal(settings.defaultMachine, 'local');
  assert.throws(() => settings.update({ defaultMachine: 'marte' }), /defaultMachine must be one of/);
  const task = store.addTask(issue(11), 'hfs');
  assert.equal(task.machine, 'local', 'sin más máquinas configuradas, local');
  assert.equal(settings.snapshot().defaultMachine, 'local');
});
