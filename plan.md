# PLANNING_ORCHESTRATOR_v1.2

> Documento canonico: `plan.md` | Version de documento: v1.2 | Fecha: 2026-03-30
> **Proyecto:** `whatsapp-web-mcp-server`
> **Modo:** `STRICT`
> **Cambios respecto a v1.1:** Endurecimiento incremental del catalogo operativo, transiciones completas de review, state-store restringido por transiciones y contratos minimos adicionales para tests, `.env.example`, auditoria de aprobaciones y consistencia de runtime/store.

---

## 0. Modo del documento

### 0.1 Regla de seleccion

- `STRICT` es el modo activo.
- `COMPACT` no aplica porque:
  - el cambio afecta mas de 2 archivos;
  - hay cambios de contrato operativo;
  - hay riesgo material de operacion, automatizacion y autorizacion de envio.

### 0.2 Regla de enforcement

- Todo sprint derivado de este documento se considera `STRICT`.

### 0.3 Regla de placeholders

- No quedan placeholders sintacticos activos como `[X]`, `[N]`, `[tipo]` o similares en este documento.
- Todo item no confirmado queda marcado como `INFERRED`, `PROVISIONAL` o `BLOCKED`.
- Todo concepto material no completamente cerrado debe expresarse con contrato, restriccion o etiqueta normativa explicita; si no puede cerrarse, no debe quedar implicito como placeholder semantico.

---

## 1. Objetivo del documento

Estandarizar la implementacion de un **orquestador reactivo y un cliente custom operativo para WhatsApp Web** que coordinen las capacidades existentes del servidor MCP y sus modulos internos reutilizables para operar flujos de atencion, ventas, soporte y seguimiento conversacional con control humano configurable.

Alcance de gobierno:

- este documento gobierna primero al `orchestrator` y, de forma subordinada, al `custom-client`;
- si hay conflicto entre ambos, prevalece el contrato del `orchestrator`.

Este documento es la fuente de verdad para agentes de IA que ejecuten la implementacion de forma autonoma o guiada.

---

## 2. Problema a resolver

El repositorio ya expone tools MCP utiles y un bot reactivo basico, pero hoy la operacion avanzada sigue fragmentada:

- las tools existen y sus modulos internos reutilizables ya cubren capacidades utiles, pero no hay un motor central que observe, priorice, decida y ejecute flujos completos;
- el bot actual responde de forma simple sobre mensajes entrantes, pero no usa la capa de auditoria, tablero, review ni accionabilidad avanzada;
- los clientes MCP genericos como Cursor, Claude o ChatGPT no son un runtime operativo reactivo continuo;
- no existe una interfaz especializada para cola operativa, revision humana, politicas y observabilidad.

**Problema tecnico concreto:**

- El consumidor del sistema necesita un runtime que transforme eventos de WhatsApp Web en acciones operativas verificables.
- El sistema lo resuelve con un orquestador que reutiliza la capa de capacidades del proyecto, aplique politicas y persista acciones operativas materializadas como jobs, resultados y evidencia humana.
- Restricciones tecnicas no negociables:
  - seguir usando WhatsApp Web via CDP, no la API oficial;
  - preservar el servidor MCP actual como capa de capacidades;
  - no enviar mensajes automaticamente sin una politica explicita;
  - no romper los contratos MCP ya publicados en `src/index.ts`.
- Integraciones externas obligatorias:
  - WhatsApp Web via Chrome DevTools Protocol;
  - proveedor de IA por API para tareas cognitivas.
- Persistencia local obligatoria:
  - almacenamiento JSON inicial separado para estado operativo, jobs y evidencia humana.

---

## 3. Estado normativo y nivel de certeza

### 3.1 Etiquetas obligatorias

- `CONFIRMED`: modulo MCP actual, bot actual, daemon actual, tools de auditoria y reply ya existen en el repo.
- `CONFIRMED`: storage local en JSON para v1.0.
- `INFERRED`: migracion a SQLite en v1.5 o v2.0 si el volumen de jobs o la concurrencia lo requiere.
- `PROVISIONAL`: soporte de auth por suscripcion para proveedor IA.
- `BLOCKED`: despliegue publico multiusuario con sesiones compartidas endurecidas.

### 3.2 Regla de autonomia

- Los agentes autonomos pueden implementar items `CONFIRMED`.
- Los items `INFERRED` pueden implementarse si no cambian el contrato MCP publico y quedan documentados en ADR.
- Los items `PROVISIONAL` y `BLOCKED` no se implementan sin confirmacion explicita.

Regla de mapeo:

- en este documento, el `Estado normativo` declarado en cada operacion de la seccion 9 y en el catalogo de 8.5 es la etiqueta que gobierna a ese item concreto;
- las etiquetas globales de 3.1 solo describen familias de decisiones o capacidades, no sustituyen el estado normativo local de cada operacion.

Item explicitamente `BLOCKED` en este plan:

- despliegue publico multiusuario con sesiones compartidas endurecidas antes de completar el hardening y auth local de `v2.5+`.

Criterio objetivo de migracion a SQLite:

- la migracion deja de ser opcional si se cumple cualquiera de estas condiciones de forma sostenida:
  - mas de un writer logico concurrente requerido;
  - mas de `1000` jobs persistidos activos o historicos por dia;
  - corrupcion o recuperacion degradada del JSON store observada mas de una vez en una semana operativa;
  - necesidad de consultas de auditoria que ya no puedan resolverse razonablemente con `listJobs()` y archivos JSON.

---

## 4. Alcance por release

### v1.0 - MVP operativo del runtime

- [ ] Setup inicial del orquestador dentro del repo actual.
- [ ] Modulo central `orchestrator` operativo.
- [ ] Transporte primario funcional: `worker` local + comandos de diagnostico basicos del runtime.
- [ ] Storage local en JSON para estado, jobs, solicitudes de review y evidencias de approvals.
- [ ] Operaciones del catalogo `P0`: `watch_activity`, `backfill_unread`, `create_review_job`.
- [ ] Maquina de estados de jobs cerrada y testeada.
- [ ] Politica minima por defecto implementada sin auto-send.
- [ ] Validacion explicita de parametros en las operaciones P0 del runtime.
- [ ] Manejo de errores basico con mensajes accionables.
- [ ] Tests unitarios minimos del motor de jobs, state-store y politicas.
- [ ] Prueba manual en entorno local con WhatsApp Web autenticado.

Nota:

- en `v1.0`, `create_review_job` solo crea el contenedor persistente de revision; la confirmacion humana formal y el envio asociado quedan fuera del release y entran con `confirm_review_send` en `v1.5`.
- aunque `create_review_job` no sea una operacion terminal externa, sigue siendo `Write-gated` en `v1.0` porque abre una intencion persistente de respuesta revisable en el store y, por lo tanto, requiere `confirm_write`.
- la CLI basica de `v1.0` resuelve arranque, bootstrap e inspeccion del runtime local; no intenta resolver todavia la necesidad de cola operativa especializada, que entra con el cliente custom de `v1.5`.

### v1.5 - IA y flujo operativo completo

- [ ] Autenticacion basica con proveedor IA por `API key`.
- [ ] Cliente custom inicial en modo CLI/TUI con cola operativa.
- [ ] Operaciones del catalogo `P1`: `classify_conversation`, `draft_reply_job`, `request_human_review`, `auto_follow_up_job`, `confirm_review_send`.
- [ ] Rate limiting con exponential backoff para proveedor IA y loops internos.
- [ ] Validacion explicita de parametros en todas las operaciones del orquestador.
- [ ] Seguridad de transporte local entre cliente custom y orquestador cuando exista superficie distinta del loop local base.
- [ ] Autorizacion de escritura por politica y tipo de accion.
- [ ] Tests de backoff, validacion, politicas y workflow de review.
- [ ] Restriccion operativa: no exponer publicamente antes del hardening de v2.0.

### v2.0 - Produccion y hardening

- [ ] Operaciones del catalogo `P2`: `metrics_export`, `reassign_job`, `dead_letter_retry`, `policy_audit_report`.
- [ ] Logging estructurado con redaction de secretos.
- [ ] Deploy containerizado del orquestador.
- [ ] Health check operativo.
- [ ] Hardening de entrada: rate limiting, rotacion de secretos, allowlist, lifecycle de sesion.
- [ ] `README.md` con matriz de operaciones, auth y permisos del orquestador.
- [ ] Gates de release de seguridad superados.

Nota:

- en `v2.0`, el health check puede exponerse como comando local, archivo de estado o endpoint local; no depende todavia del transporte HTTP de `v2.5+`.

### v2.5 - Cliente operativo expandido

- [ ] UI web ligera para inbox priorizada y cola de aprobaciones.
- [ ] Dependencias: aprobacion explicita sobre stack frontend y mecanismo de auth local.

---

## 5. Priorizacion estricta

| Prioridad | Significado | Regla |
|---|---|---|
| `P0` | Critico | Bloquea operacion reactiva base |
| `P1` | Alto | Habilita operacion principal con IA y revision |
| `P2` | Medio | Mejora escalabilidad, observabilidad y control |
| `P3` | Bajo/Expansivo | UX avanzada o extensiones |

**Regla de precedencia:** prevalece la prioridad. Nada `P1+` comienza sin cerrar `P0`.

Regla operativa de enforcement:

- `Sprint C` no puede iniciarse mientras `Sprint A` y `Sprint B` no esten formalmente cerrados bajo su DoD y gates aplicables.
- en este plan base no hay operaciones ni releases `P3`; `P3` queda reservado para extensiones futuras de UX o integraciones no comprometidas en el roadmap actual.

---

## 6. Principios de diseno

1. **Contract-first:** toda accion del orquestador debe tener entrada, salida y error definidos.
2. **Seguridad por defecto:** ninguna accion que termine en envio automatico se ejecuta sin politica explicita.
3. **Errores accionables:** todo error expone que fallo, por que fallo y el siguiente paso.
4. **Instancia unica compartida:** un solo backend MCP de WhatsApp por runtime operativo.
5. **Validacion en el borde:** toda entrada del cliente custom se valida antes de crear jobs.
6. **Modularidad por dominio:** `orchestrator`, `policy-engine`, `state-store`, `ai-adapter`, `custom-client`.
7. **Validacion lazy de permisos:** los permisos operativos se verifican al ejecutar la accion, no al boot.
8. **Gobernanza verificable:** cada sprint cierra con evidencia de tests y corrida manual.
9. **Separacion de superficies externas:** WhatsApp Web, proveedor IA y cliente custom tienen contratos separados.
10. **Humano en el loop configurable:** review humana obligatoria por defecto en acciones de escritura sensibles.

Interpretacion:

- "validacion en el borde" obliga a que toda entrada externa quede cerrada por schema antes de entrar al engine; los tipos internos abiertos solo pueden existir detras de ese borde y deben proyectarse a payloads/resultados canonicos del runtime antes de persistirse o exponerse.

---

## 7. Criterios de autonomia del agente

### 7.1 El agente puede decidir sin preguntar cuando

- El item esta marcado `CONFIRMED`.
- No cambia el contrato publico de las tools MCP existentes.
- No cambia la politica de envio por defecto.
- La decision es local y reversible.

Definicion operativa de "local y reversible":

- cambia solo modulos internos del sprint activo;
- no altera contratos publicos ni auth/transporte;
- puede revertirse sin migracion de datos irreversible ni impacto externo persistente.

### 7.2 El agente debe detenerse y pedir confirmacion cuando

- Cambia comportamiento observable de envio automatico.
- Cambia auth del proveedor IA.
- Introduce un nuevo transporte publico.
- Cambia sesiones, secretos o modelo de revision humana.
- Requiere elegir UI web, framework frontend o auth multiusuario.

---

## 8. Protocolo de comunicacion y registro de operaciones

### 8.0 Regla del modelo operativo

- Un **evento** es una señal interna observada por el orquestador.
- Una **operacion** es una capacidad del runtime con contrato funcional documentado.
- Un **job** es una unidad persistente de ejecucion creada por una operacion.
- Una **cola operativa** es una vista derivada de jobs filtrados y ordenados para uso humano o del cliente; no es una entidad persistente separada en `v1.x` salvo que el catalogo futuro lo promueva explicitamente.
- Una **accion operativa verificable** es el efecto observable de una operacion, normalmente materializado como:
  - job persistido;
  - transicion de job;
  - resultado persistido;
  - evidencia humana persistida.
- Una operacion puede:
  - no crear jobs;
  - crear exactamente un job;
  - crear multiples jobs derivados.
- Operacion y job no son equivalentes 1:1 por defecto.
- `JobType` solo enumera unidades persistentes del runtime que nacen como job o se reabren como el mismo job dentro del release activo; no enumera operaciones puramente consultivas ni operaciones que solo transicionan/evidencian sobre un job existente.
- En `v1.x`, operaciones sin creacion de job nuevo: `classify_conversation`, `draft_reply_job`, `request_human_review`, `confirm_review_send`, `metrics_export`, `policy_audit_report`, `subscription_auth_provider`, `reassign_job`, `dead_letter_retry`.
- En `v1.x`, `classify_conversation`, `draft_reply_job`, `request_human_review`, `confirm_review_send`, `reassign_job` y `dead_letter_retry` operan sobre un `job_id` existente o enriquecen un job existente; su payload pertenece al contrato de entrada de la operacion, no al union canonico de `OrchestratorJob.payload`.
- en `v2.0+`, si una operacion hoy no-job pasa a crear un job propio, ese cambio requiere ADR y actualizacion explicita del `JobType`; no existe "reserva implicita" en el contrato canonico.
- Taxonomia de origen causal:
  - `source` describe el disparador inmediato del runtime que origina o enriquece el artefacto persistido.
  - `sourceEvent` preserva el `OrchestratorEvent` normalizado cuando la causalidad inmediata proviene de actividad de WhatsApp.
  - cuando el origen inmediato es un job o scheduler y existe evento subyacente, ambos pueden coexistir sin conflicto.

### 8.1 Transportes soportados

| Transporte | Protocolo | Endpoint / Canal | Autenticacion |
|---|---|---|---|
| MCP actual | stdio MCP | proceso `dist/index.js` | sesion local |
| Orquestador | worker local | proceso `dist/orchestrator/index.js` | entorno local validado al boot |
| Cliente custom v1.5+ | CLI local sobre contrato interno del orquestador | stdin/stdout | usuario local autenticado por el entorno operativo local |
| Cliente custom v2.5 | HTTP local | `http://127.0.0.1:${PORT}` | token local de sesion |

Nota:

