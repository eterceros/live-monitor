import React, { Fragment, useEffect, useState } from 'react';
import Icon from '../Icon.jsx';
import Popover, { usePopover } from '../ui/Popover.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import SettingRow from '../ui/SettingRow.jsx';
import StateButton from '../ui/StateButton.jsx';
import RequiredPluginsDialog from '../RequiredPluginsDialog.jsx';
import { usePlugins } from '../../usePlugins.js';
import { DUO_OPTIONS, TRI_OPTIONS, projectTriState, triToProject } from '../../settingState.js';
import { HOVER_DELAY_OPTIONS, onHoverDelayChange, readHoverDelay, writeHoverDelay } from '../../cardHover.js';
import {
  RATE_OPTIONS, onVoicePrefsChange, readVoiceDefault, readVoiceListen, readVoiceName, readVoiceRate,
  writeVoiceDefault, writeVoiceListen, writeVoiceName, writeVoiceRate,
} from '../../voicePrefs.js';
import { listVoices, speechSupport } from '../../useSpeech.js';
import { useStrings, useLocale } from '../../i18n/useStrings.js';
import { LOCALES, fill, plural, setLocale, splitAround, strings } from '../../i18n/index.js';

/**
 * One per-project switch. Name and tooltip are read from the catalog when asked
 * for, so they follow the language; a phase name that is the same in every
 * language (`fixedName`) is not in the catalog.
 */
const projectRow = (key, icon, fixedName) => ({
  key,
  icon,
  get name() { return fixedName ?? strings().topbar.settings.rows[key].name; },
  get title() { return strings().topbar.settings.rows[key].title; },
});

/** The per-project switches, in the order of the artboard. `title` is the tooltip each one has always had. */
const PROJECT_ROWS = [
  projectRow('autoStart', 'rocket'),
  projectRow('approvePlan', 'note'),
  projectRow('browserQa', 'compass', 'Browser QA'), // i18n-ok: a phase name, the same in every language
  projectRow('fixGaps', 'bandage'),
  projectRow('fullTests', 'flask'),
  projectRow('resolveConflicts', 'branch'),
  projectRow('demo', 'film', 'Demo'), // i18n-ok: a phase name, the same in every language
];

/** Cuts a catalog sentence at its `{holes}` and puts an element where each one is. */
const rich = (template, els) => splitAround(template, els).map((p) => (
  <Fragment key={p.key}>{p.hole ? els[p.hole] : p.text}</Fragment>
));

/** A name with a short second line under it (for rows whose state is not a yes/no). */
const Named = ({ name, sub }) => (
  <span className="sm-named">
    <span>{name}</span>
    {sub && <span className="sm-sub">{sub}</span>}
  </span>
);

/** «Off», «1 s», «2 s»…: how a hover delay is written, in the current language. */
const hoverLabel = (t, ms) => (ms ? fill(t.topbar.settings.hoverSeconds, { n: ms / 1000 }) : t.topbar.settings.hoverOff);

/** The git refresh choices, in seconds (0 = off). */
const GIT_REFRESH_OPTIONS = [0, 30, 60, 120, 300, 600];
const gitLabel = (t, s) => (!s ? t.topbar.settings.gitOff : s < 60 ? fill(t.topbar.settings.hoverSeconds, { n: s }) : `${s / 60} min`); // i18n-ok: the unit

/** The hover delay of this browser, live: the cards and this row follow the same event. */
function useHoverDelay() {
  const [ms, setMs] = useState(readHoverDelay);
  useEffect(() => onHoverDelayChange(() => setMs(readHoverDelay())), []);
  return ms;
}

/** The voice preferences of this browser, live: this menu and the chats follow the same event. */
function useVoicePrefs() {
  const read = () => ({ name: readVoiceName(), rate: readVoiceRate(), isDefault: readVoiceDefault(), listen: readVoiceListen() });
  const [prefs, setPrefs] = useState(read);
  const [voices, setVoices] = useState(() => listVoices());
  useEffect(() => onVoicePrefsChange(() => setPrefs(read())), []);
  // A browser loads its voices a moment after the page: the list is asked again when it says so.
  useEffect(() => {
    if (!speechSupport()) return undefined;
    const again = () => setVoices(listVoices());
    window.speechSynthesis.addEventListener('voiceschanged', again);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', again);
  }, []);
  return { ...prefs, voices };
}

