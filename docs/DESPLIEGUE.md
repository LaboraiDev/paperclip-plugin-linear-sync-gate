# Despliegue del Linear sync gate

**Principio:** la rutina original «Linear ↔ Paperclip sync» (`60ebd6d9…`, revisión 17) no se modifica ni se elimina. Al activar el plugin solo se **pausa**.

## Verificado contra Paperclip 2026.1005.0 (instancia aislada, misma versión y commit que producción)

| Comprobación | Resultado |
|---|---|
| Instalación y carga del plugin | `ready`; 1 tarea registrada en el planificador |
| Cron `*/5` | Se ejecuta solo (`trigger: schedule`) |
| Configuración con referencias a secretos | Aceptada y validada contra `instanceConfigSchema` |
| Resolución de secretos y llamada a Linear con `ctx.http.fetch` | Sí (con credenciales falsas Linear responde 401 y la ejecución queda `failed` con ese mensaje, sin secretos) |
| Lecturas de Paperclip (`issues.list`, `issues.get`, `issues.relations.get`) | Funcionan. Ojo: `issues.get` **no** trae `blockedBy` en esta versión; se usa `issues.relations.get` |
| Webhook `bearer` con `setupPending: true` | `202 {"status":"test_received","test":true,"routineStarted":false}` |
| `ctx.http.fetch` a `localhost` o IP privada | **Bloqueado por el host (SSRF)**. `webhookUrl` debe ser la URL pública `https://paperclip.projectllama.cloud/api/routine-triggers/public/<id>/fire` (resuelve a IP pública, y el endpoint responde sin login; comprobado con un id inexistente → 404 de Paperclip) |

No verificado en local (requiere credenciales reales de Linear): las consultas reales a Linear y el disparo extremo a extremo. Eso es justo lo que valida la fase 3.

## Fase 1 — Publicar (con OK de Jesús)

1. Crear el repo **privado** `LaboraiDev/paperclip-plugin-linear-sync-gate` en GitHub.
2. Hacer push de `main`. El workflow `ci` pasa typecheck, tests y build.
3. Hacer push del tag `v0.1.0`. El workflow publica `@laboraidev/paperclip-plugin-linear-sync-gate@0.1.0` en GitHub Packages con el `GITHUB_TOKEN` del workflow.

## Fase 2 — Instalar en modo prueba (sin efecto en producción)

**En el VPS (Jesús), con el usuario que ejecuta Paperclip:**

```bash
# ~/.npmrc — token clásico de GitHub con SOLO read:packages
@laboraidev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<TOKEN_READ_PACKAGES>

paperclipai plugin install @laboraidev/paperclip-plugin-linear-sync-gate --version 0.1.0
paperclipai plugin list   # debe aparecer laboraidev.paperclip-plugin-linear-sync-gate en ready
```

**Rutina nueva (yo, con tu OK):**
- «Linear ↔ Paperclip sync (gated)»: copia exacta de la descripción de la revisión 17, mismo agente y mismas políticas.
- La copia se hace dentro de la página, con una sola llamada que lee la original y crea la nueva, para que el texto no pase por ninguna transcripción.
- Sin cron activo.

**En la UI (Jesús):**
1. En la rutina nueva, añadir un disparador **Webhook**:
   - firma `bearer`;
   - **dejarlo en modo configuración** (`setupPending`).
2. Paperclip enseña la URL y el secreto **una sola vez**. Guardar el secreto como secreto de Paperclip (p. ej. `LINEAR_GATE_WEBHOOK`).
3. En Ajustes → Plugins → Linear sync gate (compañía Laborai), rellenar:
   - `enabled`: sí
   - `agentId`: id de Programing CEO (`9b1bf0c0-a074-4661-9214-5f53afa3cfd9`)
   - `webhookUrl`: la URL **pública** del disparador
   - `webhookSecret`: `LINEAR_GATE_WEBHOOK`
   - `linearClientId` / `linearClientSecret`: los mismos secretos que usa `linear-app-actor`

## Fase 3 — Observar 24 h (yo leo; nada cambia)

La rutina original sigue igual, cada 30 minutos. Comparo dos fuentes:
- **Rutina original:** sus ejecuciones.
- **Plugin:**
  - el historial de ejecuciones de su tarea (`/api/plugins/<id>/jobs/<jobId>/runs`);
  - sus logs («nothing to fire» / «fired … test_received»);
  - el `lastWebhookDelivery` del disparador.

Criterio:
- si la original encontró trabajo, el plugin tuvo que disparar;
- si el plugin no disparó, la original no tuvo que encontrar nada.

## Fase 4 — Activar (con tu OK), en este orden

1. **Pausar la rutina original.**
2. En la nueva:
   - `PATCH /api/routine-triggers/<id>` `{ "setupPending": false }`;
   - añadir el cron de respaldo `0 */6 * * *` (Europe/Lisbon).

Nunca dos rutinas activas a la vez: se duplicarían las respuestas.

## Fase 5 — e2e (Jesús)

- Una issue de prueba en Todo con «Ready for AI»: en ≤5 min aparece la tarea en Paperclip.
- Una mención con una pregunta: en ≤5 min el agente responde en el hilo.

## Marcha atrás (1 minuto)

1. Pausar la rutina nueva. Los disparos del plugin devuelven 409 y no crean nada.
2. `paperclipai plugin disable laboraidev.paperclip-plugin-linear-sync-gate` (o desde la UI).
3. Reactivar la rutina original: vuelve con su cron `*/30`, su descripción y su historial.

## Actualizaciones de Paperclip

- `paperclipai update` no toca el plugin. Después de cada actualización hay que mirar que sigue en `ready`.
- **Antes de la siguiente versión del plugin:**
  1. fijar `@paperclipai/plugin-sdk` a la versión nueva de producción;
  2. ejecutar `pnpm test`;
  3. probar en una instancia aislada de esa versión;
  4. publicar con un tag nuevo.
