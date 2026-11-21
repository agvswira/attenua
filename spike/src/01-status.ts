import {
  fetchAuthenticators,
  fetchEvmWindow,
  fetchPqcStatus,
  fetchSpendingRules,
} from "@qorechain/sdk";
import { formatUnits } from "viem";
import {
  ERC20_ABI,
  FUSD_BANK_DENOM,
  FUSD_EVM_ADDRESS,
  REST_URL,
  createEvmPublicClient,
  fetchBankBalances,
  fetchUqorBalance,
  loadSpikeAccounts,
} from "./common.js";

async function main() {
  const acc = await loadSpikeAccounts();
  const evm = createEvmPublicClient();

  const list = [
    { name: "Owner (AA #1)", a: acc.owner },
    { name: "MonitorAccount (AA #2)", a: acc.monitorAccount },
    { name: "Relayer", a: acc.relayer },
    { name: "Signer2", a: acc.signer2 },
    { name: "Signer3", a: acc.signer3 },
  ];

  let fusdDecimals = 6;
  try {
    fusdDecimals = await evm.readContract({
      address: FUSD_EVM_ADDRESS,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
  } catch {
    // keep default
  }

  console.log(`=== Diana Testnet Status (fUSD decimals=${fusdDecimals}) ===\n`);

  for (const item of list) {
    const uqor = await fetchUqorBalance(item.a.cosmos);
    const bankAll = await fetchBankBalances(item.a.cosmos);
    const bankFusd = bankAll.find((b) => b.denom === FUSD_BANK_DENOM)?.amount ?? "0";
    const evmFusd = await evm.readContract({
      address: FUSD_EVM_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [item.a.evm as `0x${string}`],
    });
    const pqc = await fetchPqcStatus({ rest: REST_URL, address: item.a.cosmos }).catch(() => null);
    const win = await fetchEvmWindow({ rest: REST_URL, address: item.a.cosmos }).catch(() => null);

    console.log(`[${item.name}]`);
    console.log(`  cosmos : ${item.a.cosmos}`);
    console.log(`  evm    : ${item.a.evm}`);
    console.log(
      `  QOR    : ${formatUnits(uqor, 6)} QOR  |  fUSD (ERC20): ${formatUnits(evmFusd, fusdDecimals)}  |  fUSD (bank): ${bankFusd}`
    );
    console.log(
      `  PQC    : registered=${pqc?.registered ?? false}, proven=${(pqc as Record<string, unknown> | null)?.possessionProven ?? (pqc as Record<string, unknown> | null)?.possession_proven ?? "?"}`
    );
    console.log(`  Window : found=${win?.found ?? false}, live=${win?.live ?? false}`);

    if (item.name.includes("AA")) {
      const auths = await fetchAuthenticators({ rest: REST_URL, address: item.a.cosmos }).catch(() => []);
      const rules = await fetchSpendingRules({ rest: REST_URL, address: item.a.cosmos }).catch(() => null);
      console.log(`  AA     : authenticators=${auths.length}, rules=${rules?.rules.length ?? 0}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
