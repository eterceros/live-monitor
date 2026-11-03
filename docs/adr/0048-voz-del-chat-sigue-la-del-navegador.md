# ADR-0048 · La voz del chat sigue siendo la del navegador; no se integra un motor de síntesis propio

**Estado.** Aceptada

**Fecha.** 2026-11-03

**Rastro.** PR #31 (voz de las respuestas), #34 (idiomas), #35 y #36 (móvil), #37 (manos libres), #38 y #39 (elección de la voz del sistema), #48 (escuchar de nuevo). Evaluación de motores hecha con la persona dueña del proyecto, del 2026-10-31 al 2026-11-03.

**Afecta a.** `web/src/useSpeech.js`, `web/src/voicePrefs.js`.

## Contexto

El chat lee en voz alta el resumen hablado de sus respuestas con `speechSynthesis`, el sintetizador del propio navegador: no cuesta nada, no necesita clave y no necesita servidor. Su defecto es que la voz es la que ofrece el sistema de cada dispositivo, y por defecto suena robótica.

Restricciones del proyecto: sin presupuesto (solo motores gratuitos), el tablero se abre desde un portátil con Windows y desde un iPhone, y el idioma principal es el español (después el inglés; el francés y el alemán dejaron de ser necesarios durante la evaluación).

Dos hechos del iPhone limitaron la primera vía, la de mejorar la voz del sistema:

- Las voces de Siri no se exponen a las páginas web, ni en Safari ni en Chrome (en iOS ambos usan el motor de Safari).
- Las voces «Mejorada» o «Premium» existen, pero hay que descargarlas a mano en Ajustes, Accesibilidad, Contenido hablado, Voces. La persona dueña lo juzgó demasiado complicado.

## Decisión

Se mantiene la voz del navegador. Lo que sí se hizo, y se queda:

