import { TOOLS, toolContext } from "@qorechain/mcp";

export interface McpPreflightReport {
  network: "testnet";
  chainId: string;
  blockHeight: string;
  vaultBalanceFusdOrInfo: unknown;
  ownerPqStatus: unknown;
  orchestratorPqStatus: unknown;
  payablesPqStatus: unknown;
  latencyMs: number;
}

/**
 * Queries QoreChain state through the official @qorechain/mcp tool definitions
 * (read-only preflight/audit without needing a local stdio subprocess).
 */
export async function runQoreMcpPreflight(params: {
  ownerCosmos: string;
  orchestratorCosmos: string;
  payablesCosmos: string;
  vaultEvm: string;
}): Promise<McpPreflightReport> {
  const started = Date.now();
  const ctx = toolContext({ defaultNetwork: "testnet" });
  const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

  const callTool = async (name: string, input: Record<string, unknown>) => {
    const t = toolByName.get(name);
    if (!t) throw new Error(`@qorechain/mcp tool missing: ${name}`);
    return t.handler(input as never, ctx);
  };

  const [chainInfo, ownerPq, orchPq, payPq, vaultInfo] = await Promise.all([
    callTool("get_chain_info", { network: "testnet" }),
    callTool("get_pq_status", { network: "testnet", target: params.ownerCosmos }),
    callTool("get_pq_status", { network: "testnet", target: params.orchestratorCosmos }),
    callTool("get_pq_status", { network: "testnet", target: params.payablesCosmos }),
    callTool("get_address_info", { network: "testnet", address: params.vaultEvm }),
  ]);

  const ci = (chainInfo ?? {}) as Record<string, unknown>;
  return {
    network: "testnet",
    chainId: String(ci.chainId ?? ci.chain_id ?? "qorechain-diana"),
    blockHeight: String(ci.latestBlockHeight ?? ci.latest_block_height ?? ci.height ?? "unknown"),
    vaultBalanceFusdOrInfo: vaultInfo,
    ownerPqStatus: ownerPq,
    orchestratorPqStatus: orchPq,
    payablesPqStatus: payPq,
    latencyMs: Date.now() - started,
  };
}
