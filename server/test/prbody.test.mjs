import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AT_A_GLANCE_HEADING, prBodyProblems, prBodyComplaint } from '../src/prbody.js';

/**
 * The body is written by an agent now, so what is checked here is the frame a
 * reviewer depends on: the before/after section first, the issue closed, no
 * media, and fences that actually close.
 */

const GOOD = `${AT_A_GLANCE_HEADING}

Before, a search with \`:in\` against a ValueSet the server does not know
returned \`200\` and an empty bundle, which reads as "no matching patients".
After, it returns a \`400\` with an OperationOutcome naming the missing
ValueSet.

## What changed

| | Before | After |
|---|---|---|
| Unknown ValueSet in \`:in\` | \`200\` with an empty bundle | \`400\` with an OperationOutcome |

| Crate | Change |
|---|---|
| \`helios-rest\` | fails the search instead of swallowing it |

Closes #1445`;

test('un cuerpo bien formado pasa', () => {
  assert.deepEqual(prBodyProblems(GOOD, 1445), []);
});

test('la primera cabecera tiene que ser exactamente la de un vistazo', () => {
  const body = `## Summary\n\nSomething.\n\n${AT_A_GLANCE_HEADING}\n\nBefore, after.\n\nCloses #1445`;
  const problems = prBodyProblems(body, 1445);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /## Summary/);
  assert.match(problems[0], /At a glance/);
});

test('sin ninguna cabecera se dice que abra por la de un vistazo', () => {
  const problems = prBodyProblems('Just some prose.\n\nCloses #1445', 1445);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /At a glance: before vs\. after/);
});

test('sin ninguna cabecera se dice con qué empieza el texto, no solo con qué debía abrir', () => {
  const waiting = 'Los tres subagentes siguen trabajando; escribo el cuerpo cuando lleguen sus informes. '.repeat(3);
  const problems = prBodyProblems(`\n${waiting}\n\nCloses #1445`, 1445);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /empieza por «Los tres subagentes/);
  assert.match(problems[0], /…»/, 'la primera línea va truncada');
  assert.ok(problems[0].length < 300, 'no vuelca el texto entero');
});

test('un `#` dentro de un bloque de código no es la primera cabecera', () => {
  const body = `\`\`\`bash\n# build the image\ndocker build .\n\`\`\`\n\n${AT_A_GLANCE_HEADING}\n\nBefore, after.\n\nCloses #1445`;
  const problems = prBodyProblems(body, 1445);
  assert.deepEqual(problems, [], `un comentario de shell no es markdown: ${problems.join(' | ')}`);
});

test('nada de imágenes ni de vídeo', () => {
  const shots = [
    '![screenshot](x.png)',
    '<video src="x.mp4"></video>',
    'See https://github.com/user-attachments/assets/abc',
    'See https://raw.githubusercontent.com/o/r/main/x.png',
  ];
  for (const media of shots) {
    const problems = prBodyProblems(`${GOOD}\n\n${media}`, 1445);
    assert.equal(problems.length, 1, `${media} → ${problems.join(' | ')}`);
    assert.match(problems[0], /imágenes ni vídeo/);
  }
});

test('una valla de código sin cerrar se caza', () => {
  const body = `${AT_A_GLANCE_HEADING}\n\nBefore, after.\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\nCloses #1445`;
  const problems = prBodyProblems(body, 1445);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /sin cerrar/);
});

test('el Closes tiene que nombrar la issue de la tarea', () => {
  assert.deepEqual(prBodyProblems(GOOD.replace('Closes #1445', 'closes #1445'), 1445), [], 'GitHub no mira las mayúsculas');
  const other = prBodyProblems(GOOD.replace('Closes #1445', 'Closes #14450'), 1445);
  assert.equal(other.length, 1);
  assert.match(other[0], /Closes #1445/);
  const missing = prBodyProblems(GOOD.replace('\n\nCloses #1445', ''), 1445);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /no cerrará la issue/);
});

test('sin número de issue no se inventa el Closes', () => {
  assert.deepEqual(prBodyProblems(GOOD.replace('\n\nCloses #1445', '')), []);
});

test('un cuerpo vacío es un solo problema, no cinco', () => {
  assert.deepEqual(prBodyProblems('', 1445), ['el cuerpo está vacío']);
  assert.deepEqual(prBodyProblems(null, 1445), ['el cuerpo está vacío']);
});

test('varios fallos se cuentan todos', () => {
  const body = '## Summary\n\n![shot](a.png)\n\n```rust\nlet x = 1;';
  const problems = prBodyProblems(body, 1445);
  assert.equal(problems.length, 4, problems.join(' | '));
});

// ---------------------------------------------------------------------------
// (20) Una plantilla de PR viene comentada, y lo comentado no es el documento

