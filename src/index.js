'use strict';

const DEFAULT_BASE_URL = 'https://api.guardiansai.app';

/**
 * Error tipado del SDK. Envuelve la respuesta de error de la API para
 * que el consumidor pueda distinguir errores de red de errores de la
 * API (cuota agotada, scope insuficiente, plan no habilitado, etc.)
 *
 * ────────────────────────────────────────────────────────────────
 * (Sep 2026) LLEVA LOS DATOS DEL LÍMITE
 *
 * Cuando la API rechaza por límite de pedidos, la respuesta trae
 * cuántos segundos esperar. Sin exponerlo, una integración que reintenta
 * en un ciclo choca una y otra vez contra el mismo muro — y cada choque
 * le consume un pedido más.
 */
class GuardiansAIError extends Error {
  constructor(message, { status, code, details, retryAfter, rateLimit } = {}) {
    super(message);
    this.name = 'GuardiansAIError';
    this.status = status || null;
    this.code = code || null;
    this.details = details || null;

    /** Segundos a esperar antes de reintentar. Sólo en errores 429. */
    this.retryAfter = retryAfter ?? null;

    /** Estado del límite al momento del error, si la API lo informó. */
    this.rateLimit = rateLimit || null;
  }

  /**
   * ¿Tiene sentido reintentar este error?
   *
   * Un 403 no cambia por insistir: si la key no tiene el permiso, no lo
   * va a tener en el intento siguiente. Reintentar ahí es un ciclo
   * infinito que además consume el cupo de pedidos.
   */
  get isRetryable() {
    return this.status === 429 || this.status === 503 || this.code === 'network_error';
  }
}

/**
 * Cliente oficial de Guardians AI para Node.js.
 *
 * @example
 * const GuardiansAI = require('guardiansai-node');
 * const client = new GuardiansAI({ apiKey: process.env.GUARDIANS_AI_API_KEY });
 *
 * const result = await client.analyze({ file: fs.readFileSync('factura.pdf'), filename: 'factura.pdf' });
 * console.log(result.score, result.verdict);
 */
class GuardiansAI {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - API Key generada desde el dashboard (Account > API Keys).
   * @param {string} [opts.baseUrl] - Solo para entornos de testing/staging propios.
   * @param {number} [opts.timeout] - Timeout en ms para requests (default 60000, 180000 para archivos grandes).
   */
  constructor(opts = {}) {
    if (!opts.apiKey) {
      throw new GuardiansAIError('Falta apiKey. Generá una en https://app.guardiansai.app/account/api-keys');
    }

    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = opts.timeout || 60000;

    /**
     * Estado del límite de pedidos, tomado de la última respuesta.
     *
     * ──────────────────────────────────────────────────────────
     * POR QUÉ ESTÁ ACÁ Y NO EN CADA RESULTADO
     *
     * La API informa el consumo en las cabeceras de TODA respuesta, no
     * en el cuerpo. Devolverlo mezclado con el resultado del análisis
     * obligaría a cambiar la forma de cada método y a que el consumidor
     * lo desarme cada vez.
     *
     * Acá se actualiza solo y se consulta cuando hace falta:
     *
     *   await client.analyze({ ... });
     *   if (client.rateLimit.remaining < 500) avisarAlEquipo();
     *
     * Antes esto no existía: `_request` leía el cuerpo y descartaba las
     * cabeceras, así que una integración no tenía forma de saber cuánto
     * le quedaba hasta que la cortaban.
     */
    this.rateLimit = {
      /** Pedidos incluidos en el mes. `null` si el plan no tiene tope. */
      limit: null,
      /** Cuántos quedan. */
      remaining: null,
      /** Techo por minuto. */
      limitPerMinute: null,
      /** Cuándo se leyó por última vez. */
      updatedAt: null,
    };
  }

  /**
   * Guarda el estado del límite a partir de las cabeceras.
   *
   * Se llama en cada respuesta, incluidas las de error: el valor de
   * esto es ver acercarse el techo, no enterarse al chocarlo.
   */
  _readRateLimit(headers) {
    if (!headers) return null;

    const num = (v) => (v == null || v === '' ? null : Number(v));

    const limit          = num(headers.get('x-ratelimit-limit'));
    const remaining      = num(headers.get('x-ratelimit-remaining'));
    const limitPerMinute = num(headers.get('x-ratelimit-limit-minute'));

    // Si no vino ninguna, no se pisa lo que había: una ruta sin límite
    // no debería borrar el estado de la anterior.
    if (limit === null && remaining === null && limitPerMinute === null) {
      return null;
    }

    this.rateLimit = {
      limit,
      remaining,
      limitPerMinute,
      updatedAt: new Date(),
    };

    return this.rateLimit;
  }

