import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fetchAuthenticators, fetchEvmWindow, fetchSpendingRules } from "@qorechain/sdk";
import { parseAbi } from "viem";
import { DEPLOYMENT_FILE, EVIDENCE_FILE, REST_URL, createEvmPublicClient } from "./config.js";

const VAULT_ABI = parseAbi([
  "function rootEpoch() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function rootMandate() view returns (address,uint256,uint256,uint256,uint16,uint16,uint8,uint8,uint64,uint64,bool)",
  "function portfolioSummary() view returns (uint256,uint256,uint256,uint256)",
]);

const server = new Server(
  { name: "attenua-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_vault_state",
      description: "Read live AttenuaVault state, root mandate, and ERC-4626 portfolio weights on qorechain-diana (read-only).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_protocol_guardrails",
      description: "Inspect x/abstractaccount spending rules, linked authenticators (AA #1 & AA #2), and EVM window status on qorechain-diana.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_attack_evidence",
      description: "Return recorded live-run happy-path transactions and 9 adversarial attack refusal proofs on qorechain-diana.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

function loadDeploymentManifest() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Deployment manifest not found at ${DEPLOYMENT_FILE}`);
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "get_vault_state") {
    const dep = loadDeploymentManifest();
    const evm = createEvmPublicClient();
    const addr = dep.contracts.attenuaVault.address as `0x${string}`;
    const [epoch, frozen, rm, summary] = await Promise.all([
      evm.readContract({ address: addr, abi: VAULT_ABI, functionName: "rootEpoch" }),
      evm.readContract({ address: addr, abi: VAULT_ABI, functionName: "frozen" }),
      evm.readContract({ address: addr, abi: VAULT_ABI, functionName: "rootMandate" }),
      evm.readContract({ address: addr, abi: VAULT_ABI, functionName: "portfolioSummary" }),
    ]);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              vault: addr,
              rootEpoch: epoch.toString(),
              frozen,
              rootMandate: {
                orchestrator: rm[0],
                rootBudget: rm[1].toString(),
                rootAllocated: rm[2].toString(),
                rootSpent: rm[3].toString(),
                minLiquidityBps: rm[4],
                maxLiquidityBps: rm[5],
                actionMask: rm[6],
                maxDepth: rm[7],
                expiry: rm[8].toString(),
                epoch: rm[9].toString(),
                active: rm[10],
              },
              portfolio: {
                idleFusd: summary[0].toString(),
                liquidityAssets: summary[1].toString(),
                reserveAssets: summary[2].toString(),
                liquidityBps: summary[3].toString(),
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (req.params.name === "get_protocol_guardrails") {
    const dep = loadDeploymentManifest();
    const aa1 = dep.abstractAccounts.ownerTreasuryAA1.cosmos as string;
    const aa2 = dep.abstractAccounts.monitorAA2.cosmos as string;
    const [win1, auth1, rules1, auth2, rules2] = await Promise.all([
      fetchEvmWindow({ rest: REST_URL, address: aa1 }),
      fetchAuthenticators({ rest: REST_URL, address: aa1 }),
      fetchSpendingRules({ rest: REST_URL, address: aa1 }),
      fetchAuthenticators({ rest: REST_URL, address: aa2 }),
      fetchSpendingRules({ rest: REST_URL, address: aa2 }),
    ]);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ownerAA1: { address: aa1, evmWindow: win1, auth1, rules1 }, monitorAA2: { address: aa2, auth2, rules2 } },
            (_, v) => (typeof v === "bigint" ? v.toString() : v),
            2
          ),
        },
      ],
    };
  }

  if (req.params.name === "get_attack_evidence") {
    const ev = fs.existsSync(EVIDENCE_FILE) ? JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")) : { status: "not_run_yet" };
    return { content: [{ type: "text", text: JSON.stringify(ev, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
