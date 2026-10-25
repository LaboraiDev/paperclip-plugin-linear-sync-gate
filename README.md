# Linear sync (plugin de Paperclip)

Mantiene Linear y Paperclip sincronizados **sin LLM**. Linear es la interfaz: nadie tiene que entrar a Paperclip para ver qué pasa ni para desatascar nada.

> Hasta la v0.1.0 este plugin solo despertaba a la rutina «Linear ↔ Paperclip sync (gated)». Desde la v0.2.0 hace él la sincronización y la rutina se retira.

## Qué hace

| | Dirección | Qué |
|---|---|---|
| Entrada | Linear → Paperclip | Issue en `Todo` + «Ready for AI» → pasa a `In Progress` y se crea la tarea (asignada a la Programing CEO, proyecto según etiqueta Backend/Frontend) con el enlace guardado |
| Bloqueos | Paperclip → Linear | Cualquier tarea bloqueada del subárbol, de cualquier agente → comentario (motivo, a qué espera, desde cuándo) + etiqueta `Blocked`. Si hace falta una persona, la menciona según `routing` |
| Desbloqueos | Paperclip → Linear | Comentario; `Blocked` se quita cuando ya no queda nada bloqueado, solo si la puso (o adoptó) el plugin |
| Etiquetas antiguas | Linear | Una sola vez por issue: una `Blocked` que ya estaba se adopta si hay un bloqueo real, o se quita con un comentario si no lo hay. Una `Blocked` que una persona pone después no se toca nunca |
| Terminado | Paperclip → Linear | Comentario cuando todas las raíces enlazadas están en `done` (el estado de Linear no se toca) |
| Comentarios | Linear → Paperclip | Cada comentario humano nuevo llega a la tarea que espera a una persona (o la bloqueada más reciente, o la raíz) como comentario de esa persona, lo que despierta a su agente |
| Respuestas | Paperclip → Linear | La primera respuesta del agente tras ese comentario vuelve al mismo hilo de Linear |
| Autoarreglo | Paperclip | Tarea de arreglo terminada que «blocks LAB-X» → reanuda LAB-X. Relación «blocks» escrita pero no creada → la crea. Traspaso que nombra a una agente sin `agent://` → la menciona bien y reanuda su tarea |
| Atascadas | Paperclip → Linear | Bloqueada, sin nada que la bloquee y sin actividad en `staleMinutes` → un aviso con mención |

**No se anuncia:**
- lo que espera un merge de prototipo (`awaiting-prototype-merge`, en la tarea o en sus bloqueantes directos);
- una tarea padre que solo espera a sus propias subtareas, porque eso es avance normal.

## Disparadores

- **Eventos de Paperclip** (`issue.created`, `issue.updated`, `issue.comment.created`, `issue.relations.updated`): se agrupan 5 s y se reconcilia la issue de Linear afectada.
- **Webhook de Linear** (`/api/plugins/laboraidev.paperclip-plugin-linear-sync-gate/webhooks/linear`): verificado con `Linear-Signature` (HMAC-SHA256 del cuerpo) y `webhookTimestamp` (60 s).
- **Barrida cada 5 min**: red de seguridad. Paperclip publica los eventos sin garantía de entrega (`void emit(...)`), así que la barrida es la que asegura el resultado.

Los tres acaban en la misma función (`reconcileLinearIssue`), así que un evento perdido lo arregla la siguiente barrida con la misma lógica.

## Seguridad

- **Modo `observe`** (por defecto): no escribe nada. Registra cada acción una vez en los logs y en el estado `observed` (últimas 300).
- **Primera pasada en cada modo = línea base:** adopta lo que ya existe sin anunciarlo y sin tocar etiquetas. Solo lo atascado de verdad se anuncia y se arregla desde el principio.
- **En Linear solo escribe** comentarios, la etiqueta `Blocked` y `Todo → In Progress` (y su vuelta atrás si falla la creación). Nunca toca una issue cerrada para quitar `Blocked`.
- **Sin duplicados:** cada acción tiene una clave. Los comentarios de Linear usan un id determinista, como `linear-app-actor.sh`, y los demás se registran como hechos. Todo lo que escribe lleva la marca `<!-- linear-sync:… -->` y se ignora al leer. Los eventos que causa el propio plugin se ignoran.
- **Una pasada a la vez por compañía.**
- **Token de Linear:** se pide, se usa y se revoca en cada pasada, con exactamente los permisos de `linear-app-actor.sh` (`read write app:mentionable`).

## Configuración (por compañía, en Ajustes → Plugins)

| Campo | Valor |
|---|---|
| `enabled` | `true` para activar |
| `mode` | `observe` (por defecto) o `act` |
| `intakeAgentId` | id de la Programing CEO |
| `linearClientId` / `linearClientSecret` | Los mismos secretos que usa `linear-app-actor` |
| `linearWebhookSecret` | Secreto de firma del webhook de Linear (opcional: sin él solo corre la barrida) |
| `relayFallbackUserId` | Usuario de Paperclip al que se atribuyen los comentarios de autores que no están en `userMap` |
| `userMap` | email de Linear → id de usuario de Paperclip |
| `projectMap` | etiqueta de Linear → id de proyecto (`Backend` → API, `Frontend` → Frontend) |
| `routing` | `product`, `technicalByAssignee` y `technicalDefault`: emails a mencionar (ver `references/team-routing.md` del skill) |
| `manualLinks` | identificador de tarea raíz → identificador de Linear, para raíces sin enlace en la descripción |
| `paperclipUrl` | p. ej. `https://paperclip.projectllama.cloud`, para enlazar tareas desde Linear |
| `productLabel` | etiqueta de Paperclip que marca una pregunta de producto/diseño (por defecto `producto`) |
| `readyLabel`, `todoStateName`, `inProgressStateName`, `blockedLabel`, `awaitingMergeLabel`, `staleMinutes` | Opcionales. Por defecto `Ready for AI`, `Todo`, `In Progress`, `Blocked`, `awaiting-prototype-merge` y `30` |

**Producto o técnico.** La rutina decidía con criterio de un LLM si una pregunta era de producto o técnica. Sin LLM, la señal es la etiqueta `productLabel` en la tarea bloqueada. Si no la tiene, se usa el enrutado técnico.

## Versión de Paperclip

- Construido y probado contra **Paperclip 2026.1005.0** (commit `467125f`, la versión de producción), con `@paperclipai/plugin-sdk@2026.1005.0` de npm.
- Cuando producción se actualice: subir el SDK a esa versión exacta, ejecutar `pnpm test` y `pnpm build`, y publicar una versión nueva.

## Desarrollo

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