- en la columna "Dependencia / capacidad usada" del registro operativo, los nombres como `wait_for_activity_event`, `list_unread_chats` o `confirm_reviewed_reply` se refieren a capacidades MCP existentes del repo o a sus equivalentes modulares internos si fueron extraidos sin cambiar contrato publico.
- para implementacion autonoma, el `Estado normativo` de cada operacion en el catalogo y en la seccion 9 prevalece sobre las etiquetas globales de 3.1.
- el cliente custom de `v1.5+` no consume MCP por stdio; consume el contrato interno expuesto por el orquestador y presenta una UX operativa local.
- el proceso del orquestador se inicia por el operador local o por scripts del repo (`dev:orchestrator`, `start:orchestrator`); en `v1.0` no se asume un supervisor externo adicional.
- en `v1.5+`, el canal CLI -> orquestador es una invocacion local privada del runtime por proceso/IPC de la misma maquina; `stdin/stdout` describe la interfaz del cliente hacia el operador, no un protocolo MCP publico.
- en `v1.5`, el cliente CLI es interactivo por defecto para inspeccion y aprobacion, pero debe poder ejecutarse tambien en modo comando puntual no interactivo para acciones acotadas del operador local; no se contempla modo batch masivo como contrato base del release.
- el termino historico "cliente MCP custom" en este plan se refiere al cliente operativo construido para este proyecto; en `v1.5+` consume el contrato interno del orquestador, no un protocolo MCP separado.
- por lo tanto, "MCP" en ese nombre describe el origen del ecosistema y de las capacidades reutilizadas, no el protocolo de transporte del cliente operativo.
- la frontera operativa es: una "capacidad MCP" es la superficie publica expuesta a clientes externos; un "modulo interno reutilizable" es una extraccion o import interno permitido siempre que no cambie esa superficie publica.
- en `v2.5+`, el cliente HTTP local debe enviar el secreto activo en un header local de autenticacion definido por el runtime; `MCP_SECRET_PREVIOUS` solo habilita aceptacion temporal del header equivalente con el secreto rotado previamente.

### 8.1.1 Taxonomia de tipo operativo

| Tipo | Significado |
|---|---|
| `Read` | solo consulta estado/capacidades y no muta estado persistente ni sistemas externos |
| `Write-gated` | muta estado persistente local y/o puede terminar en mutacion externa; requiere guardrails declarativos y transiciones validas |
| `Read/Write` | combina lectura y mutacion material, normalmente en configuracion o auth |

Regla de interpretacion:

- `Write-gated` no implica automaticamente `confirm_write`.
- `confirm_write` es obligatorio solo cuando la operacion crea una nueva intencion persistente de escritura revisable, reabre una intencion terminal con impacto operativo, o puede terminar en envio/mutacion externa del chat.
- Una operacion `Write-gated` que solo transiciona un job existente o registra evidencia local sin crear una nueva intencion de escritura puede requerir permisos locales y transiciones validas sin exigir `confirm_write`.

### 8.2 Formato de respuesta exitosa

```json
{
  "data": { "...resultado..." },
  "meta": {
    "has_more": false,
    "next_cursor": null,
    "pages_fetched": 1
  },
  "warnings": []
}
```

Convencion:

- un exito sin resultado material usa `data` con valor nulo o un objeto vacio segun el contrato local de la operacion;
- en `watch_activity`, timeout sin evento se representa como `data.event = null`.
- `has_more` y `next_cursor` forman parte del envelope comun aunque varias operaciones del release activo no usen paginacion real; por defecto `next_cursor=null`.

### 8.3 Formato de error expuesto al consumidor

**Opcion B - Error como JSON estable**

```json
{
  "error": "Descripcion accionable del error.",
  "code": "ERROR_CODE",
  "action": "corregir_input"
}
```

Convencion:

- `action` debe ser un identificador corto y estable orientado a operador/cliente, preferiblemente `snake_case`;
- el render humano puede traducirlo a prosa local, pero el contrato canonico expone el identificador, no una frase arbitraria distinta por cada handler.

### 8.3.1 Catalogo minimo de codigos de error

| Code | Uso minimo |
|---|---|
| `INVALID_INPUT` | parametro ausente, vacio o fuera de rango |
| `SESSION_NOT_READY` | sesion local de WhatsApp no disponible |
| `STORE_CORRUPT` | JSON del store invalido o recuperado en degradacion |
| `POLICY_BLOCKED` | politica o guardrail impide continuar |
| `JOB_STATE_INVALID` | transicion invalida o job no elegible |
| `EXTERNAL_SEND_FAILED` | aprobacion valida pero envio externo fallido |
| `AUTH_FAILED` | credencial invalida frente a proveedor externo |
| `MCP_CONTRACT_REGRESSION` | incompatibilidad detectada con el contrato MCP publico |

### 8.4 Regla de serializacion

- En exitos, la respuesta contiene JSON valido.
- No mezclar JSON con prosa libre en el mismo campo.
- `warnings` vive dentro del JSON de exito.
- logs operativos y renderizado humano de CLI/TUI pueden usar formato legible adicional, siempre que no alteren ni reinterpreten el JSON canonico del runtime.
- Nunca exponer tokens, cookies ni headers sensibles.
- `isError` no se usa en el orquestador.

### 8.5 Registro de operaciones por release y prioridad

| Operacion | Categoria | Release | Prioridad | Capacidades / dependencias | Tipo | Estado |
|---|---|---|---|---|---|---|
| `watch_activity` | Orquestacion | v1.0 | P0 | `wait_for_activity_event`, `state-store` | Write-gated | `CONFIRMED` |
| `backfill_unread` | Orquestacion | v1.0 | P0 | `list_unread_chats`, `read_chat_messages`, `state-store` | Write-gated | `CONFIRMED` |
| `create_review_job` | Reply | v1.0 | P0 | `state-store` | Write-gated | `CONFIRMED` |
| `classify_conversation` | Analisis | v1.5 | P1 | proveedor IA + `get_chat_timeline_summary` | Write-gated | `CONFIRMED` |
| `draft_reply_job` | Reply | v1.5 | P1 | `draft_reply_with_media_context`, proveedor IA opcional | Write-gated | `CONFIRMED` |
| `request_human_review` | Reply | v1.5 | P1 | `state-store`, `saveReviewRequest()`, vista derivada `listPendingReviewJobs()` | Write-gated | `CONFIRMED` |
| `auto_follow_up_job` | Ventas/soporte | v1.5 | P1 | `get_actionable_feed` | Write-gated | `CONFIRMED` |
| `confirm_review_send` | Reply | v1.5 | P1 | `review-send-capability`, `state-store`, `saveApproval()` | Write-gated | `CONFIRMED` |
| `metrics_export` | Observabilidad | v2.0 | P2 | storage local, `listJobs()`, `listApprovals()` | Read | `INFERRED` |
| `reassign_job` | Operacion | v2.0 | P2 | state-store | Write-gated | `INFERRED` |
| `dead_letter_retry` | Operacion | v2.0 | P2 | state-store | Write-gated | `INFERRED` |
| `policy_audit_report` | Gobernanza | v2.0 | P2 | storage local, `listJobs()`, `listApprovals()`, `listReviewRequests()` | Read | `INFERRED` |
| `subscription_auth_provider` | IA | v2.5 | P2 | proveedor IA | Read/Write | `PROVISIONAL` |

Convencion:

- las "operaciones" listadas en releases 4.x equivalen exactamente a entradas de este catalogo;
- la columna `Capacidades / dependencias` puede mezclar capacidades MCP reutilizadas, contratos internos del runtime y storage local cuando esos elementos sean parte necesaria de la operacion; no representa solo dependencias externas.

### 8.6 Matriz obligatoria de control

| Operacion | Auth requerida | Permisos/scopes minimos | Recurso objetivo | Read/Write | Riesgo |
|---|---|---|---|---|---|
| `watch_activity` | sesion WhatsApp local | acceso CDP local | WhatsApp Web + job store local | Write | Bajo |
| `backfill_unread` | sesion WhatsApp local | acceso CDP local | chats no leidos + job store local | Write | Medio |
| `create_review_job` | sesion WhatsApp local + `confirm_write` | permiso de review local | chat objetivo | Write | Alto |
| `classify_conversation` | sesion WhatsApp local + proveedor IA | permiso de analisis local | job objetivo + chat objetivo | Write | Medio |
| `draft_reply_job` | sesion WhatsApp local + proveedor IA | permiso de draft local | chat objetivo | Write | Alto |
| `auto_follow_up_job` | sesion WhatsApp local + politica habilitada | permiso de auto follow-up | chat objetivo | Write | Alto |
| `request_human_review` | sesion local | permiso de review local | job objetivo | Write | Medio |
| `confirm_review_send` | sesion WhatsApp local + aprobacion humana + `confirm_write` | permiso de envio | chat objetivo | Write | Alto |
| `reassign_job` | sesion local | permiso de operacion local | job objetivo | Write | Medio |
| `dead_letter_retry` | sesion local | permiso de operacion local | job objetivo | Write | Medio |
| `metrics_export` | sesion local | permiso de lectura local | runtime/metricas | Read | Bajo |
| `policy_audit_report` | sesion local | permiso de lectura local | runtime/politicas | Read | Bajo |
| `subscription_auth_provider` | proveedor IA | auth empresarial del proveedor | adaptador IA | Write | Alto |

Nota:

- `watch_activity.timeout_ms` se considera parametro sensible de control operativo aunque la operacion figure con riesgo bajo; su hard cap y default deben revisarse junto con los demas guardrails del loop.

---

## 9. Comportamiento detallado por operacion