1. **Elección automática de la voz** (`pickVoice`, `voiceQuality`): sin voz elegida, se toma la que suele sonar más natural del idioma por su nombre (neuronales «Natural»/«Neural» primero; luego «Premium», «Enhanced», «Mejorada», «Améliorée», «Erweitert», Siri y Google; las «Compact» al final). Lo elegido a mano en los ajustes gana siempre.
2. **Botones para escuchar de nuevo** una respuesta (PR #48).

No se integra por ahora ningún motor de síntesis propio. Se reabrirá si aparece un motivo nuevo (ver «Condiciones para reabrir»).

## Consecuencias

- Cero mantenimiento y cero requisitos de hardware. La voz no depende de ningún proceso del servidor.
- La calidad de la voz depende de cada dispositivo. En el iPhone, sin descargar voces mejoradas, sigue siendo la básica.
- Las pruebas y mediciones de los motores quedan archivadas en este ADR y en `0048-voz-del-chat-evidencia/`, para no repetirlas.

## Por qué no las alternativas

Todos los motores corrieron en la máquina de la persona dueña (i9-12900H, 64 GB de RAM, RTX 3060 Laptop con ~6 GB de VRAM, Windows 11). Los agentes que generaron las muestras no pudieron escucharlas, así que los veredictos de calidad son solo los de la persona dueña.

| Motor | Veredicto de la persona dueña | Motivo para no integrarlo ahora |
|---|---|---|
| Kokoro-82M | «Suena bien» | Solo es fluido en GPU (primera frase 1,2 a 1,4 s); en CPU, 6,6 s y con cortes. Exige un proceso residente con GPU y el servidor del tablero en esa máquina. Sin alemán. `espeak-ng` (GPL-3.0) si se redistribuye |
| Qwen3-TTS 0.6B | «Suena mejor en ambos idiomas» | ~5 s por cada segundo de audio en la GPU, inutilizable en conversación. Sin voz predefinida nativa en español (acento ligero posible). ~2,5 GB de modelo |
| Piper | «No es buena, poco natural» | Descartado por calidad |
| Supertonic 3 | sin veredicto | Repositorio archivado; en CPU más lento que tiempo real; pesos OpenRAIL-M con restricciones de uso que hay que trasladar |
| MeloTTS | sin veredicto | En CPU ~0,55 s por segundo de audio; la instalación en Windows necesitó dos arreglos locales |
| Chatterbox | sin veredicto | ~2 s por segundo en GPU; la librería forzó cortes en algunas frases (muestras posiblemente truncadas) |
| XTTS-v2 | sin veredicto | Licencia CPML, no comercial |
| Edge-TTS | sin veredicto | Cliente no oficial de un servicio en línea de Microsoft; riesgo de términos de uso; necesita internet |
| F5-TTS, Fish-Speech | no probados | Pesos con licencia no comercial o términos no revisados |
| Voces SAPI/OneCore de Windows | no probadas | Solo hay voces en inglés de EE. UU. instaladas |

## Condiciones para reabrir

Reabrir esta decisión si ocurre alguna de estas:

- La voz del navegador deja de ser aceptable para la persona dueña (por ejemplo, un uso intensivo del manos libres en el iPhone).
- El servidor del tablero corre siempre en una máquina con GPU, lo que haría viable **Kokoro como proceso residente**: modelo cargado una vez, síntesis frase a frase con cola y las voces del navegador como respaldo.
- Aparece un motor que cubra español nativo, suene mejor que Kokoro y sea más rápido que tiempo real sin GPU.

Pistas de integración si se reabre: llamar a `create()` frase a frase (el `create_stream` de la librería parte por bloques de fonemas y su primer bloque tarda más); las ruedas de `onnxruntime-gpu` 1.31.1 necesitan CUDA 13 (con las de CUDA 12 cae a CPU sin avisar); y los 8 hilos de CPU fueron la mejor configuración probada (el valor por defecto y 14 hilos fueron peores).

## Anexo: mediciones

**Fecha de las mediciones.** 2026-10-31 a 2026-11-03.

**Método y avisos.** Frase de prueba de unas 20 palabras en español, inglés (y francés y alemán al principio) y, para Kokoro, un texto de 123 palabras en 8 frases. Los tiempos son segundos de síntesis frente a segundos de audio (RTF = síntesis / audio). Otros procesos de fondo (navegador, videollamada y pruebas simultáneas de otros agentes) cargaron la máquina de forma variable: **los tiempos de CPU son pesimistas y ruidosos**. Los datos en bruto están en `0048-voz-del-chat-evidencia/`. Las muestras de audio no se versionan (se regeneran con los scripts y los modelos citados).

### Kokoro-82M (kokoro-onnx 0.6.1, onnxruntime 1.31.1)

Primera prueba en CPU (máquina más tranquila): 5,5 a 6,8 s de síntesis para 6,9 a 8,6 s de audio (~0,8 de RTF), con las voces ef_dora, em_alex, af_heart, am_michael y ff_siwis. Modelo `kokoro-v1.0.onnx` de 325 MB y `voices-v1.0.bin` de 28 MB. 54 voces; ninguna alemana.

Medición de latencia (texto de 123 palabras, 8 frases, una llamada a `create()` por frase, 1 calentamiento, mediana de 3):

| CPU, voz em_alex | Primera frase | RTF global | Pausa máxima |
|---|---|---|---|
| hilos por defecto | 10,3 s | 1,99 | 9,5 s |
| 4 hilos | 7,0 s | 1,25 | 4,6 s |
| **8 hilos** | **6,6 s** | **1,20** | 4,4 s |
| 14 hilos | 10,5 s | 1,93 | 8,3 s |

| Voz | CPU (8 hilos): primera frase / RTF | GPU: primera frase / RTF / pausas |
|---|---|---|
| em_alex | 6,63 s / 1,19 | 1,33 s / 0,25 / 0 |
| ef_dora | 6,67 s / 1,27 | 1,20 s / 0,24 / 0 |
| af_heart | 8,39 s / 1,46 | 1,37 s / 0,24 / 0 |

En CPU la cola de reproducción no aguanta (pausas de 3,9 a 4,6 s entre frases). En GPU cada frase está lista mucho antes de que acabe la anterior (simulación con síntesis secuencial).

API de streaming (`create_stream`): primer bloque en 3,0 s (GPU) o 23,8 s (CPU), con el texto partido en solo 2 bloques de fonemas. Peor que llamar frase a frase.

Carga y memoria: arranque hasta listo 1,55 s (CPU) y 1,69 s (GPU) con la caché del disco caliente (una carga en frío no se midió). RAM de pico 1 376 MB (CPU) y 1 179 MB (GPU). VRAM de pico 2 607 MB usados, unos 2,2 GB por encima de los 431 MB iniciales.

Instalación de la GPU: el primer intento (ruedas CUDA 12) cayó a CPU sin avisar por `cublasLt64_13.dll` ausente; funcionó con las ruedas CUDA 13 y su carpeta de DLL en el PATH solo del proceso hijo, confirmando `CUDAExecutionProvider` activo. Licencias: kokoro-onnx MIT, modelo Apache-2.0, `espeak-ng` GPL-3.0.

### Qwen3-TTS (modelo `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`, Apache-2.0)

GPU (torch 2.11.0+cu128), atención por defecto, sin flash-attn. Solo voces predefinidas: Ryan y Aiden nativas de inglés, Serena nativa de chino; **no hay voz predefinida nativa en español**.

| Muestra | Síntesis | Audio |
|---|---|---|
| es-Ryan | 55,9 s | 10,1 s |
| es-Serena | 47,2 s | 8,8 s |
| en-Ryan | 51,6 s | 9,4 s |
| en-Aiden | 45,6 s | 8,6 s |

Unas 5 veces más lento que el tiempo real. Carga del modelo 105 s (con la descarga). VRAM de pico 2 631 MiB. El modelo (~2,5 GB) quedó en la caché de Hugging Face del usuario.

### Piper (piper-tts 1.8.0, GPL-3.0; voces de `rhasspy/piper-voices`)

CPU, Python 3.12. Modelos *medium* de 63 a 77 MB y *high* de unos 114 MB. Detalle en bruto en `piper-timings.txt`.

| Muestra | Carga | Síntesis | Audio | RTF |
|---|---|---|---|---|
| es davefx (medium) | 3,39 s | 5,51 s (primera ejecución, en frío) | 6,85 s | 0,80 |
| es sharvard / ald / claude(high) | 3,8 a 5,5 s | 1,01 / 1,05 / 1,11 s | 6,94 / 8,22 / 8,39 s | 0,13 a 0,15 |
| en lessac medium / high | 5,8 / 6,2 s | 1,04 / 3,72 s | 7,51 s | 0,14 / 0,49 |
| fr siwis / upmc (medium) | 5,5 a 5,7 s | 1,11 / 1,02 s | 7,2 a 7,3 s | 0,14 a 0,15 |
| de thorsten medium / high | 6,0 / 5,9 s | 1,20 / 3,89 s | 8,0 s | 0,15 / 0,48 |

Licencias de las voces: davefx y thorsten CC0, ald Unlicense, sharvard y siwis con atribución (CC BY), upmc CC BY-SA, claude declara Apache-2.0 con origen poco claro, lessac con licencia personalizada del Blizzard 2013.

### Supertonic 3 (pesos OpenRAIL-M, `supertonic-py` 1.3.1, código MIT)

CPU, Python 3.12. Repositorio `supertone-inc/supertonic` archivado (la copia usada es `supertone-oss-archive/supertonic-py`). 10 voces (F1 a F5, M1 a M5). Generadas F1 a F4, M1, M2 en español e inglés: 11 a 14 s de síntesis para 7,5 a 9,3 s de audio (≈1,4 de RTF), con la máquina compartida. Los pesos permiten uso comercial; las restricciones de uso (nada ilegal, no dañar a menores, declarar que el contenido es generado por una máquina, sin suplantación, sin decisiones automatizadas sobre derechos legales, sin consejo médico, sin uso en justicia, policía o inmigración, entre otras) se trasladan a quien lo use después.

### MeloTTS (melotts 0.1.2, MIT)

CPU, Python 3.10. Dos arreglos locales en el entorno: `setuptools<81` (falta `pkg_resources`) y desinstalar `unidic` para que MeCab use `unidic-lite`. Idiomas: español (ES) e inglés (EN-US, EN-BR, EN_INDIA, EN-AU, EN-Default); sin alemán. 3,95 a 4,52 s por muestra de 7 a 8,4 s; la primera de cada idioma incluye la carga del modelo (11,9 s en español, 24,1 s en EN-US).

### Chatterbox Multilingual (`chatterbox-tts` 0.1.7, MIT)

GPU, torch 2.6.0+cu124 (el paquete fija torch 2.6.0 y pip instaló la versión de CPU; hubo que reemplazarla). Voz por defecto, sin clonar. Español: 34,2 s para 17,0 s de audio; inglés: 19,0 s para 9,2 s (modelo ya cargado, texto completo por frases). Carga del modelo 16,6 s según `chatterbox-status.json`. **La librería forzó el fin de la generación en algunas frases** (avisos de repetición de tokens): las muestras pueden estar truncadas o deformes.

### XTTS-v2 (`coqui-tts` 0.28.0)

GPU, torch 2.6.0+cu124. Licencia del modelo CPML, **no comercial** (solo se usó para comparar al oído); el código del paquete es MPL-2.0. Voces integradas Claribel Dervla y Ana Florence: 8,3 s para 9,3 s (es, Claribel), 7,2 s para 9,5 s (en, Claribel), 7,4 s para 9,7 s (es, Ana), 5,7 s para 8,6 s (en, Ana). Carga del modelo 109,9 s.

### Edge-TTS 7.3.1

En línea (voces neuronales de Microsoft), cliente no oficial; solo para comparar. Voces Elvira (es-ES), Dalia (es-MX), Aria y Jenny (en-US): 2,2 a 3,1 s para 9,6 a 9,8 s de audio, incluyendo la red.

### Voces nativas

Comprobado en el iPhone con iOS 17 y Chrome: Siri 2 no aparece entre las voces disponibles para la página. La elección automática se corrigió (PR #39) porque un iPhone en español rotula sus mejores voces «Mejorada», palabra que la primera versión del ranking no reconocía.

### Cómo reproducirlo

Entornos y scripts de las pruebas en `C:\Users\edson\voice-samples\<motor>\` (un entorno de Python 3.12, salvo MeloTTS en 3.10), cada uno con su `README.txt`, su `status.json` y los audios en `samples\`. El script de la medición de Kokoro está en `0048-voz-del-chat-evidencia/bench.py`.

<!-- adr:generated -->
<!-- /adr:generated -->
