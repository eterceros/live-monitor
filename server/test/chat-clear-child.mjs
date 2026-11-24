// Child process of chat-clear.test.mjs, on the temp data directory the parent
// hands over (HFSMON_DATA_DIR). `write`: a task chat and a holder chat get three
// messages each and are flushed — so their messages are serialized and cached —
// then emptied with `clearChat` and flushed again. `read`: a fresh boot prints
// what it finds. Not a test file: `node --test` does not pick it up.
const phase = process.argv[2];
const { store } = await import('../src/store.js');
const pc = await import('../src/projectchats.js');
pc.migrateProjectChatsOnBoot();

if (phase === 'write') {
  const pipeline = await import('../src/pipeline.js');
  const task = store.addTask({ number: 4242, title: 't', labels: [], url: 'https://x/4242', closed: false }, 'hfs');
  const holder = pc.getHolder('hfs', 'local');
  const other = store.addTask({ number: 4243, title: 'u', labels: [], url: 'https://x/4243', closed: false }, 'hfs');
  for (const owner of [task, holder]) {
    for (const text of ['uno', 'dos', 'tres']) store.addChat(owner, owner.chats[0].id, 'user', text);
  }
  store.addChat(other, other.chats[0].id, 'user', 'stays');
  store.flush();
  const beforeClear = { task: task.chats[0].messages.length, holder: holder.chats[0].messages.length };
  pipeline.clearChat('hfs#4242', task.chats[0].id);
  pipeline.clearChat(pc.holderKey('hfs', 'local'), holder.chats[0].id);
  const failures = store.flush();
  console.log(JSON.stringify({ beforeClear, failures }));
  process.exit(0);
} else {
  const task = store.get('hfs#4242');
  const other = store.get('hfs#4243');
  const holder = pc.getHolder('hfs', 'local');
  console.log(JSON.stringify({ task: task.chats[0].messages.length, holder: holder.chats[0].messages.length, other: other.chats[0].messages.length }));
  process.exit(0);
}
