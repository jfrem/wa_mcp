# WhatsApp Web MCP Server

Servidor MCP para controlar `https://web.whatsapp.com` desde clientes compatibles con Model Context Protocol y para habilitar automatizaciones donde un modelo de IA pueda leer y responder mensajes.

## Qué incluye

- autenticación vía Chrome DevTools Protocol;
- tools MCP para revisar estado de sesión;
- listado de chats visibles;
- detección de chats no leídos;
- búsqueda de chats/contactos desde el buscador principal;
- activación de filtros visibles de la barra lateral;
- lectura de mensajes visibles de un chat;
- envío de mensajes desde WhatsApp Web;
- runner opcional de auto-respuesta con un módulo `generateReply(context)`.

## Casos de uso

Estos son casos de uso concretos que el proyecto ya soporta o habilita directamente sobre WhatsApp Web:

1. Auditar conversaciones para identificar patrones que anteceden el cierre de ventas.
2. Detectar leads con alta intención de compra a partir de señales como precio, disponibilidad, pago o entrega.
3. Encontrar conversaciones estancadas que necesitan seguimiento comercial inmediato.
4. Detectar preguntas abiertas de clientes que siguen sin respuesta.
5. Detectar promesas comerciales pendientes, como envío de precio, link, catálogo o confirmación.
6. Priorizar chats con mayor probabilidad de conversión para enfocar primero el esfuerzo del equipo.
7. Clasificar conversaciones por etapa comercial, por ejemplo exploración, interés, objeción o cierre.
8. Detectar objeciones frecuentes para mejorar scripts, manejo de dudas y argumentos de venta.
9. Medir tiempos de respuesta del negocio y relacionarlos con riesgo de pérdida o cierre.
10. Identificar cuándo conviene reactivar una conversación que quedó esperando al cliente.
11. Generar seguimientos sugeridos para leads interesados que dejaron de responder.
12. Proponer respuestas contextualizadas para acelerar atención comercial sin perder control humano.
13. Crear borradores revisables antes de enviar respuestas sensibles o de cierre.
14. Confirmar respuestas en un flujo de doble paso con `reviewToken` antes del envío real.
15. Analizar notas de voz e imágenes para no perder contexto relevante dentro del proceso de venta.
16. Resumir el historial reciente de un chat para que un vendedor retome contexto rápidamente.
17. Construir un tablero operativo con urgencias, promesas pendientes y oportunidades de alto valor.
18. Detectar conversaciones con riesgo de pérdida por demora, falta de seguimiento o secuencia comercial deficiente.
19. Estandarizar criterios de priorización entre vendedores, agentes o automatizaciones.
20. Generar insights accionables sobre variables que influyen en conversión, productividad y cierre de ventas.

Caso destacado:

- auditoría conversacional para optimización comercial: el sistema inspecciona conversaciones de WhatsApp para detectar señales como preguntas abiertas, promesas pendientes, objeciones, intención de compra, tiempos de espera y conversaciones estancadas. A partir de ese análisis, produce prioridades, seguimiento sugerido e insights que ayudan a optimizar estrategia comercial, elevar conversión y mejorar productividad operativa.

## Alcance del MVP

Este proyecto implementa un MVP operativo adaptado a WhatsApp Web:

- usa Chrome con `--remote-debugging-port`;
- opera contra la UI real de WhatsApp Web;
- expone tools a un modelo vía MCP;
- permite montar un bot de respuesta encima del mismo stack.

No usa la API oficial de WhatsApp Business. Este enfoque depende de selectores de la UI web y puede requerir ajustes si WhatsApp cambia su frontend.

## Requisitos

- Node.js 20+;
- Google Chrome;
- una sesión de WhatsApp disponible para escanear QR o ya autenticada.

## Instalación

```bash
npm install
npm run build
```

## Ejecutar servidor MCP

```bash
npm start
```

Puerto CDP por defecto:

- `WHATSAPP_WEB_CDP_PORT=9222`

## Abrir Chrome con CDP

En Windows:

```bat
abrir_chrome_cdp_whatsapp.bat
```

Esto abre Chrome con un perfil dedicado en:

```text
%USERPROFILE%\.whatsapp-web-mcp\chrome-profile
```

Luego abre `https://web.whatsapp.com` para que escanees el QR si hace falta.

## Tools MCP

Nota general:

- las tools que interactuan con WhatsApp Web aceptan `remote_debugging_port` opcional;
- si no lo envias, el servidor usa `WHATSAPP_WEB_CDP_PORT` o el default `9222`.