/** «1 plugin · falta en runner-1», or «N requeridos · todo instalado». */
function pluginsSummary(t, state, chips) {
  const total = state.required.length;
  if (!total) return { text: t.topbar.settings.pluginsNone, warn: null };
  if (!chips.length) return { text: fill(t.topbar.settings.pluginsAllInstalled, { n: total }), warn: null };
  const names = chips.map((c) => c.machine).join(', ');
  const busy = chips.every((c) => c.job && ['installing', 'enabling', 'verifying'].includes(c.job.state));
  const off = !busy && chips.every((c) => c.items.length && c.items.every((i) => i.reason === 'disabled'));
  const warn = busy ? t.topbar.settings.pluginsInstalling : off ? t.topbar.settings.pluginsDisabled : t.topbar.settings.pluginsMissing;
  return { text: `${plural(total, t.topbar.settings.pluginsCount)} · `, warn: fill(warn, { names }) };
}

/**
 * The board's and the active project's settings behind one «Ajustes» button.
 * The popover is controlled (`open` / `onOpenChange`) because a card can open it too.
 *
 * @param {object} props
 * @param {string|null} props.activeProject
 * @param {string} props.projectLabel
 * @param {object} props.settings
 * @param {(key: string) => any} props.eff the project's value for a key, else the board's
 * @param {(key: string) => boolean} props.isOwn the project overrides that key
 * @param {(patch: object) => void} props.saveSettings
 * @param {(patch: object) => void} props.saveProjectSetting a `null` value drops the override
 * @param {boolean} props.designOn
 * @param {(on: boolean) => void} props.saveDesign
 * @param {{ name: string, kind?: string }[]} props.machines
 * @param {number} props.pollMins
 * @param {() => void} props.onOpenModels
 * @param {boolean} [props.open]
 * @param {(open: boolean) => void} [props.onOpenChange]
 */
