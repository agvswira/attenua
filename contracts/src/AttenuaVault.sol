// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PqcVerifier} from "./PqcVerifier.sol";

/// @title AttenuaVault
/// @notice Post-Quantum Hierarchical Capability Attenuation engine for institutional multi-agent
///         treasury swarms on QoreChain.
///
///         Security invariants:
///         1. ZERO msg.sender trust: No onlyOwner or msg.sender == rootOwner checks anywhere.
///            Under QoreChain x/abstractaccount MsgExecuteEVM, linked authenticators call from the
///            canonical owner's 0x address; therefore every authorization is a domain-separated
///            cryptographic signature verified in calldata.
///         2. Zero classical spend: Every spending, delegation, and admin loosening action requires
///            an ML-DSA-87 signature verified via PqcVerifier (pqcKeyStatus -> possessionProven -> pqcVerify).
///            The classical monitorSigner key can ONLY trigger monotonic freeze().
///         3. Strict lattice attenuation: Every child sub-mandate must satisfy:
///            - Budget conservation: sum(active child allocations) + parentDirectSpent <= rootBudget
///            - Narrowed IPS weight band: childMinBps >= parentMinBps && childMaxBps <= parentMaxBps
///            - Action-mask subset: (childMask & ~parentMask) == 0
///            - Monotonic expiry & depth: childExpiry <= parentExpiry && childDepth == parentDepth + 1 <= maxDepth
///         4. O(1) cascading kill-switch: Owner increments rootEpoch with one ML-DSA-87 signature,
///            instantly invalidating every active sub-mandate in the entire delegation tree.
///
///         Prior art credited: UCAN and Biscuit capability attenuation models.
contract AttenuaVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Action capability bitmask
    uint8 public constant BIT_NONE = 0; // Research sub-agent: budget = 0, read-only + clearance signer
    uint8 public constant BIT_ALLOCATE = 1 << 0; // Allocator sub-agent: ERC-4626 deposit/withdraw inside band
    uint8 public constant BIT_PAY_INVOICE = 1 << 1; // Payables sub-agent: vendor-signed + research-cleared invoice
    uint8 public constant BIT_ALL = BIT_ALLOCATE | BIT_PAY_INVOICE;

    uint16 public constant MAX_BPS = 10_000;

    IERC20 public immutable fusd;
    IERC4626 public immutable liquidityVault;
    IERC4626 public immutable reserveVault;
    address public immutable rootOwner;
    address public immutable monitorSigner;

    uint64 public rootEpoch;
    bool public frozen;

    struct RootMandate {
        address orchestrator;
        uint256 rootBudget;
        uint256 rootAllocated; // Sum of currently reserved child budgets
        uint256 rootSpent; // Sum of actual spend finalized across closed/active children
        uint16 minLiquidityBps;
        uint16 maxLiquidityBps;
        uint8 actionMask;
        uint8 maxDepth;
        uint64 expiry;
        uint64 epoch;
        bool active;
    }

    struct SubMandate {
        bytes32 parentId; // bytes32(0) when parent is RootMandate
        address issuer;
        address subAgent;
        uint256 budget;
        uint256 allocated; // Reserved to grandchildren (if depth < maxDepth)
        uint256 spent;
        uint16 minLiquidityBps;
        uint16 maxLiquidityBps;
        uint8 actionMask;
        uint8 depth;
        uint64 expiry;
        uint64 epoch;
        bool closed;
    }

    RootMandate public rootMandate;
    mapping(bytes32 mandateId => SubMandate) public subMandates;
    mapping(address vendor => bool) public registeredVendors;
    mapping(address signer => uint64) public nonces;
    mapping(bytes32 invoiceKey => bool) public usedInvoices;

    // Events
    event RootMandateSet(
        uint64 indexed epoch,
        address indexed orchestrator,
        uint256 rootBudget,
        uint16 minLiquidityBps,
        uint16 maxLiquidityBps,
        uint64 expiry
    );
    event VendorUpdated(address indexed vendor, bool allowed);
    event SubMandateRegistered(
        bytes32 indexed mandateId,
        bytes32 indexed parentId,
        address indexed subAgent,
        uint256 budget,
        uint8 actionMask,
        uint16 minLiquidityBps,
        uint16 maxLiquidityBps,
        uint8 depth,
        uint64 expiry,
        uint64 epoch
    );
    event SubMandateReclaimed(bytes32 indexed mandateId, uint256 reclaimedBudget);
    event AllocationExecuted(
        bytes32 indexed mandateId,
        address indexed subAgent,
        uint256 liqAmount,
        bool liqIsDeposit,
        uint256 resAmount,
        bool resIsDeposit,
        uint256 postLiquidityBps
    );
    event InvoicePaid(
        bytes32 indexed mandateId,
        address indexed payablesAgent,
        address indexed vendor,
        bytes32 invoiceId,
        uint256 amount,
        address researchAgent
    );
    event VaultFrozen(address indexed monitor, uint64 nonce);
    event VaultUnfrozen(uint64 nonce);
    event RootEpochRevoked(uint64 indexed newEpoch);
    event EmergencyWithdrawn(address indexed to, uint256 amount);

    // Errors
    error ZeroAddress();
    error InvalidBand(uint16 minBps, uint16 maxBps);
    error VaultIsFrozen();
    error SignatureExpired(uint64 deadline, uint256 current);
    error BadNonce(address signer, uint64 expected, uint64 provided);
    error RootMandateInactive();
    error EpochMismatch(uint64 expected, uint64 provided);
    error MandateAlreadyExists(bytes32 mandateId);
    error MandateNotFound(bytes32 mandateId);
    error MandateClosed(bytes32 mandateId);
    error MandateExpired(uint64 expiry, uint256 current);
    error AttenuationBudgetExceeded(uint256 requested, uint256 available);
    error AttenuationBandWidened(uint16 childMin, uint16 childMax, uint16 parentMin, uint16 parentMax);
    error AttenuationMaskWidened(uint8 childMask, uint8 parentMask);
    error AttenuationExpiryWidened(uint64 childExpiry, uint64 parentExpiry);
    error AttenuationDepthExceeded(uint8 childDepth, uint8 maxDepth);
    error ZeroBudgetCapability(bytes32 mandateId);
    error ActionNotPermitted(uint8 requiredBit, uint8 actualMask);
    error SubMandateBudgetExceeded(uint256 requested, uint256 remaining);
    error SubAgentMismatch(address expected, address provided);
    error InvalidTargetVault(address target);
    error PortfolioBandViolated(uint256 actualBps, uint16 minBps, uint16 maxBps);
    error VendorNotRegistered(address vendor);
    error InvoiceAlreadyPaid(bytes32 invoiceKey);
    error InvalidResearchMandate(bytes32 researchMandateId);
    error InvalidMonitorSignature();
    error InvalidAmount();

    constructor(
        address fusd_,
        address liquidityVault_,
        address reserveVault_,
        address rootOwner_,
        address monitorSigner_
    ) {
        if (
            fusd_ == address(0) ||
            liquidityVault_ == address(0) ||
            reserveVault_ == address(0) ||
            rootOwner_ == address(0) ||
            monitorSigner_ == address(0)
        ) revert ZeroAddress();

        fusd = IERC20(fusd_);
        liquidityVault = IERC4626(liquidityVault_);
        reserveVault = IERC4626(reserveVault_);
        rootOwner = rootOwner_;
        monitorSigner = monitorSigner_;
        rootEpoch = 1;
    }

    // =========================================================================
    // Owner Admin Actions (ML-DSA-87 ONLY — Zero msg.sender Trust)
    // =========================================================================

    function setRootMandate(
        address orchestrator,
        uint256 rootBudget,
        uint16 minLiquidityBps,
        uint16 maxLiquidityBps,
        uint8 actionMask,
        uint8 maxDepth,
        uint64 expiry,
        uint64 nonce,
        uint64 deadline,
        bytes calldata ownerPqcSig
    ) external {
        if (orchestrator == address(0)) revert ZeroAddress();
        if (minLiquidityBps > maxLiquidityBps || maxLiquidityBps > MAX_BPS) {
            revert InvalidBand(minLiquidityBps, maxLiquidityBps);
        }
        if (expiry <= block.timestamp) revert MandateExpired(expiry, block.timestamp);
        if (maxDepth == 0) revert AttenuationDepthExceeded(1, 0);

        _consumeNonceAndDeadline(rootOwner, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|SET_ROOT|",
            block.chainid,
            address(this),
            rootEpoch,
            orchestrator,
            rootBudget,
            minLiquidityBps,
            maxLiquidityBps,
            actionMask,
            maxDepth,
            expiry,
            nonce,
            deadline
        );
        PqcVerifier.verify(rootOwner, ownerPqcSig, digest);

        // Ensure orchestrator has a proven ML-DSA-87 key registered on chain
        PqcVerifier.requireProvenKey(orchestrator);

        // Advance epoch cleanly whenever a new RootMandate replaces an existing one
        if (rootMandate.active) {
            rootEpoch += 1;
        }

        rootMandate = RootMandate({
            orchestrator: orchestrator,
            rootBudget: rootBudget,
            rootAllocated: 0,
            rootSpent: 0,
            minLiquidityBps: minLiquidityBps,
            maxLiquidityBps: maxLiquidityBps,
            actionMask: actionMask,
            maxDepth: maxDepth,
            expiry: expiry,
            epoch: rootEpoch,
            active: true
        });

        emit RootMandateSet(rootEpoch, orchestrator, rootBudget, minLiquidityBps, maxLiquidityBps, expiry);
    }

    function setVendor(
        address vendor,
        bool allowed,
        uint64 nonce,
        uint64 deadline,
        bytes calldata ownerPqcSig
    ) external {
        if (vendor == address(0)) revert ZeroAddress();
        _consumeNonceAndDeadline(rootOwner, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|SET_VENDOR|",
            block.chainid,
            address(this),
            rootEpoch,
            vendor,
            allowed,
            nonce,
            deadline
        );
        PqcVerifier.verify(rootOwner, ownerPqcSig, digest);

        if (allowed) {
            PqcVerifier.requireProvenKey(vendor);
        }
        registeredVendors[vendor] = allowed;
        emit VendorUpdated(vendor, allowed);
    }

    /// @notice O(1) cascading post-quantum kill-switch: invalidates every active sub-mandate instantly.
    function revokeRootEpoch(
        uint64 nonce,
        uint64 deadline,
        bytes calldata ownerPqcSig
    ) external {
        _consumeNonceAndDeadline(rootOwner, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|REVOKE_EPOCH|",
            block.chainid,
            address(this),
            rootEpoch,
            nonce,
            deadline
        );
        PqcVerifier.verify(rootOwner, ownerPqcSig, digest);

        rootEpoch += 1;
        rootMandate.active = false;
        emit RootEpochRevoked(rootEpoch);
    }

    function unfreeze(
        uint64 nonce,
        uint64 deadline,
        bytes calldata ownerPqcSig
    ) external {
        _consumeNonceAndDeadline(rootOwner, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|UNFREEZE|",
            block.chainid,
            address(this),
            rootEpoch,
            nonce,
            deadline
        );
        PqcVerifier.verify(rootOwner, ownerPqcSig, digest);

        frozen = false;
        emit VaultUnfrozen(nonce);
    }

    function emergencyWithdraw(
        address to,
        uint256 amount,
        uint64 nonce,
        uint64 deadline,
        bytes calldata ownerPqcSig
    ) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        _consumeNonceAndDeadline(rootOwner, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|EMERGENCY_WITHDRAW|",
            block.chainid,
            address(this),
            rootEpoch,
            to,
            amount,
            nonce,
            deadline
        );
        PqcVerifier.verify(rootOwner, ownerPqcSig, digest);

        fusd.safeTransfer(to, amount);
        emit EmergencyWithdrawn(to, amount);
    }

    // =========================================================================
    // Monotonic Classical Freeze (Can ONLY Freeze, NEVER Unfreeze or Spend)
    // =========================================================================

    function freeze(
        uint64 nonce,
        uint64 deadline,
        bytes calldata monitorEcdsaSig
    ) external {
        _consumeNonceAndDeadline(monitorSigner, nonce, deadline);

        bytes32 rawHash = keccak256(
            abi.encodePacked("attenua-v1|FREEZE|", block.chainid, address(this), rootEpoch, nonce, deadline)
        );
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(rawHash), monitorEcdsaSig);
        if (recovered != monitorSigner) revert InvalidMonitorSignature();

        frozen = true;
        emit VaultFrozen(monitorSigner, nonce);
    }

    // =========================================================================
    // Hierarchical Capability Attenuation (Orchestrator -> Sub-Agents)
    // =========================================================================

    function registerSubMandate(
        bytes32 mandateId,
        bytes32 parentId,
        address subAgent,
        uint256 budget,
        uint16 minLiquidityBps,
        uint16 maxLiquidityBps,
        uint8 actionMask,
        uint64 expiry,
        uint64 nonce,
        uint64 deadline,
        bytes calldata parentPqcSig
    ) external {
        if (frozen) revert VaultIsFrozen();
        if (subAgent == address(0)) revert ZeroAddress();
        if (subMandates[mandateId].issuer != address(0)) revert MandateAlreadyExists(mandateId);
        if (minLiquidityBps > maxLiquidityBps || maxLiquidityBps > MAX_BPS) {
            revert InvalidBand(minLiquidityBps, maxLiquidityBps);
        }
        if (expiry <= block.timestamp) revert MandateExpired(expiry, block.timestamp);

        // Enforce that the sub-agent holds a registered, possession-proven ML-DSA-87 key
        PqcVerifier.requireProvenKey(subAgent);

        address issuer;
        uint8 childDepth;

        if (parentId == bytes32(0)) {
            RootMandate storage rm = rootMandate;
            if (!rm.active || rm.epoch != rootEpoch) revert RootMandateInactive();
            if (block.timestamp > rm.expiry) revert MandateExpired(rm.expiry, block.timestamp);

            uint256 available = rm.rootBudget - rm.rootAllocated - rm.rootSpent;
            if (budget > available) revert AttenuationBudgetExceeded(budget, available);
            if (minLiquidityBps < rm.minLiquidityBps || maxLiquidityBps > rm.maxLiquidityBps) {
                revert AttenuationBandWidened(minLiquidityBps, maxLiquidityBps, rm.minLiquidityBps, rm.maxLiquidityBps);
            }
            if ((actionMask & ~rm.actionMask) != 0) revert AttenuationMaskWidened(actionMask, rm.actionMask);
            if (expiry > rm.expiry) revert AttenuationExpiryWidened(expiry, rm.expiry);
            if (1 > rm.maxDepth) revert AttenuationDepthExceeded(1, rm.maxDepth);

            issuer = rm.orchestrator;
            childDepth = 1;
            rm.rootAllocated += budget;
        } else {
            SubMandate storage pm = subMandates[parentId];
            if (pm.issuer == address(0)) revert MandateNotFound(parentId);
            if (pm.closed) revert MandateClosed(parentId);
            if (pm.epoch != rootEpoch) revert EpochMismatch(rootEpoch, pm.epoch);
            if (block.timestamp > pm.expiry) revert MandateExpired(pm.expiry, block.timestamp);

            uint256 available = pm.budget - pm.allocated - pm.spent;
            if (budget > available) revert AttenuationBudgetExceeded(budget, available);
            if (minLiquidityBps < pm.minLiquidityBps || maxLiquidityBps > pm.maxLiquidityBps) {
                revert AttenuationBandWidened(minLiquidityBps, maxLiquidityBps, pm.minLiquidityBps, pm.maxLiquidityBps);
            }
            if ((actionMask & ~pm.actionMask) != 0) revert AttenuationMaskWidened(actionMask, pm.actionMask);
            if (expiry > pm.expiry) revert AttenuationExpiryWidened(expiry, pm.expiry);

            childDepth = pm.depth + 1;
            if (childDepth > rootMandate.maxDepth) revert AttenuationDepthExceeded(childDepth, rootMandate.maxDepth);

            issuer = pm.subAgent;
            pm.allocated += budget;
        }

        _consumeNonceAndDeadline(issuer, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|SUB_MANDATE|",
            block.chainid,
            address(this),
            rootEpoch,
            mandateId,
            parentId,
            subAgent,
            budget,
            minLiquidityBps,
            maxLiquidityBps,
            actionMask,
            expiry,
            nonce,
            deadline
        );
        PqcVerifier.verify(issuer, parentPqcSig, digest);

        subMandates[mandateId] = SubMandate({
            parentId: parentId,
            issuer: issuer,
            subAgent: subAgent,
            budget: budget,
            allocated: 0,
            spent: 0,
            minLiquidityBps: minLiquidityBps,
            maxLiquidityBps: maxLiquidityBps,
            actionMask: actionMask,
            depth: childDepth,
            expiry: expiry,
            epoch: rootEpoch,
            closed: false
        });

        emit SubMandateRegistered(
            mandateId,
            parentId,
            subAgent,
            budget,
            actionMask,
            minLiquidityBps,
            maxLiquidityBps,
            childDepth,
            expiry,
            rootEpoch
        );
    }

    /// @notice Reclaims unspent budget from a child sub-mandate back to its parent.
    function reclaimSubMandate(
        bytes32 mandateId,
        uint64 nonce,
        uint64 deadline,
        bytes calldata issuerPqcSig
    ) external {
        SubMandate storage sm = subMandates[mandateId];
        if (sm.issuer == address(0)) revert MandateNotFound(mandateId);
        if (sm.closed) revert MandateClosed(mandateId);
        if (sm.epoch != rootEpoch) revert EpochMismatch(rootEpoch, sm.epoch);

        _consumeNonceAndDeadline(sm.issuer, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|RECLAIM|",
            block.chainid,
            address(this),
            rootEpoch,
            mandateId,
            nonce,
            deadline
        );
        PqcVerifier.verify(sm.issuer, issuerPqcSig, digest);

        uint256 unspent = sm.budget - sm.spent - sm.allocated;
        sm.closed = true;

        if (sm.parentId == bytes32(0)) {
            rootMandate.rootAllocated -= (unspent + sm.spent);
            rootMandate.rootSpent += sm.spent;
        } else {
            SubMandate storage pm = subMandates[sm.parentId];
            pm.allocated -= (unspent + sm.spent);
            pm.spent += sm.spent;
        }

        emit SubMandateReclaimed(mandateId, unspent);
    }

    // =========================================================================
    // Sub-Agent 1: Allocator (Atomic Dual-Sleeve ERC-4626 Rebalance Inside IPS Band)
    // =========================================================================

    function executeAllocate(
        bytes32 mandateId,
        uint256 liqAmount,
        bool liqIsDeposit,
        uint256 resAmount,
        bool resIsDeposit,
        uint64 nonce,
        uint64 deadline,
        bytes calldata subAgentPqcSig
    ) external nonReentrant {
        if (frozen) revert VaultIsFrozen();
        uint256 grossVolume = liqAmount + resAmount;
        if (grossVolume == 0) revert InvalidAmount();

        SubMandate storage sm = _requireActiveSubMandate(mandateId, BIT_ALLOCATE);
        if (sm.budget == 0) revert ZeroBudgetCapability(mandateId);
        uint256 remaining = sm.budget - sm.spent - sm.allocated;
        if (grossVolume > remaining) revert SubMandateBudgetExceeded(grossVolume, remaining);

        _consumeNonceAndDeadline(sm.subAgent, nonce, deadline);

        bytes memory digest = abi.encodePacked(
            "attenua-v1|ALLOCATE|",
            block.chainid,
            address(this),
            rootEpoch,
            mandateId,
            liqAmount,
            liqIsDeposit,
            resAmount,
            resIsDeposit,
            nonce,
            deadline
        );
        PqcVerifier.verify(sm.subAgent, subAgentPqcSig, digest);

        sm.spent += grossVolume;

        // Execute withdrawals first so freed fUSD can be redeployed atomically in the same tx
        if (liqAmount > 0 && !liqIsDeposit) {
            liquidityVault.withdraw(liqAmount, address(this), address(this));
        }
        if (resAmount > 0 && !resIsDeposit) {
            reserveVault.withdraw(resAmount, address(this), address(this));
        }
        if (liqAmount > 0 && liqIsDeposit) {
            fusd.forceApprove(address(liquidityVault), liqAmount);
            liquidityVault.deposit(liqAmount, address(this));
            fusd.forceApprove(address(liquidityVault), 0);
        }
        if (resAmount > 0 && resIsDeposit) {
            fusd.forceApprove(address(reserveVault), resAmount);
            reserveVault.deposit(resAmount, address(this));
            fusd.forceApprove(address(reserveVault), 0);
        }

        // Oracle-free on-chain portfolio weight check via ERC-4626 convertToAssets()
        uint256 liqAssets = liquidityVault.convertToAssets(liquidityVault.balanceOf(address(this)));
        uint256 resAssets = reserveVault.convertToAssets(reserveVault.balanceOf(address(this)));
        uint256 totalInvested = liqAssets + resAssets;
        uint256 liqBps = totalInvested == 0 ? 0 : (liqAssets * MAX_BPS) / totalInvested;

        if (totalInvested > 0 && (liqBps < sm.minLiquidityBps || liqBps > sm.maxLiquidityBps)) {
            revert PortfolioBandViolated(liqBps, sm.minLiquidityBps, sm.maxLiquidityBps);
        }

        emit AllocationExecuted(mandateId, sm.subAgent, liqAmount, liqIsDeposit, resAmount, resIsDeposit, liqBps);
    }

    // =========================================================================
    // Sub-Agent 2: Payables (3x ML-DSA-87 Atomic Verification:
    //              Payables + Vendor + Zero-Budget Research Clearance)
    // =========================================================================

    function executePayInvoice(
        bytes32 mandateId,
        bytes32 researchMandateId,
        address vendor,
        bytes32 invoiceId,
        uint256 amount,
        uint64 nonce,
        uint64 deadline,
        bytes calldata payablesPqcSig,
        bytes calldata vendorPqcSig,
        bytes calldata researchPqcSig
    ) external nonReentrant {
        if (frozen) revert VaultIsFrozen();
        if (amount == 0) revert InvalidAmount();
        if (!registeredVendors[vendor]) revert VendorNotRegistered(vendor);

        SubMandate storage sm = _requireActiveSubMandate(mandateId, BIT_PAY_INVOICE);
        if (sm.budget == 0) revert ZeroBudgetCapability(mandateId);
        uint256 remaining = sm.budget - sm.spent - sm.allocated;
        if (amount > remaining) revert SubMandateBudgetExceeded(amount, remaining);

        // Verify Research sub-agent holds an active zero-budget mandate in the same rootEpoch
        SubMandate storage rm = subMandates[researchMandateId];
        if (
            rm.issuer == address(0) ||
            rm.closed ||
            rm.epoch != rootEpoch ||
            block.timestamp > rm.expiry ||
            rm.budget != 0 ||
            rm.actionMask != BIT_NONE
        ) {
            revert InvalidResearchMandate(researchMandateId);
        }

        bytes32 invoiceKey = keccak256(abi.encodePacked(vendor, invoiceId));
        if (usedInvoices[invoiceKey]) revert InvoiceAlreadyPaid(invoiceKey);

        _consumeNonceAndDeadline(sm.subAgent, nonce, deadline);

        // 1. Payables sub-agent execution signature (bound to mandateId -> blocks confused deputy)
        bytes memory payablesDigest = abi.encodePacked(
            "attenua-v1|PAY_INVOICE|",
            block.chainid,
            address(this),
            rootEpoch,
            mandateId,
            vendor,
            invoiceId,
            amount,
            nonce,
            deadline
        );
        PqcVerifier.verify(sm.subAgent, payablesPqcSig, payablesDigest);

        // 2. Vendor's own ML-DSA-87 signature over the invoice terms
        bytes memory vendorDigest = abi.encodePacked(
            "attenua-v1|VENDOR_INVOICE|",
            block.chainid,
            address(this),
            vendor,
            invoiceId,
            amount
        );
        PqcVerifier.verify(vendor, vendorPqcSig, vendorDigest);

        // 3. Research sub-agent (budget = 0) ML-DSA-87 "invoice clean" clearance verdict
        bytes memory researchDigest = abi.encodePacked(
            "attenua-v1|RESEARCH_CLEAR|",
            block.chainid,
            address(this),
            rootEpoch,
            researchMandateId,
            vendor,
            invoiceId,
            amount
        );
        PqcVerifier.verify(rm.subAgent, researchPqcSig, researchDigest);

        usedInvoices[invoiceKey] = true;
        sm.spent += amount;

        fusd.safeTransfer(vendor, amount);
        emit InvoicePaid(mandateId, sm.subAgent, vendor, invoiceId, amount, rm.subAgent);
    }

    // =========================================================================
    // View Helpers (for Frontend, MCP Server, & Keyless Verifier)
    // =========================================================================

    function portfolioSummary()
        external
        view
        returns (uint256 idleFusd, uint256 liquidityAssets, uint256 reserveAssets, uint256 liquidityBps)
    {
        idleFusd = fusd.balanceOf(address(this));
        liquidityAssets = liquidityVault.convertToAssets(liquidityVault.balanceOf(address(this)));
        reserveAssets = reserveVault.convertToAssets(reserveVault.balanceOf(address(this)));
        uint256 total = liquidityAssets + reserveAssets;
        liquidityBps = total == 0 ? 0 : (liquidityAssets * MAX_BPS) / total;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    function _requireActiveSubMandate(bytes32 mandateId, uint8 requiredBit)
        internal
        view
        returns (SubMandate storage sm)
    {
        sm = subMandates[mandateId];
        if (sm.issuer == address(0)) revert MandateNotFound(mandateId);
        if (sm.closed) revert MandateClosed(mandateId);
        if (sm.epoch != rootEpoch) revert EpochMismatch(rootEpoch, sm.epoch);
        if (block.timestamp > sm.expiry) revert MandateExpired(sm.expiry, block.timestamp);
        if ((sm.actionMask & requiredBit) == 0) revert ActionNotPermitted(requiredBit, sm.actionMask);
    }

    function _consumeNonceAndDeadline(address signer, uint64 nonce, uint64 deadline) internal {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        uint64 expected = nonces[signer];
        if (nonce != expected) revert BadNonce(signer, expected, nonce);
        nonces[signer] = expected + 1;
    }
}
