import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  renderPrompt, ALLOWED, validatePrompts, PLACEHOLDER,
} from '../src/prompts.js';
import {
  PARALLEL_BLOCK, PARALLEL_CORE, PARALLEL_EDIT, PARALLEL_SCOPE, parallelFor,
  COLLECT_RULE, COLLECT_EXEMPT,
} from '../src/parallel.js';
import { shellRuleFor } from '../src/rules.js';

const DIR = path.join(process.cwd(), 'server', 'prompts');

/**
 * Medido antes de escribir esto: de 5033 llamadas a herramienta hechas desde los
 * chats, 34 fueron subagentes. La instrucción tiene que llegar a TODAS las fases,
 * y una fase nueva que se olvide de pedirla es justo lo que este test impide.
 */
/**
 * The structural check, pure so it can be shown red without touching a file:
 * `scope` is the table, `declared` is ALLOWED, `onDisk` the template names,
 * `textOf(name)` the template text. Returns one problem per line.
 */
function parallelProblems({ scope, declared, onDisk, textOf }) {
  const problems = [];
  const keys = Object.keys(scope);
  for (const n of onDisk) if (!keys.includes(n)) problems.push(`${n}.md no está clasificada en PARALLEL_SCOPE`);
  for (const n of keys) if (!onDisk.includes(n)) problems.push(`${n} está en PARALLEL_SCOPE pero no hay ${n}.md`);
  for (const n of Object.keys(declared)) if (!keys.includes(n)) problems.push(`${n} está en ALLOWED pero no en PARALLEL_SCOPE`);
  for (const n of keys) if (!(n in declared)) problems.push(`${n} está en PARALLEL_SCOPE pero no en ALLOWED`);
  for (const n of keys) {
    if (!onDisk.includes(n)) continue;
    const marker = textOf(n).includes('{{parallel}}');
    const exempt = typeof scope[n] === 'object' && scope[n] !== null;
    if (exempt) {
      if (!String(scope[n].exempt ?? '').trim()) problems.push(`${n} está exenta sin motivo`);
      if (marker) problems.push(`${n} está exenta pero lleva {{parallel}}`);
      if (declared[n]?.includes('parallel')) problems.push(`${n} está exenta pero declara parallel en ALLOWED`);
    } else {
      if (!marker) problems.push(`${n}.md no lleva {{parallel}}`);
      if (!declared[n]?.includes('parallel')) problems.push(`${n} no declara parallel en ALLOWED`);
    }
  }
  return problems;
}

const onDisk = () => readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
const textOf = (n) => readFileSync(path.join(DIR, `${n}.md`), 'utf8');

test('todas las plantillas piden paralelismo o están exentas con motivo', () => {
  const problems = parallelProblems({ scope: PARALLEL_SCOPE, declared: ALLOWED, onDisk: onDisk(), textOf });
  assert.deepEqual(problems, []);
});

test('el test estructural se pone en rojo si a una plantilla le falta el marcador', () => {
  const sintetico = (extra) => parallelProblems({
    scope: { ...PARALLEL_SCOPE, ...extra.scope },
    declared: { ...ALLOWED, ...extra.declared },
    onDisk: [...onDisk(), ...(extra.onDisk ?? [])],
    textOf: (n) => (extra.texts?.[n] ?? textOf(n)),
  });
  // A template that lost its marker.
  assert.deepEqual(sintetico({ texts: { triage: 'sin marcador' } }), ['triage.md no lleva {{parallel}}']);
  // A phase added and never classified.
  assert.ok(sintetico({ onDisk: ['fase-nueva'], texts: { 'fase-nueva': '{{parallel}}' } })
    .some((p) => p.includes('fase-nueva.md no está clasificada')));
  // An exemption with no reason, and an exempt template that carries the marker.
  assert.ok(sintetico({ scope: { handoff: { exempt: ' ' } } }).some((p) => p.includes('sin motivo')));
  assert.ok(sintetico({ texts: { handoff: '{{parallel}}' } }).some((p) => p.includes('exenta pero lleva')));
  // A key that ALLOWED declares and PARALLEL_SCOPE does not know.
  assert.ok(sintetico({ declared: { fantasma: ['parallel'] } })
    .some((p) => p.includes('fantasma está en ALLOWED pero no en PARALLEL_SCOPE')));
  // A scope key that ALLOWED does not know.
  assert.ok(sintetico({ scope: { fantasma: 'core' }, onDisk: ['fantasma'], texts: { fantasma: '{{parallel}}' } })
    .some((p) => p.includes('fantasma está en PARALLEL_SCOPE pero no en ALLOWED')));
  // An exempt template that still declares `parallel` in ALLOWED.
  assert.ok(sintetico({ declared: { handoff: ['parallel'] } })
    .some((p) => p.includes('handoff está exenta pero declara parallel en ALLOWED')));
});

