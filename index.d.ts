// Type definitions for @guardiansai/node

export interface GuardiansAIOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export class GuardiansAIError extends Error {
  status: number | null;
  code: string | null;
  details: unknown;
}

export type Verdict = 'authentic' | 'ai_generated' | 'uncertain' | 'inconclusive';
export type ValidationDecision = 'approve' | 'review' | 'block';
export type ContentType = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export interface AnalyzeInput {
  file?: Buffer;
  filename?: string;
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
    chargedTo: 'plan' | 'credits';
    creditsRemaining: number;
  };
  processing_ms: number;
  total_ms: number;
  analyzed_at: string;
}

export interface ValidateInput {
  files?: Array<{ buffer: Buffer; filename: string }>;
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

export default class GuardiansAI {
  constructor(opts: GuardiansAIOptions);

  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  getAnalysis(analysisId: string): Promise<AnalyzeResult>;
  listAnalyses(opts?: {
    limit?: number; offset?: number; contentType?: ContentType;
    contactId?: string; minScore?: number;
  }): Promise<{ analyses: AnalyzeResult[]; limit: number; offset: number }>;

  validate(input: ValidateInput): Promise<ValidateResult>;
  getValidation(id: string): Promise<ValidateResult>;

  createCertificate(analysisId: string): Promise<Certificate>;
  listCertificates(opts?: { limit?: number; offset?: number }): Promise<{ certificates: Certificate[]; total: number }>;
  verifyCertificate(idOrNumber: string): Promise<CertificateVerification>;

  listContacts(opts?: {
    search?: string; status?: string; riskLevel?: string; limit?: number; offset?: number;
  }): Promise<{ contacts: Contact[]; stats: unknown }>;
  getContact(contactId: string): Promise<{ contact: Contact; history: unknown[]; behavior: unknown }>;
  createContact(input: Partial<Contact>): Promise<Contact>;

  listPaymentWebhooks(): Promise<{ total: number; items: PaymentWebhook[] }>;
  createPaymentWebhook(input: {
    name: string; url: string;
    payloadFormat?: PaymentWebhook['payload_format'];
    hmacSecret?: string; authHeader?: string;
  }): Promise<PaymentWebhook>;
  testPaymentWebhook(webhookId: string): Promise<{ success: boolean; status_code: number; response_time_ms: number }>;
  deletePaymentWebhook(webhookId: string): Promise<{ ok: boolean }>;
}

export { GuardiansAI };