### `auto_auth_whatsapp_web`

Conecta o lanza Chrome con CDP y espera a que WhatsApp Web quede autenticado.

Ejemplo:

```json
{
  "name": "auto_auth_whatsapp_web",
  "arguments": {
    "mode": "connect",
    "remote_debugging_port": 9222,
    "wait_for_login_seconds": 60
  }
}
```

### `check_auth`

Devuelve si la sesión está autenticada, esperando QR o cargando.

### `wait_for_activity_event`

Espera el siguiente evento de actividad de WhatsApp Web y devuelve:

- `incoming-message` cuando detecta un mensaje entrante visible;
- `unread-chat` cuando cambia el conjunto visible de chats no leídos.

Si no ocurre nada dentro del `timeout_ms`, devuelve sin evento.

### `list_chats`

Lista los chats visibles en la barra lateral.

### `list_unread_chats`

Lista solo los chats visibles con mensajes no leídos.

### `search_chats`

Usa el buscador principal de WhatsApp Web y devuelve los resultados visibles.

### `resolve_chat`

Resuelve uno o varios chats candidatos a partir de texto y devuelve un bloque JSON con:

- `chat_key`
- `title`
- `index`
- `preview`
- `match_reason`
- `candidate_count`
- `disambiguation_needed`

Úsala cuando quieras descubrir primero el `chat_key` y luego operar con tools como `read_chat_messages`, `send_message`, `list_voice_notes` o `transcribe_voice_note`.

Nota:

- la tool inspecciona internamente una ventana de candidatos más amplia que la cantidad devuelta para reducir falsos negativos de ambigüedad.
- `chat_key` es una clave operativa de la UI. Si WhatsApp expone atributos reutilizables del row, suele servir para reabrir el chat. Si no los expone, el servidor usa un fallback `volatile:title::...`, útil dentro de la sesión pero no garantizado como identificador durable entre reordenamientos o chats con el mismo título.

### `get_chat_context`

Resuelve un chat por `query`, `chat_name` o `chat_key` y devuelve un bloque JSON con:

- chat resuelto
- `chat_key`
- mensajes recientes
- `disambiguation_needed`

Úsala cuando quieras darle a un agente contexto listo para responder sin hacer varias llamadas previas.

Parámetros útiles:

- `preferred_chat_key`: si ya resolviste candidatos antes, fuerza el candidato preferido
- `exact_match`: prioriza coincidencia exacta por título antes de tomar el primer resultado
- `message_limit`: cantidad de mensajes recientes a devolver
- `candidate_limit`: cantidad de candidatos a inspeccionar para detectar ambigüedad

Compatibilidad:

- `limit` sigue funcionando como alias de `message_limit`, pero la tool usa internamente una ventana de resolución más amplia para no ocultar chats ambiguos.

### `clear_search`

Limpia el buscador principal. Úsala antes de aplicar filtros globales si vienes de una búsqueda.

### `apply_chat_filter`

Activa un filtro visible de la barra lateral, por ejemplo `Todos`, `No leídos`, `Favoritos` o `Grupos`.

### `open_chat_by_search`

Busca por texto y abre el resultado visible indicado.

### `open_chat_by_key`

Abre un chat usando un `chat_key` previamente descubierto.

Parámetros útiles:

- `chat_key`: clave operativa del chat en la UI
- `chat_name`: texto opcional de apoyo para fallback por búsqueda si el chat no está visible en la barra lateral

Comportamiento:

- primero intenta abrir el chat recorriendo la barra lateral por `chat_key`;
- si no lo encuentra y envías `chat_name`, usa ese texto como fallback de búsqueda;
- no usa `chat_key` como texto de búsqueda.

Si el `chat_key` empieza por `volatile:title::`, úsalo como ayuda operativa de la sesión actual y conserva también `chat_name`. Si hay varios chats con el mismo título visible, sigue siendo necesaria la desambiguación por contexto o `chat_index`.

### `read_chat_messages`

Abre un chat por nombre y devuelve los mensajes visibles más recientes.

Acepta `chat_name` o `chat_key`. Si ya conoces `chat_key`, puedes usarlo sin depender del nombre visible.

Notas:

- si un mensaje visible contiene una imagen real sin texto, la tool devuelve el placeholder `[Imagen]`;
- si quieres acceder al archivo visual renderizado de esa imagen, usa `list_image_messages` y luego `download_image_message`.

Ejemplo:

```json
{
  "name": "read_chat_messages",
  "arguments": {
    "chat_name": "Equipo Producto",
    "limit": 15
  }
}
```

### `send_message`

