# Despliegue de Linear sync v0.2.0

**Principio:** nada se borra. La rutina «Linear ↔ Paperclip sync (gated)» solo se **pausa** al activar el plugin en `act`, y vuelve en 1 minuto si hace falta.

## Ya verificado

| Comprobación | Resultado |
|---|---|
| SDK = producción | `@paperclipai/plugin-sdk@2026.1005.0`, construido sobre el commit `467125f`, el que devuelve `/api/health` de producción |
| Eventos en ese commit | `issue.created`, `issue.updated` (con `status` y `_previous.status` en los dos caminos leídos), `issue.comment.created` (solo 120 caracteres del texto: el plugin lee el comentario completo) e `issue.relations.updated`. Leído en el código público de `467125f` |
| Ruta de webhooks de plugins en producción | `POST /api/plugins/laboraidev.paperclip-plugin-linear-sync-gate/webhooks/linear` → `400 "Plugin does not have the webhooks.receive capability"` con la v0.1.0. La ruta está activa y es pública, y Paperclip resuelve el plugin instalado. El 400 lo da Paperclip **antes** de llamar al plugin |
| Firma y entrega de Linear | HMAC-SHA256 en hex del cuerpo crudo en `Linear-Signature`, más `webhookTimestamp` dentro de 60 s. Linear espera 5 s y reintenta 3 veces (1 min, 1 h, 6 h); si sigue fallando puede desactivar el webhook. Por eso el plugin solo verifica y encola, y responde enseguida (documentación de Linear) |
| Límite de Linear | 5.000 llamadas/hora para una app OAuth. Cada barrida registra `linearCalls` en su log |
| Tests | Comprobación de tipos, 62 tests (incluido el caso LAB-5055 por barrida y solo por eventos) y build en verde. Se ejecutaron con los binarios locales (`tsc`, `vitest`, `esbuild`) porque `pnpm` no está instalado en esta máquina |

## Fase 2 — Instancia aislada construida desde el commit `467125f` (igual que la v0.1.0)

Lo que el arnés de tests del SDK **no** puede probar:
1. ¿`issue.updated` trae `status` y `_previous.status` en un PATCH normal de estado? Si no, solo se pierde rapidez: la barrida lo corrige.
2. ¿Un comentario con `actorUserId` despierta al agente asignado? El SDK dice que sí.
3. ¿`requestWakeup` reanuda una tarea que acaba de pasar de `blocked` a `todo`?
4. ¿Una llamada de webhook (sin compañía activa) puede leer y escribir tareas con `companyId`? Si no puede, el webhook solo registra y la barrida hace el trabajo en ≤5 min.

## Fase 3 — Producción en `observe` (necesita tu OK)

1. Publicar: `git tag v0.2.0 && git push --tags`. El workflow publica en GitHub Packages.
2. En el VPS: `paperclipai plugin install @laboraidev/paperclip-plugin-linear-sync-gate --version 0.2.0`. Luego `paperclipai plugin list` debe mostrarlo en `ready`.
3. Configuración (Ajustes → Plugins → Linear sync, compañía Laborai):
   - `enabled`: sí;
   - `mode`: **`observe`**;
   - `intakeAgentId`: `9b1bf0c0-a074-4661-9214-5f53afa3cfd9` (Programing CEO);
   - `linearClientId` / `linearClientSecret`: los secretos de `linear-app-actor`;
   - `relayFallbackUserId`: tu id de usuario de Paperclip;
   - `userMap`: email de Linear → id de usuario de Paperclip de cada persona;
   - `projectMap`: `{ "Backend": "a204c0ec-3173-4b83-8cb5-37a6dd6973b9", "Frontend": "9bb55fdb-d075-4c11-9d00-14d1053745e3" }` (los mismos de la rutina);
   - `routing`: los emails de `references/team-routing.md`;
   - `paperclipUrl`: `https://paperclip.projectllama.cloud`.
4. Webhook en Linear (Ajustes → API → Webhooks):
   - URL `https://paperclip.projectllama.cloud/api/plugins/laboraidev.paperclip-plugin-linear-sync-gate/webhooks/linear`;
   - recursos: Issues, Comments, Issue labels;
   - equipo DEV;
   - guardar el secreto de firma como secreto de Paperclip y ponerlo en `linearWebhookSecret`.
5. Repetir el `curl` de comprobación. Ya **no** debe responder `400 … webhooks.receive capability`. En los logs del plugin debe aparecer «Linear webhook rejected: no enabled company's secret matches the signature», porque el `curl` no va firmado. No se ha leído qué código HTTP devuelve Paperclip en ese caso: anótalo.
6. Durante 24–48 h, revisar:
   - logs «Linear sync (observe): would apply» y el estado `observed`;
   - el número de la primera pasada («adopted the current state…»);
   - cuántas etiquetas `Blocked` antiguas se quitarían (`linear.labels` con clave `…:legacy` en `observed`);
   - que LAB-5055 aparece como reanudación, si sigue atascada;
   - que no hay avisos de tareas padre que solo esperan a sus subtareas;
   - una mención de prueba en una issue de prueba → «would apply … paperclip.comment».

## Fase 4 — Activar `act` (necesita tu OK), en este orden

1. Pausar la rutina «Linear ↔ Paperclip sync (gated)» y quitar su cron. Nunca dos sincronizaciones a la vez.
2. Cambiar `mode` a `act`. La primera pasada en `act` vuelve a ser línea base: no inunda Linear.
3. Prueba de punta a punta:
   - pregunta en una issue de prueba → el agente de la tarea responde → la respuesta aparece en el hilo de Linear;
   - una issue en `Todo` con «Ready for AI» → en ≤5 min (o al instante con el webhook) aparece la tarea en Paperclip.

## Marcha atrás (1 minuto)

1. `mode: observe`, o desactivar el plugin.
2. Reactivar la rutina «(gated)», que no se ha modificado.

## Actualizaciones de Paperclip

- `paperclipai update` no toca el plugin. Después de cada actualización hay que mirar que sigue en `ready`.
- **Antes de la siguiente versión del plugin:**
  1. fijar `@paperclipai/plugin-sdk` a la versión nueva de producción;
  2. ejecutar `pnpm test`;
  3. probar en una instancia aislada de esa versión;
  4. publicar con un tag nuevo.
