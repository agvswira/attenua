// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {AttenuaVault} from "../src/AttenuaVault.sol";
import {QoreChainHybridHolderGuard} from "../vendor/asset-kit/guard/QoreChainHybridHolderGuard.sol";
import {QoreChainRwaVault} from "../vendor/asset-kit/vaults/QoreChainRwaVault.sol";
import {MockFusd} from "./mocks/MockFusd.sol";
import {PqcKeyStatusMock, PqcVerifyMock} from "./mocks/PqcPrecompileMock.sol";

contract AttenuaHandler is Test {
    uint256 internal constant ONE_FUSD = 1_000_000;

    AttenuaVault public vault;
    MockFusd public fusd;
    PqcKeyStatusMock public keyStatus;

    address public owner;
    uint256 public monitorPriv;
    address public orchestrator;
    address public allocator;
    address public payables;
    address public research;
    address public vendor;

    bytes32[] public mandateIds;
    uint256 public totalPaidToVendor;
    uint64 public monitorNonceLocal;
    uint256 public invoiceSeq;

    constructor(
        AttenuaVault vault_,
        MockFusd fusd_,
        PqcKeyStatusMock keyStatus_,
        address owner_,
        uint256 monitorPriv_,
        address orchestrator_,
        address allocator_,
        address payables_,
        address research_,
        address vendor_
    ) {
        vault = vault_;
        fusd = fusd_;
        keyStatus = keyStatus_;
        owner = owner_;
        monitorPriv = monitorPriv_;
        orchestrator = orchestrator_;
        allocator = allocator_;
        payables = payables_;
        research = research_;
        vendor = vendor_;
    }

    function _sign(address signer, bytes memory digest) internal view returns (bytes memory sig) {
        (, , bytes memory pubkey, ) = keyStatus.pqcKeyStatus(signer);
        bytes32 tag = keccak256(abi.encodePacked(pubkey, digest));
        sig = new bytes(4627);
        assembly ("memory-safe") {
            mstore(add(sig, 32), tag)
        }
    }

    function setOrResetRoot(uint96 rawBudget, uint16 rawA, uint16 rawB) external {
        uint256 budget = bound(uint256(rawBudget), 10 * ONE_FUSD, 30 * ONE_FUSD);
        uint16 minBps = uint16(bound(rawA, 1000, 5000));
        uint16 maxBps = uint16(bound(rawB, minBps, 9000));
        uint64 ep = vault.rootEpoch();
        uint64 n = vault.nonces(owner);
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 expiry = uint64(block.timestamp + 30 days);
        bytes memory d = abi.encodePacked(
            "attenua-v1|SET_ROOT|",
            block.chainid,
            address(vault),
            ep,
            orchestrator,
            budget,
            minBps,
            maxBps,
            uint8(3),
            uint8(2),
            expiry,
            n,
            dl
        );
        vault.setRootMandate(orchestrator, budget, minBps, maxBps, 3, 2, expiry, n, dl, _sign(owner, d));
    }

    function delegateFromRoot(uint256 seed, uint96 rawBudget, uint16 rawMin, uint16 rawMax, uint8 mask) external {
        (, uint256 rBudget, uint256 rAlloc, uint256 rSpent, , , , , uint64 rExp, , bool rActive) = vault.rootMandate();
        if (!rActive || vault.frozen()) return;
        uint256 avail = rBudget - rAlloc - rSpent;
        uint256 budget = rawBudget % (avail + 2 * ONE_FUSD); // Intentionally tries over-budget too!
        uint16 minBps = uint16(rawMin % 10001);
        uint16 maxBps = uint16(rawMax % 10001);
        address sub = seed % 3 == 0 ? allocator : (seed % 3 == 1 ? payables : research);
        bytes32 mid = keccak256(abi.encodePacked("M", seed, mandateIds.length));
        uint64 n = vault.nonces(orchestrator);
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 exp = rExp > block.timestamp + 1 days ? rExp - 1 days : rExp;

        bytes memory d = abi.encodePacked(
            "attenua-v1|SUB_MANDATE|",
            block.chainid,
            address(vault),
            vault.rootEpoch(),
            mid,
            bytes32(0),
            sub,
            budget,
            minBps,
            maxBps,
            mask,
            exp,
            n,
            dl
        );
        try vault.registerSubMandate(mid, bytes32(0), sub, budget, minBps, maxBps, mask, exp, n, dl, _sign(orchestrator, d)) {
            mandateIds.push(mid);
        } catch {}
    }

    function delegateChild(uint256 idxSeed, uint256 seed, uint96 rawBudget, uint16 rawMin, uint16 rawMax, uint8 mask) external {
        if (mandateIds.length == 0 || vault.frozen()) return;
        bytes32 parentId = mandateIds[idxSeed % mandateIds.length];
        (, address issuer, address pSub, uint256 pBudget, , , , , , , , , ) = vault.subMandates(parentId);
        if (issuer == address(0)) return;
        uint256 budget = rawBudget % (pBudget + ONE_FUSD);
        address child = pSub == allocator ? payables : allocator;
        bytes32 cid = keccak256(abi.encodePacked("C", seed, mandateIds.length));
        uint64 n = vault.nonces(pSub);
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 exp = uint64(block.timestamp + 10 days);
        bytes memory d = abi.encodePacked(
            "attenua-v1|SUB_MANDATE|",
            block.chainid,
            address(vault),
            vault.rootEpoch(),
            cid,
            parentId,
            child,
            budget,
            rawMin % 10001,
            rawMax % 10001,
            mask,
            exp,
            n,
            dl
        );
        try vault.registerSubMandate(
            cid, parentId, child, budget, rawMin % 10001, rawMax % 10001, mask, exp, n, dl, _sign(pSub, d)
        ) {
            mandateIds.push(cid);
        } catch {}
    }

    function payInvoice(uint256 payIdxSeed, uint256 resIdxSeed, uint96 rawAmt) external {
        if (mandateIds.length < 2 || vault.frozen()) return;
        bytes32 pId = mandateIds[payIdxSeed % mandateIds.length];
        bytes32 rId = mandateIds[resIdxSeed % mandateIds.length];
        (, , address pAgent, uint256 pBudget, , uint256 pSpent, , , , , , , ) = vault.subMandates(pId);
        if (pBudget <= pSpent) return;
        uint256 amt = bound(uint256(rawAmt), 1, pBudget - pSpent);
        if (amt > fusd.balanceOf(address(vault))) return;
        bytes32 invId = keccak256(abi.encodePacked("INV", ++invoiceSeq));
        uint64 ep = vault.rootEpoch();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 pNonce = vault.nonces(pAgent);

        (, , address rAgent, , , , , , , , , , ) = vault.subMandates(rId);
        bytes memory pSig = _sign(
            pAgent,
            abi.encodePacked("attenua-v1|PAY_INVOICE|", block.chainid, address(vault), ep, pId, vendor, invId, amt, pNonce, dl)
        );
        bytes memory vSig = _sign(
            vendor,
            abi.encodePacked("attenua-v1|VENDOR_INVOICE|", block.chainid, address(vault), vendor, invId, amt, dl)
        );
        bytes memory rSig = _sign(
            rAgent,
            abi.encodePacked("attenua-v1|RESEARCH_CLEAR|", block.chainid, address(vault), ep, rId, vendor, invId, amt, dl)
        );
        try vault.executePayInvoice(pId, rId, vendor, invId, amt, pNonce, dl, dl, dl, pSig, vSig, rSig) {
            totalPaidToVendor += amt;
        } catch {}
    }

    function reclaim(uint256 idxSeed) external {
        if (mandateIds.length == 0) return;
        bytes32 id = mandateIds[idxSeed % mandateIds.length];
        (, address issuer, , , , , , , , , , , ) = vault.subMandates(id);
        if (issuer == address(0)) return;
        uint64 n = vault.nonces(issuer);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory d = abi.encodePacked("attenua-v1|RECLAIM|", block.chainid, address(vault), vault.rootEpoch(), id, n, dl);
        try vault.reclaimSubMandate(id, n, dl, _sign(issuer, d)) {} catch {}
    }

    function toggleFreeze(bool doFreeze) external {
        uint64 dl = uint64(block.timestamp + 3600);
        if (doFreeze && !vault.frozen()) {
            uint64 mn = vault.monitorNonce();
            bytes32 raw = keccak256(abi.encodePacked("attenua-v1|FREEZE|", block.chainid, address(vault), vault.rootEpoch(), mn, dl));
            bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(monitorPriv, ethHash);
            vault.freeze(mn, dl, abi.encodePacked(r, s, v));
        } else if (!doFreeze && vault.frozen()) {
            uint64 n = vault.nonces(owner);
            bytes memory d = abi.encodePacked("attenua-v1|UNFREEZE|", block.chainid, address(vault), vault.rootEpoch(), n, dl);
            vault.unfreeze(n, dl, _sign(owner, d));
        }
    }

    function revokeEpoch() external {
        uint64 n = vault.nonces(owner);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory d = abi.encodePacked("attenua-v1|REVOKE_EPOCH|", block.chainid, address(vault), vault.rootEpoch(), n, dl);
        vault.revokeRootEpoch(n, dl, _sign(owner, d));
    }

    function mandateCount() external view returns (uint256) {
        return mandateIds.length;
    }
}