Abre un chat por nombre y envía un mensaje.

Acepta `chat_name` o `chat_key`. Si ya conoces `chat_key`, puedes usarlo sin depender del nombre visible.

Ejemplo:

```json
{
  "name": "send_message",
  "arguments": {
    "chat_name": "Equipo Producto",
    "text": "Mensaje enviado desde el MCP server"
  }
}
```

### `download_voice_note`

Abre un chat y descarga una nota de voz del historial a un archivo temporal local.

Acepta `chat_name` o `chat_key`.

Parámetros útiles:

- `chat_key`: clave operativa del chat si ya fue descubierta
- `voice_note_index`: índice 1-based contando desde la nota de voz más reciente del historial cargado. `1` es la más reciente, `2` la anterior, etc.
- `direction`: `in`, `out` o `any`

Compatibilidad:

- `download_latest_voice_note` sigue disponible como alias.

### `list_image_messages`

Enumera imagenes reales del historial cargado de un chat y recorre de forma acotada mensajes anteriores cuando hace falta.

Devuelve:

- índice 1-based desde la más reciente encontrada;
- dirección `in` o `out`;
- caption visible si existe;
- `meta` visible si existe;
- `fingerprint` local de la imagen detectada.

Notas:

- ignora emojis, stickers inline pequenos y placeholders `data:image/...` sin evidencia de media real;
- puede recorrer mensajes anteriores de forma acotada para encontrar imagenes mas viejas.

Aporta acceso a la presencia visual del mensaje, pero no hace OCR ni análisis multimodal por sí solo.

### `download_image_message`

Descarga una imagen real del historial cargado de un chat a un archivo temporal local y recorre de forma acotada mensajes anteriores cuando hace falta.

Parámetros útiles:

- `chat_key`: clave operativa del chat si ya fue descubierta
- `image_index`: índice 1-based contando desde la imagen más reciente del historial cargado. `1` es la más reciente, `2` la anterior, etc.
- `direction`: `in`, `out` o `any`

Devuelve:

- `path`
- `mimeType`
- `sourceUrl`
- `chatName`
- `caption`

Notas:

- ignora emojis, stickers inline pequenos y placeholders `data:image/...` que no correspondan a media real;
- puede recorrer mensajes anteriores de forma acotada para alcanzar imagenes mas viejas.

### `get_latest_media_summary`

Detecta el ultimo medio relevante del chat en una sola llamada.

Comportamiento:

- inspecciona mensajes recientes para encontrar el ultimo medio real;
- si es una imagen, la descarga;
- si es una nota de voz, la descarga y puede transcribirla de forma opcional;
- devuelve un JSON con el mensaje origen y el artefacto enriquecido.

Parámetros útiles:

- `chat_key`: clave operativa del chat si ya fue descubierta
- `message_limit`: cuantos mensajes recientes inspeccionar para detectar el ultimo medio
- `include_transcription`: si el ultimo medio es una nota de voz, intenta incluir la transcripcion; por defecto es `false`
- `direction`: `in`, `out` o `any`

Comportamiento de fallback:

- si pides transcripcion y el worker de audio no esta disponible o falla, la tool devuelve igualmente la nota de voz descargada y reporta `transcription.available: false`.

### `describe_latest_image`

Descarga la imagen real mas reciente del chat y, si hay un worker visual configurado, devuelve tambien una descripcion automatica.

Comportamiento:

- usa la misma deteccion robusta de imagen real;
- descarga la imagen mas reciente;
- si `WHATSAPP_IMAGE_DESCRIBE_SCRIPT` apunta a un worker Node compatible, envia la imagen para describirla;
- si no hay worker configurado, devuelve la imagen y un estado explicito indicando que la descripcion automatica no esta disponible.

Contrato del worker:

- recibe por `stdin` un JSON con `imagePath` y `prompt` opcional;
- devuelve por `stdout` un JSON con `description` y `model` opcional.

### `get_chat_timeline_summary`

Devuelve una linea de tiempo reciente del chat en orden cronologico, con enriquecimiento opcional de medios.

Comportamiento:

- incluye los mensajes recientes del tramo visible/cargado;
- detecta imagenes reales y notas de voz dentro de ese tramo;
- puede enriquecer una cantidad acotada de medios con descarga, transcripcion o descripcion visual;
- genera un `summary` textual automatico y una lista breve de `highlights`;
- mantiene el orden cronologico original de la conversacion.

Parámetros útiles:

