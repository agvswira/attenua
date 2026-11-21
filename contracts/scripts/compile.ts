import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { keccak256 } from "viem";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const BUILD_INFO_PATH = path.join(OUT_DIR, "build-info.json");

const SOURCES: Record<string, string> = {
  "src/PqcVerifier.sol": path.join(ROOT, "src", "PqcVerifier.sol"),
  "src/AttenuaVault.sol": path.join(ROOT, "src", "AttenuaVault.sol"),
  "vendor/asset-kit/interfaces/IHolderEligibility.sol": path.join(
    ROOT,
    "vendor",
    "asset-kit",
    "interfaces",
    "IHolderEligibility.sol"
  ),
  "vendor/asset-kit/interfaces/IQorePqcKeyStatus.sol": path.join(
    ROOT,
    "vendor",
    "asset-kit",
    "interfaces",
    "IQorePqcKeyStatus.sol"
  ),
  "vendor/asset-kit/guard/QoreChainHybridHolderGuard.sol": path.join(
    ROOT,
    "vendor",
    "asset-kit",
    "guard",
    "QoreChainHybridHolderGuard.sol"
  ),
  "vendor/asset-kit/vaults/QoreChainRwaVault.sol": path.join(
    ROOT,
    "vendor",
    "asset-kit",
    "vaults",
    "QoreChainRwaVault.sol"
  ),
};

const sourcesInput: Record<string, { content: string }> = {};
for (const [key, fullPath] of Object.entries(SOURCES)) {
  sourcesInput[key] = { content: fs.readFileSync(fullPath, "utf8") };
}

function findImports(importPath: string): { contents: string } | { error: string } {
  if (importPath.startsWith("@openzeppelin/")) {
    const resolved = path.join(ROOT, "node_modules", importPath);
    if (fs.existsSync(resolved)) {
      return { contents: fs.readFileSync(resolved, "utf8") };
    }
  }
  const direct = path.join(ROOT, importPath);
  if (fs.existsSync(direct)) {
    return { contents: fs.readFileSync(direct, "utf8") };
  }
  return { error: `Import not found: ${importPath}` };
}

const standardInput = {
  language: "Solidity",
  sources: sourcesInput,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(standardInput), { import: findImports }));

if (output.errors?.length) {
  let hasError = false;
  for (const err of output.errors) {
    console.error(err.formattedMessage);
    if (err.severity === "error") hasError = true;
  }
  if (hasError) process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  BUILD_INFO_PATH,
  JSON.stringify({ solcVersion: solc.version(), input: standardInput, output }, null, 2)
);

const targets = [
  ["src/AttenuaVault.sol", "AttenuaVault"],
  ["vendor/asset-kit/guard/QoreChainHybridHolderGuard.sol", "QoreChainHybridHolderGuard"],
  ["vendor/asset-kit/vaults/QoreChainRwaVault.sol", "QoreChainRwaVault"],
] as const;

console.log(`Compiled with solc ${solc.version()} (viaIR=true, optimizer=200, evm=cancun)\n`);
for (const [file, name] of targets) {
  const c = output.contracts[file][name];
  const bytecode = `0x${c.evm.bytecode.object}` as `0x${string}`;
  const deployedBytecode = `0x${c.evm.deployedBytecode.object}` as `0x${string}`;
  const artifactPath = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        contractName: name,
        sourceName: file,
        compiler: solc.version(),
        abi: c.abi,
        bytecode,
        deployedBytecode,
        bytecodeHash: keccak256(bytecode),
        methodIdentifiers: c.evm.methodIdentifiers,
      },
      null,
      2
    )
  );
  console.log(`  ${name} -> ${artifactPath} (${bytecode.length / 2 - 1} bytes)`);
}
