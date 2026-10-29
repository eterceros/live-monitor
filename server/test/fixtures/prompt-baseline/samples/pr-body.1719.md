Redacta el CUERPO del pull request del issue #1719 ("ui(search-parameters): detail panel values not aligned with badge indent (URL, Name, Status, FHIRPath expression)"), ya arreglado y probado en la rama `fix/1719-ui-search-parameters-detail-panel`.

**TODO LO QUE ACABE EN GITHUB VA EN INGLÉS:** mensajes de commit, título y cuerpo del PR, comentarios de PR o de issue y respuestas a hilos de review — aunque estas instrucciones y la conversación estén en español. Aquí eso alcanza a todo lo que escribas: encabezados, tablas y las frases de mecanismo.

Cuerpo del issue:
<<issueBody>>
<<diffSection>>

## Paralelismo: repártete el trabajo, no vayas en fila

- **Explora en abanico.** Antes de tocar nada, convierte lo que no sabes en
  preguntas independientes y lanza **un subagente por pregunta** con la
  herramienta de subagentes —`Agent`, o `Task` si tu versión la llama así—
  pasando `subagent_type: Explore` para buscar y leer ("¿dónde está X?",
  "¿cómo funciona Y?", "¿qué tests cubren Z?").
- **Lánzalos en el MISMO mensaje.** Varias llamadas en un solo mensaje se
  ejecutan a la vez; una por mensaje es ir en fila con pasos extra. Si sólo
  lanzas un subagente, no has paralelizado nada.
- **Lo que no merece un subagente, también junto.** Las llamadas `Read`,
  `Grep` y `Bash` que no dependen una de otra van en un solo mensaje: tres
  lecturas en tres mensajes son tres turnos; en uno, uno.
- **Los comandos largos, al fondo.** Compilaciones, suites de tests y descargas
  van con `run_in_background`, y sigues trabajando mientras corren; recoges la
  salida cuando la necesites. Nunca te quedes mirando una compilación.
- La serie se reserva para lo que necesita de verdad el resultado del paso
  anterior. Todo lo demás, a la vez.

## Antes de tu respuesta final: recoge todo

- **Subagentes en primer plano.** Lánzalos con `run_in_background: false`: tu
  turno no puede cerrarse con ellos fuera.
- **Recoge todo antes de responder.** Espera a cada subagente y a cada comando
  que dejaste en segundo plano (léelos con la herramienta de salida). Una frase
  como «siguen trabajando, escribo el plan cuando lleguen» no es una respuesta.
- **El último mensaje del turno es el entregable.** El tablero se queda con él:
  el plan, el cuerpo del PR o el veredicto, completo y en el formato pedido.

Aquí el abanico es la comprobación: leer el diff, confirmar el nombre real de cada test y averiguar qué hacía el código ANTES son preguntas independientes. Lánzalas a la vez y redacta con las respuestas, nunca de memoria.

Solo necesitas leer el diff y escribir texto: no dejes comandos en segundo plano ni bucles de espera (`until`, `while`, `sleep`) en marcha. Si lanzas algo, que termine antes de tu respuesta final.

## Qué devuelves

SOLO el cuerpo del PR, en Markdown, listo para publicarse tal cual: sin preámbulo, sin anunciar lo que vas a hacer, sin comentarios tuyos al final y sin envolverlo en un bloque de código. Tu primera línea es exactamente `## At a glance: before vs. after`.

## Estructura obligatoria, en este orden

### 1. `## At a glance: before vs. after`

SIEMPRE la primera sección. Su único objetivo: que un reviewer entienda qué se arregló **de un solo vistazo y sin leer el resto del cuerpo**. La pieza principal es una tabla.

**Una tabla comparativa de 3 a 5 filas**, con encabezados `| | Before | After |`, una fila por magnitud que cambia: cuentas, latencias, filas que quedan, reintentos, llamadas. Números y hechos, no valoraciones. Si una magnitud la mediste en este PR, dilo en la fila. Tiene que caber en una pantalla: celdas cortas, sin párrafos dentro de una celda.

**Opcional, y solo si los números no cuentan el mecanismo** (un arreglo de lógica que no se mide, por ejemplo): dos líneas de texto justo antes de la tabla, `**Before:** paso → paso → paso` y `**After:** paso → paso`, de 3 o 4 pasos cortos cada una, que cuenten la secuencia real —qué hacía el código y qué hace ahora—, no adjetivos («roto» → «arreglado»). Si la tabla ya lo dice, no las pongas.

**Nada de diagramas.** Ni mermaid ni ningún otro gráfico, ni ASCII art: se dibujan enormes y desproporcionados frente al resto del cuerpo, y la tabla se lee mejor. Si no hay magnitudes que comparar, una tabla de dos o tres filas con lo que cambia de comportamiento (qué pasaba antes, qué pasa ahora) basta.

### 2. `## Problem`

La causa real, no el síntoma. Nombra el archivo, el tipo o la función donde vive (`src/<modulo>/<archivo>.<ext>`), y explica por qué el código se comportaba así. Si el issue describía el síntoma, aquí se dice qué había debajo.

### 3. `## Fix`

Qué cambia y **por qué así**: la decisión de diseño, no la lista de líneas tocadas. Si algo quedó fuera a propósito, dilo en una frase.

### 4. `## Tests`

Qué se añadió y qué se corrió, con **nombres reales** copiados del código y de la salida: rutas de archivo, nombres de tests y de specs. Nada de «added unit tests». Si un test ya existía y ahora cubre el caso, dilo. Si algo no se pudo probar, dilo también.

### 5. El cierre

La última línea del cuerpo, sola y **sin backticks ni valla de código**, escrita tal cual como texto plano: Closes #1719

Dentro de un bloque de código GitHub no la lee, y el issue se queda abierto sin que nadie se entere.

## Prohibido

- **Diagramas de cualquier tipo** (mermaid, ASCII art, gráficos): la comparación va en la tabla.
- **Imágenes, vídeos y GIFs.** Ni `![...](...)`, ni `<img>`, ni `<video>`, ni adjuntos, ni enlaces a capturas o a URLs `raw`/`user-images`. La evidencia se cuenta con texto: un fragmento de la salida de los tests dentro de un bloque de código dice más y no caduca.
- **Commitear evidencia al repositorio** para poder enlazarla. Capturas, vídeos y volcados no entran en el repo.
- **Nombrar el tablero (hfs-monitor) ni la herramienta que condujo el trabajo.** Ni agentes, ni automatización, ni «generated with». Escribes como el autor del PR, en voz neutra o en primera persona del plural.
- **Marcadores sin rellenar.** Nada de `<id>`, `TODO`, `<owner>/<repo>` ni «por ejemplo…»: si no lo comprobaste, no lo escribas.