- `message_limit`: cantidad de mensajes recientes a incluir
- `media_limit`: cantidad maxima de medios recientes a enriquecer
- `include_transcriptions`: si es `true`, intenta transcribir notas de voz enriquecidas
- `include_image_descriptions`: si es `true`, intenta describir visualmente imagenes enriquecidas
- `direction`: `in`, `out` o `any`; afecta que medios se consideran para el enriquecimiento

Fallbacks:

- si falla la transcripcion de una nota de voz enriquecida, la linea de tiempo conserva la nota descargada y reporta `transcription.available: false`;
- si no hay worker visual configurado para una imagen enriquecida, la linea de tiempo conserva la imagen descargada y reporta `imageDescription.available: false`.

### `audit_conversations`

Audita chats visibles o no leidos para detectar conversaciones con parones, preguntas abiertas o seguimientos pendientes.

Devuelve:

- `profile`
- `scope`
- `count`
- `items`
- `warnings`

Cada item incluye:

- `chatName`
- `chatKey`
- `unreadCount`
- `priority`
- `status`
- `waitingOn`
- `stallType`
- `idleMinutes`
- `confidence`
- `signals`
- `lastRelevantMessage`
- `suggestedAction`
- `nextBestAction`

Parámetros útiles:

- `profile`: `generic` o `sales`
- `scope`: puede salir como `unread`, `visible`, `query` o `chat_keys` segun el alcance efectivo usado
- `query`: si se envía, audita coincidencias filtradas de búsqueda y desplaza el uso de `scope`
- `chat_keys`: lista explícita de `chat_key`; tiene precedencia sobre `query` y `scope`
- `max_chats`: cantidad maxima de chats a auditar
- `message_limit`: cantidad de mensajes recientes a inspeccionar por chat
- `stale_after_minutes`: umbral base para marcar un paron

Comportamiento:

- no envia mensajes;
- no modifica chats;
- resuelve el alcance con esta precedencia: `chat_keys` -> `query` -> `scope`;
- prioriza los resultados por urgencia y tiempo de espera;
- si un chat falla durante la lectura, el lote continua y agrega un warning.

Perfiles:

- `generic`: detector neutral de parones, preguntas abiertas, promesas no resueltas y seguimientos pendientes.
- `sales`: interpreta las mismas señales con enfoque comercial y añade `profileData` con:
  - `salesStage`
  - `salesSignal`
  - `lossRisk`
  - `recommendedSalesAction`
  - las señales comerciales se calculan sobre el paso activo actual, no sobre una intencion comercial vieja ya respondida.

### `conversation_attention_board`

Construye un tablero operativo a partir de `audit_conversations`, agrupando chats por buckets accionables.

Devuelve:

- `summary`
- `topActions`
- `buckets`
- `items`
- `warnings`

Buckets actuales:

- `urgentNow`
- `followUpToday`
- `waitingOnCustomer`
- `promisesToFulfill`
- `stalledHighValue`
- `healthy`
- `monitoring`

Comportamiento:

- reutiliza exactamente la misma auditoria base;
- no envia mensajes;
- no cambia chats;
- agrupa resultados para que un humano o agente sepa por donde empezar;
- garantiza que todo chat auditado quede representado en al menos un bucket operativo;
- `topActions` resume las acciones prioritarias de la corrida.

Entrada:

- usa los mismos parametros operativos de `audit_conversations`
- misma precedencia de alcance: `chat_keys` -> `query` -> `scope`

### `get_actionable_feed`

Construye un feed read-only de acciones sugeridas a partir del mismo `conversation-state` compartido por auditoria y scoring.

Devuelve:

- `data`
- `meta.has_more`
- `warnings`

Cada item incluye:

- `chatId`
- `priority`
- `reason`
- `summary`
- `actions`

Cada `SuggestedAction` expuesto por el feed incluye como contrato minimo:

- `actionId`
- `chatKey`
- `type`
- `label`
- `priority`
- `reason`
- `preview`
- `strategy`
- `recommendedTool`
- `recommendedArgs`
- `executionMode`
- `requiresHumanReview`

Y puede incluir adicionalmente:

- `kind`
- `confidence`
- `evidence`
- `generatedAt`
- `expiresAt`
- `cooldownUntil`
- `previewTool`
- `previewArgs`
- `confirmTool`
- `blockingSignals`

Comportamiento:

- no envia mensajes;
- no modifica chats;
- usa `conversation-state` como base compartida con `audit_conversations`;
- las acciones de respuesta apuntan al flujo seguro `review_then_confirm`;
- `recommendedTool` nunca apunta a envio directo en el release actual.

Parámetros útiles:

