// Which web/src files belong to which catalog area, and a walker the i18n
// tests share. Not a test (the npm glob only runs *.test.mjs).
//
// HFSMON_I18N_AREA=card (or card,chat) limits every i18n test to those areas, so
// a work package can check only its own files while the others migrate. With no
// filter the tests cover every file under web/src, unmapped ones included.
//
// An entry ending in '/' is a directory; anything else is one file. Paths are
// relative to web/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB_SRC = path.join(ROOT, 'web', 'src');

export const AREAS = {
  common: [], // the shared glossary: it has no component of its own
  app: ['App.jsx', 'useDialog.jsx', 'useDictation.js', 'upgradeOffer.js', 'components/Dialog.jsx',
    'components/Markdown.jsx', 'components/MicButton.jsx'],
  shared: ['status.js', 'time.js', 'settingState.js', 'metricsView.js', 'kpiView.js', 'publishQuestion.js',
    'reviewerRules.js', 'modelRules.js', 'loginChip.js', 'pluginChip.js'],
  topbar: ['components/topbar/', 'components/ui/ExpandButton.jsx', 'components/ui/StateButton.jsx',
    'components/ProjectPicker.jsx', 'components/LoginChips.jsx', 'components/LoginCard.jsx',
    'components/LoginDialog.jsx', 'components/PluginChips.jsx', 'components/RequiredPluginsDialog.jsx',
    'components/ImportProjectDialog.jsx', 'components/ManageProjectsDialog.jsx'],
  board: ['components/Board.jsx', 'components/TaskCard.jsx', 'components/CompletedRail.jsx',
    'components/CompletedStrip.jsx', 'components/ProjectChatCard.jsx', 'components/BackgroundStrip.jsx'],
  card: ['components/card/', 'components/ChangeRequestCard.jsx', 'components/ChangeRequestPanel.jsx',
    'components/BrowserQaPanel.jsx', 'components/DemoPanel.jsx', 'components/EvidencePreview.jsx',
    'components/LogPanel.jsx', 'components/TimelinePanel.jsx'],
  chat: ['components/ChatPanel.jsx', 'components/chat/', 'components/TaskTabs.jsx',
    'components/ActivityGroup.jsx', 'components/PlanReview.jsx', 'components/QuestionDialog.jsx',
    'components/PublishConfirm.jsx'],
  kpi: ['components/kpi/', 'components/QuotaChip.jsx', 'components/QuotaMeter.jsx',
    'components/MetricsDialog.jsx'],
  ops: ['components/UpgradeDialog.jsx', 'components/RestartControl.jsx', 'components/MoveDialog.jsx',
    'restartOutcome.js'],
  dialogs: ['components/CloseIssueDialog.jsx', 'components/CreateTaskDialog.jsx',
    'components/ModelsDialog.jsx', 'components/ReviewerDialog.jsx', 'components/PrTitleDialog.jsx',
    'components/InstallDepsDialog.jsx'],
  viewer: ['viewer/'],
};

const rel = (file) => path.relative(WEB_SRC, file).split(path.sep).join('/');

const ownedBy = (relPath, area) =>
  AREAS[area].some((e) => (e.endsWith('/') ? relPath.startsWith(e) : relPath === e));

/** The areas the run is limited to, or null for all of them. */
export function areaFilter(env = process.env.HFSMON_I18N_AREA) {
  const names = String(env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  const unknown = names.filter((n) => !Object.hasOwn(AREAS, n));
  if (unknown.length) throw new Error(`HFSMON_I18N_AREA: unknown area ${unknown.join(', ')}`);
  return names;
}

export const areaNames = () => areaFilter() ?? Object.keys(AREAS);

/** Every .js and .jsx under web/src, without the catalogs and the i18n layer. */
export function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules' && name !== 'i18n') walk(full);
      } else if (/\.jsx?$/.test(name)) out.push(full);
    }
  };
  walk(WEB_SRC);
  return out.sort();
}

/** The files the run covers: those of the filtered areas, or all of them. */
export function filesInScope() {
  const filter = areaFilter();
  return sourceFiles()
    .map((file) => ({ file, name: rel(file) }))
    .filter(({ name }) => !filter || filter.some((a) => ownedBy(name, a)));
}

export const read = (file) => readFileSync(file, 'utf8');
