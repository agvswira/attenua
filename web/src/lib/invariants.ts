export interface InvariantSpec {
  id: string;
  title: string;
  description: string;
  enforcedBy: string;
  chips: Array<{ id: string; kind: "attack" | "run" | "check" }>;
}

export const INVARIANTS: InvariantSpec[] = [
  {
    id: "I1",
    title: "Zero msg.sender trust",
    description:
      "Every state change verifies an ML-DSA-87 signature bound to chain, vault, epoch and nonce.",
    enforcedBy: "AttenuaVault + PqcVerifier",
    chips: [{ id: "H1 to H7", kind: "run" }],
  },
  {
    id: "I2",
    title: "Single linked key on AA #1",
    description:
      "A second key would inherit fUSD transfer rights, so AA #1 holds only the Orchestrator.",
    enforcedBy: "x/abstractaccount",
    chips: [{ id: "verify", kind: "check" }],
  },
  {
    id: "I3",
    title: "Isolated freeze-only monitor",
    description:
      "AA #2 holds 0 fUSD and may call freeze() only. It cannot move funds or unfreeze.",
    enforcedBy: "x/abstractaccount AA #2",
    chips: [
      { id: "A8", kind: "attack" },
      { id: "verify", kind: "check" },
    ],
  },
  {
    id: "I4",
    title: "Monotonic attenuation",
    description:
      "Child budget, band, action mask, expiry and depth stay inside the parent.",
    enforcedBy: "AttenuaVault lattice",
    chips: [
      { id: "A1", kind: "attack" },
      { id: "A2", kind: "attack" },
      { id: "A3", kind: "attack" },
      { id: "A4", kind: "attack" },
    ],
  },
  {
    id: "I5",
    title: "Budget conservation",
    description:
      "Sum of child budgets never exceeds the parent. Unused budget returns only by reclaim.",
    enforcedBy: "AttenuaVault lattice",
    chips: [
      { id: "A2", kind: "attack" },
      { id: "H7", kind: "run" },
    ],
  },
  {
    id: "I6",
    title: "3-signature invoice settlement",
    description:
      "Payables, Vendor and Research sign each invoice in one call (H6: 638,947 gas).",
    enforcedBy: "AttenuaVault + 3× pqcVerify",
    chips: [
      { id: "H6", kind: "run" },
      { id: "A5", kind: "attack" },
      { id: "A6", kind: "attack" },
    ],
  },
  {
    id: "I7",
    title: "No standing allowance",
    description:
      "The Owner never approves the vault. Funding is a capped just-in-time transfer.",
    enforcedBy: "x/abstractaccount denom_limits",
    chips: [
      { id: "H3", kind: "run" },
      { id: "A7", kind: "attack" },
    ],
  },
  {
    id: "I8",
    title: "HolderGuard renounced",
    description: "Guard owner is 0x0000…0000 and the Owner EVM window is closed.",
    enforcedBy: "@qorechain/asset-kit guard",
    chips: [{ id: "verify", kind: "check" }],
  },
  {
    id: "I9",
    title: "O(1) post-quantum kill-switch",
    description: "revokeRootEpoch() voids every sub-mandate in one call.",
    enforcedBy: "AttenuaVault epoch + AA #1",
    chips: [{ id: "A9", kind: "attack" }],
  },
];