export default function SettingsMenu({
  activeProject, projectLabel, settings, eff, isOwn, saveSettings, saveProjectSetting,
  designOn, saveDesign, machines, pollMins, onOpenModels, open, onOpenChange,
}) {
  const t = useStrings();
  const lang = useLocale();
  const pop = usePopover({ open, onOpenChange });
  const { state, chips } = usePlugins();
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const own = settings?.projects?.[activeProject] ?? {};
  const hasProject = Boolean(activeProject);
  const sourceOf = (key) => (hasProject && isOwn(key) ? t.topbar.settings.sourceOwn : t.topbar.settings.sourceBoard);
  const scopeNote = (key) => (hasProject ? ` (${sourceOf(key)})` : '');

  /** The way back to following the board: only offered while the project has its own value. */
  const resetBtn = (key) => (hasProject && isOwn(key) ? (
    <button type="button" className="btn btn-ghost btn-icon sm-reset" title={t.topbar.settings.resetToBoard} aria-label={t.topbar.settings.resetToBoard}
      onClick={() => saveProjectSetting({ [key]: null })}><Icon name="reset" /></button>
  ) : null);

  const hoverMs = useHoverDelay();
  const voice = useVoicePrefs();
  const gitSecs = eff('gitRefreshSeconds') ?? 300;
  const plugins = pluginsSummary(t, state, chips);
  const maxTasks = settings.maxActiveTasks;

  return (
    <>
      <button type="button" className="btn btn-md sm-trigger" {...pop.triggerProps} aria-haspopup="dialog"
        aria-label={t.topbar.settings.title} title={t.topbar.settings.triggerTitle}>
        <Icon name="sliders" />
        <span className="sm-trigger-label">{t.topbar.settings.title}</span>
      </button>

      <Popover pop={pop} placement="bottom-end" label={t.topbar.settings.title} className="sm-root">
        <section className="sm-col sm-col-project" aria-labelledby="sm-h-project">
          <h3 id="sm-h-project" className="sm-title">{rich(t.topbar.settings.projectTitle, { project: <b>{projectLabel}</b> })}</h3>
          <p className="sm-note-top">{t.topbar.settings.projectNote}</p>
          <div className="sm-list">
            {PROJECT_ROWS.map((row) => {
              const st = projectTriState(own, settings, row.key, hasProject);
              return (
                <SettingRow key={row.key} layout="inline" icon={row.icon} name={row.name}
                  title={`${row.title}${scopeNote(row.key)}`} effective={st.effective} source={st.source}>
                  <SegmentedControl context="menu" size="sm" label={row.name} value={st.value}
                    options={hasProject ? TRI_OPTIONS : DUO_OPTIONS}
                    onChange={(v) => (hasProject
                      ? saveProjectSetting({ [row.key]: triToProject(v) })
                      : saveSettings({ [row.key]: v === 'on' }))} />
                </SettingRow>
              );
            })}

            {hasProject && (
              <SettingRow layout="inline" icon="palette" name={t.topbar.settings.uxName} title={t.topbar.settings.uxTitle}
                effective={designOn} source={t.topbar.settings.uxSource}>
                <StateButton on={designOn} name={t.topbar.settings.uxName} title={t.topbar.settings.uxTitle} onToggle={() => saveDesign(!designOn)} />
              </SettingRow>
            )}

            {machines.length > 1 && (
              <SettingRow layout="inline" icon="map-pin"
                name={<Named name={t.topbar.settings.newIn} sub={sourceOf('defaultMachine')} />}
                title={fill(t.topbar.settings.newInTitle, { scope: scopeNote('defaultMachine') })}>
                <span className="sm-inline">
                  <span className="sm-select">
                    <select aria-label={t.topbar.settings.newIn} value={eff('defaultMachine') ?? 'local'}
                      onChange={(e) => saveProjectSetting({ defaultMachine: e.target.value })}>
                      {machines.map((m) => (
                        <option key={m.name} value={m.name}>{m.kind === 'local' ? t.topbar.settings.here : m.name}</option>
                      ))}
                    </select>
                    <Icon name="chevron-down" />
                  </span>
                  {resetBtn('defaultMachine')}
                </span>
              </SettingRow>
            )}

            <SettingRow layout="inline" icon="refresh"
              name={<Named name={t.topbar.settings.pollEvery} sub={sourceOf('pollIntervalMinutes')} />}
              title={fill(t.topbar.settings.pollEveryTitle, { scope: scopeNote('pollIntervalMinutes') })}>
              <span className="sm-inline">
                <span className="sm-step" role="group" aria-label={t.topbar.settings.pollEvery}>
                  <button type="button" aria-label={t.topbar.settings.less} disabled={pollMins <= 1}
                    onClick={() => saveProjectSetting({ pollIntervalMinutes: Math.max(1, pollMins - 1) })}><Icon name="minus" /></button>
                  <b>{pollMins}</b>
                  <small>min</small>{/* i18n-ok: the unit */}
                  <button type="button" aria-label={t.topbar.settings.more} disabled={pollMins >= 120}
                    onClick={() => saveProjectSetting({ pollIntervalMinutes: Math.min(120, pollMins + 1) })}><Icon name="plus" /></button>
                </span>
                {resetBtn('pollIntervalMinutes')}
              </span>
            </SettingRow>

            <SettingRow layout="inline" icon="branch"
              name={<Named name={t.topbar.settings.gitName} sub={sourceOf('gitRefreshSeconds')} />}
              title={fill(t.topbar.settings.gitTitle, { scope: scopeNote('gitRefreshSeconds') })}>
              <span className="sm-inline">
                <SegmentedControl context="menu" size="sm" label={t.topbar.settings.gitName} className="sm-git" value={gitSecs}
                  options={GIT_REFRESH_OPTIONS.map((s) => ({ value: s, label: gitLabel(t, s) }))}
                  onChange={(s) => saveProjectSetting({ gitRefreshSeconds: s })} />
                {resetBtn('gitRefreshSeconds')}
              </span>
            </SettingRow>
          </div>
        </section>

        <div className="sm-divider" aria-hidden="true" />

        <section className="sm-col sm-col-board" aria-labelledby="sm-h-board">
          <h3 id="sm-h-board" className="sm-title">{t.topbar.settings.boardTitle}</h3>
          <p className="sm-note-top">{t.topbar.settings.boardNote}</p>
          <div className="sm-list">
            <SettingRow layout="inline" icon="zap" name={t.topbar.settings.parallel} title={t.topbar.settings.parallelTitle}>
              <span className="sm-step" role="group" aria-label={t.topbar.settings.parallel}>
                <button type="button" aria-label={t.topbar.settings.less} disabled={maxTasks <= 1}
                  onClick={() => saveSettings({ maxActiveTasks: Math.max(1, maxTasks - 1) })}><Icon name="minus" /></button>
                <b>{maxTasks}</b>
                <button type="button" aria-label={t.topbar.settings.more} disabled={maxTasks >= settings.ceiling}
                  onClick={() => saveSettings({ maxActiveTasks: Math.min(settings.ceiling, maxTasks + 1) })}><Icon name="plus" /></button>
              </span>
            </SettingRow>

            <SettingRow layout="inline" icon="brain" name={t.topbar.settings.models} title={t.topbar.settings.modelsTitle}>
              <button type="button" className="btn btn-sm sm-configure" title={t.topbar.settings.modelsTitle}
                onClick={() => { pop.close(); onOpenModels(); }}>{t.topbar.settings.configure}</button>
            </SettingRow>

            <SettingRow layout="inline" icon="message" name={t.topbar.settings.language} title={t.topbar.settings.languageTitle}>
              <span className="sm-inline">
                <span className="sm-select">
                  <select aria-label={t.topbar.settings.language} value={lang} onChange={(e) => setLocale(e.target.value)}>
                    {LOCALES.map((code) => (
                      <option key={code} value={code}>{t.common.languageNames[code]}</option>
                    ))}
                  </select>
                  <Icon name="chevron-down" />
                </span>
              </span>
            </SettingRow>

            <SettingRow layout="inline" icon="maximize"
              name={<Named name={t.topbar.settings.hoverName} sub={hoverLabel(t, hoverMs)} />}
              title={t.topbar.settings.hoverTitle}>
              <SegmentedControl context="menu" size="sm" label={t.topbar.settings.hoverName} className="sm-hover" value={hoverMs}
                options={HOVER_DELAY_OPTIONS.map((ms) => ({ value: ms, label: hoverLabel(t, ms) }))}
                onChange={writeHoverDelay} />
            </SettingRow>

            {speechSupport() && (
              <>
                <SettingRow layout="inline" icon="volume" name={<Named name={t.topbar.settings.voiceName} sub={voice.name || t.topbar.settings.voiceAuto} />}
                  title={t.topbar.settings.voiceTitle}>
                  <span className="sm-inline">
                    <span className="sm-select">
                      <select aria-label={t.topbar.settings.voiceName} value={voice.name} onChange={(e) => writeVoiceName(e.target.value)}>
                        <option value="">{t.topbar.settings.voiceAuto}</option>
                        {voice.voices.map((v) => <option key={v.name} value={v.name}>{v.name} · {v.lang}</option>)}
                      </select>
                      <Icon name="chevron-down" />
                    </span>
                  </span>
                </SettingRow>
                <SettingRow layout="inline" icon="timer" name={<Named name={t.topbar.settings.rateName} sub={`${voice.rate}×`} />} // i18n-ok: a speed multiplier
                  title={t.topbar.settings.rateTitle}>
                  <span className="sm-inline">
                    <span className="sm-select">
                      <select aria-label={t.topbar.settings.rateName} value={voice.rate} onChange={(e) => writeVoiceRate(Number(e.target.value))}>
                        {RATE_OPTIONS.map((r) => <option key={r} value={r}>{r}×{/* i18n-ok: a speed multiplier */}</option>)}
                      </select>
                      <Icon name="chevron-down" />
                    </span>
                  </span>
                </SettingRow>
                <SettingRow layout="inline" icon="volume" name={t.topbar.settings.voiceDefaultName} title={t.topbar.settings.voiceDefaultTitle}
                  effective={voice.isDefault} source={t.topbar.settings.voiceSource}>
                  <StateButton on={voice.isDefault} name={t.topbar.settings.voiceDefaultName} title={t.topbar.settings.voiceDefaultTitle}
                    onToggle={() => writeVoiceDefault(!voice.isDefault)} />
                </SettingRow>
                <SettingRow layout="inline" icon="mic" name={t.topbar.settings.voiceListenName} title={t.topbar.settings.voiceListenTitle}
                  effective={voice.listen} source={t.topbar.settings.voiceSource}>
                  <StateButton on={voice.listen} name={t.topbar.settings.voiceListenName} title={t.topbar.settings.voiceListenTitle}
                    onToggle={() => writeVoiceListen(!voice.listen)} />
                </SettingRow>
              </>
            )}

            <button type="button" className="sm-plugins" aria-haspopup="dialog" title={t.topbar.settings.pluginsTitle}
              onClick={() => { pop.close(); setPluginsOpen(true); }}>
              <Icon name="puzzle" />
              <span className="sm-plugins-text">
                <span>{t.topbar.settings.pluginsRequired}</span>
                <span className="sm-sub">{plugins.text}{plugins.warn && <span className="sm-warn">{plugins.warn}</span>}</span>
              </span>
              <Icon name="chevron-right" />
            </button>
          </div>
          <p className="sm-hint">
            <Icon name="info" />
            <span>{t.topbar.settings.hint}</span>
          </p>
        </section>
      </Popover>

      {pluginsOpen && <RequiredPluginsDialog onClose={() => setPluginsOpen(false)} />}
    </>
  );
}