- `chat_keys`: lista explicita de `chat_key`; si no viene, usa chats visibles
- `strategies`: estrategias activas; por defecto `unanswered_message` y `follow_up_simple`
- `limit`: cantidad maxima de items devueltos; maximo `50`
- `message_limit`: ventana de mensajes recientes usada tanto para detectar la accion como para hidratar `previewArgs` y `recommendedArgs`
- `stale_after_minutes`: umbral base compartido con `audit_conversations` para marcar conversaciones estancadas y habilitar follow-ups

Errores parciales:

- estrategia desconocida -> warning
- chat no visible -> warning
- fallo de lectura por chat -> warning parcial y el resto del lote continua

Notas de ejecucion sugerida:

- para acciones `follow_up`, el feed incluye `seed_reply` dentro de `previewArgs` y `recommendedArgs`;
- `draft_reply_with_media_context` y `review_reply_for_confirmation` consumen `seed_reply` para conservar la intencion concreta sugerida por la accion.

### `reply_with_context`

Construye una respuesta sugerida a partir del contexto reciente del chat.

Comportamiento:

- usa la linea de tiempo reciente como base;
- prioriza el ultimo evento entrante real del tramo reciente; si lo mas nuevo es una imagen o nota de voz, responde sobre ese medio antes que sobre texto entrante mas antiguo;
- genera una sugerencia de respuesta con heuristica local;
- por defecto no envia nada;
- si `mode=send`, envia exactamente la respuesta sugerida.

Parámetros útiles:

- `mode`: `suggest` o `send`; por defecto `suggest`
- `tone`: `neutral`, `warm`, `brief` o `supportive`
- `seed_reply`: texto semilla opcional para fijar una recomendacion operativa concreta
- `max_length`: longitud maxima aproximada de la respuesta sugerida
- `alternative_index`: indice 1-based de `alternatives[]`; maximo actual `3`
- `draft_signature`: firma del borrador revisado previamente
- `selected_reply`: texto exacto revisado previamente
- `message_limit`: cuantos mensajes recientes inspeccionar
- `media_limit`: cuantos medios recientes enriquecer para entender mejor el contexto
- `include_transcriptions`: si es `true`, intenta usar notas de voz transcritas para mejorar la respuesta
- `include_image_descriptions`: si es `true`, intenta usar descripcion visual de imagenes para mejorar la respuesta

Compatibilidad:

- sigue siendo util si quieres hacer una llamada unica en `mode=suggest` o `mode=send`;
- para flujos review/send nuevos, se recomienda usar `review_and_send_reply` + `confirm_reviewed_reply`.

Para un flujo manual compatible de revision y envio:

1. llama `draft_reply_with_media_context`
2. conserva `draft.draftSignature`
3. envia con `reply_with_context` usando `draft_signature` y una de estas opciones:
   `selected_reply`
   o `alternative_index`

Si el contexto cambio entre la revision y el envio, `reply_with_context` falla en vez de mandar una alternativa distinta por accidente.

### `draft_reply_with_media_context`

Construye un borrador enriquecido de respuesta sin enviarlo.

Devuelve:

- `draftSignature`
- `recommendedReply`
- `alternatives`
- `reasoningSummary`
- `basedOn`
- `sendable`
- `recommendedOptionId`
- `timeline`

Comportamiento:

- usa la linea de tiempo reciente como base;
- prioriza el ultimo evento entrante real;
- propone una respuesta recomendada y hasta 3 alternativas;
- devuelve ids estables por opcion (`recommendedOptionId` y `alternatives[].optionId`);
- explica brevemente por que la recomendacion se apoya en ese texto, imagen o nota de voz;
- no envia nada.

Parámetros útiles:

- `tone`: tono preferido del borrador recomendado
- `message_limit`: cuantos mensajes recientes inspeccionar
- `media_limit`: cuantos medios recientes enriquecer
- `include_transcriptions`: si es `true`, intenta usar transcripciones
- `include_image_descriptions`: si es `true`, intenta usar descripcion visual

### `review_and_send_reply`

Genera un borrador revisable listo para confirmacion posterior con un `reviewToken` estable.

Nota:

- esta tool no envia nada todavia;
- ahora devuelve `sent: false`;
- el nombre se conserva por compatibilidad, pero el alias recomendado para flujos nuevos es `review_reply_for_confirmation`.

Devuelve:

- `reviewToken`
- `sent`
- `expiresAt`
- `recommendedReply`
- `recommendedOptionId`
- `alternatives`
- `contextSummary`
- `sendable`
- `draft`
- `timeline`

