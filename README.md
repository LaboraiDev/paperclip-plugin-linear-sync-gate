# Linear sync gate (plugin de Paperclip)

Comprueba cada 5 minutos, **sin LLM**, si hay trabajo para la rutina «Linear ↔ Paperclip sync (gated)», y solo entonces la dispara por su webhook. Quien razona y responde sigue siendo el agente de la rutina (Programing CEO).

## Por qué

Medido en producción el 08/10:
- 18–20 de cada 20 ejecuciones de la rutina no encontraban nada;
- cada una costaba ~0,50 USD equivalentes;
- a 5 minutos serían 288 ejecuciones al día gastando el plan para descubrir que no hay trabajo.

## Qué comprueba

| | Fuente | Regla |
|---|---|---|
| A. Menciones pendientes | Linear | Igual que `linear-app-actor.sh pending-mentions --label "Ready for AI"`. Mira las issues con esa etiqueta en triage, unstarted o started. Una mención es un comentario que no es de la app y contiene `@<nombre de la app>` (regex, sin distinguir mayúsculas) o la URL de su perfil. Está pendiente si la última mención es posterior al último comentario de la app |
| B. Entrada | Linear | Igual que `list --state "Todo" --label "Ready for AI"` |
| C. Bloqueos nuevos | Paperclip | Tareas del agente que **entran** en `blocked` desde la comprobación anterior, menos las que tienen `awaiting-prototype-merge` (ellas o sus bloqueadores directos). La primera comprobación solo fija la línea base |

**Por qué C usa transiciones:** la rutina no tiene un enlace fijo a la issue de Linear de cada tarea; la deduce leyendo la descripción. Reproducir esa deducción sin LLM daría falsos positivos.

## Disparo

- **Nada pendiente** (A, B y C vacías): no hace nada y gasta 0 tokens.
- **Algo pendiente:** `POST` al webhook `bearer` de la rutina. El `Idempotency-Key` es la huella del conjunto pendiente más la hora de la comprobación.
- **Antibucle:** no repite el mismo conjunto antes de `refireMinutes` (60 por defecto).
- **Entrega no aceptada:** si se fusiona con una ejecución en curso (`coalesced`) o falla, no guarda estado y reintenta en la siguiente comprobación.
- **Fase de observación:** con el webhook en `setupPending: true`, la respuesta es `test_received` y no se crea ninguna ejecución.

## Token de Linear

En cada comprobación se pide un token `client_credentials`, se usa y se revoca. Los permisos tienen que ser **exactamente** los de `linear-app-actor.sh` (`read write app:mentionable`): con otros, Linear revocaría todos los tokens de la app, incluido el del agente.

## Configuración (por compañía, en Ajustes → Plugins)

| Campo | Valor |
|---|---|
| `enabled` | `true` para activar la comprobación |
| `agentId` | id de Programing CEO |
| `webhookUrl` | URL del webhook `bearer` de la rutina «(gated)» |
| `webhookSecret` | Referencia al secreto de ese webhook |
| `linearClientId` / `linearClientSecret` | Los mismos secretos que usa `linear-app-actor` |
| `readyLabel`, `todoStateName`, `awaitingMergeLabel`, `refireMinutes` | Opcionales; por defecto `Ready for AI`, `Todo`, `awaiting-prototype-merge` y `60` |

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
