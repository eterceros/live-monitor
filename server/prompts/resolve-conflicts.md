La rama `{{branch}}` del issue #{{issueNumber}} ("{{issueTitle}}") tiene su PR abierto y ahora choca con `origin/{{baseBranch}}`: la rama base avanzó ({{behind}} commit(s) por delante) y el merge no se resuelve solo. Esta es la misma sesión del fix, reanudada: conoces lo que cambiaste y por qué.

Archivos en conflicto ({{conflictCount}}):
{{conflictFiles}}

Instrucciones de trabajo:
{{parallel}}

Qué hacer:

1. Ejecuta `git merge origin/{{baseBranch}}` en este worktree. No uses rebase y no reescribas la historia de la rama.
2. Resuelve cada archivo en conflicto conservando lo que hace esta rama **y** lo que trae la rama base. Ninguna de las dos partes se descarta sin decirlo. Si ambas tocaron la misma lógica, combínalas de modo que se sigan cumpliendo las dos intenciones.
3. Comprueba que lo que tocaste compila o pasa su comprobación más rápida (un comando acotado, no la suite completa: la suite la corre el tablero después).
4. Commitea el merge con el mensaje que git propone. Debe quedar un único commit de merge que tenga como padres el HEAD de la rama y `origin/{{baseBranch}}`.

Reglas:
- No hagas push: lo hace el tablero cuando verifique el resultado.
- No pidas nada a una persona ni hagas preguntas. Si algún conflicto no tiene una resolución evidente y elegir una cambiaría lo que hace el código, ejecuta `git merge --abort`, no commitees nada y explica en tu respuesta final qué dos versiones chocan y por qué no pudiste decidir: el tablero lo dejará a una persona.
- No toques archivos que no estén en conflicto, salvo lo estrictamente necesario para que lo resuelto compile.
- No uses `--no-verify` ni `git commit --amend` sobre commits que ya existían.
- {{processRule}} Every server or process you start to verify something, stop it before your final answer.
- {{shellRule}}Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- No escribas nada en GitHub.
