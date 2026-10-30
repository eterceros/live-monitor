import React from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ban, Bandage, Bot, Brain, ChartColumn, ChartLine,
  ChevronDown, ChevronLeft, ChevronRight, Check, CircleCheck, CircleHelp, CircleMinus, CircleStop,
  CircleX, Circle, ClipboardList, Command, Compass, Construction, Copy, Ellipsis, ExternalLink, Eye, EyeOff,
  File, FileCode, FilePen, FileText, Film, Flame, FlaskConical, Folder, FolderGit2, GitBranch,
  GitPullRequest, Hand, History, Hourglass, Image, Inbox, Info, KeyRound, LayoutGrid, Layers, Lightbulb, Link,
  LoaderCircle, Lock, MapPin, Maximize2, Menu, MessageSquare, Mic, Minimize2, Minus, Moon, Palette,
  Paperclip, Pause, Pencil, Pin, Play, Plug, Plus, Puzzle, Recycle, Redo2, RefreshCw, Repeat, Rocket,
  RotateCcw, ScrollText, Search, Server, Settings, SkipForward, SlidersHorizontal, Sprout, Terminal,
  Timer, Trash2, TreeDeciduous, TriangleAlert, Truck, Undo2, User, Volume2, VolumeX, Wrench, X, Zap,
} from 'lucide-react';

/*
 * <Icon name="..." /> — the board's one icon component, and the single place
 * that decides which glyph stands for which concept. CONTRACT: one concept, one
 * name. Replace a text emoji/glyph by the name in this table; do not invent a
 * second name for something already listed.
 *
 *   emoji / glyph        name             lucide
 *   -------------------  ---------------  ---------------
 *   🕘                   history          History
 *   📥                   inbox            Inbox
 *   📝                   note             FilePen          (pr_draft state, notes, .md files in the viewer)
 *   📋                   clipboard        ClipboardList    (plan_ready state, the plan)
 *   ❓                   help-circle      CircleHelp
 *   ⏳ ⌛                hourglass        Hourglass
 *   📍                   map-pin          MapPin
 *   📌                   pin              Pin
 *   ✅                   check-circle     CircleCheck
 *   ✓                    check            Check
 *   ✕ ✗                  x                X
 *   ✖ ❌                 x-circle         CircleX          (error state)
 *   ⚠ ⚠️                 alert-triangle   TriangleAlert
 *   💬                   message          MessageSquare
 *   🚧                   construction     Construction
 *   🌳                   tree             TreeDeciduous
 *   🌱 🌿                sprout           Sprout
 *   🔍                   search           Search
 *   🧪                   flask            FlaskConical
 *   🧭                   compass          Compass
 *   🩹                   bandage          Bandage
 *   👀                   eye              Eye
 *   (none)               eye-off          EyeOff           (restricted / hide a project)
 *   (none)               grid             LayoutGrid       (card grid, manage projects)
 *   🔴 🟢 🟡 ● • ·       dot              Circle (filled)  (colour it with className)
 *   ○                    circle           Circle
 *   ✋                   hand             Hand
 *   ⚙️                   settings         Settings
 *   🎬                   film             Film
 *   📜                   scroll           ScrollText
 *   ⏱                   timer            Timer
 *   🔗                   link             Link
 *   ⬇ ↓                  arrow-down       ArrowDown
 *   ⬆ ⬆️ ↑               arrow-up         ArrowUp
 *   ←                    arrow-left       ArrowLeft
 *   →                    arrow-right      ArrowRight
 *   ↗                    external         ExternalLink
 *   ‹                    chevron-left     ChevronLeft
 *   › ▸                  chevron-right    ChevronRight
 *   ▾ ▼                  chevron-down     ChevronDown
 *   ▶ ▶️                 play             Play
 *   🤖                   bot              Bot
 *   👤                   user             User
 *   🗑️                   trash            Trash2
 *   🔒                   lock             Lock
 *   🚚                   truck            Truck
 *   ♻️                   recycle          Recycle
 *   🔥                   flame            Flame
 *   🚀                   rocket           Rocket
 *   📁                   folder           Folder
 *   (folder that is a git repo) folder-git FolderGit2      (was 🟢 in the folder browser)
 *   ➕                   plus             Plus
 *   −                    minus            Minus
 *   🖼️                   image            Image
 *   📄                   file-text        FileText         (text files in the viewer)
 *   (code file)          file-code        FileCode
 *   (any other file)     file             File
 *   🔧                   wrench           Wrench
 *   🔌                   plug             Plug
 *   ⏹                   stop             CircleStop
 *   ⏸                   pause            Pause
 *   ⏭                   skip             SkipForward
 *   ☰                    menu             Menu
 *   ⑂                    branch           GitBranch
 *   ⧉                    copy             Copy
 *   ⚡                   zap              Zap
 *   ⤢                    maximize         Maximize2
 *   🧠                   brain            Brain
 *   🎤                   mic              Mic
 *   📎                   paperclip        Paperclip
 *   🔑                   key              KeyRound
 *   ✏️ ✍️                pencil           Pencil
 *   💡                   lightbulb        Lightbulb
 *   ℹ️                   info             Info
 *   ⌘                    command          Command
 *   ↻ ⟳ 🔄               refresh          RefreshCw        (reload / «working»)
 *   (spinner)            loader           LoaderCircle     (spin it with CSS)
 *   🔁                   repeat           Repeat           (retry / iterations)
 *   ↺                    reset            RotateCcw
 *   ↩                    undo             Undo2            (go back to)
 *   ↪                    forward          Redo2
 *   ⊘ ↷                  ban              Ban              (skipped / omitted)
 *   (terminal)           terminal         Terminal
 *   (server)             server           Server
 *   (none)               layers           Layers           (stacked sets, e.g. grouped items)
 *   (none)               minimize         Minimize2        (task-card expand → minimize)
 *   🎨                   palette          Palette          (Artifact canvases / design canvases)
 *   🧩                   puzzle           Puzzle           (UX skills, plug-in style extras)
 *   (none)               pull-request     GitPullRequest   (a PR link or state)
 *   (none)               circle-minus     CircleMinus      («no» in a yes/no state)
 *   (none)               chart-column     ChartColumn      (Métricas button, bar charts)
 *   (none)               chart-line       ChartLine        (line charts, usage trend)
 *   ⋯                    more             Ellipsis         (overflow / more)
 *   (none)               sliders          SlidersHorizontal (settings, filters)
 *   (none)               moon             Moon             (dark theme marker)
 *
 * An unknown `name` is drawn as the plain text it is, so a screen can migrate
 * one glyph at a time and a literal emoji keeps working until it is replaced.
 * The map is closed and uses named imports only, so unused icons tree-shake.
 *
 * Size defaults to 1em (inherits the text), stroke 1.75, aligned to the
 * baseline. Decorative (aria-hidden) unless a `title` is given.
 */
