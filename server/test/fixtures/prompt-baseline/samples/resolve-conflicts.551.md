La rama `<<branch>>` del issue #551 ("HTS: research terminology UI requirements and build an administrative console") tiene su PR abierto y ahora choca con `origin/<<baseBranch>>`: la rama base avanzó (<<behind>> commit(s) por delante) y el merge no se resuelve solo. Esta es la misma sesión del fix, reanudada: conoces lo que cambiaste y por qué.

Archivos en conflicto (<<conflictCount>>):
<<conflictFiles>>

Instrucciones de trabajo:

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
- **Editar en paralelo, sólo en archivos distintos.** Los subagentes comparten
  este worktree: dos escribiendo el mismo archivo se pisan y gana el último sin
  avisar a nadie. Reparte por archivo o por módulo; si dos cambios dependen de
  verdad uno del otro, hazlos tú, en serie.
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

Qué hacer:

1. Ejecuta `git merge origin/<<baseBranch>>` en este worktree. No uses rebase y no reescribas la historia de la rama.
2. Resuelve cada archivo en conflicto conservando lo que hace esta rama **y** lo que trae la rama base. Ninguna de las dos partes se descarta sin decirlo. Si ambas tocaron la misma lógica, combínalas de modo que se sigan cumpliendo las dos intenciones.
3. Comprueba que lo que tocaste compila o pasa su comprobación más rápida (un comando acotado, no la suite completa: la suite la corre el tablero después).
4. Commitea el merge con el mensaje que git propone. Debe quedar un único commit de merge que tenga como padres el HEAD de la rama y `origin/<<baseBranch>>`.

Reglas:
- No hagas push: lo hace el tablero cuando verifique el resultado.
- No pidas nada a una persona ni hagas preguntas. Si algún conflicto no tiene una resolución evidente y elegir una cambiaría lo que hace el código, ejecuta `git merge --abort`, no commitees nada y explica en tu respuesta final qué dos versiones chocan y por qué no pudiste decidir: el tablero lo dejará a una persona.
- No toques archivos que no estén en conflicto, salvo lo estrictamente necesario para que lo resuelto compile.
- No uses `--no-verify` ni `git commit --amend` sobre commits que ya existían.
- **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado. Every server or process you start to verify something, stop it before your final answer.
- Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- No escribas nada en GitHub.
