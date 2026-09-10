// Type definitions for guardiansai-node

export interface GuardiansAIOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Estado del límite de pedidos, tomado de la última respuesta.
 *
 * `null` en `limit` significa que ese plan no tiene tope mensual — es
 * el caso de Enterprise mientras no se le cargue uno por contrato.
 */
export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  limitPerMinute: number | null;
  updatedAt: Date | null;
}

export class GuardiansAIError extends Error {
  status: number | null;
  code: string | null;
  details: unknown;

  /** Segundos a esperar antes de reintentar. Sólo en errores 429. */
  retryAfter: number | null;

  /** Estado del límite al momento del error, si la API lo informó. */
  rateLimit: RateLimitState | null;

  /**
   * ¿Tiene sentido reintentar este error?
   *
   * Un 403 no cambia por insistir. Reintentar ahí es un ciclo infinito
   * que además consume el cupo de pedidos.
   */
  readonly isRetryable: boolean;
}

export type Verdict = 'authentic' | 'ai_generated' | 'uncertain' | 'inconclusive';
export type ValidationDecision = 'approve' | 'review' | 'block';
export type ContentType = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export type VerificationKind = 'kyc' | 'kyb';
export type VerificationVerdict = 'clear' | 'review' | 'reject';
export type EvidenceLevel = 'A' | 'B' | 'C';

export interface FilePart {
  buffer: Buffer;
  filename: string;
}

export interface AnalyzeInput {
  file?: Buffer;
  filename?: string;
  /** Dirección pública del contenido. La descarga el servidor. */
  url?: string;
  text?: string;
  sourceChannel?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactName?: string;
  amount?: number;
  currency?: string;
}

export interface AnalyzeResult {
  analysis_id: string;
  score: number;
  verdict: Verdict;
  label: Verdict;
  confidence: number;
  content_type: ContentType;
  summary: string;
  top_signals: Array<{ description: string; suspicious: boolean }>;
  fraud_tags: string[];
  content_hash: string;
  contact: { id: string; name: string | null; email: string | null; risk_level: string } | null;
  quota: {
    scansUsed: number;
    scansLimit: number;
    cost: number;
    charged: number;
    chargedTo: 'plan' | 'credits';
    creditsRemaining: number;
    debtFromThisAnalysis?: number;
    pendingDebt?: number;
  };
  processing_ms: number;
  total_ms: number;
  analyzed_at: string;
}

export interface AnalysisGroup {
  group_id: string;
  sender: { email: string | null; name: string | null; subject: string | null };
  pieces_count: number;
  worst_score: number;
  worst_label: Verdict;
  received_at: string;
  pieces: AnalyzeResult[];
}

export interface AnalysisDebt {
  pending_total: number;
  explanation: string | null;
  items: Array<{
    id: string;
    filename: string | null;
    content_type: ContentType | null;
    pending: number;
    created_at: string;
  }>;
}

export interface ValidateInput {
  files?: FilePart[];
  text?: string;
  amount?: number;
  currency?: string;
  contactId?: string;
  contactEmail?: string;
  paymentId?: string;
}

export interface ValidateResult {
  decision: ValidationDecision;
  decision_reason: string;
  max_score: number;
  confidence: number;
  payment_id: string | null;
  amount: number | null;
  currency: string | null;
  contact: { id: string; name: string | null; email: string | null } | null;
  most_suspicious_item: unknown;
  files_analyzed: unknown[];
  text_analyzed: unknown;
  total_ms: number;
}

export interface Certificate {
  id: string;
  cert_number: string;
  content_hash: string;
  signature: string;
  issued_at: string;
  valid_until: string;
  status: 'active' | 'revoked';
}

export interface CertificateVerification {
  valid: boolean;
  reason: string | null;
  certificate: {
    id: string;
    cert_number: string;
    certificate_hash: string;
    verification_url: string;
    issued_at: string;
    expires_at: string;
    revoked: boolean;
  };
  analysis_summary: {
    content_type: ContentType;
    filename: string | null;
    score: number;
    verdict: Verdict;
    analyzed_at: string;
    top_signals: Array<{ description: string; suspicious: boolean }>;
  };
}

export interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  total_analyses: number;
  is_vip: boolean;
}

export interface PaymentWebhook {
  id: string;
  name: string;
  url: string;
  payload_format: 'guardians' | 'mercadopago' | 'stripe' | 'paypal' | 'custom';
  enabled: boolean;
  created_at: string;
}

// ── Verificación de identidad (KYC / KYB) ──────────────────────
//
// Sólo funcionan si la organización tiene el módulo activado desde el
// panel: tener el scope en la key no alcanza, porque la habilitación va
// junto con el contrato de tratamiento de datos firmado.

export interface CreateVerificationInput {
  kind: VerificationKind;

  /** Obligatoria en los dos tipos. */
  selfie?: FilePart;
  /** Obligatorio en los dos tipos. */
  idDocument?: FilePart;
  idDocumentBack?: FilePart;
  livenessVideo?: FilePart;
  /** Sólo KYC. */
  proofOfAddress?: FilePart;
  /** Obligatorio en KYB. */
  incorporationDoc?: FilePart;
  /** Sólo KYB. */
  powerOfAttorney?: FilePart;
  /** Sólo KYB. */
  financialStatement?: FilePart;