test('el chat recibe el bloque entero, sin su frase propia', () => {
  const chat = renderPrompt('chat-rules', { text: 'hola', siblings: '', e2ePortEnv: 'PORT', attachments: '' });
  // `Agent` es el nombre real de la herramienta en el SDK; pedir `Task` era pedir
  // una que no existe.
  assert.match(chat, /Agent/);
  assert.match(chat, /Explore/);
  assert.match(chat, /MISMO mensaje/);
  assert.match(chat, /archivos distintos/);
  assert.ok(!chat.includes('No vayas en fila si no hace falta'));
  assert.ok(textOf('chat-rules').length < 1400, 'la plantilla del chat tiene que seguir siendo corta');
});

test('el bloque dice lo que de verdad hace falta para paralelizar', () => {
  // Lo que fallaba no era pedirlo, era no decir cómo: llamadas agrupadas.
  assert.match(PARALLEL_CORE, /MISMO mensaje/, 'agrupar las llamadas es lo que las hace concurrentes');
  assert.match(PARALLEL_CORE, /run_in_background/, 'los comandos largos no deben bloquear');
  assert.match(PARALLEL_CORE, /Explore/);
  assert.match(PARALLEL_CORE, /`Read`,\s+`Grep` y `Bash`/, 'las lecturas sueltas también van juntas');
  assert.ok(!PARALLEL_CORE.includes('archivos distintos'), 'el núcleo no habla de editar');
  assert.match(PARALLEL_EDIT, /archivos distintos/, 'editar en paralelo sólo sin solaparse');
  assert.ok(PARALLEL_BLOCK.includes(PARALLEL_EDIT));
  // Lo paga cada turno de chat, y el chat recibe el bloque entero: el tope mide ese.
  assert.ok(PARALLEL_BLOCK.length < 1500, `el bloque mide ${PARALLEL_BLOCK.length}`);
});

test('las fases de solo lectura no reciben la regla de editar y las que editan sí', () => {
  const vars = {
    triage: { issueNumber: 1, issueTitle: 'x', issueLabels: '', issueBody: '' },
    advisor: { issueNumber: 1, issueTitle: 'x', triageSummary: '', issueBody: '' },
    'change-request': { issueNumber: 1, issueTitle: 'x', branch: 'b', changeRequestSection: '' },
    'qa-run': { issueNumber: 1, issueTitle: 'x', branch: 'b', servers: '', qaDir: '/qa', e2eDir: '/e2e', plan: '- q1' },
    fix: VARS.fix,
    'plan-task': VARS['plan-task'],
    'chat-rules': VARS['chat-rules'],
    'plan-retry': { taskId: 't1', attempt: 2, where: 'x', output: '', hint: '' },
  };
  for (const [nombre, v] of Object.entries(vars)) {
    const out = renderPrompt(nombre, v);
    const edita = PARALLEL_SCOPE[nombre] === 'edit';
    assert.equal(out.includes('archivos distintos'), edita, `${nombre}: la regla de editar ${edita ? 'falta' : 'sobra'}`);
    assert.ok(out.includes('Explora en abanico'), `${nombre} no lleva el núcleo`);
  }
  assert.equal(parallelFor('close-issue'), '');
  assert.throws(() => parallelFor('no-existe'), /sin ámbito/);
});

test('se sirve solo: ninguna llamada tiene que acordarse de pasarlo', () => {
  const t = renderPrompt('triage', {
    issueNumber: 1, issueTitle: 'x', issueLabels: '', issueBody: '',
  });
  assert.ok(t.includes('Explora en abanico'), 'el bloque llega sin que el llamante lo pase');
});

test('quien quiera puede reemplazarlo para una fase concreta', () => {
  const t = renderPrompt('triage', {
    issueNumber: 1, issueTitle: 'x', issueLabels: '', issueBody: '', parallel: 'BLOQUE PROPIO',
  });
  assert.ok(t.includes('BLOQUE PROPIO'));
  assert.ok(!t.includes('Explora en abanico'));
});

/**
 * Era una comprobación de una sola variable (`{{parallel}}`), y por eso no
 * habría visto un `{{shellRule}}` sin declarar. Ahora mira TODOS los
 * marcadores de cada plantilla: olvidar una entrada en ALLOWED falla aquí, a
 * la vista, en vez de reventar la fase que la use.
 */
