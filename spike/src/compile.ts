import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { keccak256, toHex } from "viem";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_PATH = path.join(ROOT, "contracts", "SpikeProbe.sol");
const OUT_DIR = path.join(ROOT, "out");
const OUT_PATH = path.join(OUT_DIR, "SpikeProbe.json");

const source = fs.readFileSync(SOURCE_PATH, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "SpikeProbe.sol": { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors?.length) {
  let hasError = false;
  for (const err of output.errors) {
    console.error(err.formattedMessage);
    if (err.severity === "error") hasError = true;
  }
  if (hasError) process.exit(1);
}

const contract = output.contracts["SpikeProbe.sol"]["SpikeProbe"];
const bytecode = `0x${contract.evm.bytecode.object}`;
const deployedBytecode = `0x${contract.evm.deployedBytecode.object}`;
const methodIdentifiers = contract.evm.methodIdentifiers as Record<string, string>;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      compiler: solc.version(),
      abi: contract.abi,
      bytecode,
      deployedBytecode,
      bytecodeHash: keccak256(bytecode as `0x${string}`),
      methodIdentifiers,
    },
    null,
    2
  )
);

console.log(`Compiled SpikeProbe.sol with solc ${solc.version()}`);
console.log(`Artifact: ${OUT_PATH}`);
console.log("Selectors:");
for (const [sig, sel] of Object.entries(methodIdentifiers)) {
  console.log(`  0x${sel}  ${sig}`);
}