  subjectName?: string;
  subjectDocument?: string;
  subjectDocumentType?: string;
  subjectCountry?: string;

  /** Tu proveedor de identidad actual. */
  providerName?: string;
  /** Qué dictaminó ese proveedor. */
  providerResult?: string;

  /**
   * Qué se le pidió al usuario durante la prueba de vida.
   *
   * Es opcional, pero sin él la validación del desafío se devuelve como
   * `unavailable`: vemos la grabación, pero no tenemos contra qué
   * contrastarla.
   */
  livenessChallenge?:
    | 'turn_left' | 'turn_right' | 'turn_head'
    | 'nod' | 'move_closer' | 'blink'
    | 'smile' | 'speak' | 'read_code';

  /** Tu identificador interno del trámite. */
  externalRef?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'unavailable';

export interface Check {
  status: CheckStatus;
  score?: number;
  reason?: string;
  [key: string]: unknown;
}

export interface VerificationResult {
  reference: string;
  kind: VerificationKind;
  risk_score: number;

  /**
   * Se toma el riesgo MÁS ALTO entre las piezas, no el promedio: una
   * verificación con el documento impecable y la selfie generada por IA
   * es fraudulenta.
   */
  verdict: VerificationVerdict;

  /** Lo mide el motor según la calidad del material, no lo declara la integración. */
  evidence_level: EvidenceLevel;

  provider_result: string | null;

  checks: {
    persona: Record<string, Check>;
    documento: Record<string, Check>;
    captura: Record<string, Check>;
  };

  items: unknown[];
  cost: number;
}

export interface VerificationStats {
  total: number;
  clear: number;
  review: number;
  reject: number;
  accuracy: number | null;
  period: string;
}

export default class GuardiansAI {
  constructor(opts: GuardiansAIOptions);

  /**
   * Estado del límite de pedidos, actualizado en cada respuesta.
   *
   * @example
   * await client.analyze({ ... });
   * if (client.rateLimit.remaining < 500) avisarAlEquipo();
   */
  readonly rateLimit: RateLimitState;

  // ── Análisis ────────────────────────────────────────────────
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  getAnalysis(analysisId: string): Promise<AnalyzeResult>;
  listAnalyses(opts?: {
    limit?: number; offset?: number; contentType?: ContentType;
    contactId?: string; minScore?: number; maxScore?: number;
    desde?: string; hasta?: string;
  }): Promise<{ analyses: AnalyzeResult[]; limit: number; offset: number; total: number }>;
  getAnalysisGroup(groupId: string): Promise<AnalysisGroup>;
  getAnalysisDebt(): Promise<AnalysisDebt>;
  deleteAnalysis(analysisId: string): Promise<{ ok: boolean; deleted: number }>;

  // ── Pre-validación de pagos ─────────────────────────────────
  validate(input: ValidateInput): Promise<ValidateResult>;
  getValidation(id: string): Promise<ValidateResult>;

  // ── Certificados ────────────────────────────────────────────
  createCertificate(analysisId: string): Promise<Certificate>;
  listCertificates(opts?: { limit?: number; offset?: number }): Promise<{ certificates: Certificate[]; total: number }>;
  verifyCertificate(idOrNumber: string): Promise<CertificateVerification>;

  // ── Contactos ───────────────────────────────────────────────
  listContacts(opts?: {
    search?: string; status?: string; riskLevel?: string; limit?: number; offset?: number;
  }): Promise<{ contacts: Contact[]; stats: unknown }>;
  getContact(contactId: string): Promise<{ contact: Contact; history: unknown[]; behavior: unknown }>;
  createContact(input: Partial<Contact>): Promise<Contact>;

  // ── Webhooks de bloqueo de pagos ────────────────────────────
  listPaymentWebhooks(): Promise<{ total: number; items: PaymentWebhook[] }>;
  createPaymentWebhook(input: {
    name: string; url: string;
    payloadFormat?: PaymentWebhook['payload_format'];
    hmacSecret?: string; authHeader?: string;
  }): Promise<PaymentWebhook>;
  testPaymentWebhook(webhookId: string): Promise<{ success: boolean; status_code: number; response_time_ms: number }>;
  deletePaymentWebhook(webhookId: string): Promise<{ ok: boolean }>;

  // ── Verificación de identidad (Enterprise) ──────────────────
  createVerification(input: CreateVerificationInput): Promise<VerificationResult>;
  listVerifications(opts?: {
    kind?: VerificationKind; verdict?: VerificationVerdict;
    limit?: number; offset?: number;
  }): Promise<{ items: VerificationResult[]; total: number }>;
  getVerification(id: string): Promise<VerificationResult>;
  getVerificationStats(): Promise<VerificationStats>;
  resolveVerification(id: string, opts?: { wasFraud?: boolean; notes?: string }): Promise<{ ok: boolean }>;
}

export { GuardiansAI };
