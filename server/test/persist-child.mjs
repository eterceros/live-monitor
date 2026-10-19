// Child process of persist-atomic.test.mjs: it runs a real store on the data
// directory the parent hands over (HFSMON_DATA_DIR, always a copy) so the parent
// can kill it in the middle of a write. Not a test file: `node --test` does not
// pick it up.
import { store } from '../src/store.js';

const mode = process.argv[2];
if (mode === 'hammer') {
  // Mutates tasks forever; the parent decides when to kill.
  const tasks = Object.values(store.tasks);
  let n = 0;
  setInterval(() => {
    for (let i = 0; i < 20; i++, n++) store.addLog(tasks[n % tasks.length], 'tool', `child ${n} `.repeat(8));
  }, 2);
  console.log('ready');
} else if (mode === 'boot') {
  // Boots (migrations run), writes everything, leaves.
  store.flush();
  console.log(JSON.stringify(Object.keys(store.tasks).length));
  process.exit(0);
}
