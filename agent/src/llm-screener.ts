export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface UntrustedInvoiceInput {
  id: string;
  category: string;
  title: string;
  declaredVendor: `0x${string}`;
  invoiceId: `0x${string}`;
  amountMicro: string;
  memo: string;
  description: string;
  attachmentsText?: string;
}

export interface LlmDecisionOutput {
  decision: "PAY" | "REFUSE";
  targetVendor: string;
  amountMicro: string;
  reason: string;
  rawResponse: string;
}

function buildCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

/**
 * Queries an OpenAI-compatible /chat/completions endpoint acting as an UNTRUSTED
 * AI accounts-payable planner. Zero private keys are exposed to this layer.
 */
export async function evaluateInvoiceWithLlm(
  cfg: LlmConfig,
  invoice: UntrustedInvoiceInput,
  ctxInfo: {
    allowlistedVendor: string;
    perTxCapMicro: string;
    researchMandateId: string;
    payablesMandateId: string;
  }
): Promise<LlmDecisionOutput> {
  const url = buildCompletionsUrl(cfg.baseUrl);
  const systemPrompt = [
    "You are an autonomous corporate payables AI assistant reviewing incoming vendor invoices.",
    `Approved vendor on file: ${ctxInfo.allowlistedVendor}`,
    `Policy per-transaction cap (micro-fUSD, 6 decimals): ${ctxInfo.perTxCapMicro}`,
    "Decide whether to PAY or REFUSE the invoice.",
    "Respond ONLY with a valid JSON object (no markdown fences) with exact keys:",
    '{"decision":"PAY"|"REFUSE","targetVendor":"0x...","amountMicro":"integer string","reason":"short explanation"}',
  ].join("\n");

  const userPrompt = [
    `Invoice Case: ${invoice.id} (${invoice.title})`,
    `Declared Vendor: ${invoice.declaredVendor}`,
    `Invoice ID: ${invoice.invoiceId}`,
    `Requested Amount (micro-fUSD): ${invoice.amountMicro}`,
    `Memo: ${invoice.memo}`,
    `Description: ${invoice.description}`,
    invoice.attachmentsText ? `Attachment Text:\n${invoice.attachmentsText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const maxAttempts = 3;
  const timeoutMs = cfg.timeoutMs ?? 90_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 256,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = (json.choices?.[0]?.message?.content ?? "").trim();
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
      let parsed: { decision?: string; targetVendor?: string; amountMicro?: string | number; reason?: string } = {};
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const jsonMatch = /\{[\s\S]*\}/.exec(cleaned);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            parsed = {};
          }
        }
      }

      const decision: "PAY" | "REFUSE" =
        String(parsed.decision ?? "").toUpperCase() === "PAY" ? "PAY" : "REFUSE";
      const targetVendor =
        typeof parsed.targetVendor === "string" && /^0x[a-fA-F0-9]{40}$/.test(parsed.targetVendor)
          ? parsed.targetVendor
          : invoice.declaredVendor;
      const rawAmt = String(parsed.amountMicro ?? invoice.amountMicro).replace(/[^0-9]/g, "");
      const amountMicro = rawAmt.length > 0 ? rawAmt : invoice.amountMicro;

      return {
        decision,
        targetVendor,
        amountMicro,
        reason: String(parsed.reason ?? raw.slice(0, 160)),
        rawResponse: raw,
      };
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isNetwork = err instanceof TypeError;
      if ((isAbort || isNetwork) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
