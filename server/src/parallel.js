/**
 * The parallelism block every phase prompt carries.
 *
 * It lives here rather than being copied into every template because it is one
 * instruction that has to say the same thing everywhere, and because the way it
 * is phrased decides whether it works at all. Measured on this board before
 * writing it: of 5033 tool calls made from chats, 34 were subagents — 0.7%. The
 * fix phase, the only prompt that *did* ask for parallelism, managed 1.6%. The
 * ask was there; what was missing was telling the agent concretely how, and
 * that grouping the calls is what makes them concurrent at all.
 *
 * The block comes in two parts. The core is what every phase that runs tools
 * needs: fan questions out, one message, long commands in the background,
 * independent reads together. The edit part is only for phases that write to
 * the worktree: subagents share it, so two of them writing the same file is the
 * same silent clobber two parallel chats would produce. A read-only phase gets
 * no rule about editing: it would be noise there.
 */

const HEAD = `
## Paralelismo: repártete el trabajo, no vayas en fila

- **Explora en abanico.** Antes de tocar nada, convierte lo que no sabes en
  preguntas independientes y lanza **un subagente por pregunta** con la
  herramienta de subagentes —\`Agent\`, o \`Task\` si tu versión la llama así—
  pasando \`subagent_type: Explore\` para buscar y leer ("¿dónde está X?",
  "¿cómo funciona Y?", "¿qué tests cubren Z?").
- **Lánzalos en el MISMO mensaje.** Varias llamadas en un solo mensaje se
  ejecutan a la vez; una por mensaje es ir en fila con pasos extra. Si sólo
  lanzas un subagente, no has paralelizado nada.
- **Lo que no merece un subagente, también junto.** Las llamadas \`Read\`,
  \`Grep\` y \`Bash\` que no dependen una de otra van en un solo mensaje: tres
  lecturas en tres mensajes son tres turnos; en uno, uno.
- **Los comandos largos, al fondo.** Compilaciones, suites de tests y descargas
  van con \`run_in_background\`, y sigues trabajando mientras corren; recoges la
  salida cuando la necesites. Nunca te quedes mirando una compilación.`;

/** The rule for phases that write to the worktree. A single bullet. */
export const PARALLEL_EDIT = `
- **Editar en paralelo, sólo en archivos distintos.** Los subagentes comparten
  este worktree: dos escribiendo el mismo archivo se pisan y gana el último sin
  avisar a nadie. Reparte por archivo o por módulo; si dos cambios dependen de
  verdad uno del otro, hazlos tú, en serie.`;

const TAIL = `
- La serie se reserva para lo que necesita de verdad el resultado del paso
  anterior. Todo lo demás, a la vez.`;

/** The reminder for phases that only read. */
export const PARALLEL_CORE = `${HEAD}${TAIL}`;

/** The full reminder, with the edit rule: core with `PARALLEL_EDIT` inserted before the closing line. */
export const PARALLEL_BLOCK = `${HEAD}${PARALLEL_EDIT}${TAIL}`;

/**
 * What each template gets. Every template in `ALLOWED` is classified here, and
 * `parallel.test.mjs` fails when the keys of this table, the keys of `ALLOWED`
 * and the `.md` files on disk stop matching (checked in both directions), when
 * a non-exempt template lacks `{{parallel}}` or does not declare it, and when
 * an exempt one carries the marker or declares it. `validatePrompts` also
 * calls `parallelFor` for every `ALLOWED` key at boot.
 *
 * - `'edit'`: the phase writes to the worktree; core plus the edit rule.
 * - `'core'`: the phase runs tools but writes nothing in the worktree.
 * - `{ exempt }`: no reminder, and the reason is the value. These run with
 *   no subagent tool to fan out with.
 */
export const PARALLEL_SCOPE = {
  triage: 'core',
  advisor: 'core',
  'fix-plan': 'core',
  'plan-revise': 'core',
  fix: 'edit',
  'fix-gaps': 'core',
  'resolve-conflicts': 'edit',
  'pr-body': 'core',
  demo: 'core',
  'change-request': 'core',
  'review-replies': 'core',
  // `tools: ['Read', 'Grep']`: no Bash, so no subagent tool to fan out with.
  'close-issue': { exempt: 'runs with only Read and Grep: no subagent tool to fan out with' },
  'chat-rules': 'edit',
  'chat-project-rules': 'edit',
  // `tools: []`: nothing to run at all.
  'issue-draft': { exempt: 'runs with no tools: nothing to fan out' },
  // A turn without tools, right before a task leaves the machine.
  handoff: { exempt: 'a turn without tools: it only writes memory' },
  'qa-plan': 'core',
  // Writes only in `qaDir`, outside the worktree, and the worktree is read-only for it.
  'qa-run': 'core',
  'plan-mode': 'core',
  'plan-task': 'edit',
  'plan-retry': 'edit',
  'plan-repair': 'edit',
};

/**
 * The closing rule, applied right behind the parallel block. Fanning out is
 * not enough: a session that launches subagents (they run in the background by
 * default) and ends its turn on "they are still working" hands the board that
 * sentence as the phase's answer. A prompt asks, it does not guarantee, so this
 * is the weaker second line of defence behind the hook and the seal rule.
 */
export const COLLECT_RULE = `
## Antes de tu respuesta final: recoge todo

- **Subagentes en primer plano.** Lánzalos con \`run_in_background: false\`: tu
  turno no puede cerrarse con ellos fuera.
- **Recoge todo antes de responder.** Espera a cada subagente y a cada comando
  que dejaste en segundo plano (léelos con la herramienta de salida). Una frase
  como «siguen trabajando, escribo el plan cuando lleguen» no es una respuesta.
- **El último mensaje del turno es el entregable.** El tablero se queda con él:
  el plan, el cuerpo del PR o el veredicto, completo y en el formato pedido.`;

/**
 * Templates that run with a person in front of them (chats): nobody reads a
 * deliverable off the last message there, so they keep the parallel block alone.
 * Exempt-from-parallel templates get no rule at all, as before.
 */
export const COLLECT_EXEMPT = new Set(['chat-rules', 'chat-project-rules']);

/** The text `{{parallel}}` takes in a template: '' for an exempt one. */
export function parallelFor(name) {
  const scope = PARALLEL_SCOPE[name];
  if (scope === undefined) throw new Error(`Plantilla sin ámbito de paralelismo: ${name}`);
  if (scope !== 'edit' && scope !== 'core') return '';
  const block = scope === 'edit' ? PARALLEL_BLOCK : PARALLEL_CORE;
  // The blank line keeps the rule's heading off the last bullet of the block.
  return COLLECT_EXEMPT.has(name) ? block : `${block}\n${COLLECT_RULE}`;
}
