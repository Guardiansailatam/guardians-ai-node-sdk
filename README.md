# guardiansai-node

SDK oficial de [Guardians AI](https://www.guardiansai.app) para Node.js. Detección de deepfakes y contenido generado por IA, pre-validación de pagos, y certificación legal — vía API, sin escribir las llamadas HTTP a mano.

Requiere Node.js 18 o superior (usa `fetch` nativo).

## Instalación

```bash
npm install guardiansai-node
```

## Requisitos

- Una cuenta Guardians AI con plan **Business** o superior (la API pública no está disponible en Trial/Personal).
- Una API Key generada desde **[app.guardiansai.app/account/api-keys](https://app.guardiansai.app/account/api-keys)**.

## Uso básico

```js
const GuardiansAI = require('guardiansai-node');
const fs = require('fs');

const client = new GuardiansAI({
  apiKey: process.env.GUARDIANS_AI_API_KEY,
});

// Analizar una imagen
const result = await client.analyze({
  file: fs.readFileSync('./imagen.jpg'),
  filename: 'imagen.jpg',
});

console.log(result.score, result.verdict, result.summary);
```

## Pre-validación de pagos

El caso de uso más fuerte para bancos, aseguradoras, fintechs y cualquier empresa que mueva dinero a proveedores: validar comprobantes, audios de autorización y comunicaciones **antes** de procesar el pago.

```js
const validation = await client.validate({
  files: [{ buffer: fs.readFileSync('./factura.pdf'), filename: 'factura.pdf' }],
  amount: 15000,
  currency: 'USD',
  paymentId: 'pay_8821', // tu identificador interno
});

if (validation.decision === 'block') {
  // No proceses el pago. validation.decision_reason explica por qué.
}
```

## Certificados legales

```js
const cert = await client.createCertificate(result.analysis_id);
console.log(cert.cert_number, cert.signature);

// Verificación pública (no requiere API Key) — útil para validar
// un certificado que te mandó un tercero.
const check = await client.verifyCertificate(cert.cert_number);
console.log(check.valid);
```

## Webhooks de bloqueo de pagos

Notificá automáticamente a tu sistema de pagos cuando se detecta fraude, sin tener que consultar la API activamente.

```js
const webhook = await client.createPaymentWebhook({
  name: 'Producción',
  url: 'https://tu-sistema.com/webhooks/guardians-ai',
  payloadFormat: 'guardians', // o 'mercadopago' | 'stripe' | 'paypal' | 'custom'
  hmacSecret: 'un-secreto-que-vos-elijas', // para verificar el origen en tu servidor
});

await client.testPaymentWebhook(webhook.id); // dispara un evento de prueba
```

Tu endpoint recibe un payload con `action: 'block' | 'hold' | 'release'` — la señal de qué hacer con el pago. Guardians AI no toca tu pago directamente; tu sistema decide cómo actuar sobre la señal.

## Manejo de errores

```js
const { GuardiansAIError } = require('guardiansai-node');

try {
  await client.analyze({ file: buffer, filename: 'x.jpg' });
} catch (err) {
  if (err instanceof GuardiansAIError) {
    console.error(err.status, err.code, err.message);
    // ej: 402 quota_exhausted "Se agotaron tus análisis del plan..."
    // ej: 403 insufficient_scope "Esta API Key no tiene el permiso..."
  }
}
```

## Scopes de la API Key

Cada API Key tiene permisos acotados. Si tu key no tiene el scope necesario para una operación, el SDK lanza `GuardiansAIError` con `code: 'insufficient_scope'`.

| Scope | Habilita |
|---|---|
| `analyze:write` | `client.analyze()` |
| `analyze:read` | `client.getAnalysis()`, `client.listAnalyses()` |
| `validate:write` | `client.validate()`, `client.getValidation()` |
| `certificates:write` | `client.createCertificate()` |
| `certificates:read` | `client.listCertificates()` |
| `contacts:read` / `contacts:write` | métodos de `contacts` |
| `payment_webhooks:manage` | métodos de `PaymentWebhook` |

## TypeScript

El paquete incluye tipos (`index.d.ts`) — no hace falta instalar `@types/guardiansai-node` por separado.

```ts
import GuardiansAI, { AnalyzeResult } from 'guardiansai-node';

const client = new GuardiansAI({ apiKey: process.env.GUARDIANS_AI_API_KEY! });
const result: AnalyzeResult = await client.analyze({ text: 'contenido a analizar' });
```

## Soporte

- Documentación completa: [guardiansai.app/api-docs](https://www.guardiansai.app/api-docs)
- Soporte técnico (Enterprise): gerente de cuenta dedicado
- Reportar un bug del SDK: [issues en GitHub](https://github.com/guardiansailatam/guardians-ai-node-sdk/issues)

## Licencia

MIT