Comportamiento:

- construye el mismo borrador enriquecido de `draft_reply_with_media_context`;
- persiste una referencia estable al borrador revisado;
- no envia nada;
- deja preparado un segundo paso seguro con `confirm_reviewed_reply`.

Parámetros útiles:

- `review_ttl_seconds`: vida util del `reviewToken`; por defecto `600`
- `tone`, `message_limit`, `media_limit`, `include_transcriptions`, `include_image_descriptions`: igual que en `draft_reply_with_media_context`

### `confirm_reviewed_reply`

Confirma y envia exactamente una opcion previamente revisada con `reviewToken`.

Parámetros útiles:

- `review_token`: token devuelto por `review_and_send_reply`
- `option_id`: `recommendedOptionId` o `alternatives[].optionId`; si se omite, usa la recomendacion revisada por defecto

Garantias:

- si el `reviewToken` expiro, falla;
- si el contexto visible del chat cambio, falla;
- si el `option_id` ya no pertenece al borrador revisado, falla;
- si todo coincide, envia exactamente esa opcion.

### `review_reply_for_confirmation`

Alias recomendado de `review_and_send_reply`.

Tiene el mismo contrato, pero el nombre describe mejor que la primera llamada solo prepara la revision y no realiza el envio.

### `list_voice_notes`

Enumera notas de voz del historial cargado de un chat.

Devuelve:

- índice 1-based desde la más reciente encontrada;
- dirección `in` o `out`;
- duración visible;
- `meta` visible si existe;
- `fingerprint` local de la nota detectada.

Acepta `chat_name` o `chat_key`. Si ya conoces `chat_key`, puedes usarlo sin depender del nombre visible.

### `transcribe_voice_note`

Descarga una nota de voz del historial del chat y la transcribe con un worker local de `faster-whisper`.

Acepta `chat_name` o `chat_key`.

Restricciones operativas:

- `model`: `tiny`, `base`, `small`, `medium`, `large-v3`
- `device`: `cpu`, `cuda`
- `compute_type`: `default`, `auto`, `int8`, `int8_float16`, `int8_float32`, `float16`, `float32`

Ejemplo:

```json
{
  "name": "transcribe_voice_note",
  "arguments": {
    "chat_name": "Amor 🤍",
    "chat_key": "volatile:title::Amor 🤍",
    "voice_note_index": 2,
    "direction": "in",
    "language": "es",
    "model": "small",
    "beam_size": 5
  }
}
```

Compatibilidad:

- `transcribe_latest_voice_note` sigue disponible como alias.

### `get_server_info`

Devuelve la configuración básica y las tools disponibles.

## Uso con un modelo

La forma recomendada es:

1. ejecutar este servidor como MCP server;
2. conectarlo a tu cliente MCP o runtime de agentes;
3. instruir al modelo para que:
   - use `check_auth` antes de operar;
   - use `clear_search` antes de cambiar entre búsqueda y filtros globales;
   - use `search_chats` cuando necesite encontrar un chat no visible;
   - use `apply_chat_filter` para cambiar el contexto visible de la barra lateral;
   - use `list_unread_chats` para descubrir pendientes;
   - use `read_chat_messages` para tomar contexto;
   - use `send_message` solo cuando ya tenga respuesta final.

Prompt operativo sugerido para el modelo:

```text
Tu canal de salida hacia WhatsApp Web es el servidor MCP.
Antes de responder, revisa auth y lee el contexto visible del chat.
No inventes destinatarios ni cambies de chat sin indicación.
Si hay ambigüedad en el nombre del chat, usa el indice del chat visible.
Envía mensajes breves, claros y sin repetir texto del historial salvo que sea necesario.
```

## Runner opcional de auto-respuesta

Además del MCP server, el proyecto trae un runner:

```bash
npm run bot
```

Este proceso:

- espera a que WhatsApp Web esté listo;
- instala un `MutationObserver` dentro de WhatsApp Web;
- espera eventos reales de cambios en chats o mensajes entrantes;
- lee el historial reciente;
- llama una función `generateReply(context)`;
- envía la respuesta generada.

### Modo demo

Si no defines un módulo de respuesta, el bot usa un responder mínimo de prueba.

### Conectar tu propio modelo

Define:

```text
WHATSAPP_BOT_RESPONDER_MODULE=./responder.example.mjs
```

El módulo debe exportar:

```js
export async function generateReply(context) {
  return "respuesta";
}
```

La ruta se resuelve dentro del directorio `responders/`.

Restricciones:

