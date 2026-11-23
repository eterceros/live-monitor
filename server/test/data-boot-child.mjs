// Child process of data-recovery.test.mjs: boots the board's data layer on the
// data directory the parent hands over (HFSMON_DATA_DIR, always a temp dir), does
// what a running board does first, and prints what it ended up believing. A
// fresh process per case: settings, the store and the project chats each read
// their files once, at import. Not a test file: `node --test` does not pick it up.
const { settings } = await import('../src/settings.js');
const { store } = await import('../src/store.js');
const pc = await import('../src/projectchats.js');
const { dataHealth } = await import('../src/datahealth.js');

pc.migrateProjectChatsOnBoot();
// What the board does when someone opens a project chat: create it if missing.
const holder = process.env.CHILD_OPEN_HOLDER ? pc.getHolder(...process.env.CHILD_OPEN_HOLDER.split('@')) : null;
if (process.env.CHILD_SET_MAX) settings.update({ maxActiveTasks: Number(process.env.CHILD_SET_MAX) });
store.flush();

console.log(JSON.stringify({
  health: dataHealth(),
  maxActiveTasks: settings.snapshot().maxActiveTasks,
  tasks: Object.fromEntries(Object.values(store.tasks).map((t) => [`${t.project}#${t.issue}`, { title: t.title, log: t.log.length }])),
  holder: holder ? { log: holder.log.length, messages: holder.chats.map((c) => c.messages.length) } : null,
}));