contract AttenuaVaultInvariantTest is StdInvariant, Test {
    address internal constant PQC_VERIFY_ADDR = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS_ADDR = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant INITIAL_SUPPLY = 50_000_000;

    AttenuaVault internal vault;
    MockFusd internal fusd;
    AttenuaHandler internal handler;

    address internal owner = makeAddr("inv-owner");
    uint256 internal monitorPriv = 0xB0B;
    address internal monitor = vm.addr(monitorPriv);
    address internal orchestrator = makeAddr("inv-orch");
    address internal allocator = makeAddr("inv-alloc");
    address internal payables = makeAddr("inv-pay");
    address internal research = makeAddr("inv-res");
    address internal vendor = makeAddr("inv-vendor");

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.etch(PQC_KEY_STATUS_ADDR, address(new PqcKeyStatusMock()).code);
        vm.etch(PQC_VERIFY_ADDR, address(new PqcVerifyMock()).code);
        PqcKeyStatusMock ks = PqcKeyStatusMock(PQC_KEY_STATUS_ADDR);
        ks.setActive(true);
        PqcVerifyMock(PQC_VERIFY_ADDR).setActive(true);

        address[6] memory actors = [owner, orchestrator, allocator, payables, research, vendor];
        for (uint256 i = 0; i < actors.length; i++) {
            ks.setValidKey(actors[i]);
        }

        fusd = new MockFusd();
        QoreChainHybridHolderGuard guard = new QoreChainHybridHolderGuard(owner);
        QoreChainRwaVault lv = new QoreChainRwaVault(fusd, "Liq", "aL", guard);
        QoreChainRwaVault rv = new QoreChainRwaVault(fusd, "Res", "aR", guard);
        vault = new AttenuaVault(address(fusd), address(lv), address(rv), owner, monitor);

        vm.startPrank(owner);
        guard.setExempt(address(vault), true, "vault");
        guard.renounceOwnership();
        vm.stopPrank();

        fusd.mint(address(vault), INITIAL_SUPPLY);

        handler = new AttenuaHandler(vault, fusd, ks, owner, monitorPriv, orchestrator, allocator, payables, research, vendor);

        // Register vendor & initial root
        bytes memory sig = _signInit(
            ks,
            owner,
            abi.encodePacked("attenua-v1|SET_VENDOR|", block.chainid, address(vault), vault.rootEpoch(), vendor, true, uint64(0), uint64(block.timestamp + 3600))
        );
        vault.setVendor(vendor, true, 0, uint64(block.timestamp + 3600), sig);
        handler.setOrResetRoot(20_000_000, 4000, 7000);

        targetContract(address(handler));
    }

    function _signInit(PqcKeyStatusMock ks, address signer, bytes memory digest) internal view returns (bytes memory sig) {
        (, , bytes memory pubkey, ) = ks.pqcKeyStatus(signer);
        bytes32 tag = keccak256(abi.encodePacked(pubkey, digest));
        sig = new bytes(4627);
        assembly ("memory-safe") {
            mstore(add(sig, 32), tag)
        }
    }

    struct SubInfo {
        bytes32 parentId;
        uint256 budget;
        uint256 allocated;
        uint256 spent;
        uint16 minBps;
        uint16 maxBps;
        uint8 mask;
        uint8 depth;
        uint64 exp;
        uint64 epoch;
    }

    function _readSub(bytes32 id) internal view returns (SubInfo memory s) {
        (
            bytes32 parentId,
            ,
            ,
            uint256 budget,
            uint256 allocated,
            uint256 spent,
            uint16 minBps,
            uint16 maxBps,
            uint8 mask,
            uint8 depth,
            uint64 exp,
            uint64 mEpoch,
        ) = vault.subMandates(id);
        s = SubInfo(parentId, budget, allocated, spent, minBps, maxBps, mask, depth, exp, mEpoch);
    }

    /// @notice I5: Root budget conservation never breached
    function invariant_rootBudgetConservation() public view {
        (, uint256 rBudget, uint256 rAlloc, uint256 rSpent, , , , , , , ) = vault.rootMandate();
        assertLe(rAlloc + rSpent, rBudget);
    }

    /// @notice I4: Every created sub-mandate satisfies strict subset & budget conservation relative to its parent
    function invariant_strictLatticeAttenuation() public view {
        (, uint256 rBudget, , , uint16 rMin, uint16 rMax, uint8 rMask, uint8 maxDepth, uint64 rExp, , ) = vault.rootMandate();
        assertLe(maxDepth, vault.MAX_ANCESTOR_HOPS());
        uint256 ep = vault.rootEpoch();
        uint256 count = handler.mandateCount();
        for (uint256 i = 0; i < count; i++) {
            SubInfo memory s = _readSub(handler.mandateIds(i));
            assertLe(s.allocated + s.spent, s.budget);
            if (s.epoch == ep) {
                assertLe(s.depth, maxDepth);
                if (s.parentId == bytes32(0)) {
                    assertGe(s.minBps, rMin);
                    assertLe(s.maxBps, rMax);
                    assertEq(s.mask & ~rMask, 0);
                    assertLe(s.exp, rExp);
                    assertLe(s.budget, rBudget);
                } else {
                    SubInfo memory p = _readSub(s.parentId);
                    assertGe(s.minBps, p.minBps);
                    assertLe(s.maxBps, p.maxBps);
                    assertEq(s.mask & ~p.mask, 0);
                    assertLe(s.exp, p.exp);
                    assertEq(s.depth, p.depth + 1);
                    assertLe(s.budget, p.budget);
                }
            }
        }
    }

    /// @notice Token conservation: Vault + ERC-4626 sleeves + paid vendor totals always equal initial vault funding
    function invariant_fusdTokenConservation() public view {
        (uint256 idle, uint256 liqA, uint256 resA, ) = vault.portfolioSummary();
        assertEq(idle + liqA + resA + handler.totalPaidToVendor(), INITIAL_SUPPLY);
        assertEq(fusd.balanceOf(vendor), handler.totalPaidToVendor());
    }
}
