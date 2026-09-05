# Circuit Breaker

El circuit breaker por cuenta evita que 9Router martillee una cuenta que claramente está fallando. Cuando una cuenta acumula errores, el breaker se "abre" y la omite durante un cooldown — luego la sondea con suavidad antes de volver a confiar en ella.

Vive dentro del bucle de fallback del chat: cuando una cuenta se corta, tu petición simplemente cae a la siguiente cuenta sana. **Tú nunca ves el fallo.**

---

## Cómo funciona

```
La cuenta falla 5 veces en 60s
        ↓
🔴 Breaker ABIERTO — cuenta omitida 60s
        ↓ expira el cooldown
🟡 Half-open — exactamente UNA petición real entra como sonda pasiva
        ↓
✅ Éxito → el breaker se cierra, la cuenta vuelve plenamente
❌ Fallo → se reabre con cooldown ×2 (30s→60s→120s…, tope 10 min)
```

- **Umbral de fallos**: 5 fallos a nivel de cuenta en una ventana de 60 segundos (por defecto).
- **Cooldowns crecientes**: cada reapertura duplica el cooldown, con tope de 10 minutos.
- **Sonda pasiva**: una petición real de usuario actúa como sonda — sin tráfico sintético, y el usuario jamás se sacrifica: si la sonda falla, la petición cae a la siguiente cuenta.
- **Sin doble conteo**: los 429 de cuota ya gestionados por el strike-block de antigravity no cuentan como fallos del breaker.

Al abrirse o recuperarse un breaker se dispara la alerta `breaker-open` / `breaker-recovered` (ver [Alertas](./alerts.md)).

---

## Panel del Dashboard

```
Dashboard → Quota → panel Circuit Breaker

Cuenta             Estado     Fallos   Cooldown
cc/claude-opus-5   🔴 open     7        reintentar en 42s
cx/gpt-5.6-sol   🟡 half-open 1        sondeando…
glm/glm-4.7        🟢 closed   —        —
```

El panel muestra breakers abiertos/half-open, conteos de fallos recientes, cuentas atrás de cooldown, strike-blocks de antigravity y un botón de **reset manual**.

Reset manual vía API:

```bash
POST /api/providers/{providerId}/breaker
```

---

## Configuración

| Ajuste | Por defecto | Significado |
|---|---|---|
| `breakerEnabled` | `true` | Kill switch — `false` restaura el comportamiento anterior exacto |
| `breakerFailureThreshold` | `5` | Fallos en la ventana antes de abrir |
| `breakerWindowSec` | `60` | Ventana de conteo de fallos |
| `breakerBaseCooldownSec` | `60` | Primer cooldown; se duplica en reaperturas |

Ajusta en Dashboard → Settings. Ante sospechas, desactiva `breakerEnabled` — el comportamiento es idéntico al bucle de fallback antiguo.

---

## Cuándo se cortan

Causas típicas al recibir una alerta `breaker-open`:

- Caída o degradación del API del provider (lo más común)
- Token OAuth caducado/revocado en esa cuenta
- Un proxy frente a la cuenta muerto (revisa el proxy pool)
- Strikes de cuota de Antigravity (mostrados en el panel, pero no contados aquí)

---

## Relacionado

- [Alertas](./alerts.md) - eventos `breaker-open` / `breaker-recovered`
- [Smart Routing](./smart-routing.md) - el bucle de fallback donde vive el breaker