### 9.1 `watch_activity`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `timeout_ms?: number` (default `300000`, max `3600000`)
- **Salida:** `{ data: { event?: { type: "incoming-message" | "unread-chat", chatName?: string, chatKey?: string, unreadCount?: number, preview?: string, timestamp?: number } | null }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** espera un evento desde WhatsApp Web y lo transforma en un `OrchestratorEvent` interno via un adaptador formal. Si el timeout expira sin evento, retorna `data.event=null` y no crea jobs. Si faltan `chatKey`, `chatName` o `timestamp`, el adaptador devuelve `null` y la operacion responde con warning accionable sin crear jobs. En v1.0 crea un job `watch_activity` de trazabilidad antes de despachar cualquier job derivado. La creacion de jobs derivados es responsabilidad posterior del engine, no del adaptador.
- **Errores esperados:** sesion no lista -> error JSON accionable; `timeout_ms` invalido o fuera de rango -> error de validacion.
- **Notas de negocio:** no crea respuesta por si sola; solo dispara el workflow. Un timeout sin evento es un exito vacio de polling, no un error. `timeout_ms` es el hard cap de cada invocacion individual de la operacion; el loop del engine decide si rearma una nueva espera despues. Si no se pasa `timeout_ms`, el runtime usa `ORCHESTRATOR_WATCH_TIMEOUT_MS`. El `timestamp` normalizado de `OrchestratorEvent` usa epoch en milisegundos UTC. La ausencia de `preview` no invalida el evento; solo reduce contexto de triage o logging. Los jobs `watch_activity` de trazabilidad usan el mismo `JobType` y guardrails generales del runtime; no crean bypass especial de dedupe o cooldown. Un evento parcial sin `chatKey`, `chatName` o `timestamp` nunca se normaliza a `OrchestratorEvent`; se descarta con warning y sin job derivado. El dedupe se aplica a jobs, no a eventos crudos; dos eventos iguales pueden existir, pero no deben producir jobs duplicados si el guardrail de `job_type:chat_key` ya bloquea la derivacion. Dentro del loop reactivo, `watch_activity` tiene prioridad sobre `backfill_unread`.
- **Regla de preview:** la ausencia de `preview` no invalida el evento; solo reduce contexto de triage/logging y nunca bloquea por si sola la creacion de jobs derivados.
- **Control sensible:** `timeout_ms` se trata como guardrail operativo sensible; valores altos deben quedar explicitamente visibles en validacion, logs de diagnostico y tests.
- **Shape minimo de warning parcial:** cuando el evento sea parcial, `warnings[]` debe incluir al menos un string estable con el patron `partial_event_missing:<campo>` por cada campo normativo ausente (`chatKey`, `chatName`, `timestamp`).

### 9.2 `create_review_job`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `chat_key: string`, `policy_reason: string`, `review_type: "reply" | "follow_up" | "support_response"`, `confirm_write: "CONFIRMED_BY_USER"`
- **Regla critica:** toda accion de respuesta creada por esta operacion queda en estado `pending_review`
- **Confirmacion obligatoria:** `confirm_write` debe ser exactamente `"CONFIRMED_BY_USER"`
- **Autorizacion obligatoria:** verificar que la politica permita trabajar el `chat_key`
- **Valores validos para enums sensibles:** `reply`, `follow_up`, `support_response`
- **Salida:** `{ data: { id: string, status: "pending_review" }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Errores esperados:** chat fuera de politica, chat no resoluble, fallo de preparacion local del review job
- **Notas de negocio:** en `v1.0` esta operacion crea el contenedor persistente de revision y no exige IA ni draft previo; la generacion real de borrador queda diferida a `draft_reply_job` desde `v1.5`. En `v1.0`, `pending_review` significa "review container creado" y no necesariamente "draft ya generado". `confirm_write` se exige porque la operacion muta el job store creando una intencion de respuesta revisable, aunque no envie a WhatsApp. Los valores del enum sensible corresponden al campo de entrada `review_type`.
- **Regla de origen de razon:** `policy_reason` normalmente deriva de `PolicyDecision.reason`, pero puede enriquecerse con contexto operativo adicional del runtime siempre que preserve trazabilidad semantica.
- **Notas de payload:** el artefacto principal de review vive en `CreateReviewJobPayload` mediante `draftText` o `draftRef`. En `v1.0` ambos pueden ser omitidos; en `v1.5+` al menos uno debe quedar poblado antes de confirmacion humana.
- **Nota de seguridad:** `confirm_write` es guardrail declarativo local
- **Orden de validacion:** el runtime debe validar `confirm_write` y shape basico de input antes de evaluar politica; asi los errores deterministas de guardrail se resuelven antes de cualquier decision de negocio.
- **Regla de lifecycle:** `create_review_job` crea el job ya nacido en `pending_review` como excepcion explicita del runtime; no requiere ni simula una transicion `running_to_pending_review` previa.

### 9.3 `backfill_unread`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `limit?: number` (default `50`, min `1`, max `50`)
- **Salida:** `{ data: { jobs_created: number, chats_scanned: number, skipped: number }, meta: { has_more: boolean, next_cursor: null, pages_fetched: 1 }, warnings: string[] }`
- **Comportamiento esperado:** lista chats no leidos, deduplica por `job_type:chat_key`, y crea jobs `backfill_unread` de escaneo/seguimiento sin enviar mensajes. La derivacion posterior hacia jobs de review o draft es responsabilidad del engine, no de esta operacion.
- **Errores esperados:** sesion no lista, lectura parcial de chats, estado corrupto del store, `limit` invalido o fuera de rango.
- **Notas de negocio:** no requiere IA en v1.0; no crea acciones de envio automatico; `has_more=true` si el total de chats no leidos visibles supera `limit`; `pages_fetched=1` significa una sola lectura del origen visible en esa iteracion, aunque el lote haya quedado truncado por `limit`; el scheduler del loop la ejecuta segun `ORCHESTRATOR_BACKFILL_MS`. En `v1.0`, cada chat escaneado puede originar como maximo un job base `backfill_unread`, por lo que `jobs_created <= limit`. `limit` aplica al numero maximo de chats escaneados en una invocacion, no al numero de jobs derivados posteriores del engine. `chats_scanned` cuenta chats efectivamente leidos del origen en la invocacion actual; puede ser menor que `limit` si el origen devuelve menos elementos o si la lectura se interrumpe por fallo parcial antes del tope. `jobs_created` cuenta solo jobs base `backfill_unread` persistidos despues de dedupe. El orden de procesamiento sigue por defecto el orden observable del origen en esa iteracion; `v1.0` no introduce reordenamiento propio. Una lectura parcial no invalida los jobs ya persistidos correctamente; debe reflejarse como warning operativo y preservar los exitos parciales obtenidos antes del fallo. `skipped` cuenta chats omitidos por dedupe, cooldown o politica minima local; puede coexistir con warnings operativos, pero no representa errores parciales. El termino "seguimiento" en esta operacion significa tracking interno de candidatos para pasos posteriores del engine; no define una operacion separada. El `limit` de entrada controla solo el lote leido; la ejecucion posterior sigue sujeta a `ORCHESTRATOR_MAX_PARALLEL_JOBS`, dedupe y limites por chat. Los jobs `backfill_unread` son consumidos por el mismo engine del runtime en iteraciones posteriores del scheduler.
- **Regla de conteo:** `chats_scanned` cuenta chats efectivamente iterados por la operacion en esa invocacion; puede ser menor que `limit` si hay menos chats visibles o si la lectura se interrumpe antes del tope.
- **Regla de capa:** `limit` controla la lectura del origen MCP/UI en la invocacion actual; no redefine el maximo de jobs posteriores fuera de los jobs base `backfill_unread` creados en esa misma pasada.
- **Regla matematica:** `jobs_created + skipped` puede ser menor o igual que `chats_scanned`; no debe asumirse igualdad con `limit` por truncado del origen, fallo parcial o items descartados antes de persistencia.

### 9.4 `auto_follow_up_job`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `chat_keys: string[]` (max `50`)
- **Comportamiento dual:**
  - `<= 10`: evaluacion individual de cada chat usando lectura contextual y el mismo modulo compartido de scoring/accionabilidad que alimenta `get_actionable_feed`
  - `> 10`: evaluacion por lote usando `get_actionable_feed`
- **Cache:** TTL `5` min, key `chat_key:policy_version`, cap `500`, eviccion `LRU`
- **Tolerancia a fallos:** error parcial preserva exitos parciales
- **Salida:** `{ data: Array<{ chat_key: string, data?: { job_id: string, status: string }, error?: string, warnings?: string[] }>, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Notas de negocio:** esta operacion crea o prepara jobs de follow-up; no implica envio automatico por si misma. Para `<= 10` chats puede crear cero o un job por `chat_key` segun politica y guardrails; nunca crea mas de un job por chat en una misma invocacion. Solo puede terminar en envio si una politica posterior lo habilita explicitamente. Cuando `AUTO_FOLLOW_UP_ENABLED=false`, la operacion puede seguir evaluando y creando review jobs o resultados diagnosticos, pero no debe terminar en auto-send. El parcial se serializa por item en `data[]`; `warnings` del envelope solo agregan resumen operativo del lote. El orden de salida debe preservar el orden de entrada de `chat_keys`, incluso si hay errores parciales por item. En `v1.x`, el TTL y el cap del cache son defaults fijos del runtime; no se exponen como variables de entorno separadas hasta que el contrato de cache se promueva a configuracion publica. `source="scheduler"` representa disparo periodico del loop reactivo del orquestador.
- **Regla de warnings:** `warnings` por item describen incidencias especificas de ese `chat_key`; `warnings` del envelope describen incidencias agregadas del lote completo.
- **Regla de cardinalidad:** el maximo `50` aplica sobre la entrada ya normalizada y deduplicada por `chat_key`; si la entrada original supera `50` antes de dedupe, debe fallar por `INVALID_INPUT`.

### 9.5 `request_human_review`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `job_id: string`, `reason: string`, `actor_id: string`
- **Salida:** `{ data: { job_id: string, status: "pending_review" }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** mueve un job elegible a cola de revision humana y registra evidencia local de la solicitud.
- **Errores esperados:** job inexistente, estado invalido, job terminal, `reason` vacio o invalido.
- **Notas de negocio:** no envia mensajes; solo prepara el paso humano. En v1.x un job es elegible para esta operacion solo si esta en `running`; si ya esta en `pending_review`, la operacion falla por estado invalido y no es idempotente. La operacion debe usar la transicion `running_to_pending_review`. No exige `confirm_write` porque no crea una nueva intencion de respuesta ni ejecuta mutacion externa; la evidencia minima local es la transicion de estado + la persistencia de `ReviewRequestEvidence`.
- **Regla estructural:** esta operacion no crea un job nuevo; opera sobre un job existente.
- **Definicion de cola:** la "cola de revision humana" en `v1.x` es la vista derivada de `listPendingReviewJobs()` sobre jobs en `pending_review`; no existe una entidad `ReviewQueue` persistente separada.
- **Regla de razon:** el `reason` de esta operacion se preserva como solicitud humana adicional y no reemplaza `policyReason` del payload original del job.
- **Regla de actor:** `actor_id` es obligatorio y debe persistirse en `ReviewRequestEvidence.actorId`; una solicitud humana sin identidad local valida debe fallar.
- **Estados elegibles:** en `v1.x`, un job elegible para `request_human_review` debe estar en estado `running`.
- **Regla de auditoria:** esta operacion no crea `HumanApprovalRecord` pendiente; el estado pendiente se representa por el job en `pending_review` mas `ReviewRequestEvidence`.
- **Regla de attempts:** `request_human_review` no incrementa ni resetea `attempts`; solo cambia estado y evidencia humana asociada.
- **Regla de composicion:** esta operacion se usa para jobs que nacieron fuera de review y luego quedaron listos para revision humana; no reemplaza la ruta directa de `create_review_job`.

### 9.6 `confirm_review_send`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `job_id: string`, `approval_actor: string`, `review_action: "approved" | "rejected"`, `confirm_write: "CONFIRMED_BY_USER"`
- **Salida:** `{ data: { job_id: string, status: "completed" | "cancelled" | "failed_retryable", approval_recorded_at: string }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** confirma o cancela un job en `pending_review`, ejecuta el envio si aplica y registra la aprobacion humana.
- **Errores esperados:** job no encontrado, job fuera de `pending_review`, falta de confirmacion, `approval_actor` vacio o invalido, fallo de envio externo.
- **Notas de negocio:** toda aprobacion o cancelacion humana debe quedar auditada. `review_action="approved"` equivale a la transicion `pending_review -> completed`; `review_action="rejected"` equivale a `pending_review -> cancelled` y representa rechazo humano, no cancelacion tecnica. Si el envio externo falla despues de una aprobacion valida, el job transiciona a `failed_retryable`. `confirm_write` es un guardrail declarativo obligatorio tanto para aprobar como para rechazar. Solo pueden invocar esta operacion actores humanos locales autenticados por el runtime o el cliente custom autorizado; `approval_actor` no es texto libre arbitrario y debe resolver a una identidad local valida. "Si aplica" significa que solo ejecuta envio cuando `review_action="approved"` y existe un artefacto enviable asociado al job (`draftText`, `draftRef` o `reviewToken`) y la politica vigente permite envio confirmado por humano. Las aprobaciones persistidas deben poder ser consumidas por `metrics_export` y `policy_audit_report`. La operacion debe respetar la politica vigente del job y no puede forzar envio si el job ya fue cancelado o quedo fuera de politica.
- **Notas de idempotencia:** la operacion no es idempotente. Repetir una confirmacion sobre el mismo job ya transicionado debe fallar con error accionable y nunca duplicar envio ni registro humano.
- **Regla estructural:** esta operacion no crea un job nuevo; opera sobre un job existente.
- **Regla de persistencia:** `approval_actor` se persiste en `HumanApprovalRecord`; no requiere duplicacion obligatoria en `OrchestratorJob` salvo que una vista futura la necesite como denormalizacion.
- **Regla de reintento:** un job en `failed_retryable` no vuelve a pasar por `confirm_review_send` salvo que otra operacion lo transicione antes a un estado elegible.
- **Regla de rechazo:** `review_action="rejected"` tambien persiste `HumanApprovalRecord` con `action="rejected"` y `sendOutcome="not_sent"`; no se trata como cancelacion silenciosa.
- **Regla de attempts:** una confirmacion o rechazo humano no incrementa `attempts`; solo un fallo retryable de ejecucion externa posterior a aprobacion puede hacerlo avanzar segun el runtime.

### 9.7 `classify_conversation`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `job_id: string`, `chat_key: string`
- **Salida:** `{ data: { job_id: string, classification: { intent: string | null, stage: string | null, priority: "low" | "medium" | "high" | null, labels: string[], summary: string | null } }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** obtiene contexto conversacional, consulta el proveedor IA y adjunta una clasificacion estructurada al job existente.
- **Errores esperados:** proveedor IA no disponible, chat no resoluble, timeout.
- **Regla estructural:** esta operacion no crea un job nuevo; en `v1.x` enriquece un job existente mediante `saveJobArtifacts()` o API equivalente sin cambiar su `status`.
- **Estados elegibles:** el job objetivo debe existir y estar en un estado no terminal compatible con analisis (`pending`, `running` o `pending_review` segun el workflow concreto del release).
- **Notas de negocio:** `chatState=null` es valido cuando el chat aun no tiene snapshot persistido; no implica por si mismo corrupcion ni error.
- **Cierre de schema:** aunque la clasificacion interna pueda usar campos auxiliares, la salida expuesta debe limitarse a `intent`, `stage`, `priority`, `labels` y `summary`.

### 9.8 `draft_reply_job`

- **Estado normativo:** `CONFIRMED`
- **Entrada:** `job_id: string`, `chat_key: string`, `draft_type: "reply" | "follow_up"`
- **Salida:** `{ data: { job_id: string, draft_created: true }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** genera un borrador asociado al job existente usando herramientas existentes y, si aplica, proveedor IA.
- **Errores esperados:** fallo de contexto, fallo de draft, politica incompatible.
- **Regla estructural:** esta operacion no crea un job nuevo en `v1.x`; enriquece un job existente, normalmente un `create_review_job`, mediante `saveJobArtifacts()` o API equivalente.
- **Estados elegibles:** en `v1.x`, esta operacion se ejecuta sobre un job existente compatible con generacion de borrador. El caso canonico es un `create_review_job` en `pending_review`; cualquier otro estado elegible debe documentarse explicitamente en el release que lo habilite.
- **Regla de estado:** generar o refrescar el borrador no cambia por si mismo el estado visible del job objetivo. Si el job ya estaba en `pending_review`, permanece en `pending_review`.
- **Regla de persistencia de artefacto:** el borrador generado debe persistirse como enriquecimiento de `CreateReviewJobPayload` (`draftText`, `draftRef` o `reviewToken`) y/o como `result` no terminal del job objetivo segun el contrato del release, sin reemplazar el payload completo.
- **Regla de composicion:** en `v1.5`, el flujo recomendado es:
  - crear/obtener contenedor con `create_review_job` cuando ya existe intencion de respuesta revisable;
  - ejecutar `draft_reply_job` para poblar el artefacto enviable;
  - usar `confirm_review_send` sobre el contenedor en `pending_review`.
- **Trazabilidad minima:** el resultado o payload enriquecido del draft debe conservar `policyReason`, `draftType` y una referencia al origen (`sourceEvent` o `jobId`) para que la revision humana tenga contexto auditable.

### 9.9 `reassign_job`

- **Estado normativo:** `INFERRED`
- **Entrada:** `job_id: string`, `owner: string`
- **Salida:** `{ data: { job_id: string, owner: string }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** reasigna ownership operativo sin alterar el payload funcional del job.

### 9.10 `dead_letter_retry`

- **Estado normativo:** `INFERRED`
- **Entrada:** `job_id: string`, `confirm_write: "CONFIRMED_BY_USER"`
- **Salida:** `{ data: { job_id: string, status: "pending" }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** reabre un job elegible desde estado terminal retryable hacia `pending`.
- **Notas de negocio:** en `v2.0`, la condicion de dead-letter se modela sobre jobs en `failed_terminal` con `deadLetteredAt` informado; no introduce un `JobStatus` separado. Esta operacion usa la transicion `failed_terminal_to_pending` y debe incrementar `deadLetterCount` o registrar metadata equivalente de reapertura.

### 9.11 `metrics_export`

- **Estado normativo:** `INFERRED`
- **Entrada:** `window_minutes?: number`
- **Salida:** `{ data: { counters: { jobsCreated: number, jobsCompleted: number, jobsCancelled: number, jobsFailedRetryable: number, jobsFailedTerminal: number, reviewRequestsCreated: number, approvalsApproved: number, approvalsRejected: number }, generatedAt: string }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** consolida metricas locales del runtime como jobs creados, completados, cancelados, retryables y aprobaciones humanas registradas.
- **Errores esperados:** storage no disponible, lectura parcial del store.
- **Contrato minimo de salida:** `counters` debe incluir como minimo `jobsCreated`, `jobsCompleted`, `jobsCancelled`, `jobsFailedRetryable`, `jobsFailedTerminal`, `reviewRequestsCreated`, `approvalsApproved` y `approvalsRejected`.

### 9.12 `policy_audit_report`

- **Estado normativo:** `INFERRED`
- **Entrada:** `window_minutes?: number`
- **Salida:** `{ data: { items: Array<{ jobId: string, jobType: string, policyReason?: string, decision: string, source: string, createdAt: string, approvalAction?: "approved" | "rejected" }> }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** resume decisiones de politica, cancelaciones, reviews y auto-send ejecutados.
- **Contrato minimo de salida:** cada item debe incluir como minimo `jobId`, `jobType`, `policyReason?`, `decision`, `source`, `createdAt` y `approvalAction?`.

### 9.13 `subscription_auth_provider`

- **Estado normativo:** `PROVISIONAL`
- **Entrada:** `provider: string`, `subscription_token_ref: string`
- **Salida:** `{ data: { provider: string, enabled: boolean }, meta: { has_more: false, next_cursor: null, pages_fetched: 1 }, warnings: [] }`
- **Comportamiento esperado:** habilita auth de proveedor por suscripcion si el proveedor lo soporta.

### 9.14 Contrato minimo obligatorio para toda operacion nueva

Toda operacion nueva debe documentar:
- Entrada
- Salida
- Errores esperados
- Notas de negocio
- Estado normativo

---

## 10. Arquitectura tecnica

### 10.1 Stack tecnologico

| Capa | Tecnologia | Justificacion |
|---|---|---|
| Lenguaje | TypeScript | el repo ya esta en TS |
| Runtime | Node.js 20+ | consistente con el proyecto actual |
| Validacion | validacion explicita actual + Zod en modulos nuevos | endurecer contratos del orquestador |
| Linting | ESLint | separa lint de typecheck en gates y scripts |
| Testing | Node test actual / Vitest opcional en modulos nuevos | continuidad y mejor DX |
| Contenedor | Docker multistage | v2.0 |
| Deploy | local/self-hosted inicialmente | depende de sesion WhatsApp Web local |

Nota:

- `Zod` queda requerido desde `v1.0` para schemas de entrada de modulos nuevos del orquestador que reciban input externo u operativo; no se deja a criterio del implementador en esos casos.
- la containerizacion de `v2.0` no elimina la dependencia de sesion local de WhatsApp Web; en la fase actual solo se considera valida para despliegues locales o self-hosted con navegador/sesion adjunta en el mismo entorno operativo.

### 10.2 Estructura de directorios

```text
whatsapp-web-mcp-server/
├── src/
│   ├── index.ts
│   ├── bot.ts
│   ├── orchestrator/
│   │   ├── index.ts
│   │   ├── capabilities.ts
│   │   ├── engine.ts
│   │   ├── jobs.ts
│   │   ├── policies.ts
│   │   ├── state-store.ts
│   │   ├── handlers/
│   │   │   ├── activity.ts
│   │   │   ├── backfill.ts
│   │   │   ├── review-create.ts
│   │   │   ├── review-request.ts
│   │   │   └── review-confirm.ts
│   │   └── types.ts
│   ├── ai/
│   │   ├── adapter.ts
│   │   ├── provider.ts
│   │   ├── prompts.ts
│   │   └── types.ts
│   ├── custom-client/
│   │   ├── cli.ts
│   │   └── formatters.ts
│   └── utils/
│       ├── masking.ts
│       ├── errors.ts
│       └── backoff.ts
├── tests/
├── tmp/
├── .env.example
├── Dockerfile
├── package.json
└── README.md
```

Nota:

- en `v1.0` solo se materializan los handlers obligatorios de Sprint A;
- operaciones de `v1.5+` pueden introducir handlers adicionales como `classification.ts`, `drafts.ts` u `operations.ts` sin cambiar este contrato base.
- el dominio `review` queda separado por responsabilidad: `review-create.ts` crea contenedores de revision, `review-request.ts` gestiona paso a `pending_review`, y `review-confirm.ts` gestiona confirmacion/rechazo y envio.
- en `v1.x`, approvals viven dentro de `state-store.ts`; no requieren modulo dedicado separado.
- `capabilities.ts` encapsula la coordinacion con capacidades MCP existentes o sus modulos internos equivalentes; evita que `engine.ts` conozca detalles de UI/CDP o imports cruzados del repo.
- `jobs.ts` centraliza fabricacion, tipado practico y helpers de transicion de jobs;
- `policies.ts` implementa el contrato `PolicyEngine`;
- `engine.ts` es el coordinador con side effects del runtime; los helpers puros de scheduling, dedupe o seleccion pueden extraerse, pero la autoridad operativa sigue en el engine.
- en `v1.0`, la carga y validacion inicial de configuracion puede vivir en `src/orchestrator/index.ts`; no requiere un modulo `config.ts` separado mientras el alcance siga acotado.
- `ai/prompts.ts` define plantillas internas del adaptador IA y no expone contrato publico adicional.
- `ai/adapter.ts` actua como bridge entre `AIAdapter` del orquestador y `provider.ts`; encapsula mapeo de credenciales, provider selection y proyeccion de respuestas al contrato interno.
- `ai/types.ts` concentra tipos compartidos del adaptador IA y sus entradas/salidas internas.
- si la complejidad de resolucion config -> policy crece, puede introducirse `src/orchestrator/policy-config.ts` sin romper la estructura base; en `v1.x` esa responsabilidad minima puede vivir en `policies.ts` o `index.ts`, pero debe quedar centralizada en un solo punto.
- `custom-client/formatters.ts` adapta `SuccessResult<T>`, `InternalError` y estados del runtime a salidas legibles de CLI/TUI sin cambiar semantica.
- `utils/masking.ts` se usa para redactar secretos, tokens, headers sensibles y referencias de sesion en logs y errores.

### 10.3 Scripts de proyecto

```json
{
  "scripts": {
    "dev": "node dist/orchestrator/index.js",
    "dev:tsc": "tsc -w",
    "dev:server": "node dist/index.js",
    "dev:orchestrator": "node dist/orchestrator/index.js",
    "build": "tsc",
    "start": "node dist/index.js",
    "start:server": "node dist/index.js",
    "start:orchestrator": "node dist/orchestrator/index.js",
    "start:client": "node dist/custom-client/cli.js",
    "orchestrator:run": "node dist/orchestrator/index.js --run",
    "orchestrator:store:inspect": "node dist/orchestrator/index.js --inspect-store",
    "orchestrator:store:init": "node dist/orchestrator/index.js --init-store",
    "lint": "eslint .",
    "format": "prettier --write .",
    "audit:deps": "npm audit",
    "test": "npm run build && node tests/whatsapp-locators.test.mjs",
    "test:unit": "node --test tests/unit/*.test.mjs",
    "test:contract": "node --test tests/contract/*.test.mjs",
    "test:all": "npm run test && npm run test:unit && npm run test:contract",
    "test:coverage": "node --test --experimental-test-coverage tests/unit/*.test.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

Nota:

- `start:client` queda reservado para `v1.5+` y no forma parte del DoD de Sprint A.
- `dev` representa el entrypoint reactivo de desarrollo del runtime ya compilado; `dev:tsc` mantiene la compilacion continua en una terminal separada.
- `start` y `start:server` conservan compatibilidad con el servidor MCP actual; el proceso principal del runtime operativo nuevo es `start:orchestrator`.
- `dev:server` se usa para desarrollo/manual del servidor MCP actual; `start:server` es su equivalente estable de ejecucion sin semantica extra de build/watch dentro de este plan.
- `orchestrator:store:init` y `orchestrator:store:inspect` son comandos de diagnostico del runtime; forman parte del soporte operativo base de `v1.0`.
- `orchestrator:run` es la superficie minima one-shot de `v1.0` para ejecutar operaciones `P0` con input controlado y verificar manualmente el runtime sin introducir todavia un cliente operativo completo.
- `start:client` puede existir en scripts antes de `v1.5`, pero no debe considerarse soportado ni verificable hasta ese release.
- la "CLI basica" de `v1.0` se limita a esos comandos de diagnostico del runtime y al arranque del orquestador; no implica todavia un cliente operativo de cola o aprobacion.
- en `v1.0`, esa CLI basica es de observacion, bootstrap, diagnostico y ejecucion puntual controlada de operaciones `P0`; no autoriza todavia una UX de cola, aprobacion interactiva ni cliente operativo general.
- el flujo de DX esperado en `v1.0` es: una terminal con `npm run dev:tsc` y otra con `npm run dev` o `npm run dev:orchestrator`; asi el runtime reactivo existe tambien en desarrollo.
- `dev:orchestrator` y `start:orchestrator` levantan un loop continuo del runtime; los comandos `--inspect-store` y `--init-store` son invocaciones puntuales de diagnostico.
- `test` conserva la regresion legacy del repo; para validar el runtime nuevo la ruta oficial es `test:unit`, `test:contract`, `test:coverage` y, cuando aplique, `test:all`.
- `format` es tooling de apoyo y no gatea el release por si mismo; solo debe aplicarse cuando el cambio lo requiera o la convención del repo lo exija.
- `audit:deps` es obligatorio en gates de `v2.0+`; antes de ese release puede correrse como diagnostico no bloqueante.

### 10.4 Flujo de datos

```text
Evento WhatsApp Web
  -> orquestador
    -> validacion de evento
      -> creacion o lookup de job base
        -> lectura de state-store y estado por chat
          -> dedupe, cooldown y guardrails
          -> politicas
            -> modulos internos reutilizados del backend MCP existente
              -> persistencia de transiciones y evidencias
              -> proveedor IA si aplica
                -> clasificacion y/o draft si aplica
                  -> job derivado, enriquecido o transicionado
                    -> review humana o auto-ejecucion
                      -> registro de approvals si aplica
                        -> confirmacion y envio
```

### 10.5 Autoridad operativa

- El `orchestrator` es la unica autoridad para:
  - crear jobs;
  - aplicar politicas;
  - persistir estado;
  - decidir transiciones de estado;
  - autorizar ejecucion operativa.
- El `custom-client` no contiene logica operativa ni duplica politicas.
- El `custom-client` solo:
  - consulta estado;
  - muestra cola e items;
  - solicita acciones al orquestador;
  - presenta resultados y errores.
- Para v1.0 y v1.5, el orquestador debe reutilizar modulos internos TypeScript del repo cuando sea posible.
- Para v1.0 no se implementa un cliente MCP stdio interno para consumir `src/index.ts` desde el mismo repo.

---

## 11. Contratos de salida

### 11.1 Schema de exito

```typescript
type SuccessResult<T> = {
  data: T;
  meta: {
    has_more: boolean;
    next_cursor?: string | null;
    pages_fetched?: number;
  };
  warnings: string[];
};
```

### 11.2 Schema de error interno

```typescript
type InternalError = {
  error: string;
  code?: string;
  action: string;
};
```

Nota:

- `code` es recomendado cuando el error proviene de un sistema externo o de una regla interna identificable; puede omitirse en fallos genéricos no clasificados.
- `action` debe ser una instruccion breve y accionable para el operador, por ejemplo: `reintentar`, `revisar_configuracion`, `reautenticar_sesion`, `esperar_y_reintentar`, `corregir_input`.
- `src/utils/errors.ts` debe modelar errores internos del runtime y su proyeccion a `InternalError`; logs internos pueden contener contexto tecnico adicional redacted, pero la superficie expuesta al cliente solo entrega `error`, `code` y `action`.
- ningun handler del runtime debe devolver "shape crudo" fuera de `SuccessResult<T>` o `InternalError`; los objetos internos del plan solo representan el contenido de `data` salvo que se indique lo contrario.

### 11.3 Politica de versionado

- Campos nuevos en minor: permitido.
- Eliminacion o renombrado: requiere major.
- No romper contratos MCP existentes durante v1.x del orquestador.
- Si el cliente custom define API local, debe declarar `schemaVersion`.

Nota:

- "API local" en este plan se refiere a una futura superficie local del orquestador, por ejemplo el transporte HTTP de `v2.5+`; no define una API separada del cliente.
- este versionado aplica al contrato del orquestador y a cualquier superficie local que exponga; no reemplaza ni redefine el versionado historico del repo ni del servidor MCP existente.

### 11.4 Contrato minimo del cliente custom

- En `v1.5+`, el cliente custom debe consumir y mostrar respuestas `SuccessResult<T>` e `InternalError` emitidas por el orquestador.
- El cliente custom no define un schema paralelo para operaciones del runtime.
- `formatters.ts` solo adapta presentacion local; no altera semantica de estados, errores ni payloads.
- En CLI/TUI local, las capacidades minimas son:
  - listar jobs pendientes o en revision;
  - ver detalle de un job;
  - solicitar una accion al orquestador;
  - mostrar error accionable sin reinterpretar su semantica.
- estas son capacidades del cliente, no operaciones del runtime; por eso no aparecen en el catalogo operativo de 8.5.

---

## 12. Variables de entorno y configuracion

```bash
# WhatsApp / MCP actual
WHATSAPP_WEB_CDP_PORT=9222
WHATSAPP_BOT_CONFIG_FILE=tmp/bot.config.json

# Proveedor IA
AI_PROVIDER=openai
AI_API_KEY=
AI_MODEL=gpt-5.4-mini
AI_TIMEOUT_MS=30000

# Orquestador
ORCHESTRATOR_MODE=active
ORCHESTRATOR_STATE_FILE=tmp/orchestrator-state.json
ORCHESTRATOR_JOB_FILE=tmp/orchestrator-jobs.json
ORCHESTRATOR_REVIEW_REQUEST_FILE=tmp/orchestrator-review-requests.json
ORCHESTRATOR_APPROVALS_FILE=tmp/orchestrator-approvals.json
ORCHESTRATOR_RUNTIME_LOCK_FILE=tmp/orchestrator.lock
ORCHESTRATOR_MAX_PARALLEL_JOBS=3
ORCHESTRATOR_WATCH_TIMEOUT_MS=300000
ORCHESTRATOR_BACKFILL_MS=20000
ORCHESTRATOR_POLICY_VERSION=v1

# Politicas
AUTO_SEND_ENABLED=false
AUTO_FOLLOW_UP_ENABLED=false
REQUIRE_REVIEW_FOR_REPLY=true
REQUIRE_REVIEW_FOR_FOLLOW_UP=true

# Cliente custom HTTP futuro (v2.5+)
HTTP_HOST=127.0.0.1
PORT=3010
MCP_SECRET=
MCP_SECRET_PREVIOUS=
HTTP_SESSION_TTL_MS=28800000
HTTP_SECRET_ROTATION_GRACE_MS=900000

# Seguridad HTTP futura (v2.5+)
ALLOWED_ORIGINS=http://127.0.0.1:3010
ALLOWED_HOSTS=127.0.0.1,localhost
HTTP_RATE_LIMIT_RPM=60
HTTP_RATE_LIMIT_WINDOW_MS=60000
HTTP_RATE_LIMIT_BURST=10
```

Nota:

- variables obligatorias por release:
  - `v1.0`: `WHATSAPP_WEB_CDP_PORT`, `ORCHESTRATOR_MODE`, `ORCHESTRATOR_STATE_FILE`, `ORCHESTRATOR_JOB_FILE`, `ORCHESTRATOR_REVIEW_REQUEST_FILE`, `ORCHESTRATOR_APPROVALS_FILE`, `ORCHESTRATOR_RUNTIME_LOCK_FILE`, `ORCHESTRATOR_MAX_PARALLEL_JOBS`, `ORCHESTRATOR_WATCH_TIMEOUT_MS`, `ORCHESTRATOR_BACKFILL_MS`, `ORCHESTRATOR_POLICY_VERSION`, `AUTO_SEND_ENABLED`, `AUTO_FOLLOW_UP_ENABLED`, `REQUIRE_REVIEW_FOR_REPLY`, `REQUIRE_REVIEW_FOR_FOLLOW_UP`;
  - `v1.5+`: se agregan `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`;
  - `v2.5+`: se agregan `HTTP_HOST`, `PORT`, `MCP_SECRET`, `MCP_SECRET_PREVIOUS`, `HTTP_SESSION_TTL_MS`, `HTTP_SECRET_ROTATION_GRACE_MS`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, `HTTP_RATE_LIMIT_RPM`, `HTTP_RATE_LIMIT_WINDOW_MS`, `HTTP_RATE_LIMIT_BURST`.
- las variables HTTP y de secreto local solo aplican desde `v2.5+`; no forman parte del setup obligatorio de `v1.0`.
- el transporte HTTP futuro hace bind en `http://${HTTP_HOST}:${PORT}`.
- los paths de store relativos (`tmp/...`) se resuelven desde la raiz del repo/runtime actual; si se usan paths absolutos, prevalecen tal cual.
- salvo indicacion explicita en el nombre o la nota, las variables de este bloque son obligatorias para el release activo; las marcadas `v2.5+` son futuras y no deben copiarse a `.env.example` de `v1.0`.
- si `HTTP_HOST`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS` o `HTTP_RATE_LIMIT_RPM` tienen valores invalidos en `v2.5+`, el transporte HTTP local no debe arrancar y debe devolver error de configuracion accionable en boot.
- `HTTP_SESSION_TTL_MS` define la expiracion maxima del token local de sesion del cliente HTTP en `v2.5+`; no se permite sesion sin TTL explicito.
- `HTTP_SECRET_ROTATION_GRACE_MS` define la ventana maxima en la que `MCP_SECRET_PREVIOUS` puede seguir aceptandose durante una rotacion controlada.
- `WHATSAPP_BOT_CONFIG_FILE` es una variable heredada del bot actual; en el orquestador nuevo solo se usa si se reutiliza configuracion ya existente del repo y no constituye por si sola fuente de verdad del runtime.

### 12.1 Reglas de seguridad

- Nunca exponer secretos en logs, errores o codigo.
- `.env` debe permanecer en `.gitignore`.
- `AUTO_SEND_ENABLED=false` por defecto.
- `confirm_review_send` representa envio confirmado por humano y no requiere un flag separado de auto-send; su habilitacion depende de identidad local valida, politica del job y `confirm_write`.
- Si el cliente custom se expone por HTTP, debe aplicar rate limiting antes del handler.
- Toda aprobacion humana debe quedar auditada en storage local.
- `MCP_SECRET_PREVIOUS` solo aplica desde `v2.5+` y se usa exclusivamente para aceptar temporalmente el secreto anterior durante una rotacion controlada de sesion del cliente custom HTTP.
- `MCP_SECRET` autentica cliente custom HTTP -> orquestador HTTP local; no autentica el servidor MCP stdio actual.
- la rotacion de `MCP_SECRET` debe tener ventana temporal explicita y cierre manual del secreto anterior; no se permite fallback indefinido.
- el runtime debe adquirir `ORCHESTRATOR_RUNTIME_LOCK_FILE` al iniciar; si el lock existe y esta activo, una segunda instancia no puede arrancar en modo operativo.
- en `.env.example`, `MCP_SECRET=` vacio es un placeholder permitido solo porque el transporte HTTP es futuro en `v1.0`; en cualquier release que habilite HTTP local, el secreto vacio debe fallar en boot.

### 12.2 Scopes / permisos por dominio

| Dominio | Permisos / scopes | Tipo de credencial | Notas |
|---|---|---|---|
| WhatsApp Web | sesion local autenticada | sesion UI | no oficial |
| Proveedor IA | inferencia de texto | API key | `CONFIRMED` |
| Storage local del runtime | lectura/escritura sobre archivos JSON y lock file del orquestador | filesystem local | obligatorio para jobs, estado, review-requests y approvals |
| Cliente custom HTTP | token local | token local | `INFERRED` |

### 12.3 Estrategia lazy de permisos

```text
Primera llamada real al proveedor IA
  -> si error de auth:
    -> retornar error accionable
    -> incluir codigo exacto si existe
    -> no terminar el proceso
    -> no loguear secretos

Primera llamada real a WhatsApp Web
  -> si la sesion local no esta lista:
    -> retornar error accionable
    -> no crear jobs de escritura
    -> mantener el loop en modo de espera controlada

Primera llamada real a CDP / WhatsApp Web
  -> si falla la conectividad CDP o la automatizacion base:
    -> retornar error accionable
    -> no crear jobs de escritura
    -> registrar warning operativo reutilizable
    -> mantener el runtime en espera controlada

Primera escritura real al state-store
  -> si falla el filesystem o el write atomico:
    -> retornar error accionable
    -> entrar en modo degradado seguro
    -> bloquear nuevas mutaciones write-gated
    -> no enviar mensajes

Primera llamada real al cliente custom HTTP (v2.5+)
  -> si el token local es invalido:
    -> retornar error accionable
    -> no ejecutar mutaciones
```

---

## 12.3.1 Contenido minimo de `.env.example`

El archivo `.env.example` debe incluir, como minimo:

```bash
WHATSAPP_WEB_CDP_PORT=9222
AI_PROVIDER=openai
AI_API_KEY=
AI_MODEL=gpt-5.4-mini
AI_TIMEOUT_MS=30000
ORCHESTRATOR_MODE=active
ORCHESTRATOR_STATE_FILE=tmp/orchestrator-state.json
ORCHESTRATOR_JOB_FILE=tmp/orchestrator-jobs.json
ORCHESTRATOR_REVIEW_REQUEST_FILE=tmp/orchestrator-review-requests.json
ORCHESTRATOR_APPROVALS_FILE=tmp/orchestrator-approvals.json
ORCHESTRATOR_RUNTIME_LOCK_FILE=tmp/orchestrator.lock
ORCHESTRATOR_MAX_PARALLEL_JOBS=3
ORCHESTRATOR_WATCH_TIMEOUT_MS=300000
ORCHESTRATOR_BACKFILL_MS=20000
ORCHESTRATOR_POLICY_VERSION=v1
AUTO_SEND_ENABLED=false
AUTO_FOLLOW_UP_ENABLED=false
REQUIRE_REVIEW_FOR_REPLY=true
REQUIRE_REVIEW_FOR_FOLLOW_UP=true
```

---

## 12.4 Integracion con el MCP existente

- Para v1.0 el orquestador no debe invocar el servidor MCP via stdio.
- Para v1.0 el orquestador debe importar funciones internas compartidas del repo cuando exista equivalente estable.
- El servidor MCP actual sigue siendo la superficie publica para clientes externos.
- El orquestador es una capa interna de runtime y puede depender de modulos TS internos del proyecto.
- Si una capacidad solo existe como tool MCP y no como modulo reutilizable, su extraccion a modulo compartido queda permitida siempre que no cambie el contrato MCP publico.
- Se considera "equivalente estable" a un modulo interno exportado, cubierto por tests o ya usado por mas de una superficie del repo, y cuyo uso no requiera reimplementar selectores o contratos MCP publicos.
- Importar modulos internos o extraer capacidades compartidas no autoriza duplicar ni bifurcar la capa de selectores/UI de WhatsApp Web; la propiedad de selectores sigue siendo unica y debe permanecer alineada con la capa MCP existente.

## 12.5 Fuente de verdad de configuracion

- En `v1.x`, la fuente primaria de configuracion del runtime es el entorno (`process.env`) con defaults documentados en este archivo.
- `config local` en tablas y transportes significa valores resueltos desde variables de entorno y validados al boot del orquestador.
- Ningun archivo de configuracion adicional es obligatorio en `v1.0` salvo los JSON de estado persistente del store.
- `ORCHESTRATOR_MODE` controla el modo del runtime:
  - `active`: escucha eventos y ejecuta scheduler;
  - `diagnostic`: no envia ni crea jobs de escritura y solo permite inspeccion/diagnostico del store y conectividad.
- `ORCHESTRATOR_POLICY_VERSION` es la fuente de verdad del versionado de politica usado por `PolicyContext.config.policyVersion` y por la key de cache de `auto_follow_up_job`.
- `ORCHESTRATOR_RUNTIME_LOCK_FILE` es la traduccion operativa minima del principio de "instancia unica compartida"; en `v1.x` no se requiere `instanceId` publico adicional mientras el lock local sea suficiente.
- precedencia config/politica:
  - si `AUTO_SEND_ENABLED=false`, una decision `PolicyDecision.action="auto_send"` debe degradarse de forma determinista:
    - `reply` o `support_response` -> `review`;
    - `follow_up` con `REQUIRE_REVIEW_FOR_FOLLOW_UP=true` -> `review`;
    - `follow_up` con `REQUIRE_REVIEW_FOR_FOLLOW_UP=false` -> `skip`;
    - cualquier job sin `chatKey` o sin artefacto enviable -> `cancel`;
  - si `AUTO_FOLLOW_UP_ENABLED=false`, un follow-up nunca puede autoenviarse aunque la politica lo sugiera;
  - si `AUTO_SEND_ENABLED=false` y `REQUIRE_REVIEW_FOR_REPLY=false` / `REQUIRE_REVIEW_FOR_FOLLOW_UP=false`, el runtime sigue sin autoenviar y aplica la tabla determinista anterior; esos flags no rehabilitan auto-send por si solos;
  - una aprobacion humana valida via `confirm_review_send` puede ejecutar el envio aun con `AUTO_SEND_ENABLED=false`, porque ya no es una decision automatica sino una confirmacion explicita;
  - los flags de config son guardrails superiores; la politica no puede anularlos.

---

## 13. Rate limiting y resiliencia

### 13.1 Estrategia de backoff

```text
Request fallido
  -> espera min(base * 2^intento, cap_maximo_ms)
  -> si tiempo_acumulado > 30 segundos:
    -> fallar de inmediato
    -> retornar accion: reintentar despues
```

Nota:

- esta estrategia aplica a fallos retryables de I/O o dependencias externas;
- el tiempo acumulado y el contador de reintentos se miden por job u operacion retryable individual; no son un presupuesto global compartido por todo el proceso;
- corrupcion del state-store, input invalido y transiciones invalidas de job deben fallar de inmediato sin backoff.

### 13.2 Configuracion por defecto

| Parametro | Valor |
|---|---|
| Base de espera | `1000` ms |
| Factor multiplicador | `2` |
| Cap maximo por espera | `10000` ms |
| Limite total | `30` segundos |
| Maximo de reintentos | `4` |

### 13.3 Limites conocidos

| Tipo de limite | Cuota | Codigo de error | Notas |
|---|---|---|---|
| proveedor IA | variable por proveedor | `429` | usar backoff; cache local solo donde el contrato lo defina explicitamente |
| loop del orquestador | 3 jobs paralelos por defecto | `LOCAL_LIMIT` | evitar saturacion |
| cliente HTTP local (v2.5+) | `HTTP_RATE_LIMIT_RPM` por minuto | `429` | aplicar antes del handler HTTP |
| cliente HTTP local (v2.5+) | `HTTP_RATE_LIMIT_BURST` por ventana | `429` | usar junto con `HTTP_RATE_LIMIT_WINDOW_MS` |
| cliente HTTP local (v2.5+) | `HTTP_SESSION_TTL_MS` por sesion | `AUTH_FAILED` | TTL obligatorio del token local |
| `auto_follow_up_job.chat_keys` | max `50` por invocacion | `INVALID_INPUT` | validacion de operacion, no rate limit |
| `watch_activity.timeout_ms` | max `3600000` por invocacion | `INVALID_INPUT` | hard cap por llamada individual |
| cooldown por chat | `45000` ms por defecto | `POLICY_BLOCKED` | aplica a nuevas acciones de escritura conversacional |
| store JSON del runtime | max `25` MB por archivo operativo en `v1.x` | `LOCAL_LIMIT` | si se supera, degradar a diagnostico y planear migracion/retencion |
| retencion de approvals/review-requests | `90` dias o snapshot/export previo | `LOCAL_LIMIT` | evitar crecimiento indefinido del storage local |

Nota:

- salvo `ORCHESTRATOR_MAX_PARALLEL_JOBS`, los demas guardrails del loop son defaults canonicos del runtime en `v1.x`; no se promueven a variables de entorno hasta que exista un caso operativo que justifique exponerlos sin fragmentar el contrato.

### 13.4 Headers de monitoreo

| Header | Contenido | Accion |
|---|---|---|
| `x-request-id` | correlacion local | loggear |
| `retry-after` | espera sugerida por proveedor IA o por el transporte HTTP local en `v2.5+` | respetar |

Nota:

- estos headers aplican solo cuando existe una superficie HTTP o una respuesta de proveedor externo que los exponga; no aplican al transporte CLI local de `v1.x`.
- si existe `retry-after`, el runtime debe respetar como minimo ese valor; si el backoff exponencial local calcula una espera mayor, prevalece la mayor.

### 13.5 Guardrails operativos del loop

| Limite | Valor | Regla |
|---|---|---|
| Maximo de jobs activos por tipo + chat | `1` | no crear un segundo job activo del mismo tipo para el mismo `chat_key` |
| Maximo de jobs totales por chat en ventana corta | `3` por `10` min | si supera el limite, cancelar nuevos jobs con warning |
| Cooldown por chat | `45000` ms | valor fijo por defecto del runtime en `v1.0`; no depende de leer configuracion del bot legado |
| Retry cap por job | `4` | al superar el cap pasa a `failed_terminal` |
| Dedupe por tipo + chat | `activo` | clave minima: `job_type:chat_key` |
| Maximo de jobs paralelos | `3` | no exceder `ORCHESTRATOR_MAX_PARALLEL_JOBS` como limite global por proceso del orquestador |

Interpretacion obligatoria:

- el limite efectivo es por combinacion `job_type:chat_key`;
- puede haber jobs activos de distinto tipo para un mismo chat solo si no violan politica ni cooldown;
- la regla de dedupe y el limite por chat usan la misma clave minima: `job_type:chat_key`.
- la ventana corta de `3` jobs por `10` min se mide sobre `createdAt` de jobs persistidos para el mismo `chat_key`;
- el dedupe aplica a jobs activos; no bloquea por si solo jobs historicos terminales.
- para estos guardrails, `pending`, `running` y `pending_review` cuentan como estados activos.
- `request_human_review` y `confirm_review_send` no estan sujetos al cooldown conversacional de respuesta ni al dedupe por `job_type:chat_key`; deben respetar transiciones validas, precondiciones de estado e idempotencia operacional.
- el `Retry cap por job` del loop adopta el mismo valor por defecto que `Maximo de reintentos` del backoff en `v1.0`; si divergen en el futuro, la configuracion del loop prevalece para cierre terminal del job.

---

## 14. Testing

### 14.1 Cobertura minima obligatoria por release

| Release | Cobertura minima | Paths criticos obligatorios |
|---|---|---|
| v1.0 | `70%` | jobs, state-store, politicas y errores de runtime local |
| v1.5 | `80%` | review, backoff, validacion, auto-follow-up |
| v2.0 | `85%` | rate limiting, health check, dead-letter, redaction |

Regla de medicion:

- el porcentaje de coverage por release aplica como minimo a los modulos nuevos o modificados del release activo dentro de `src/orchestrator/`, `src/ai/` y `src/utils/` afectados por ese sprint, no al repo historico completo.

### 14.2 Estructura de tests

```text
tests/
├── unit/
│   ├── orchestrator-policies.test.mjs
│   ├── orchestrator-jobs.test.mjs
│   ├── state-store.test.mjs
│   ├── orchestrator-approvals.test.mjs
│   ├── orchestrator-operation-contracts.test.mjs
│   ├── state-machine-transitions.test.mjs
│   ├── ai-provider.test.mjs
│   └── backoff.test.mjs
└── contract/
    ├── custom-client-contract.test.mjs
    └── orchestrator-lifecycle.test.mjs
```

Nota:

- en `v1.0` solo son obligatorios los tests del runtime y store;
- `state-store.test.mjs` cubre orden estable, recuperacion por corrupcion, bootstrap e invariantes de `saveJob()`/`transitionJob()`.
- `state-machine-transitions.test.mjs` cubre la maquina de estados valida, rechazos de transicion y metadata asociada a transiciones criticas.
- `ai-provider.test.mjs` y `custom-client-contract.test.mjs` entran con `v1.5+`.
- `orchestrator-approvals.test.mjs` cubre persistencia humana, auditoria y corrupcion del archivo de approvals; en `v1.0` puede existir con alcance minimo sobre el store aunque `confirm_review_send` entre en `v1.5`.
- `orchestrator-operation-contracts.test.mjs` debe cubrir, como minimo, la diferencia entre operaciones que crean job (`watch_activity`, `backfill_unread`, `create_review_job`, `draft_reply_job`, `auto_follow_up_job`) y operaciones que solo transicionan/evidencian (`request_human_review`, `confirm_review_send`, `reassign_job`, `dead_letter_retry`).
- `test:all` es la suite agregada recomendada cuando ya existan tests unitarios y de contrato del orquestador en el sprint activo.

Canon:

- el bloque de scripts de 10.3 es el canon ejecutable del repo;
- la estructura de 14.2 define la suite minima objetivo que esos scripts deben cubrir a medida que el runtime exista;
- no existe un segundo bloque de scripts canonico separado para testing.

### 14.3 Reglas de testing

- Unit tests con mocks del proveedor IA y WhatsApp tools.
- Contract tests del cliente custom y del store de jobs.
- Casos negativos obligatorios.
- Hasta que la suite nueva del runtime exista en el repo, los gates de coverage y contract tests del orquestador se consideran objetivos del sprint activo, no evidencia ya disponible en el estado base del repositorio.
- En escrituras, testear rechazo por politica, falta de confirmacion y chat fuera de alcance.
- Incluir casos explicitos de transicion invalida del state machine.
- Incluir casos explicitos para `StateStore.transitionJob()` y para persistencia/lectura de `HumanApprovalRecord`.
- Incluir casos explicitos para `StateStore.saveJobArtifacts()` y su rechazo cuando intente mutar `status`, `type`, `attempts` o `chatKey`.
- Incluir casos explicitos de recuperacion por JSON corrupto y entrada a modo degradado seguro.
- Incluir casos explicitos de `policyVersion` cuando afecte cache o decisiones derivadas.

---

## 15. Gates de release

### 15.1 Gates universales

| Gate | Criterio | Evidencia |
|---|---|---|
| Tests unitarios | `>= 70%` en paths criticos | `npm run test:coverage` o coverage CI equivalente |
| Linting | 0 errores bloqueantes | `npm run lint` |
| Typecheck | 0 errores | `npm run typecheck` |
| No auto-send por defecto | ninguna ruta automatica envia con `AUTO_SEND_ENABLED=false` en el release activo | test/checklist/manual |
| Secretos en codigo | 0 secretos expuestos | scanner/manual |
| `.env` ignorado | presente en `.gitignore` | verificacion repo |

Nota:

- este gate universal aplica al release activo y a los modulos afectados por el cambio; no exige alcanzar coverage global del repo historico.
- `npm run test:coverage` mide coverage unitario de los modulos afectados; los contract tests se gatean por existencia/verde, no por el numerador de coverage salvo que CI combine ambas fuentes explicitamente.
- el umbral universal y el umbral de `v1.0` coinciden deliberadamente; el de `v1.0` concreta los paths criticos y el universal define el gate transversal.
- para este gate, `.env.example` puede contener `MCP_SECRET=` vacio solo mientras el transporte HTTP siga fuera del release activo; cualquier secreto de ejemplo no vacio debe ser sintacticamente ficticio y no reutilizable.

### 15.2 Gates v1.0

| Gate | Criterio | Evidencia |
|---|---|---|
| Runtime base operativo | `start:orchestrator`, `orchestrator:store:init`, `orchestrator:store:inspect` y `orchestrator:run` funcionan en local | comandos / evidencia manual |
| Store consistente | crea y lee `state`, `jobs`, `review-requests` y `approvals` segun contrato | test / evidencia manual |
| Maquina de estados cerrada | transiciones validas e invalidas cubiertas | suite |
| Compatibilidad MCP heredada | no hay regresion observable en `src/index.ts` ni en contratos MCP publicados | test / inspeccion dirigida |
| No auto-send por defecto | ninguna ruta automatica envia con la config minima de `v1.0` | test / checklist / manual |

### 15.2.1 Evidencia minima manual v1.0

```markdown
## Evidencia manual v1.0

- [ ] WhatsApp Web autenticado y accesible via `WHATSAPP_WEB_CDP_PORT`
- [ ] `npm run start:orchestrator` arranca sin crash
- [ ] `npm run orchestrator:run -- watch_activity --timeout_ms=1000` o comando equivalente del runtime ejecuta una operacion `P0` controlada
- [ ] `watch_activity` tolera timeout limpio sin crear envio
- [ ] `backfill_unread` persiste jobs base sin enviar mensajes
- [ ] `create_review_job` deja job en `pending_review`
- [ ] `AUTO_SEND_ENABLED=false` verificado en entorno local
- [ ] store JSON creado en `tmp/` con archivos esperados
```

### 15.3 Gates v1.5

| Gate | Criterio | Evidencia |
|---|---|---|
| Tests de contrato | schema estable | suite |
| Backoff funcional | reintenta sin crash | test |
| Validacion de schema | input invalido no rompe proceso | test |
| Autorizacion por politica | accion bloqueada falla correctamente | test |
| Compatibilidad MCP | no hay regresion observable en `src/index.ts` ni en contratos MCP publicados | test/inspeccion dirigida |

### 15.4 Gates v2.0

| Gate | Criterio | Evidencia |
|---|---|---|
| Auditoria de dependencias | 0 CVE criticos | `npm audit` |
| Lockfile comprometido | consistente | repo |
| Secretos en logs | 0 leaks | pruebas |
| Health check | respuesta sana del orquestador en menos de `500` ms | test de comando local, archivo de estado o endpoint local del orquestador si existiera |
| Rate limiting activo | sobre limite retorna `429` en la superficie HTTP local cuando exista | test |
| Revision auth/transporte | checklist completo | PR |
| Secretos de transporte futuro | rotacion documentada de `MCP_SECRET` / `MCP_SECRET_PREVIOUS` | checklist / PR |

### 15.5 Checklist pre-merge obligatorio

```markdown
## Checklist pre-merge

### Seguridad
- [ ] No hay tokens ni secretos en codigo
- [ ] Redaction aplicada a logs nuevos
- [ ] Cambios en auth/transporte revisados
- [ ] Flags criticos revisados (`AUTO_SEND_ENABLED=false`, `AUTO_FOLLOW_UP_ENABLED=false` y `REQUIRE_REVIEW_*` coherentes con el release)

### Calidad
- [ ] Tests pasan
- [ ] 0 errores de typecheck
- [ ] Toda operacion nueva documenta entrada y salida
- [ ] Si cambia superficie MCP publica o modulos compartidos que la soportan, se verifica compatibilidad con `src/index.ts`

### Operacion
- [ ] `.env.example` actualizado
- [ ] `package.json` y scripts del repo coherentes con el release y el plan
- [ ] si cambian scripts o dependencias, `package-lock.json` y el impacto operativo de `package.json` fueron revisados
- [ ] si cambia storage persistido, compatibilidad de archivos JSON, bootstrap y estrategia de migracion/rollback fueron revisados
- [ ] `README.md` actualizado
- [ ] `plan.md` actualizado si cambia cualquier contrato, variable, flujo o gate del runtime
- [ ] `README.md` y `plan.md` coherentes entre si para variables, flujos y limites del release activo

Regla:

- "documento actualizado" significa ajustar la version o changelog si corresponde y modificar todas las secciones afectadas por el cambio, no solo una referencia aislada.
- cuando cambie cualquier contrato del runtime, este item implica actualizar `plan.md` explicitamente; no basta con actualizar solo `README.md`.
```

### 15.5 Documentacion minima por release

| Release | README obligatorio |
|---|---|
| v1.0 | arranque local del orquestador, variables requeridas, limites operativos base |
| v1.5 | cliente CLI/TUI, flujo de review, proveedor IA y politicas |
| v2.0 | matriz de operaciones, auth, permisos, hardening y observabilidad |
| v2.5 | transporte HTTP local, token local y politicas de sesion |

---

## 16. Flujos E2E esperados

### 16.1 Flujo de exito v1.0

- Entra evento de actividad.
- `watch_activity` identifica `chat_key`.
- Crea o actualiza job base de trazabilidad.
- Lee `state-store`, aplica dedupe, cooldown y guardrails antes de derivar trabajo.
- Aplica politica.
- Si corresponde respuesta revisable, ejecuta `create_review_job` y crea un job nuevo en `pending_review`.
- Toda evolucion posterior del mismo job ocurre via `transitionJob()`; no se mezcla creacion inicial con transiciones terminales.
- Se persiste estado, resultado operativo del job y evidencia humana solo cuando la operacion del release lo soporte.

### 16.2 Flujo de exito v1.5+

- Entra evento de actividad.
- El orquestador identifica `chat_key`.
- Lee contexto reciente mediante modulos internos reutilizados del backend MCP existente.
- Corre auditoria/feed si aplica.
- Aplica politica.
- Si corresponde clasificacion, ejecuta `classify_conversation`.
- Si corresponde borrador, ejecuta `draft_reply_job`.
- Genera borrador o review job.
- Si corresponde review humano explicito: `request_human_review` mueve el job a `pending_review`.
- Si el tipo es respuesta general y la politica exige review: `confirm_review_send` confirma o rechaza.
- Si el tipo es follow-up y la politica permite auto-send: se ejecuta el envio controlado.
- Se persiste estado, aprobacion humana cuando exista y evidencia operativa.

### 16.3 Flujo de degradacion v1.0

- Falla la sesion local de WhatsApp.
- El orquestador no se cae.
- Registra error accionable.
- No crea jobs de escritura.
- El runtime queda en espera controlada.
- Si falla una escritura del store o se detecta corrupcion, el runtime entra en modo diagnostico/degradado y bloquea nuevas mutaciones write-gated.
- En modo degradado no se permite ningun envio, ni automatico ni confirmado por humano, hasta recuperar lectura/escritura valida del store.

### 16.4 Flujo de degradacion v1.5+

- Falla auth del proveedor IA.
- El orquestador no se cae.
- Registra error accionable.
- Si el job estaba en `running`, lo transiciona a `failed_retryable`.
- El cliente custom muestra proximo paso.
- Si falla la persistencia de approvals o review-requests, el runtime no confirma ni rechaza externamente el job y expone error accionable de auditoria.

### 16.5 Flujo de recuperacion

- Se reintenta con backoff.
- Si el error persiste, se mueve a cola de revision humana o queda listo para recuperacion manual futura.
- Si WhatsApp Web no esta lista, el loop espera una verificacion periodica de readiness del runtime antes de continuar.
- Si el state-store esta corrupto, el runtime entra en modo degradado seguro: recupera estructura vacia por archivo, emite warning operativo y bloquea mensajes salientes hasta nueva lectura valida.

Nota:

- `dead_letter_retry` modela el camino de recuperacion manual posterior para jobs que ya agotaron reintentos automaticos.

---

## 17. Riesgos y mitigaciones

| Riesgo | Severidad | Release/Fase | Mitigacion | Owner |
|---|---|---|---|---|
| Fragilidad por cambios de UI de WhatsApp Web | Alta | v1.0+ | mantener MCP actual como unica capa de UI y no duplicar selectores | Tech Lead |
| Envio automatico incorrecto | Alta | v1.0+ | `AUTO_SEND_ENABLED=false` por defecto y politicas explicitas | Product/Tech |
| Saturacion del proveedor IA | Alta | v1.5 | backoff, cache local in-memory con TTL/LRU solo donde el contrato lo permita, y limite de jobs paralelos | Backend |
| Estado inconsistente en JSON files | Media | v1.0-v1.5 | escritura atomica, writer serializado, recuperacion segura por archivo en `orchestrator-state.json`, `orchestrator-jobs.json`, `orchestrator-review-requests.json` y `orchestrator-approvals.json`, y migracion a SQLite si la carga lo exige | Backend |
| Drift entre flags de config y `PolicyDecision` | Media | v1.0+ | precedencia formal config > politica, tests de degradacion a `review/skip/cancel` y checklist de flags criticos | Backend |
| Confirmacion/envio no idempotente | Alta | v1.5+ | `confirm_review_send` no idempotente por contrato, transiciones unicas y tests de repeticion | Backend |
| Drift entre custom-client y orquestador | Media | v1.5+ | contrato unico del runtime, formatters sin semantica propia y tests de contrato del cliente | Backend/UX |
| Divergencia entre `SuccessResult<T>` y payloads crudos de handlers | Media | v1.0+ | envelope canonico unico, tests de contrato y revision de handlers antes de merge | Backend |
| Drift de casing/nombres entre estados y outputs | Media | v1.0+ | usar un unico casing canonico en tipos, responses y docs; tests de contrato sobre `status`, `jobType` y timestamps expuestos | Backend |
| Falta de observabilidad | Alta | v2.0 | logging estructurado y metricas | Platform |

Nota:

- antes de `v2.0`, la observabilidad minima obligatoria sigue siendo: errores accionables, evidencias persistidas y trazas verificables del runtime.

---

## 18. Definiciones operativas

| Termino | Definicion |
|---|---|
| Ready | modulo u operacion implementable con contrato cerrado, dependencias disponibles, compatibilidad de storage vigente, compatibilidad MCP heredada vigente y alcance de release vigente; para operaciones del catalogo implica tambien estar registrada en 8.5 con estado normativo consistente |
| Done | modulo u operacion con tests, evidencia manual, docs, gates completos, compatibilidad de storage persistido y compatibilidad de contratos MCP/cliente para la superficie que cambia; para operaciones del catalogo implica implementacion mas registro/documentacion cerrados |
| Error accionable | mensaje con causa y siguiente paso concreto |
| `confirm_write` | guardrail declarativo. Valor esperado: `"CONFIRMED_BY_USER"` |
| `review job` | job persistente de respuesta revisable que puede agrupar contexto, borrador, motivo de politica y evidencia humana antes de cualquier envio |
| `policy-engine` | modulo que decide review, auto-send, skip o cancel; no define escalacion como accion separada en `v1.x` |
| `state-store` | persistencia de estado por chat, jobs, solicitudes de review y aprobaciones humanas |
| `Write-gated` | operacion que muta estado persistente local y/o puede terminar en mutacion externa; requiere guardrail declarativo segun contrato |
| `sesion local` | sesion interactiva local de WhatsApp Web mantenida por el runtime en el entorno del operador; equivalente operativo a la `sesion UI` del navegador controlado |
| `preview` | texto breve no normativo proveniente de la UI/evento observado; sirve para triage local y nunca reemplaza la lectura formal del contexto del chat |
| `Read` | operacion solo de consulta, sin mutacion persistente local ni externa |
| `Read/Write` | operacion que combina lectura y mutacion material sobre configuracion o auth |
| `seguimiento` | tracking interno de un chat o job como candidato a pasos posteriores del engine; no constituye por si mismo una operacion separada |

---

## 19. ADR - Decisiones de arquitectura

| # | Decision | Alternativas descartadas | Justificacion | Estado |
|---|---|---|---|---|
| ADR-01 | Mantener el servidor MCP actual como backend de capacidades para el orquestador; el cliente custom consume al orquestador, no al MCP publico | Reescribir toda la capa de WhatsApp dentro del orquestador | reduce riesgo y reuso de codigo existente | `ACTIVA` |
| ADR-02 | Crear un orquestador separado de `bot.ts` | inflar el bot actual con toda la logica nueva | separacion de responsabilidades | `ACTIVA` |
| ADR-03 | Cliente custom primero como CLI/TUI local | UI web completa desde v1.0 | menor costo de implementacion inicial | `ACTIVA` |
| ADR-04 | Estado inicial en JSON para v1.0; evaluar SQLite en v1.5/v2.0 con migracion compatible | introducir DB compleja desde el dia 1 | entrega mas rapida y reversible | `ACTIVA` |
| ADR-05 | El cliente custom no contiene logica operativa | duplicar politicas/estado en CLI o UI | una sola autoridad de runtime | `ACTIVA` |
| ADR-06 | El orquestador reutiliza modulos TS internos en v1.0 | montar un cliente MCP stdio dentro del mismo repo | menor complejidad y mas robustez | `ACTIVA` |

---

## 20. Roadmap visual consolidado

```text
Semana 1-2 (v1.0)
├── Sprint A: skeleton del orquestador + estado + loop reactivo
└── Sprint B: creacion de review jobs + politicas basicas + pruebas locales

Semana 3 (v1.5)
├── Sprint C: cliente custom CLI + cola operativa
└── Sprint D: adapter IA + auto-follow-up controlado + tests

Semana 4 (v2.0)
└── Sprint E: hardening + logging + health + containerizacion

Semana 5+ (v2.5)
└── Sprint F+: UI web y auth local si se aprueba
```

**Total:** 5 sprints base, ~25 dias, 13 operaciones definidas.

Supuesto de planning:

- la estimacion `~25 dias` asume 1 equipo pequeno con capacidad sostenida de 1 sprint semanal, baja interrupcion externa y reuso significativo del backend MCP existente; si esa capacidad no existe, el roadmap conserva orden relativo pero no calendario comprometido.

### 20.1 Alcance exacto de Sprint A

Archivos obligatorios:

- `src/orchestrator/index.ts`
- `src/orchestrator/types.ts`
- `src/orchestrator/state-store.ts`
- `src/orchestrator/engine.ts`
- `src/orchestrator/jobs.ts`
- `src/orchestrator/policies.ts`
- `src/orchestrator/handlers/activity.ts`
- `src/orchestrator/handlers/backfill.ts`
- `src/orchestrator/handlers/review-create.ts`
- `src/utils/errors.ts`
- `src/utils/backoff.ts`

Archivos explicitamente fuera de Sprint A:

- `src/custom-client/cli.ts`
- cualquier cliente HTTP
- cualquier UI web
- SQLite
- implementacion real de proveedor IA
- cualquier auth de proveedor distinta de placeholders/configuracion no operativa

### 20.2 Definition of Done por sprint

#### Sprint A

- [ ] `npm run build` verde
- [ ] `npm test` verde
- [ ] `npm run test:unit` verde para la suite nueva de orquestador
- [ ] `tests/contract/orchestrator-lifecycle.test.mjs` existe o queda cubierto por suite equivalente del sprint
- [ ] `dist/orchestrator/index.js` arranca sin crash
- [ ] persiste jobs y estado en `tmp/orchestrator-jobs.json` y `tmp/orchestrator-state.json`
- [ ] procesa al menos un evento mock y deja traza persistida en el job store sin enviar mensajes
- [ ] `npm run orchestrator:run -- watch_activity --timeout_ms=1000` o comando equivalente del runtime existe para verificacion manual deterministicamente reproducible
- [ ] aplica la politica minima por defecto
- [ ] respeta la maquina de estados definida en este documento
- [ ] evidencia manual minima capturada de arranque, evento mock y persistencia del store
- [ ] documentacion minima alineada (`plan.md`, `.env.example` y README del release si cambia la superficie)

#### Sprint B

- [ ] crea `review jobs` reales desde eventos o backfill
- [ ] aplica dedupe por `job_type:chat_key`
- [ ] no envia mensajes automaticamente con config por defecto
- [ ] errores retryables quedan persistidos y reintentan con backoff
- [ ] tests cubren al menos `running -> failed_retryable`, `failed_retryable -> pending` y cierre terminal por retry cap cuando aplique al sprint
- [ ] evidencia manual minima capturada del flujo de review sobre jobs existentes

Nota:

- en `Sprint A` deben existir el scheduler base, el state-store y los guardrails estructurales;
- en `Sprint B` esos guardrails pasan de scaffolding a enforcement operativo completo sobre jobs reales;
- "review jobs reales" en `Sprint B` significa jobs persistidos desde `watch_activity` o `backfill_unread` con payload y estado validos del runtime, no placeholders manuales ni fixtures sin state machine.
- `request_human_review` y `confirm_review_send` pertenecen al alcance formal de `v1.5` y su validacion completa comienza a partir de `Sprint C`.

#### Sprint C

- [ ] cliente custom CLI consulta cola y estado sin contener logica operativa
- [ ] puede listar jobs, ver detalle y solicitar acciones al orquestador
- [ ] `request_human_review` opera sobre jobs existentes en `running`
- [ ] `confirm_review_send` opera sobre jobs existentes en `pending_review`
- [ ] evidencia manual minima capturada de lectura y accion solicitada al runtime

#### Sprint D

- [ ] proveedor IA responde al contrato `AIAdapter`
- [ ] clasificacion y drafts funcionan detras de policy-engine
- [ ] auto-follow-up sigue bloqueado salvo politica explicita
- [ ] evidencia manual minima capturada de clasificacion y draft

#### Sprint E

- [ ] logging estructurado activo
- [ ] health check operativo
- [ ] `metrics_export` y `policy_audit_report` generan salida valida
- [ ] hardening y gates de seguridad superados
- [ ] evidencia manual minima capturada del health check y exportes operativos

---

## 21. Gobernanza de sprints y aprobacion

### 21.1 Roles por sprint

| Sprint | Owner | Reviewer | Approver |
|---|---|---|---|
| Sprint A | Backend | Tech Lead | Product Owner |
| Sprint B | Backend | Security Reviewer | Product Owner |
| Sprint C | Backend/UX | Tech Lead | Product Owner |
| Sprint D | Backend/AI | Tech Lead | Product Owner |
| Sprint E | Platform | Security Reviewer | Product Owner |

### 21.2 Cierre de sprint

Un sprint solo se considera cerrado cuando:
- el checklist del sprint esta completo;
- los gates aplicables estan superados;
- existe evidencia verificable;
- los riesgos residuales quedan documentados.

Nota:

- `Sprint F+` pertenece al roadmap expandido posterior a los 5 sprints base y no se contabiliza en el total base del plan.

---

## 22. Referencias y fuentes de verificacion

| Fuente | URL / Ubicacion | Informacion obtenida |
|---|---|---|
| Codigo actual | `src/index.ts`, `src/bot.ts`, `src/bot-daemon.ts` | capacidades existentes del MCP y del bot |
| Tests actuales | `tests/whatsapp-locators.test.mjs` | contratos vigentes y regresiones cubiertas |
| README actual | `README.md` | herramientas, casos de uso y operacion documentada |

---

## Apendice A - Contratos detallados

### A.1 `create_review_job`

```typescript
import { z } from "zod";

const CreateReviewJobInput = z.object({
  chat_key: z.string().min(1),
  policy_reason: z.string().min(1),
  review_type: z.enum(["reply", "follow_up", "support_response"]),
  confirm_write: z.literal("CONFIRMED_BY_USER"),
});

type CreateReviewJobOutput = SuccessResult<{
  id: string;
  status: "pending_review";
}>;
```

Nota:

- en `v1.x`, Zod queda asumido como libreria obligatoria de validacion runtime para inputs del orquestador; su version exacta debe pinnearse en `package.json` del sprint que introduzca estas operaciones.

### A.2 Contratos operativos minimos del runtime

```typescript
type JobStatus =
  | "pending"
  | "running"
  | "pending_review"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled";

type JobType =
  | "watch_activity"
  | "backfill_unread"
  | "create_review_job"
  | "auto_follow_up_job";

type PolicyDecision =
  | { action: "skip"; reason: string }
  | { action: "review"; reason: string }
  | { action: "auto_send"; reason: string }
  | { action: "cancel"; reason: string };

interface OrchestratorJob {
  id: string;
  type: JobType;
  status: JobStatus;
  chatKey?: string;
  chatName?: string;
  priority?: "low" | "medium" | "high";
  queueKey?: string;
  queuePosition?: number;
  owner?: string;
  requestId?: string;
  policyReason?: string;
  policyVersion?: string;
  reviewToken?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  deadLetterCount?: number;
  deadLetteredAt?: string;
  payload:
    | CreateReviewJobPayload
    | AutoFollowUpJobPayload;
  result?:
    | { classification?: ClassifyConversationOutput; warnings?: string[] }
    | { draft?: { reply: string; alternatives?: string[]; rationale?: string; sourceSummary?: string; model?: string }; warnings?: string[] }
    | { approvalRecordedAt?: string; sendOutcome?: "sent" | "not_sent" | "failed" }
    | { items?: AutoFollowUpJobResultItem[] }
    | { status?: JobStatus };
  error?: string;
  warnings?: string[];
}

type JobTransition =
  | "pending_to_running"
  | "running_to_pending_review"
  | "running_to_completed"
  | "running_to_failed_retryable"
  | "failed_retryable_to_pending"
  | "failed_retryable_to_failed_terminal"
  | "failed_terminal_to_pending"
  | "running_to_cancelled"
  | "pending_review_to_failed_retryable"
  | "pending_review_to_completed"
  | "pending_review_to_cancelled";

interface OrchestratorEvent {
  type: "incoming-message" | "unread-chat";
  chatKey: string;
  chatName: string;
  unreadCount?: number;
  preview?: string;
  timestamp: number;
}

interface ActivitySource {
  waitForEvent(timeoutMs: number): Promise<{
    type: "incoming-message" | "unread-chat";
    chatName?: string;
    chatKey?: string;
    unreadCount?: number;
    preview?: string;
    timestamp?: number;
  } | null>;
}

interface ActivityEventAdapter {
  toOrchestratorEvent(input: Awaited<ReturnType<ActivitySource["waitForEvent"]>>): OrchestratorEvent | null;
}

interface ChatRuntimeSnapshot {
  lastEventAt?: string;
  lastJobId?: string;
  lastPolicyDecision?: PolicyDecision["action"];
  lastReviewRequestedAt?: string;
  lastApprovalAt?: string;
  activeJobCount?: number;
  cooldownUntil?: string;
  lastError?: string;
}

interface OrchestratorState {
  chats: Record<string, ChatRuntimeSnapshot>;
  providerCooldownUntil?: string;
}

interface RuntimeDerivedState {
  activeJobKeys: string[];
  recentWindowCounts: Record<string, number>;
}

interface RuntimeCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface RuntimeScheduler {
  maxParallelJobs: number;
  watchTimeoutMs: number;
  backfillIntervalMs: number;
  acquireRuntimeLock(): Promise<void>;
  releaseRuntimeLock(): Promise<void>;
}

interface StateStore {
  loadState(): Promise<OrchestratorState>;
  saveState(state: OrchestratorState): Promise<void>;
  listJobs(): Promise<OrchestratorJob[]>;
  listPendingReviewJobs(): Promise<OrchestratorJob[]>;
  listReviewRequests(): Promise<ReviewRequestEvidence[]>;
  findActiveJobByKey(jobType: JobType, chatKey: string): Promise<OrchestratorJob | null>;
  listActiveJobsByChatKey(chatKey: string): Promise<OrchestratorJob[]>;
  saveJob(job: OrchestratorJob): Promise<void>;
  saveReviewRequest(record: ReviewRequestEvidence): Promise<void>;
  listApprovals(): Promise<HumanApprovalRecord[]>;
  saveApproval(record: HumanApprovalRecord): Promise<void>;
  transitionJob(
    id: string,
    transition: JobTransition,
    payload?: {
      result?: OrchestratorJob["result"];
      error?: string;
      warnings?: string[];
      actorType?: "system" | "human";
      actorId?: string;
      reason?: string;
      requestId?: string;
      transitionMeta?: Record<string, string | number | boolean | null>;
    }
  ): Promise<OrchestratorJob>;
  saveJobArtifacts(
    id: string,
    payload?: {
      result?: OrchestratorJob["result"];
      warnings?: string[];
      actorType?: "system" | "human";
      actorId?: string;
      reason?: string;
      requestId?: string;
    },
    payloadPatch?: Record<string, unknown>
  ): Promise<OrchestratorJob>;
}

interface ReviewSendCapability {
  confirmReviewedReply(input: {
    jobId: string;
    chatKey: string;
    approvalActor: string;
    reviewAction: "approved" | "rejected";
    draftText?: string;
    draftRef?: string;
    reviewToken?: string;
  }): Promise<{
    sent: boolean;
    providerMessageId?: string;
    warnings?: string[];
  }>;
}

interface PolicyContext {
  job: OrchestratorJob;
  sourceEvent?: OrchestratorEvent | null;
  timelineSummary?: string;
  chatState: ChatRuntimeSnapshot | null;
  jobIntent: "reply" | "follow_up" | "support_response" | "analysis" | "other";
  actionType: "reply" | "follow_up" | "support_response" | "analysis" | "other";
  actorType?: "system" | "human";
  actorId?: string;
  staleAfterMinutes?: number;
  config: {
    autoSendEnabled: boolean;
    autoFollowUpEnabled: boolean;
    requireReviewForReply: boolean;
    requireReviewForFollowUp: boolean;
    policyVersion: string;
  };
  guardrails?: {
    activeJobsForChat?: number;
    recentJobsForChatWindow?: number;
    cooldownActive?: boolean;
  };
}

interface PolicyEngine {
  decide(context: PolicyContext): PolicyDecision;
}

interface ClassifyConversationInput {
  chatKey: string;
  timelineSummary: string;
  chatState: ChatRuntimeSnapshot | null;
}

interface ClassifyConversationOutput {
  intent: string | null;
  stage: string | null;
  priority: "low" | "medium" | "high" | null;
  labels: string[];
  summary: string | null;
}

interface DraftReplyInput {
  chatKey: string;
  draftType: "reply" | "follow_up";
  timelineSummary: string;
  chatState: ChatRuntimeSnapshot | null;
}

interface AIAdapter {
  healthcheck(): Promise<AIHealthcheckOutput>;
  getRuntimeInfo(): {
    provider: string;
    model: string;
    timeoutMs: number;
  };
  classify(input: ClassifyConversationInput): Promise<ClassifyConversationOutput>;
  draftReply(input: DraftReplyInput): Promise<{
    reply: string;
    alternatives?: string[];
    rationale?: string;
    sourceSummary?: string;
    model?: string;
    warnings?: string[];
  }>;
}

// Portabilidad:
// cambios en AI_PROVIDER no deben cambiar el contrato de AIAdapter;
// solo la implementacion concreta del proveedor detras de esa interfaz.

interface AIHealthcheckOutput {
  ok: boolean;
  checkedAt: string;
  provider: string;
}

interface HumanApprovalRecord {
  id: string;
  jobId: string;
  chatKey?: string;
  reviewToken?: string;
  requestId?: string;
  actor: string;
  action: "approved" | "rejected";
  confirmWriteUsed: boolean;
  policyVersion?: string;
  policyReasonSnapshot?: string;
  sendOutcome?: "sent" | "not_sent" | "failed";
  sendResult?: {
    sent: boolean;
    providerMessageId?: string;
  };
  reason?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string;
}

interface ReviewRequestEvidence {
  jobId: string;
  chatKey?: string;
  actorId: string;
  requestId?: string;
  policyVersion?: string;
  reason: string;
  createdAt: string;
}

interface CreateReviewJobPayload {
  chatKey: string;
  chatName?: string;
  policyReason: string;
  reviewType: "reply" | "follow_up" | "support_response";
  actionKind: "reply" | "follow_up" | "support_response";
  confirmWriteUsed: boolean;
  reviewToken?: string;
  draftText?: string;
  draftRef?: string;
  source: "watch_activity" | "backfill_unread" | "manual" | "manual_batch" | "reactive_policy" | "scheduler" | "actionable_feed";
  sourceEvent?: OrchestratorEvent;
}

interface AutoFollowUpJobPayload {
  chatKeys: string[]; // max 50
  source: "actionable_feed" | "manual_batch" | "reactive_policy" | "watch_activity" | "backfill_unread" | "scheduler";
  policyVersion: string;
  staleAfterMinutes?: number;
  messageLimit?: number;
  cacheKey?: string;
  decisionSource?: string;
  policyReason?: string;
}

interface AutoFollowUpJobResultItem {
  chatKey: string;
  jobId?: string;
  status?: JobStatus;
  error?: string;
  warnings?: string[];
}

type AutoFollowUpJobOutput = SuccessResult<AutoFollowUpJobResultItem[]>;

interface RequestHumanReviewInput {
  jobId: string;
  reason: string;
}

interface ConfirmReviewSendInput {
  jobId: string;
  approvalActor: string;
  reviewAction: "approved" | "rejected";
  confirmWrite: "CONFIRMED_BY_USER";
}

interface MetricsExportInput {
  windowMinutes?: number;
}

interface MetricsExportOutput {
  generatedAt: string;
  counters: {
    jobsCreated: number;
    jobsCompleted: number;
    jobsCancelled: number;
    jobsFailedRetryable: number;
    jobsFailedTerminal: number;
    reviewRequestsCreated: number;
    approvalsApproved: number;
    approvalsRejected: number;
  };
}

interface ReassignJobInput {
  jobId: string;
  owner: string;
}

interface DeadLetterRetryInput {
  jobId: string;
  confirmWrite: "CONFIRMED_BY_USER";
}

interface PolicyAuditReportInput {
  windowMinutes?: number;
}

interface PolicyAuditReportItem {
  jobId: string;
  jobType: JobType;
  policyReason?: string;
  decision: "review" | "auto_send" | "skip" | "cancel" | "approved" | "rejected";
  source: string;
  createdAt: string;
  approvalAction?: "approved" | "rejected";
}

interface SubscriptionAuthProviderInput {
  provider: string;
  subscriptionTokenRef: string;
}
```

Nota de release:

- en `v1.0`, `AIAdapter` puede existir solo como interfaz o stub no operativo;
- la primera implementacion real del adaptador IA entra en `v1.5`.
- `AIAdapter.healthcheck()` respalda el gate de health check de `v2.0`; no obliga a registrar una operacion catalogada `healthcheck_ai` separada en `v1.x`.
- `AIAdapter.getRuntimeInfo()` expone `provider`, `model` y `timeoutMs` efectivos para alinear contrato interno con `AI_PROVIDER`, `AI_MODEL` y `AI_TIMEOUT_MS`.
- `CreateReviewJobPayload.sourceEvent` es opcional porque un review job puede nacer desde un evento reactivo, desde backfill o desde una accion manual del runtime.
- `CreateReviewJobPayload.source` usa la misma taxonomia de disparador inmediato que el resto del runtime; cuando un review job deriva de `watch_activity`, el valor canonico es `watch_activity`, no `event`.
- `policyReason` es texto libre controlado por runtime/policy-engine en `v1.x`; no se congela como enum mientras no exista una taxonomia formal cerrada.
- `OrchestratorJob.chatKey` y `chatName` permanecen opcionales a nivel de modelo global porque existen jobs diagnosticos/administrativos que podrian no ser conversacionales; para `watch_activity`, `backfill_unread`, `create_review_job`, `auto_follow_up_job` y para operaciones de respuesta/confirmacion sobre jobs conversacionales, `chatKey` se considera obligatorio por contrato operativo.
- `classify_conversation`, `draft_reply_job`, `request_human_review`, `confirm_review_send`, `metrics_export`, `policy_audit_report`, `reassign_job`, `dead_letter_retry` y `subscription_auth_provider` son contratos de operacion; no son `JobType` en `v1.x` salvo que un release futuro los promueva explicitamente.
- Existen dos rutas validas y explicitas hacia `pending_review`:
  - creacion directa via `create_review_job`;
  - transicion `running_to_pending_review` via `request_human_review`.
- `draft_reply_job` no es por si mismo una transicion a review; su responsabilidad es producir/enriquecer el artefacto enviable del flujo.
- `saveJobArtifacts()` aplica merge parcial sobre artefactos permitidos del payload existente; no reemplaza el payload completo del job.
- cuando `PolicyContext.chatState=null`, la politica minima debe operar con defaults conservadores: no asumir historial, no inferir cooldown previo ausente y degradar a `review` o `skip` antes que a `auto_send`.
- `HumanApprovalRecord.reason` es una razon opcional de aprobacion/rechazo humano y no reemplaza la razon obligatoria de `ReviewRequestEvidence`.
- `HumanApprovalRecord.policyReasonSnapshot` permite correlacionar la decision humana con el motivo de politica vigente al momento de la confirmacion.
- `HumanApprovalRecord` solo modela decisiones humanas (`approved`/`rejected`); cancelaciones tecnicas del runtime no deben persistirse como aprobacion humana.
- `HumanApprovalRecord.updatedAt` permite correcciones auditadas de metadatos sin perder el `decidedAt` original.
- puede haber multiples `HumanApprovalRecord` historicos para un mismo `jobId` solo si representan intentos/decisiones distintas materializadas por el runtime; la unicidad recomendada es por `id`, no por `jobId`.
- `CreateReviewJobPayload` debe conservar al menos uno entre `draftText`, `draftRef` o `reviewToken` cuando el job ya este listo para confirmacion humana real; en `v1.0` puede existir solo el contenedor.
- `AutoFollowUpJobPayload.cacheKey` es derivado del runtime y no input del cliente; se persiste solo para trazabilidad y diagnostico del scheduler.
- `attempts` inicia en `0` al crear el job y aumenta solo al registrar un intento real de ejecucion retryable.
- `result` y `error` no deben coexistir en estado terminal para la misma transicion; solo se admite `warnings` junto con cualquiera de ellos.
- `requestId` permite correlacion local con `x-request-id` cuando exista una superficie de request/response o diagnostico del runtime.
- `providerCooldownUntil` representa una espera global temporal impuesta por `retry-after` u otro bloqueo retryable del proveedor; no es cooldown conversacional por chat.
- `saveJobArtifacts()` existe para enriquecer payload/result/warnings de un job sin cambiar su `status`; no puede modificar `status`, `attempts`, `createdAt`, `type` ni `chatKey`.
- `saveJobArtifacts()` recibe `payloadPatch` semantico y no reemplaza el payload completo; el merge se limita a artefactos permitidos del tipo de job objetivo.

### A.3 Maquina de estados valida de jobs

```text
pending -> running
running -> pending_review
running -> completed
running -> failed_retryable
failed_retryable -> pending
failed_retryable -> failed_terminal
running -> cancelled
pending_review -> failed_retryable
pending_review -> completed
pending_review -> cancelled
```

Reglas:

- No se permite `pending -> completed` directo.
- `pending_review -> completed` requiere accion explicita de confirmacion.
- `pending_review -> failed_retryable` se usa cuando una aprobacion humana es valida pero el envio externo falla.
- si un job en `pending_review` expira, queda obsoleto por cambio de contexto o requiere redraft, el runtime debe transicionarlo a `cancelled` con `reason` accionable y crear un nuevo job derivado en lugar de reusar silenciosamente el mismo contenedor.
- `cancelled` y `failed_terminal` son estados finales.
- `completed` es estado final.
- Toda transicion invalida debe fallar con error interno accionable.

### A.4 Politica minima por defecto

```text
- Toda accion de escritura queda en modo review por defecto.
- `AUTO_SEND_ENABLED=false`.
- `AUTO_FOLLOW_UP_ENABLED=false`.
- Si no hay `chat_key`, no se crea job de escritura.
- Si falla el proveedor IA, el job pasa a `failed_retryable`.
- Si el chat queda fuera de politica, la decision formal es `PolicyDecision.action="cancel"` y el job pasa a `cancelled`.
- `request_human_review` explicito por operador humano sigue permitido si el job existe y su estado es elegible, aunque `AUTO_SEND_ENABLED=false`.
- si `AUTO_SEND_ENABLED=false`, `confirm_review_send` humano sigue permitido para jobs elegibles en `pending_review`; el flag bloquea automatizacion, no confirmacion humana explicita.
- sobre jobs ya `cancelled`, `request_human_review` debe fallar por estado invalido.
- un job ya en `pending_review` no debe auto-cancelarse ni auto-promoverse solo porque cambie la config; requiere reevaluacion o accion humana explicita posterior.
- si `backfill_unread` no puede resolver `chat_key` de un item observado, ese item se omite con warning operativo y nunca crea job de escritura.
```

### A.5 Contrato minimo del state-store JSON

```text
Archivos exactos:
- `tmp/orchestrator-state.json`
- `tmp/orchestrator-jobs.json`
- `tmp/orchestrator-review-requests.json`
- `tmp/orchestrator-approvals.json`

Reglas de implementacion:
- escritura atomica via archivo temporal + rename
- un solo writer logico por proceso
- lock entre procesos via `ORCHESTRATOR_RUNTIME_LOCK_FILE` para asegurar una unica instancia operativa del orquestador escribiendo el store a la vez
- writes serializados internamente
- si el JSON esta corrupto:
  - registrar error accionable
  - emitir warning operativo y contador de recuperacion
  - recuperar con estructura vacia segura
  - no enviar mensajes

Regla de API:
- no se permiten patches arbitrarios de job;
- todo cambio de estado pasa por `transitionJob()` y debe respetar la maquina de estados;
- cambios de `result`, `error` y `warnings` solo pueden adjuntarse junto con una transicion valida.
- `saveJob()` se usa para creacion inicial del job y para escrituras no terminales de metadatos/payload antes de que el job entre al ciclo de transiciones.
- una vez que el job sale de `pending`, toda mutacion de `status`, `attempts`, `error` o `result` terminal debe pasar por `transitionJob()`.
- `saveJobArtifacts()` es la unica API permitida para enriquecer `payload`, `result` no terminal o `warnings` de un job ya existente sin cambiar su `status`.
- `saveJob()` puede persistir payload, metadatos base y warnings iniciales de creacion; no debe persistir por si solo un `result` terminal ni un `error` terminal sin transicion valida.
- `saveJob()` no debe crear jobs nuevos ya nacidos en `running`, `completed`, `failed_retryable`, `failed_terminal` o `cancelled`; la creacion inicial valida en `v1.x` es `pending` o `pending_review` segun la operacion catalogada.
- `saveJobArtifacts()` debe rechazar cualquier intento de mutar `status`, `type`, `chatKey`, `attempts`, `createdAt` o `updatedAt` fuera de la semantica propia de la API.
- el cliente custom nunca escribe directo sobre archivos JSON; toda escritura pasa por el orquestador como unico writer logico del store.
- la solicitud de revision humana debe persistirse como `ReviewRequestEvidence`.
- toda aprobacion humana se persiste en storage local con estructura `HumanApprovalRecord`.
- en un flujo de confirmacion humana, la transicion de job y el `saveApproval()` asociado deben quedar consistentes dentro de la misma unidad logica del runtime; no se permite registrar aprobacion exitosa sin transicion de job correspondiente.
- si la transicion del job falla, `saveApproval()` no debe materializarse; si el runtime implementa compensacion inversa, debe dejar traza accionable.
- la cola de revision humana en `v1.x` se define como la vista derivada de `listPendingReviewJobs()` sobre jobs en `pending_review`; no requiere un archivo adicional separado.
- la corrupcion del archivo de aprobaciones obliga a preservar el archivo dañado para inspeccion y a levantar warning operativo; no habilita borrado silencioso de evidencia.
- la recuperacion segura por JSON corrupto es por archivo individual; una corrupcion en `orchestrator-jobs.json` no invalida automaticamente `orchestrator-state.json` ni `orchestrator-approvals.json`.
- `listApprovals()` y `saveApproval()` usan la misma disciplina de recuperacion por archivo que el resto del store; una corrupcion en approvals no cambia el contrato de lectura de `jobs` o `state`.
- `listJobs()` debe devolver orden estable por `createdAt` ascendente y, en empate, por `id`; cualquier vista derivada puede reordenar explicitamente encima de esa base.
- "estructura vacia segura" significa, por archivo: `{"chats":{}}` para state, `[]` para jobs, `[]` para review-requests y `[]` para approvals.
- antes de recuperar un archivo corrupto, el runtime debe preservarlo con rename o backup diagnostico local (`*.corrupt.<timestamp>.json`) cuando el filesystem lo permita.
- el modo degradado por corrupcion de store permite solo lectura diagnostica y operaciones sin mutacion externa; no debe crear nuevos jobs de respuesta ni enviar mensajes.
- el warning por corrupcion del store debe ser visible para la superficie consumidora activa del runtime, ya sea CLI, logs operativos o respuesta estructurada de diagnostico.
- la deteccion de corrupcion activa modo degradado seguro para el runtime completo hasta nueva lectura valida del store; no solo para la operacion puntual que detecto el problema.
- cache LRU y guardrails de ventana corta pueden derivarse de `listJobs()`, `findActiveJobByKey()`, `listActiveJobsByChatKey()` y/o de estado transitorio en memoria; no requieren persistirse en `OrchestratorState` en v1.0.
- la cache de `auto_follow_up_job` es transitoria e in-memory en `v1.x`, implementada detras de `RuntimeCache`; no forma parte de `OrchestratorState`.
- el writer serializado del store cubre los cuatro archivos del runtime (`state`, `jobs`, `review-requests`, `approvals`) bajo la misma disciplina de escritura atomica y serializacion interna.
```

---

## Apendice B - Onboarding para nuevos agentes

```markdown
## Onboarding - Nuevo agente en whatsapp-web-mcp-server

### Lectura obligatoria
- [ ] 0. Modo del documento
- [ ] 1. Objetivo
- [ ] 2. Problema
- [ ] 4. Alcance por release
- [ ] 5. Priorizacion
- [ ] 6. Principios de diseno
- [ ] 8. Registro de operaciones
- [ ] 8.5 Catalogo operativo y 8.6 Matriz de control
- [ ] 9. Contratos del sprint activo
- [ ] A.2 Contratos operativos minimos del runtime
- [ ] A.3 Maquina de estados valida de jobs
- [ ] A.4 Politica minima por defecto
- [ ] A.5 Contrato minimo del state-store JSON
- [ ] 12. Variables de entorno
- [ ] 15. Gates de release

### Verificacion del entorno
- [ ] WhatsApp Web autenticado
- [ ] `WHATSAPP_WEB_CDP_PORT` resoluble y sesion CDP funcional para el runtime
- [ ] `npm run build` funciona
- [ ] `npm test` pasa
- [ ] `npm run test:unit` y `npm run test:contract` estan disponibles cuando la suite del orquestador exista en el sprint activo
- [ ] `npm run dev:orchestrator` y `npm run start:orchestrator` son invocables en el entorno local del sprint activo
- [ ] `npm run orchestrator:store:init` ejecutable para bootstrap del store cuando aplique
- [ ] `dist/orchestrator/index.js` arranca en el entorno local del sprint activo
- [ ] directorio `tmp/` escribible y archivos `ORCHESTRATOR_STATE_FILE`, `ORCHESTRATOR_JOB_FILE`, `ORCHESTRATOR_REVIEW_REQUEST_FILE` y `ORCHESTRATOR_APPROVALS_FILE` creables por el runtime
- [ ] directorio `tmp/` existe o puede crearse sin escalacion adicional en el entorno operativo local
- [ ] variables minimas de `.env.example` revisadas y presentes para el release activo
- [ ] flags criticos revisados (`AUTO_SEND_ENABLED=false`, `AUTO_FOLLOW_UP_ENABLED=false`, `REQUIRE_REVIEW_FOR_REPLY`, `REQUIRE_REVIEW_FOR_FOLLOW_UP`) antes de pruebas operativas
- [ ] `npm run test:all` ejecutable cuando la suite del orquestador ya exista en el sprint activo
- [ ] catalogo operativo y matriz de control revisados contra el sprint activo
- [ ] Para sprint >= v1.5: proveedor IA accesible con una llamada diagnostica
- [ ] Para sprint >= v1.5: `AI_TIMEOUT_MS` validado para el proveedor configurado

### Reglas de trabajo
- [ ] No implementar items `PROVISIONAL` o `BLOCKED` sin confirmacion
- [ ] Ante ambiguedad material: preguntar y documentar
- [ ] Todo cambio en auth o transporte requiere checklist reforzado
- [ ] No cerrar sprint sin evidencia verificable
```

---

## Apendice C - Modo compacto permitido

No aplica para este plan.
