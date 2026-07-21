'use strict';

const DEFAULT_BASE_URL = 'https://api.guardiansai.app';

/**
 * Error tipado del SDK. Envuelve la respuesta de error de la API para
 * que el consumidor pueda distinguir errores de red de errores de la
 * API (cuota agotada, scope insuficiente, plan no habilitado, etc.)
 */
class GuardiansAIError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'GuardiansAIError';
    this.status = status || null;
    this.code = code || null;
    this.details = details || null;
  }
}

/**
 * Cliente oficial de Guardians AI para Node.js.
 *
 * @example
 * const GuardiansAI = require('@guardiansai/node');
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

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      throw new GuardiansAIError(
        data?.message || data?.error || `HTTP ${res.status}`,
        { status: res.status, code: data?.error || data?.code, details: data }
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
   * Analiza un archivo (imagen, video, audio, PDF) o un texto.
   * @param {Object} input
   * @param {Buffer} [input.file] - Buffer del archivo a analizar.
   * @param {string} [input.filename] - Nombre del archivo (requerido si mandás `file`).
   * @param {string} [input.text] - Texto a analizar (alternativa a `file`).
   * @param {string} [input.sourceChannel] - Origen del análisis (default 'api').
   * @param {string} [input.contactEmail] - Email del contacto asociado, si aplica.
   * @param {string} [input.contactPhone]
   * @param {string} [input.contactName]
   * @param {number} [input.amount] - Monto asociado, si es una operación de pago.
   * @param {string} [input.currency]
   */
  async analyze(input = {}) {
    if (!input.file && !input.text) {
      throw new GuardiansAIError('Debés pasar `file` o `text`');
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

  /** Lista análisis, con filtros opcionales (paginado). */
  async listAnalyses({ limit = 20, offset = 0, contentType, contactId, minScore } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (contentType) params.set('content_type', contentType);
    if (contactId) params.set('contact_id', contactId);
    if (minScore != null) params.set('min_score', String(minScore));
    return this._request('GET', `/api/analyze?${params.toString()}`);
  }

  // ════════════════════════════════════════════════════════════
  // VALIDATE — scope: validate:write
  // Pre-validación de pagos: approve / review / block antes de mover
  // dinero. El endpoint más fuerte para integraciones de pago.
  // ════════════════════════════════════════════════════════════

  /**
   * Valida uno o más archivos (comprobantes, audios, etc.) asociados a
   * una operación de pago, antes de procesarla.
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

  /** Recupera una validación previa por su id. */
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
}

module.exports = GuardiansAI;
module.exports.GuardiansAI = GuardiansAI;
module.exports.GuardiansAIError = GuardiansAIError;
module.exports.default = GuardiansAI;