- debe apuntar a un archivo real dentro de `responders/`;
- no se aceptan escapes por rutas relativas fuera de ese directorio;
- solo se aceptan extensiones `.js`, `.mjs` o `.cjs`.

El objeto `context` incluye:

- `chatKey`
- `chatName`
- `messages`
- `systemPrompt`
- `latestVoiceNote` cuando el ultimo mensaje entrante visible es una nota de voz y se pudo transcribir

Variables útiles:

- `WHATSAPP_BOT_HISTORY_LIMIT=12`
- `WHATSAPP_BOT_EVENT_TIMEOUT_MS=300000`
- `WHATSAPP_BOT_BACKFILL_MS=20000`
- `WHATSAPP_BOT_SYSTEM_PROMPT=...`
- `WHATSAPP_BOT_INCLUDE_CHATS=...`
- `WHATSAPP_BOT_INCLUDE_PATTERNS=...`
- `WHATSAPP_BOT_EXCLUDE_CHATS=...`
- `WHATSAPP_BOT_EXCLUDE_PATTERNS=...`
- `WHATSAPP_BOT_COOLDOWN_MS=45000`
- `WHATSAPP_BOT_DRY_RUN=false`
- `WHATSAPP_BOT_CONFIG_FILE=...`
- `WHATSAPP_BOT_MIN_VOICE_TRANSCRIPT_CHARS=12`
- `WHATSAPP_BOT_MAX_VOICE_NO_SPEECH_PROB=0.6`
- `WHATSAPP_BOT_MIN_VOICE_AVG_LOGPROB=-1.2`

## Transcripcion local de audios con faster-whisper

El proyecto ya puede invocar un worker local en Python para transcribir notas de voz.

Archivos:

- `src/transcription.ts`
- `scripts/transcribe_faster_whisper.py`

Requisitos recomendados:

1. Instala Python 3.10+.
2. Crea un entorno virtual y activa el del proyecto o usa el que ya existe en `.venv`.
3. Instala `faster-whisper` en ese entorno:

```bash
pip install -r requirements.transcription.txt
```

Variables opcionales:

- `WHATSAPP_TRANSCRIBE_PYTHON_BIN=python`
- `WHATSAPP_TRANSCRIBE_PYTHON_ARGS=`
- `WHATSAPP_TRANSCRIBE_SCRIPT=./scripts/transcribe_faster_whisper.py`
- `WHATSAPP_TRANSCRIBE_MODEL=small`
- `WHATSAPP_TRANSCRIBE_BEAM_SIZE=5`
- `WHATSAPP_TRANSCRIBE_DEVICE=cpu`
- `WHATSAPP_TRANSCRIBE_COMPUTE_TYPE=int8`

## Politica de limpieza de tmp

El proyecto ahora limpia `tmp/` automaticamente para evitar crecimiento sin control.

Reglas:

- rota archivos `.log` cuando superan el limite configurado;
- elimina directorios temporales residuales no gestionados;
- limpia `tmp/reply-reviews/` borrando tokens expirados o invalidos;
- elimina audios temporales demasiado antiguos;
- conserva solo un numero maximo de audios temporales;
- si `tmp/` supera el presupuesto total, elimina primero los temporales mas viejos;
- no elimina `bot.config.json`, `bot-state.json`, `bot-health.json` ni `bot-daemon.json`.

Comandos operativos:

```bash
npm run tmp:status
npm run tmp:clean
npm run tmp:prune
```

- `tmp:status`: muestra un resumen JSON de uso y categorias dentro de `tmp/`.
- `tmp:clean`: aplica la limpieza conservadora normal.
- `tmp:prune`: elimina de forma agresiva todos los temporales no preservados, incluyendo directorios gestionados como `reply-reviews/`.

Extensiones de audio temporales contempladas por la limpieza:

- `.ogg`
- `.opus`
- `.mp3`
- `.bin`

Variables opcionales:

- `WHATSAPP_TMP_MAX_AUDIO_AGE_HOURS=72`
- `WHATSAPP_TMP_MAX_AUDIO_FILES=20`
- `WHATSAPP_TMP_MAX_BYTES_MB=512`
- `WHATSAPP_TMP_MAX_LOG_BYTES_MB=10`

Notas:

- El proyecto intenta usar primero `.venv/Scripts/python.exe` en Windows o `.venv/bin/python` en Unix.
- En Windows, si no defines `WHATSAPP_TRANSCRIBE_PYTHON_BIN`, Node intenta usar `py -3`.
- Si tienes GPU NVIDIA y el entorno correcto, puedes usar `WHATSAPP_TRANSCRIBE_DEVICE=cuda`.
- La tool `transcribe_latest_voice_note` descarga primero el audio y luego llama el worker Python.

