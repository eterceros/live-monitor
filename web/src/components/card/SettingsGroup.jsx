import React from 'react';
import CardSection from './CardSection.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import SettingRow from '../ui/SettingRow.jsx';
import StateButton from '../ui/StateButton.jsx';
import { TRI_OPTIONS, taskTriState } from '../../settingState.js';
import { useStrings } from '../../i18n/useStrings.js';

// One three-valued row: name + effective value + where it comes from, with the
// segmented Activar / Desactivar / Automático underneath. `taskTriState` holds
// the semantics (what `auto` means, the project lock); the group only paints.
function TriRow({ task, settingKey, icon, name, onSet, onOpenSettings }) {
  const t = useStrings();
  const s = taskTriState(task, settingKey);
  const locked = s.locked
    ? {
      text: s.source,
      action: onOpenSettings ? { label: t.card.settings.openSettings, icon: 'sliders', onClick: onOpenSettings } : undefined,
    }
    : null;
  return (
    <SettingRow icon={icon} name={name} detail={s.detail} effective={s.effective} source={s.source}
      locked={locked} layout="stack">
      <SegmentedControl label={name} value={s.value} options={TRI_OPTIONS} size="sm" context="card"
        disabled={s.locked} onChange={onSet} />
    </SettingRow>
  );
}

export default function SettingsGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { mode } = m;
  const { onSetMode, onSetBrowserQa, onSetDemo, onSetApprovePlan, onSetFixGaps, onSetFullTests, onSetResolveConflicts, onSetDesign, onOpenSettings } = h;
  return (
    <CardSection title={t.card.settings.title}>
      <div className="tcs-rows">
        <TriRow task={task} settingKey="demo" icon="film" name="Demo"
          onSet={(v) => onSetDemo(task.issue, v)} />
        {/* The project's switch (or the board's) wins over the card's own: with it
            off the phase never runs, so the row shows it off and locked. */}
        <TriRow task={task} settingKey="browserQa" icon="compass" name="Browser QA"
          onOpenSettings={onOpenSettings} onSet={(v) => onSetBrowserQa(task.issue, v)} />
        <TriRow task={task} settingKey="approvePlan" icon="note" name="Plan"
          onSet={(v) => onSetApprovePlan(task.issue, v)} />
        {/* Gaps are what the verification found and the fix did not close; the
            board tries before opening the PR. */}
        <TriRow task={task} settingKey="fixGaps" icon="bandage" name={t.card.settings.gaps}
          onSet={(v) => onSetFixGaps(task.issue, v)} />
        {/* Off: the test phase runs only what the diff touched. On: the whole suite. */}
        <TriRow task={task} settingKey="fullTests" icon="flask" name={t.card.settings.fullTests}
          onSet={(v) => onSetFullTests(task.issue, v)} />
        {/* On: a PR waiting for review that conflicts with its base is merged, tested and pushed by the board. */}
        <TriRow task={task} settingKey="resolveConflicts" icon="branch" name={t.card.settings.resolveConflicts}
          onSet={(v) => onSetResolveConflicts(task.issue, v)} />
        {mode !== 'unconfirmed' && (
          <SettingRow icon="hand" name={t.card.settings.manual} effective={mode === 'manual'}
            source={mode === 'manual' ? t.card.settings.sourceManual : t.card.settings.sourceAuto}
            title={mode === 'manual' ? t.card.settings.backToAuto : t.card.settings.markManual}>
            <StateButton on={mode === 'manual'} name={t.card.settings.manual}
              onToggle={() => onSetMode(task.issue, mode === 'manual' ? 'auto' : 'manual')} />
          </SettingRow>
        )}
        {/* Set by a person only: it lets this task's unattended phases use the
            Artifact tool (Claude Design canvases). Publishing still asks; delete is refused. */}
        <SettingRow icon="palette" name={t.card.settings.design} effective={task.design === true}
          title={task.design === true ? t.card.settings.designOn : t.card.settings.designOff}>
          <StateButton on={task.design === true} name={t.card.settings.design}
            onToggle={() => onSetDesign(task.issue, task.design !== true)} />
        </SettingRow>
      </div>
    </CardSection>
  );
}
