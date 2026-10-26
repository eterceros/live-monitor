import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// There is no web test runner: the card's settings group (its segmented
// controls and what each one writes) is pinned by reading the sources as text.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const card = read('components/TaskCard.jsx');
const settings = read('components/card/SettingsGroup.jsx');
const count = (re, src = settings) => (src.match(re) ?? []).length;
// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

test('no switches left in the card: neither Toggle nor role=switch', () => {
  assert.equal(count(/<Toggle\b/g), 0);
  assert.equal(count(/role="switch"/g), 0);
  assert.equal(/\b(c1|c2|span-2|ctl-group)\b/.test(settings), false);
});

test('the six three-valued settings are segmented controls over TRI_OPTIONS', () => {
  assert.match(settings, /<SettingsGroup|export default function SettingsGroup/);
  assert.equal(count(/<TriRow\b/g), 6);
  assert.equal(count(/<SegmentedControl\b/g), 1, 'one control, rendered by TriRow for each row');
  assert.match(settings, /options=\{TRI_OPTIONS\}/);
  for (const k of ['demo', 'browserQa', 'approvePlan', 'fixGaps', 'fullTests', 'resolveConflicts']) {
    assert.match(settings, new RegExp(`settingKey="${k}"`));
  }
  assert.match(settings, /taskTriState\(task, settingKey\)/);
  pin('card.settings.title', 'Ajustes de la tarea');
  assert.match(settings, /<CardSection title=\{t\.card\.settings\.title\}>/);
});

test('each segmented control writes the chosen value (on|off|auto) for its own setting', () => {
  assert.match(settings, /onSetDemo\(task\.issue, v\)/);
  assert.match(settings, /onSetBrowserQa\(task\.issue, v\)/);
  assert.match(settings, /onSetApprovePlan\(task\.issue, v\)/);
  assert.match(settings, /onSetFixGaps\(task\.issue, v\)/);
});

test('Browser QA locked by the project: disabled control, lock text and «Abrir Ajustes»', () => {
  assert.match(settings, /disabled=\{s\.locked\}/);
  assert.match(settings, /locked=\{locked\}/);
  pin('card.settings.openSettings', 'Abrir Ajustes');
  assert.match(settings, /label: t\.card\.settings\.openSettings, icon: 'sliders'/);
  assert.match(settings, /onOpenSettings \?/);
});

test('Demo in the card: the server resolves it and TaskCard still derives demoOn', () => {
  assert.match(card, /const demoOn = task\.demoWanted \?\? task\.demo !== 'off'/);
});

test('Manual and Lienzos de diseño are state + one action button (StateButton)', () => {
  assert.equal(count(/<StateButton\b/g), 2);
  pin('card.settings.manual', 'Manual');
  assert.match(settings, /name=\{t\.card\.settings\.manual\}/);
  assert.match(settings, /onSetMode\(task\.issue, mode === 'manual' \? 'auto' : 'manual'\)/);
  assert.match(settings, /mode !== 'unconfirmed'/);
  pin('card.settings.sourceManual', 'manual');
  pin('card.settings.sourceAuto', 'automática');
  assert.match(settings, /source=\{mode === 'manual' \? t\.card\.settings\.sourceManual : t\.card\.settings\.sourceAuto\}/);
});