  // ── Interno: request base con manejo de errores uniforme ────────
  async _request(method, path, { body, isFormData, timeout } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout || this.timeout);

    const headers = { Authorization: `Bearer ${this.apiKey}` };
    if (!isFormData && body != null) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: isFormData ? body : (body != null ? JSON.stringify(body) : undefined),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        throw new GuardiansAIError(`Timeout después de ${timeout || this.timeout}ms`, { code: 'timeout' });
      }

      throw new GuardiansAIError(`Error de red: ${err.message}`, { code: 'network_error' });
    }
    clearTimeout(timeoutId);

    // Las cabeceras se leen SIEMPRE, antes de mirar si la respuesta fue
    // correcta: en un 429 son justamente el dato más útil.
    const rateLimit = this._readRateLimit(res.headers);

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers?.get('retry-after');

      throw new GuardiansAIError(
        data?.message || data?.error || `HTTP ${res.status}`,
        {
          status: res.status,
          code: data?.error || data?.code,
          details: data,
          retryAfter: retryAfterHeader ? Number(retryAfterHeader) : (data?.retry_after_seconds ?? null),
          rateLimit,
        }
      );
    }

    return data;
  }

  // ── Helper: arma multipart/form-data sin dependencias externas ──
  _buildFormData(fields) {
    const form = new FormData();

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;

      if (key === 'file' && value) {
        // value puede ser Buffer (Node) o Blob/File (compat browser/edge)
        const blob = Buffer.isBuffer(value)
          ? new Blob([value])
          : value;
        form.append('file', blob, fields.filename || 'file');
      } else if (key !== 'filename') {
        form.append(key, String(value));
      }
    }

    return form;
  }

  // ════════════════════════════════════════════════════════════
  // ANALYZE — scope: analyze:write / analyze:read
  // ════════════════════════════════════════════════════════════

  /**
   * Analiza un archivo, una dirección pública o un texto.
   *
   * @param {Object} input
   * @param {Buffer} [input.file] - Buffer del archivo a analizar.
   * @param {string} [input.filename] - Nombre del archivo (requerido si mandás `file`).
   * @param {string} [input.url] - Dirección pública del contenido. La descarga el servidor.
   * @param {string} [input.text] - Texto a analizar.
   * @param {string} [input.sourceChannel] - Origen del análisis (default 'api').
   * @param {string} [input.contactEmail] - Email del contacto asociado, si aplica.
   * @param {string} [input.contactPhone]
   * @param {string} [input.contactName]
   * @param {number} [input.amount] - Monto asociado, si es una operación de pago.
   * @param {string} [input.currency]
   */
  async analyze(input = {}) {
    if (!input.file && !input.text && !input.url) {
      throw new GuardiansAIError('Debés pasar `file`, `url` o `text`');
    }

    // ── Por dirección pública ─────────────────────────────────
    //
    // (Sep 2026) Antes esto no existía y el SDK rechazaba el pedido
    // antes de mandarlo, aunque el backend ya lo aceptara.
    //
    // Sirve cuando el archivo ya está en tu CDN o tu bucket y no querés
    // volver a subirlo. La descarga la hace nuestro servidor, que no
    // comparte tu red ni tu sesión: la dirección tiene que ser pública.
    //
    // Va con el mismo timeout largo que un archivo: el servidor tiene
    // que bajarlo antes de analizarlo, así que tarda más, no menos.
    if (input.url) {
      return this._request('POST', '/api/analyze', {
        body: {
          url: input.url,
          source_channel: input.sourceChannel || 'api',
          contact_email: input.contactEmail,
          contact_phone: input.contactPhone,
          contact_name: input.contactName,
          amount: input.amount,
          currency: input.currency,
        },
        timeout: 180000,
      });
    }

    if (input.file) {
      const form = this._buildFormData({
        file: input.file,
        filename: input.filename,
        source_channel: input.sourceChannel || 'api',
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        contact_name: input.contactName,
        amount: input.amount,
        currency: input.currency,
      });

      return this._request('POST', '/api/analyze', { body: form, isFormData: true, timeout: 180000 });
    }

    return this._request('POST', '/api/analyze', {
      body: {
        text: input.text,
        source_channel: input.sourceChannel || 'api',
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        contact_name: input.contactName,
      },
    });
  }

  /** Obtiene el detalle de un análisis previo por su analysis_id. */
  async getAnalysis(analysisId) {
    return this._request('GET', `/api/analyze/${encodeURIComponent(analysisId)}`);
  }

  /**
   * Lista análisis, con filtros opcionales (paginado).
   *
   * `minScore` y `maxScore` funcionan juntos o por separado. Los dos
   * hacen falta para aislar una zona del semáforo: pedir sólo `minScore`
   * de 40 trae también los de 99, así que "ver los inciertos" devuelve
   * los fraudes de siempre.
   *
   * Las zonas del motor: auténtico 0-39, incierto 40-64, fraude 65-100.
   */
  async listAnalyses({ limit = 20, offset = 0, contentType, contactId, minScore, maxScore, desde, hasta } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });

    if (contentType) params.set('content_type', contentType);
    if (contactId) params.set('contact_id', contactId);
    if (minScore != null) params.set('min_score', String(minScore));
    if (maxScore != null) params.set('max_score', String(maxScore));
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);

    return this._request('GET', `/api/analyze?${params.toString()}`);
  }

  /**
   * Las piezas de un mismo envío.
   *
   * Un email con tres adjuntos genera tres análisis distintos, agrupados
   * por `email_group_id`. Verlos juntos es lo que permite decidir sobre
   * el envío completo y no sobre una pieza suelta.
   */
  async getAnalysisGroup(groupId) {
    return this._request('GET', `/api/analyze/group/${encodeURIComponent(groupId)}`);
  }

  /**
   * Análisis pendientes de descontar.
   *
   * El costo real de un análisis se conoce recién cuando el motor abre
   * el archivo, así que un PDF largo puede costar más de lo que había
   * disponible. En ese caso el análisis se entrega igual y la diferencia
   * queda como deuda, que se descuenta en la próxima recarga o
   * renovación.
   *
   * Consultarlo sirve para explicar por qué el saldo arranca por debajo
   * del máximo — sin eso, parece un error de facturación.
   */
  async getAnalysisDebt() {
    return this._request('GET', '/api/analyze/debt');
  }

  /** Elimina un análisis del historial. */
  async deleteAnalysis(analysisId) {
    return this._request('DELETE', `/api/analyze/${encodeURIComponent(analysisId)}`);
  }

  // ════════════════════════════════════════════════════════════
  // VALIDATE — scope: validate:write / validate:read
  // Pre-validación de pagos: approve / review / block antes de mover
  // dinero. El endpoint más fuerte para integraciones de pago.
  // ════════════════════════════════════════════════════════════

  /**
   * Valida uno o más archivos (comprobantes, audios, etc.) asociados a
   * una operación de pago, antes de procesarla.
   *
   * @param {Object} input
   * @param {Array<{buffer: Buffer, filename: string}>} [input.files] - Hasta 5 archivos.
   * @param {string} [input.text]
   * @param {number} [input.amount]
   * @param {string} [input.currency]
   * @param {string} [input.contactId]
   * @param {string} [input.contactEmail]
   * @param {string} [input.paymentId] - Tu identificador interno de la operación.
   * @returns {Promise<{decision: 'approve'|'review'|'block', decision_reason: string, ...}>}
   */
  async validate(input = {}) {
    const form = new FormData();

    for (const f of input.files || []) {
      const blob = Buffer.isBuffer(f.buffer) ? new Blob([f.buffer]) : f.buffer;
      form.append('files', blob, f.filename || 'file');
    }

    if (input.text) form.append('text', input.text);
    if (input.amount != null) form.append('amount', String(input.amount));
    if (input.currency) form.append('currency', input.currency);
    if (input.contactId) form.append('contact_id', input.contactId);
    if (input.contactEmail) form.append('contact_email', input.contactEmail);
    if (input.paymentId) form.append('payment_id', input.paymentId);

    return this._request('POST', '/api/validate', { body: form, isFormData: true, timeout: 180000 });
  }

  /**
   * Recupera una validación previa por su id.
   *
   * Requiere el scope `validate:read`, separado de `validate:write`: un
   * equipo de auditoría puede leer validaciones sin poder dispararlas.
   */
  async getValidation(id) {
    return this._request('GET', `/api/validate/${encodeURIComponent(id)}`);
  }

  // ════════════════════════════════════════════════════════════
  // CERTIFICATES — scope: certificates:write / certificates:read
  // ════════════════════════════════════════════════════════════

  /** Emite un certificado legal firmado a partir de un análisis. */
  async createCertificate(analysisId) {
    return this._request('POST', '/api/certificates', { body: { analysis_id: analysisId } });
  }

  /** Lista los certificados emitidos por tu organización. */
  async listCertificates({ limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this._request('GET', `/api/certificates?${params.toString()}`);
  }

  /**
   * Verifica un certificado por su número, UUID o hash. Público — no
   * requiere API Key. Útil para validar certificados de terceros.
   */
  async verifyCertificate(idOrNumber) {
    return this._request('GET', `/api/certificates/verify/${encodeURIComponent(idOrNumber)}`);
  }

  // ════════════════════════════════════════════════════════════
  // CONTACTS — scope: contacts:read / contacts:write
  // ════════════════════════════════════════════════════════════

  /** Lista contactos, con filtros opcionales. */
  async listContacts({ search, status, riskLevel, limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });

    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (riskLevel) params.set('risk_level', riskLevel);

    return this._request('GET', `/api/contacts?${params.toString()}`);
  }

  /** Detalle de un contacto, incluyendo historial de comportamiento. */
  async getContact(contactId) {
    return this._request('GET', `/api/contacts/${encodeURIComponent(contactId)}`);
  }

  /** Crea un contacto manualmente. */
  async createContact(input) {
    return this._request('POST', '/api/contacts', { body: input });
  }

  // ════════════════════════════════════════════════════════════
  // PAYMENT BLOCK WEBHOOKS — scope: payment_webhooks:manage
  // Configura notificaciones automáticas a tu sistema de pagos ante
  // fraude detectado (acción: block / hold / release).
  // ════════════════════════════════════════════════════════════

  async listPaymentWebhooks() {
    return this._request('GET', '/api/payment-block-webhooks');
  }

  /**
   * @param {Object} input
   * @param {string} input.name
   * @param {string} input.url
   * @param {'guardians'|'mercadopago'|'stripe'|'paypal'|'custom'} [input.payloadFormat]
   * @param {string} [input.hmacSecret] - Para verificar la firma del webhook en tu servidor.
   */
  async createPaymentWebhook(input) {
    return this._request('POST', '/api/payment-block-webhooks', {
      body: {
        name: input.name,
        url: input.url,
        payload_format: input.payloadFormat || 'guardians',
        hmac_secret: input.hmacSecret,
        auth_header: input.authHeader,
      },
    });
  }

  /** Dispara un evento de prueba contra el webhook, sin fraude real. */
  async testPaymentWebhook(webhookId) {
    return this._request('POST', `/api/payment-block-webhooks/${encodeURIComponent(webhookId)}/test`);
  }

  async deletePaymentWebhook(webhookId) {
    return this._request('DELETE', `/api/payment-block-webhooks/${encodeURIComponent(webhookId)}`);
  }

  // ════════════════════════════════════════════════════════════
  // VERIFICATIONS — scope: verifications:write / verifications:read
  // ════════════════════════════════════════════════════════════
  //
  // (Sep 2026) Faltaban en el SDK: la documentación los listaba pero el
  // cliente no los tenía, así que había que llamarlos a mano con fetch.
  //
  // Segunda capa de auditoría sobre KYC y KYB. El cliente conserva su
  // proveedor de identidad; Guardians recibe el material que ese
  // proveedor ya procesó y verifica algo distinto — que el humano
  // detrás del trámite exista.
  //
  // Sólo funcionan si la organización tiene el módulo activado desde el
  // panel: tener el scope en la key no alcanza, porque la habilitación
  // va junto con el contrato de tratamiento de datos firmado.

  /**
   * Envía una verificación de identidad para auditar.
   *
   * ────────────────────────────────────────────────────────────
   * TODO EL MATERIAL VA EN UNA SOLA LLAMADA
   *
   * La comparación entre la selfie y el documento necesita las dos
   * piezas juntas: mandarlas por separado haría imposible esa
   * validación.
   *
   * Y el NOMBRE del campo importa: indica el rol de cada archivo dentro
   * del trámite, y de eso depende qué se le aplica. A una selfie se le
   * mide el pulso; a un acta constitutiva, no.
   *
   * @param {Object} input
   * @param {'kyc'|'kyb'} input.kind
   * @param {{buffer: Buffer, filename: string}} [input.selfie] - Obligatoria en los dos tipos.
   * @param {{buffer: Buffer, filename: string}} [input.idDocument] - Obligatorio en los dos tipos.
   * @param {{buffer: Buffer, filename: string}} [input.idDocumentBack]
   * @param {{buffer: Buffer, filename: string}} [input.livenessVideo]
   * @param {{buffer: Buffer, filename: string}} [input.proofOfAddress] - Sólo KYC.
   * @param {{buffer: Buffer, filename: string}} [input.incorporationDoc] - Obligatorio en KYB.
   * @param {{buffer: Buffer, filename: string}} [input.powerOfAttorney] - Sólo KYB.
   * @param {{buffer: Buffer, filename: string}} [input.financialStatement] - Sólo KYB.
   * @param {string} [input.subjectName]
   * @param {string} [input.subjectDocument]
   * @param {string} [input.subjectDocumentType]
   * @param {string} [input.subjectCountry]
   * @param {string} [input.providerName] - Tu proveedor de identidad actual.
   * @param {string} [input.providerResult] - Qué dictaminó ese proveedor.
   * @param {string} [input.livenessChallenge] - Qué se le pidió al usuario: turn_right, blink, etc.
   * @param {string} [input.externalRef] - Tu identificador interno del trámite.
   */
  async createVerification(input = {}) {
    if (!input.kind) {
      throw new GuardiansAIError('Falta `kind`: debe ser "kyc" o "kyb"');
    }

    const form = new FormData();
    form.append('kind', input.kind);

    // Los archivos, cada uno con el nombre de campo que le corresponde.
    const archivos = {
      selfie:              input.selfie,
      id_document:         input.idDocument,
      id_document_back:    input.idDocumentBack,
      liveness_video:      input.livenessVideo,
      proof_of_address:    input.proofOfAddress,
      incorporation_doc:   input.incorporationDoc,
      power_of_attorney:   input.powerOfAttorney,
      financial_statement: input.financialStatement,
    };

    for (const [campo, archivo] of Object.entries(archivos)) {
      if (!archivo) continue;
      const blob = Buffer.isBuffer(archivo.buffer) ? new Blob([archivo.buffer]) : archivo.buffer;
      form.append(campo, blob, archivo.filename || campo);
    }

    // Los datos del titular y del trámite.
    const campos = {
      subject_name:          input.subjectName,
      subject_document:      input.subjectDocument,
      subject_document_type: input.subjectDocumentType,
      subject_country:       input.subjectCountry,
      provider_name:         input.providerName,
      provider_result:       input.providerResult,
      liveness_challenge:    input.livenessChallenge,
      external_ref:          input.externalRef,
    };

    for (const [campo, valor] of Object.entries(campos)) {
      if (valor != null) form.append(campo, String(valor));
    }

    // Timeout largo: una verificación procesa varios archivos —selfie,
    // video, documento— con distintas capas del motor.
    return this._request('POST', '/api/verifications', { body: form, isFormData: true, timeout: 300000 });
  }

  /** La bandeja de verificaciones, con filtros opcionales. */
  async listVerifications({ kind, verdict, limit = 20, offset = 0 } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });

    if (kind) params.set('kind', kind);
    if (verdict) params.set('verdict', verdict);

    return this._request('GET', `/api/verifications?${params.toString()}`);
  }

  /** La ficha completa de una verificación. */
  async getVerification(id) {
    return this._request('GET', `/api/verifications/${encodeURIComponent(id)}`);
  }

  /** Contadores y precisión del período. */
  async getVerificationStats() {
    return this._request('GET', '/api/verifications/stats');
  }

  /**
   * Registra si el caso terminó siendo fraude.
   *
   * Es lo que cierra el círculo: sin saber qué pasó de verdad, no hay
   * forma de medir si el motor acertó ni de mejorarlo.
   */
  async resolveVerification(id, { wasFraud, notes } = {}) {
    return this._request('POST', `/api/verifications/${encodeURIComponent(id)}/resolve`, {
      body: { was_fraud: wasFraud, notes },
    });
  }
}

module.exports = GuardiansAI;
module.exports.GuardiansAI = GuardiansAI;
module.exports.GuardiansAIError = GuardiansAIError;
module.exports.default = GuardiansAI;