test('todas las variables de cada plantilla están declaradas en ALLOWED', () => {
  // La misma expresión que usa el renderizador, importada y no copiada: dos
  // copias de esto se separan en cuanto alguien cambie una.
  const marcadores = (texto) => [...new Set([...texto.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  const faltan = [];
  for (const [nombre, permitidas] of Object.entries(ALLOWED)) {
    const texto = readFileSync(path.join(DIR, `${nombre}.md`), 'utf8');
    for (const v of marcadores(texto)) {
      if (!permitidas.includes(v)) faltan.push(`${nombre}.md usa {{${v}}} pero no lo declara`);
    }
  }
  assert.deepEqual(faltan, []);
});

/**
 * El heredoc en Windows: el tablero no toca el texto de un comando, lo envuelve
 * el CLI, y en Windows lo envuelve dos veces. Seis sesiones lo redescubrieron a
 * mano; la frase se la damos hecha, y solo donde hace falta.
 */
const VARS = {
  fix: {
    issueNumber: 1, issueTitle: 'x', branch: 'b', issueBody: '', planSection: '',
    extraContext: '', workPlanSection: '', e2ePortEnv: 'PORT',
  },
  'plan-task': {
    taskId: 't1', what: 'x', files: '`a.js`', checkLine: '', upstream: '', hint: '', e2ePortEnv: 'PORT',
  },
  'qa-run': {
    issueNumber: 1, issueTitle: 'x', branch: 'b', servers: '', qaDir: '/qa', e2eDir: '/e2e', plan: '- q1',
  },
  'chat-rules': { text: 'hola', siblings: '', e2ePortEnv: 'PORT', attachments: '' },
};

// Lo que el placeholder tiene delante y detrás en cada plantilla: en Linux las
// dos mitades tienen que quedar pegadas por UN espacio, ni dos ni ninguno.
const COSTURA = {
  fix: /^- Otra trampa: para descartar salida/m,
  'plan-task': /con `CI=1`\. Para descartar salida/,
  'qa-run': /^3\. \*\*PROCESOS/m,
  'chat-rules': /con CI=1\. Para descartar salida/,
};

test('la regla del heredoc se renderiza en Windows y desaparece en Linux', () => {
  const win = shellRuleFor({ platform: 'win32' });
  const linux = shellRuleFor({ platform: 'linux' });
  assert.equal(linux, '');
  assert.match(win, /unexpected EOF while looking for matching/, 'la frase nombra el error que la sesión va a ver');
  // La comilla simple es la que rompe; una `"` dentro del cuerpo es inofensiva.
  assert.match(win, /cuyo contenido lleve comillas simples \(`'`\) o barras invertidas/, 'el matiz que deja en paz a un `cat >` limpio');
  assert.ok(win.endsWith(' '), 'el espacio final va DENTRO del valor');
  // El mecanismo vive en el comentario de rules.js: el tablero del mantenedor es
  // Windows y esta frase la paga cada turno de chat.
  assert.ok(!win.includes('eval'), 'la frase no explica el mecanismo, lo nombra el comentario');

  for (const [nombre, vars] of Object.entries(VARS)) {
    const enLinux = renderPrompt(nombre, { ...vars, shellRule: linux });
    const enWindows = renderPrompt(nombre, { ...vars, shellRule: win });
    assert.ok(!enLinux.includes('unexpected EOF'), `${nombre} no debe avisar del heredoc en Linux`);
    assert.ok(enWindows.includes(win.trimEnd()), `${nombre} no lleva la regla en Windows`);
    assert.match(enLinux, COSTURA[nombre], `${nombre} deja un hueco donde estaba el marcador`);
    // `win` ya termina en espacio: comparar contra `${win}  ` sólo cazaría un
    // espacio TRIPLE. Lo que se mira es que no aparezca ningún doble espacio
    // dentro de una línea. (El guardián de la costura es el regex de arriba.)
    assert.ok(!/\S {2,}/.test(enWindows), `${nombre} deja doble espacio en medio de una línea`);
  }
});

test('sin máquina, la regla del heredoc mira la plataforma de este proceso', () => {
  const esperado = process.platform === 'win32' ? shellRuleFor({ platform: 'win32' }) : '';
  assert.equal(shellRuleFor(undefined), esperado);
  assert.equal(shellRuleFor(null), esperado);
  // Una máquina que no dice su plataforma NO es este proceso: un tablero en
  // Windows no debe colar la regla en una sesión que corre en otro sitio.
  assert.equal(shellRuleFor({}), '');
  assert.equal(shellRuleFor({ kind: 'runner' }), '');
});

test('olvidar el shellRule en una llamada cuesta una frase, no una fase', () => {
  // renderPrompt lanza si falta una variable: el valor por defecto vacío es lo
  // que impide que un sitio olvidado reviente la tarea a los veinte minutos.
  for (const [nombre, vars] of Object.entries(VARS)) {
    assert.doesNotThrow(() => renderPrompt(nombre, vars), `${nombre} debería renderizar sin shellRule`);
  }
});

test('las plantillas siguen validando como en el arranque', () => {
  // La misma llamada que hace server/src/index.js al levantarse.
  assert.equal(validatePrompts(), Object.keys(ALLOWED).length);
});

test('el fix sabe que su turno es su sesión: nada de dejar tests de fondo y «commitear luego»', () => {
  const fix = readFileSync(path.join(DIR, 'fix.md'), 'utf8');
  assert.match(fix, /todo lo que dejaste en segundo plano muere con él/);
  assert.match(fix, /Terminar sin commit es, para el tablero, un fix fallido/);
});

test('la variante que recibe cada plantilla es una decisión explícita', () => {
  const exempt = { exempt: true };
  const esperado = {
    triage: 'core', advisor: 'core', 'fix-plan': 'core', 'plan-revise': 'core', fix: 'edit',
    'fix-gaps': 'core', 'resolve-conflicts': 'edit', 'pr-body': 'core', demo: 'core', 'change-request': 'core',
    'review-replies': 'core', 'close-issue': exempt, 'chat-rules': 'edit', 'chat-project-rules': 'edit',
    'issue-draft': exempt, handoff: exempt, 'qa-plan': 'core', 'qa-run': 'core', 'plan-mode': 'core',
    'plan-task': 'edit', 'plan-retry': 'edit', 'plan-repair': 'edit',
  };
  const real = Object.fromEntries(Object.entries(PARALLEL_SCOPE)
    .map(([n, v]) => [n, typeof v === 'object' && v !== null ? exempt : v]));
  assert.deepEqual(real, esperado);
});

// Mutates the real ALLOWED and calls validatePrompts() with its defaults, so it
// also notices if the default `scopeOf` stops being `parallelFor`.
test('validatePrompts() sin argumentos falla si ALLOWED trae una clave sin ámbito', () => {
  ALLOWED.fantasma = ['parallel'];
  try {
    assert.throws(() => validatePrompts(), /sin ámbito de paralelismo: fantasma/);
  } finally {
    delete ALLOWED.fantasma;
  }
  assert.equal(validatePrompts(), Object.keys(ALLOWED).length);
});

test('index.js valida las plantillas antes de abrir el puerto', () => {
  const src = readFileSync(path.join(process.cwd(), 'server', 'src', 'index.js'), 'utf8');
  const call = src.indexOf('validatePrompts()');
  const listen = src.indexOf('server.listen(');
  assert.ok(call > -1 && listen > -1, 'both calls exist');
  assert.ok(call < listen, 'validatePrompts() runs before server.listen(');
  assert.equal(src.indexOf('validatePrompts()', call + 1), -1, 'and only once');
});

test('validatePrompts falla al arrancar si una clave de ALLOWED no tiene ámbito de paralelismo', () => {
  const sinAmbito = (name) => {
    if (name === 'handoff') throw new Error(`Plantilla sin ámbito de paralelismo: ${name}`);
    return parallelFor(name);
  };
  assert.throws(() => validatePrompts({ scopeOf: sinAmbito }), /sin ámbito de paralelismo: handoff/);
});

test('la regla de recoger antes de responder llega a toda fase con ámbito salvo los chats', () => {
  for (const [name, scope] of Object.entries(PARALLEL_SCOPE)) {
    const text = parallelFor(name);
    if (typeof scope === 'object') {
      assert.equal(text, '', `${name} está exenta y no recibe nada`);
    } else if (COLLECT_EXEMPT.has(name)) {
      assert.ok(!text.includes(COLLECT_RULE), `${name} es un chat: sin la regla`);
    } else {
      assert.ok(text.endsWith(COLLECT_RULE), `${name} debería terminar con la regla de recoger`);
    }
  }
  assert.deepEqual([...COLLECT_EXEMPT].sort(), ['chat-project-rules', 'chat-rules']);
  for (const n of COLLECT_EXEMPT) assert.ok(n in PARALLEL_SCOPE, `${n} existe en PARALLEL_SCOPE`);
});

test('la regla de recoger dice lo que hace falta y no toca el tope del bloque paralelo', () => {
  assert.match(COLLECT_RULE, /run_in_background: false/);
  assert.match(COLLECT_RULE, /subagente/);
  assert.match(COLLECT_RULE, /segundo plano/);
  assert.match(COLLECT_RULE, /último mensaje del turno es el entregable/);
});

test('el advisor pide abrir con la cabecera del plan y recibe la regla de recoger', () => {
  const adv = readFileSync(path.join(DIR, 'advisor.md'), 'utf8');
  assert.match(adv, /## Plan de implementación/);
  const out = renderPrompt('advisor', { issueNumber: 1, issueTitle: 't', triageSummary: 's', issueBody: 'b' });
  assert.ok(out.includes(COLLECT_RULE));
  assert.ok(!renderPrompt('chat-rules', VARS['chat-rules']).includes(COLLECT_RULE));
});