## Bot con notas de voz

El bot ahora puede detectar el placeholder `[Nota de voz]` en el historial visible, descargar la ultima nota de voz del chat y pasar su transcripcion al responder.

Flujo:

1. detecta el ultimo mensaje entrante;
2. si el mensaje visible es una nota de voz, descarga el audio;
3. lo transcribe con `faster-whisper`;
4. entrega `latestVoiceNote.transcription.text` al modulo `generateReply(context)`.

Esto no envia mensajes por si solo durante pruebas manuales; el envio sigue dependiendo de tu configuracion del bot y de `dryRun`.

Guardrails para audio:

- si la transcripcion sale demasiado corta, el bot no responde;
- si la probabilidad promedio de no-habla es muy alta, el bot no responde;
- si la confianza promedio aparente (`avgLogProb`) es demasiado baja, el bot no responde.

### Operación robusta

El runner ya no depende de un solo chat. El modo recomendado es multi-chat:

- escucha eventos en vivo desde WhatsApp Web;
- hace barrido periódico de chats no leídos como respaldo;
- persiste por chat el último mensaje entrante procesado;
- usa la mejor clave operativa disponible del chat para reducir mezclas entre conversaciones con el mismo nombre visible; si WhatsApp no expone un identificador reutilizable, el sistema cae a una clave volátil por título y sigue dependiendo del contexto visible para la desambiguación;
- evita doble respuesta tras reinicios;
- aplica cooldown por chat;
- permite allowlist y blocklist por nombre exacto o regex.

Configuración recomendada:

1. Copia `bot.config.example.json` a `tmp/bot.config.json`.
2. Ajusta `include*` y `exclude*` según tus reglas.
3. Ejecuta:

```bash
npm run bot
```

Si quieres dejarlo en segundo plano sin una terminal abierta, usa:

```bash
npm run bot:bg:start
npm run bot:bg:status
npm run bot:bg:stop
```

Ese modo usa un proceso `detached` de Node con PID persistido en:

```text
tmp/bot-daemon.json
```

No depende de PowerShell ni de una shell específica: el arranque en segundo plano usa `spawn` de Node con el mismo mecanismo en Windows, Linux y macOS.

`bot:bg:status` ahora distingue entre un proceso realmente sano (`running`) y un proceso con `health` stale (`stale_health`) si deja de emitir heartbeat fresco.

Reglas:

- Si `includeChats` e `includePatterns` están vacíos, el bot considera todos los chats.
- `excludeChats` y `excludePatterns` siempre tienen prioridad.
- Si una regex en `includePatterns` o `excludePatterns` es inválida, el bot falla al arrancar en vez de ignorarla silenciosamente.
- `cooldownMs` limita la frecuencia de respuesta por chat.
- `dryRun=true` registra la respuesta en logs pero no la envía.

## Coordinacion de acceso a la UI

El servidor MCP y el bot comparten la misma pestaña de WhatsApp Web. Para evitar carreras entre procesos, el proyecto serializa las operaciones que mutan o dependen del chat activo mediante un lock local en `tmp/whatsapp-ui.lock`.

Notas:

- si una operación encuentra la UI ocupada, espera brevemente antes de fallar;
- puedes ajustar el comportamiento con `WHATSAPP_UI_LOCK_WAIT_MS` y `WHATSAPP_UI_LOCK_STALE_MS`;
- esto reduce respuestas al chat equivocado cuando usas MCP y bot sobre la misma sesión.

## Limitaciones

- depende de la UI de WhatsApp Web;
- la lectura general de mensajes sigue dependiendo del DOM visible/cargado, aunque las tools de notas de voz recorren historial cargado de forma acotada;
- si hay varios chats con el mismo nombre, conviene usar `chat_index`;
- cambios de layout en WhatsApp Web pueden romper selectores.

## Release Checklist

Antes de dar una version por buena:

1. Ejecuta `npm run release:check`.
2. Verifica `npm run bot:bg:start`.
3. Verifica `npm run bot:bg:status` y confirma `status: "running"`.
4. Si usas responder propio, valida que cargue desde `responders/` con extension `.js`, `.mjs` o `.cjs`.
5. Si usas descripcion visual o transcripcion, confirma que los workers externos esten configurados.

## Archivos principales

- `src/index.ts`
- `src/whatsapp.ts`
- `src/bot.ts`
- `abrir_chrome_cdp_whatsapp.bat`

