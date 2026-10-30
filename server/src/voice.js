/**
 * Voice mode of a chat: the browser reads aloud what the chat says, so a
 * message sent with `voice: true` carries this rule for THAT turn only.
 *
 * What is spoken is not the whole reply but an executive summary inside a
 * `<voz>…</voz>` tag, the way one developer briefs another; the rest of the
 * text stays on screen. More depth comes in layers, when asked for, and the
 * chat announces its progress at milestones in the same tag. The browser
 * reads only what is inside the tag (`web/src/voice.js`).
 *
 * The preference lives in each browser, not here: the browser marks the
 * message and this is all the board adds. A constant rather than a template:
 * it is appended to whatever the chat prompt rendered, and has no variables.
 */

/** Words a spoken summary may have: about 40 seconds of speech. */
export const VOICE_MAX_WORDS = 120;

export const VOICE_RULE = `[Modo voz] Esta conversación se está ESCUCHANDO, no leyendo. Reglas para esta respuesta:
- Empieza con un resumen hablado dentro de <voz>…</voz>: como un desarrollador que le cuenta a otro qué pasa. Qué pasaba o qué encontraste, qué hiciste y qué necesitas de él si hay algo que decidir. Máximo ${VOICE_MAX_WORDS} palabras (unos 40 segundos), frases cortas, dicho como se dice en voz alta: sin código, sin rutas ni nombres de archivo largos, sin tablas ni listas.
- Después de la etiqueta puedes escribir el detalle completo en texto normal. Ese texto NO se lee en voz alta, solo se muestra en pantalla.
- Contesta en el idioma en que te hablan: si te escriben o te dictan en inglés, el resumen hablado va en inglés.
- Si te piden «más detalle» (o «more detail», «plus de détails», «mehr Details»), escribe otro <voz>…</voz> que desglose el punto en el que están, con más profundidad. Si piden «menos detalle» («less detail»…), uno más corto. Si piden que lo repitas («repeat that», «répète»…), repite el resumen anterior con otras palabras.
- Si lo que haces tarda, avisa en cada hito importante con una nota corta <voz>…</voz> (una o dos frases: qué acabas de terminar y qué haces ahora), sin repetir un aviso anterior. Si te preguntan cómo va, contesta con un <voz>…</voz> con el estado real.
- Todo lo que deba oírse va dentro de <voz>…</voz>; lo que escribas fuera no se oye.`;

/** `rules` with the voice rule appended when the turn is a voice one. */
export const withVoiceRule = (rules, voice) => (voice === true ? `${rules}\n\n${VOICE_RULE}` : rules);
