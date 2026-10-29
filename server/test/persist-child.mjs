// Child process of the persistence tests: it runs a real store on the data
// directory the parent hands over (HFSMON_DATA_DIR, always a copy), so the parent
// can kill it in the middle of a write or look at what a boot did to the files.
// Not a test file: `node --test` does not pick it up.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// A frozen clock, so a parent can predict what the boot's own fix-ups stamp.
if (process.env.HFSMON_FROZEN_NOW) {
  const T = new Date(process.env.HFSMON_FROZEN_NOW).getTime();
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [T])); }
    static now() { return T; }
  };
}
const { store } = await import('../src/store.js');
const pc = await import('../src/projectchats.js');

const mode = process.argv[2];
if (mode === 'hammer') {
  // Mutates tasks forever; the parent decides when to kill.
  const tasks = Object.values(store.tasks);
  let n = 0;
  setInterval(() => {
    for (let i = 0; i < 20; i++, n++) store.addLog(tasks[n % tasks.length], 'tool', `child ${n} `.repeat(8));
  }, 2);
  console.log('ready');
} else if (mode === 'inflight') {
  // A change, an async write that has just started, and then the orderly exit
  // (what a signal or upgrade.js does): flush() with NOTHING new since the write began.
  const t = Object.values(store.tasks)[0];
  t.title = 'cambiado justo antes de salir';
  store.addLog(t, 'estado', 'linea en vuelo');
  store.addChat(t, null, 'user', 'mensaje en vuelo');
  const holder = pc._loadedHoldersForTests()[0]?.[1];
  if (holder) {
    store.addLog(holder, 'estado', 'linea de holder en vuelo');
    store.addChat(holder, null, 'user', 'mensaje de holder en vuelo');
  }
  store.persist(t);
  store.flushAsync();                    // takes the dirty lists, awaits the file
  pc._flushProjectChatsAsyncForTests();
  store.flush();                         // must write again what is in flight
  process.exit(0);
} else if (mode === 'exit-late') {
  // upgrade.js: the last flush, then a change, then process.exit() (which fires `exit`, not `beforeExit`).
  store.flush();
  const t = Object.values(store.tasks)[0];
  store.addLog(t, 'estado', 'cambio despues del ultimo flush');
  process.exit(0);
} else if (mode === 'boot') {
  // Boots (migrations run), writes everything, leaves.
  pc.migrateProjectChatsOnBoot();   // what index.js does before it listens
  store.flush();
  console.log(JSON.stringify(Object.keys(store.tasks).length));
  process.exit(0);
} else if (mode === 'dump') {
  // Boots, makes the first write of the project chats (which is what migrates their file),
  // and dumps what is in MEMORY, one file per project, for the parent to compare with the disk.
  const out = process.argv[3];
  const holders = pc._loadedHoldersForTests();
  if (holders.length) pc.persistHolder(holders[0][1]);
  store.flush();
  mkdirSync(out, { recursive: true });
  const byProject = {};
  for (const task of Object.values(store.tasks)) (byProject[task.project] ??= {})[task.issue] = task;
  for (const [project, tasks] of Object.entries(byProject)) writeFileSync(path.join(out, `mem.${project}.json`), JSON.stringify(tasks));
  writeFileSync(path.join(out, 'mem.holders.json'), JSON.stringify(Object.fromEntries(holders)));
  console.log(JSON.stringify({ tasks: Object.keys(store.tasks).length, holders: holders.length }));
  process.exit(0);
}
