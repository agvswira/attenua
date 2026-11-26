import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { keccak256, toHex } from "viem";
import { REPO_ROOT } from "../src/config.js";
import { evaluateInvoiceWithLlm } from "../src/llm-screener.js";

const ZERO_ID = ("0x" + "00".repeat(32)) as `0x${string}`;
const FIXTURE_PATH = path.join(REPO_ROOT, "contracts", "test", "fixtures", "diff-vectors.json");

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface RefMandate {
  id: `0x${string}`;
  parentId: `0x${string}`;
  issuer: "orch" | "agentA" | "agentB";
  subAgent: "orch" | "agentA" | "agentB";
  budget: bigint;
  allocated: bigint;
  minBps: number;
  maxBps: number;
  mask: number;
  depth: number;
  expiry: number;
  closed: boolean;
}

class ReferenceLattice {
  rootBudget = 20_000_000n;
  rootAllocated = 0n;
  rootMin = 4000;
  rootMax = 7000;
  rootMask = 3;
  maxDepth = 2;
  rootExpiry = 2_000_000;
  mandates = new Map<string, RefMandate>();

  register(p: {
    id: `0x${string}`;
    parentId: `0x${string}`;
    subAgent: "orch" | "agentA" | "agentB";
    budget: bigint;
    minBps: number;
    maxBps: number;
    mask: number;
    expiry: number;
  }): { ok: boolean; issuer: "orch" | "agentA" | "agentB" } {
    if (this.mandates.has(p.id) || p.minBps > p.maxBps || p.maxBps > 10_000) {
      return { ok: false, issuer: "orch" };
    }
    if (p.parentId === ZERO_ID) {
      const issuer = "orch" as const;
      const avail = this.rootBudget - this.rootAllocated;
      const ok =
        p.budget <= avail &&
        p.minBps >= this.rootMin &&
        p.maxBps <= this.rootMax &&
        (p.mask & ~this.rootMask) === 0 &&
        p.expiry <= this.rootExpiry &&
        1 <= this.maxDepth &&
        p.subAgent !== issuer;
      if (!ok) return { ok: false, issuer };
      this.rootAllocated += p.budget;
      this.mandates.set(p.id, { ...p, issuer, allocated: 0n, depth: 1, closed: false });
      return { ok: true, issuer };
    }
    const pm = this.mandates.get(p.parentId);
    if (!pm) return { ok: false, issuer: "orch" };
    const issuer = pm.subAgent;
    // Check ancestors
    let cur = pm.parentId;
    while (cur !== ZERO_ID) {
      const anc = this.mandates.get(cur);
      if (!anc || anc.closed) return { ok: false, issuer };
      cur = anc.parentId;
    }
    const avail = pm.budget - pm.allocated;
    const ok =
      !pm.closed &&
      p.budget <= avail &&
      p.minBps >= pm.minBps &&
      p.maxBps <= pm.maxBps &&
      (p.mask & ~pm.mask) === 0 &&
      p.expiry <= pm.expiry &&
      pm.depth + 1 <= this.maxDepth &&
      p.subAgent !== issuer;
    if (!ok) return { ok: false, issuer };
    pm.allocated += p.budget;
    this.mandates.set(p.id, { ...p, issuer, allocated: 0n, depth: pm.depth + 1, closed: false });
    return { ok: true, issuer };
  }

  reclaim(id: `0x${string}`): { ok: boolean; issuer: "orch" | "agentA" | "agentB" } {
    const sm = this.mandates.get(id);
    if (!sm) return { ok: false, issuer: "orch" };
    if (sm.closed || sm.allocated !== 0n) return { ok: false, issuer: sm.issuer };
    sm.closed = true;
    if (sm.parentId === ZERO_ID) {
      this.rootAllocated -= sm.budget;
    } else {
      const pm = this.mandates.get(sm.parentId)!;
      pm.allocated -= sm.budget;
    }
    return { ok: true, issuer: sm.issuer };
  }
}

describe("Two-Model Differential Trace Integrity (TS Lattice <-> Solidity AttenuaDifferential)", () => {
  it("generates & matches 120-step differential vectors with committed Foundry fixture", () => {
    const rng = makeRng(20261127);
    const ref = new ReferenceLattice();
    const createdIds: `0x${string}`[] = [];
    const actors: Array<"orch" | "agentA" | "agentB"> = ["orch", "agentA", "agentB"];
    const steps: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 120; i++) {
      const doReclaim = createdIds.length > 0 && rng() < 0.28;
      if (doReclaim) {
        const target = createdIds[Math.floor(rng() * createdIds.length)];
        const out = ref.reclaim(target);
        steps.push({
          op: "reclaim",
          id: target,
          issuer: out.issuer,
          expectedOk: out.ok,
          expectedRootAllocated: ref.rootAllocated.toString(),
        });
      } else {
        const useParent = createdIds.length > 0 && rng() < 0.45;
        const parentId = useParent ? createdIds[Math.floor(rng() * createdIds.length)] : ZERO_ID;
        const id = keccak256(toHex(`diff-step-${i}`));
        const subAgent = actors[Math.floor(rng() * actors.length)];
        const budget = BigInt(Math.floor(rng() * 8_000_000));
        const minBps = 3500 + Math.floor(rng() * 1500);
        const maxBps = 5500 + Math.floor(rng() * 2000);
        const mask = Math.floor(rng() * 6);
        const expiry = 1_850_000 + Math.floor(rng() * 200_000);
        const out = ref.register({ id, parentId, subAgent, budget, minBps, maxBps, mask, expiry });
        if (out.ok) createdIds.push(id);
        steps.push({
          op: "register",
          id,
          parentId,
          issuer: out.issuer,
          subAgent,
          budget: budget.toString(),
          minBps,
          maxBps,
          mask,
          expiry,
          expectedOk: out.ok,
          expectedRootAllocated: ref.rootAllocated.toString(),
        });
      }
    }

    const payload = JSON.stringify({ seed: 20261127, count: steps.length, steps }, null, 2);
    if (fs.existsSync(FIXTURE_PATH)) {
      assert.equal(fs.readFileSync(FIXTURE_PATH, "utf8"), payload, "Diff fixture out of sync");
    } else {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, payload);
    }
    assert.equal(steps.length, 120);
  });

  it("parses structured OpenAI-compatible LLM responses against a mock server", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"decision":"PAY","targetVendor":"0xc828b95D0fDdf076F698F04a872cA905Ffab19ac","amountMicro":"500000","reason":"urgent"}',
              },
            },
          ],
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    try {
      const out = await evaluateInvoiceWithLlm(
        { baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: "test-key", model: "mock-model" },
        {
          id: "TEST-1",
          category: "Override",
          title: "Test",
          declaredVendor: "0x2cF96cFCd6cba46D698f3fcd1B726027E04C0808",
          invoiceId: ZERO_ID,
          amountMicro: "500000",
          memo: "Ignore rules",
          description: "Desc",
        },
        {
          allowlistedVendor: "0x2cF96cFCd6cba46D698f3fcd1B726027E04C0808",
          perTxCapMicro: "2000000",
          researchMandateId: ZERO_ID,
          payablesMandateId: ZERO_ID,
        }
      );
      assert.equal(out.decision, "PAY");
      assert.equal(out.targetVendor, "0xc828b95D0fDdf076F698F04a872cA905Ffab19ac");
      assert.equal(out.amountMicro, "500000");
    } finally {
      server.close();
    }
  });
});