test('los comentarios HTML no cuentan: ni sus cabeceras ni su `Closes`', () => {
  const body = `<!--\n## Template heading\nWrite the summary here.\n-->\n\n${GOOD}`;
  assert.deepEqual(prBodyProblems(body, 1445), [], 'la cabecera de dentro del comentario no es la primera');

  const commented = `${AT_A_GLANCE_HEADING}\n\nBefore, after.\n\n<!-- Closes #1445 -->`;
  const problems = prBodyProblems(commented, 1445);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /no cerrará la issue/, 'un Closes comentado no cierra nada');
});

// ---------------------------------------------------------------------------
// (21) GitHub cierra con tres verbos, no con uno

test('`Fixes` y `Resolves` cierran igual que `Closes`', () => {
  for (const keyword of ['Closes', 'Fixes', 'Resolves', 'fixes', 'resolved', 'Closed']) {
    const body = GOOD.replace('Closes #1445', `${keyword} #1445`);
    assert.deepEqual(prBodyProblems(body, 1445), [], keyword);
  }
  assert.equal(prBodyProblems(GOOD.replace('Closes #1445', 'See #1445'), 1445).length, 1, 'mencionarla no es cerrarla');
});

// ---------------------------------------------------------------------------
// (22) Un enlace a un fichero de un repositorio no es una captura

test('`raw.githubusercontent` sólo molesta cuando es una imagen o un vídeo', () => {
  const fixture = `${GOOD}\n\nFixture: https://raw.githubusercontent.com/HL7/fhir/master/patient-example.json`;
  assert.deepEqual(prBodyProblems(fixture, 1445), [], 'una fixture de HL7 es una referencia, no una captura');

  const shot = `${GOOD}\n\nSee https://raw.githubusercontent.com/o/r/main/docs/ui.png`;
  const problems = prBodyProblems(shot, 1445);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /imagen o un vídeo/);
});

// ---------------------------------------------------------------------------
// (23) Una valla que no abre no puede quedarse sin cerrar

test('un renglón que cita ```` ```rust ```` entre backticks no abre ninguna valla', () => {
  const body = `${AT_A_GLANCE_HEADING}\n\n\`\`\`rust\`\`\` is the fence the docs use now.\n\nCloses #1445`;
  assert.deepEqual(prBodyProblems(body, 1445), [], 'el info string de una valla no puede llevar backticks');
});

test('la queja dice qué arreglar sin tocar el código', () => {
  const message = prBodyComplaint(['la primera cabecera es `## Summary`']);
  assert.match(message, /## Summary/);
  assert.match(message, /At a glance/);
  assert.match(message, /No rehagas el trabajo/);
});

// ---------------------------------------------------------------------------
// ensureClosesLine

test('ensureClosesLine appends the closing line when the body lacks it', async () => {
  const { ensureClosesLine } = await import('../src/prbody.js');
  const fixed = ensureClosesLine(GOOD.replace(/Closes #\d+/gi, ''), 942);
  assert.match(fixed, /\n\nCloses #942\n$/);
  assert.deepEqual(prBodyProblems(fixed, 942).filter((p) => /Closes/.test(p)), []);
});

test('ensureClosesLine leaves a body alone when any closing keyword already names the issue', async () => {
  const { ensureClosesLine } = await import('../src/prbody.js');
  for (const line of ['Closes #7', 'fixes #7', 'Resolved #7']) {
    const body = `${AT_A_GLANCE_HEADING}\n\nText.\n\n${line}\n`;
    assert.equal(ensureClosesLine(body, 7), body, line);
  }
  // #70 is not #7
  assert.match(ensureClosesLine(`${AT_A_GLANCE_HEADING}\n\nCloses #70\n`, 7), /Closes #7\n$/);
  assert.equal(ensureClosesLine('body', 'nope'), 'body');
  assert.equal(ensureClosesLine(null, 3), 'Closes #3\n');
});

test('the missing-Closes error says exactly what to add', () => {
  const problems = prBodyProblems(`${AT_A_GLANCE_HEADING}\n\nText.\n`, 12);
  const about = problems.find((p) => /Closes #12/.test(p));
  assert.ok(about, problems.join(' | '));
  assert.match(about, /añade una línea propia con exactamente `Closes #12`/);
});

test('el prompt pide una tabla de un vistazo y ningún diagrama', () => {
  const prompt = readFileSync(new URL('../prompts/pr-body.md', import.meta.url), 'utf8');
  assert.match(prompt, /\| \| Before \| After \|/, 'la tabla comparativa sigue siendo obligatoria');
  assert.match(prompt, /Nada de diagramas/);
  assert.doesNotMatch(prompt, /```mermaid/, 'ya no hay un ejemplo de diagrama que copiar');
  assert.doesNotMatch(prompt, /flowchart|subgraph/);
  assert.match(prompt, /\*\*Before:\*\* paso/, 'el mecanismo opcional es texto, de dos líneas');
});