const ICONS = {
  history: History,
  inbox: Inbox,
  note: FilePen,
  clipboard: ClipboardList,
  'help-circle': CircleHelp,
  hourglass: Hourglass,
  'map-pin': MapPin,
  pin: Pin,
  'check-circle': CircleCheck,
  check: Check,
  x: X,
  'x-circle': CircleX,
  'alert-triangle': TriangleAlert,
  message: MessageSquare,
  construction: Construction,
  tree: TreeDeciduous,
  sprout: Sprout,
  search: Search,
  flask: FlaskConical,
  compass: Compass,
  bandage: Bandage,
  eye: Eye,
  'eye-off': EyeOff,
  grid: LayoutGrid,
  dot: Circle, // drawn filled, see below
  circle: Circle,
  hand: Hand,
  settings: Settings,
  film: Film,
  scroll: ScrollText,
  timer: Timer,
  link: Link,
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  external: ExternalLink,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  play: Play,
  bot: Bot,
  user: User,
  trash: Trash2,
  lock: Lock,
  truck: Truck,
  recycle: Recycle,
  flame: Flame,
  rocket: Rocket,
  folder: Folder,
  'folder-git': FolderGit2,
  plus: Plus,
  minus: Minus,
  image: Image,
  'file-text': FileText,
  'file-code': FileCode,
  file: File,
  wrench: Wrench,
  plug: Plug,
  stop: CircleStop,
  pause: Pause,
  skip: SkipForward,
  menu: Menu,
  branch: GitBranch,
  copy: Copy,
  zap: Zap,
  maximize: Maximize2,
  brain: Brain,
  mic: Mic,
  volume: Volume2,
  'volume-off': VolumeX,
  paperclip: Paperclip,
  key: KeyRound,
  pencil: Pencil,
  lightbulb: Lightbulb,
  info: Info,
  command: Command,
  refresh: RefreshCw,
  loader: LoaderCircle,
  repeat: Repeat,
  reset: RotateCcw,
  undo: Undo2,
  forward: Redo2,
  ban: Ban,
  terminal: Terminal,
  server: Server,
  layers: Layers,
  minimize: Minimize2,
  palette: Palette,
  puzzle: Puzzle,
  'pull-request': GitPullRequest,
  'circle-minus': CircleMinus,
  'chart-column': ChartColumn,
  'chart-line': ChartLine,
  more: Ellipsis,
  sliders: SlidersHorizontal,
  moon: Moon,
};

export const ICON_NAMES = Object.keys(ICONS);
export const hasIcon = (name) => typeof name === 'string' && Object.hasOwn(ICONS, name);

export default function Icon({ name, size = '1em', className, title }) {
  if (!hasIcon(name)) return <>{name}</>;
  const Glyph = ICONS[name];
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={className}
      style={{ verticalAlign: '-0.125em', flex: 'none' }}
      fill={name === 'dot' ? 'currentColor' : 'none'}
      {...a11y}
    >
      {title ? <title>{title}</title> : null}
    </Glyph>
  );
}
