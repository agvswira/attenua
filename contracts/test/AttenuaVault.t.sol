// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AttenuaVault} from "../src/AttenuaVault.sol";
import {PqcVerifier} from "../src/PqcVerifier.sol";
import {QoreChainHybridHolderGuard} from "../vendor/asset-kit/guard/QoreChainHybridHolderGuard.sol";
import {QoreChainRwaVault} from "../vendor/asset-kit/vaults/QoreChainRwaVault.sol";
import {MockFusd} from "./mocks/MockFusd.sol";
import {PqcKeyStatusMock, PqcVerifyMock} from "./mocks/PqcPrecompileMock.sol";

/// @notice Focused 48-test unit & regression suite for AttenuaVault v1.1 + PqcVerifier + asset-kit integration.
///         NOTE: QoreChain precompiles 0x0a01 / 0x0a02 are mocked via vm.etch; real ML-DSA-87 verification
///         is proven live on qorechain-diana (`deployments/live-run-evidence.json` & `deployments/standing-tree.json`).
contract AttenuaVaultTest is Test {
    address internal constant PQC_VERIFY_ADDR = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS_ADDR = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant ONE_FUSD = 1_000_000;

    PqcKeyStatusMock internal keyStatusMock;
    PqcVerifyMock internal verifyMock;
    MockFusd internal fusd;
    QoreChainHybridHolderGuard internal guard;
    QoreChainRwaVault internal liqVault;
    QoreChainRwaVault internal resVault;
    AttenuaVault internal vault;

    address internal owner = makeAddr("owner");
    uint256 internal monitorPriv = 0xA11CE;
    address internal monitor = vm.addr(monitorPriv);
    address internal orchestrator = makeAddr("orchestrator");
    address internal allocator = makeAddr("allocator");
    address internal payables = makeAddr("payables");
    address internal research = makeAddr("research");
    address internal vendor = makeAddr("vendor");
    address internal stranger = makeAddr("stranger");

    bytes32 internal allocId = keccak256("ALLOC");
    bytes32 internal payId = keccak256("PAY");
    bytes32 internal researchId = keccak256("RESEARCH");

    function setUp() public {
        vm.warp(1_760_000_000);

        vm.etch(PQC_KEY_STATUS_ADDR, address(new PqcKeyStatusMock()).code);
        vm.etch(PQC_VERIFY_ADDR, address(new PqcVerifyMock()).code);
        keyStatusMock = PqcKeyStatusMock(PQC_KEY_STATUS_ADDR);
        verifyMock = PqcVerifyMock(PQC_VERIFY_ADDR);

        keyStatusMock.setActive(true);
        verifyMock.setActive(true);

        address[6] memory actors = [owner, orchestrator, allocator, payables, research, vendor];
        for (uint256 i = 0; i < actors.length; i++) {
            keyStatusMock.setValidKey(actors[i]);
        }

        fusd = new MockFusd();
        guard = new QoreChainHybridHolderGuard(owner);
        liqVault = new QoreChainRwaVault(fusd, "Liquidity fUSD", "aLiq", guard);
        resVault = new QoreChainRwaVault(fusd, "Reserve fUSD", "aRes", guard);
        vault = new AttenuaVault(address(fusd), address(liqVault), address(resVault), owner, monitor);

        vm.startPrank(owner);
        guard.setExempt(address(vault), true, "AttenuaVault settlement");
        guard.renounceOwnership();
        vm.stopPrank();

        fusd.mint(address(vault), 20 * ONE_FUSD);
    }

    // -------------------------------------------------------------------------
    // Signing & Setup Helpers
    // -------------------------------------------------------------------------

    function _mockPqcSign(address signer, bytes memory digest) internal view returns (bytes memory sig) {
        (, , bytes memory pubkey, ) = keyStatusMock.pqcKeyStatus(signer);
        bytes32 tag = keccak256(abi.encodePacked(pubkey, digest));
        sig = new bytes(4627);
        assembly ("memory-safe") {
            mstore(add(sig, 32), tag)
        }
    }

    function _signMonitorFreeze(uint64 epoch, uint64 nonce, uint64 deadline) internal view returns (bytes memory) {
        bytes32 raw =
            keccak256(abi.encodePacked("attenua-v1|FREEZE|", block.chainid, address(vault), epoch, nonce, deadline));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(monitorPriv, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _installRoot(uint64 expiry) internal {
        uint64 ep = vault.rootEpoch();
        uint64 n = vault.nonces(owner);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory d = abi.encodePacked(
            "attenua-v1|SET_ROOT|",
            block.chainid,
            address(vault),
            ep,
            orchestrator,
            uint256(20 * ONE_FUSD),
            uint16(4000),
            uint16(7000),
            uint8(3),
            uint8(2),
            expiry,
            n,
            dl
        );
        vault.setRootMandate(orchestrator, 20 * ONE_FUSD, 4000, 7000, 3, 2, expiry, n, dl, _mockPqcSign(owner, d));
    }

    function _registerVendor(address v, bool allowed) internal {
        uint64 ep = vault.rootEpoch();
        uint64 n = vault.nonces(owner);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory d = abi.encodePacked("attenua-v1|SET_VENDOR|", block.chainid, address(vault), ep, v, allowed, n, dl);
        vault.setVendor(v, allowed, n, dl, _mockPqcSign(owner, d));
    }

    function _delegate(
        bytes32 id,
        bytes32 parentId,
        address issuer,
        address subAgent,
        uint256 budget,
        uint16 minBps,
        uint16 maxBps,
        uint8 mask,
        uint64 expiry
    ) internal {
        uint64 ep = vault.rootEpoch();
        uint64 n = vault.nonces(issuer);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory d = abi.encodePacked(
            "attenua-v1|SUB_MANDATE|",
            block.chainid,
            address(vault),
            ep,
            id,
            parentId,
            subAgent,
            budget,
            minBps,
            maxBps,
            mask,
            expiry,
            n,
            dl
        );
        vault.registerSubMandate(
            id, parentId, subAgent, budget, minBps, maxBps, mask, expiry, n, dl, _mockPqcSign(issuer, d)
        );
    }

    function _setupStandingSwarm() internal {
        uint64 expiry = uint64(block.timestamp + 30 days);
        _installRoot(expiry);
        _registerVendor(vendor, true);
        _delegate(allocId, bytes32(0), orchestrator, allocator, 6 * ONE_FUSD, 4500, 6500, 1, expiry - 1 days);
        _delegate(payId, bytes32(0), orchestrator, payables, 2 * ONE_FUSD, 4000, 7000, 2, expiry - 1 days);
        _delegate(researchId, bytes32(0), orchestrator, research, 0, 4000, 7000, 0, expiry - 1 days);
    }

    // -------------------------------------------------------------------------
    // 1. Constructor & HolderGuard (1-9)
    // -------------------------------------------------------------------------

    function test_01_constructorZeroFusd() public {
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        new AttenuaVault(address(0), address(liqVault), address(resVault), owner, monitor);
    }

    function test_02_constructorZeroLiquidityVault() public {
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        new AttenuaVault(address(fusd), address(0), address(resVault), owner, monitor);
    }

    function test_03_constructorZeroReserveVault() public {
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        new AttenuaVault(address(fusd), address(liqVault), address(0), owner, monitor);
    }

    function test_04_constructorZeroOwnerOrMonitor() public {
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        new AttenuaVault(address(fusd), address(liqVault), address(resVault), address(0), monitor);

        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        new AttenuaVault(address(fusd), address(liqVault), address(resVault), owner, address(0));
    }

    function test_05_constructorSameOwnerAndMonitorReverts() public {
        vm.expectRevert(AttenuaVault.InvalidRoles.selector);
        new AttenuaVault(address(fusd), address(liqVault), address(resVault), owner, owner);
    }

    function test_06_constructorDuplicateVaultsReverts() public {
        vm.expectRevert(AttenuaVault.DuplicateVaults.selector);
        new AttenuaVault(address(fusd), address(liqVault), address(liqVault), owner, monitor);
    }

    function test_07_constructorInvalidVaultAssetReverts() public {
        MockFusd other = new MockFusd();
        QoreChainRwaVault badVault = new QoreChainRwaVault(other, "Bad", "BAD", guard);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.InvalidVaultAsset.selector, address(badVault)));
        new AttenuaVault(address(fusd), address(badVault), address(resVault), owner, monitor);
    }

    function test_08_holderGuardRenouncedAndEligible() public view {
        assertEq(guard.owner(), address(0));
        assertTrue(guard.exempt(address(vault)));
        assertTrue(guard.isEligible(address(vault)));
        assertTrue(guard.isEligible(vendor));
        assertFalse(guard.isEligible(stranger));
    }

    function test_09_rwaVaultRejectsIneligibleReceiver() public {
        MockFusd t = new MockFusd();
        t.mint(stranger, ONE_FUSD);
        vm.startPrank(stranger);
        t.approve(address(liqVault), ONE_FUSD);
        assertEq(liqVault.maxDeposit(stranger), 0);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // 2. PqcVerifier Precompiles & Zero msg.sender Trust (10-18)
    // -------------------------------------------------------------------------

    function test_10_zeroMsgSenderTrustStrangerCanRelayValidPqc() public {
        vm.prank(stranger);
        _installRoot(uint64(block.timestamp + 7 days));
        (address orch, , , , , , , , , , bool active) = vault.rootMandate();
        assertEq(orch, orchestrator);
        assertTrue(active);
    }

    function test_11_revertPrecompileInactiveKeyStatus() public {
        keyStatusMock.setActive(false);
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory sig = new bytes(4627);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PrecompileInactive.selector, PQC_KEY_STATUS_ADDR));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, sig);
    }

    function test_12_revertPrecompileInactiveVerify() public {
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory sig = new bytes(4627);
        verifyMock.setActive(false);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PrecompileInactive.selector, PQC_VERIFY_ADDR));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, sig);
    }

    function test_13_revertPqcSigLengthInvalid() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcSigLengthInvalid.selector, 2));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, hex"1234");
    }

    function test_14_revertPqcSignatureInvalid() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcSignatureInvalid.selector, owner));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    function test_15_revertPqcKeyNotRegisteredOnDelegate() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        _installRoot(expiry);
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcKeyNotRegistered.selector, stranger));
        vault.registerSubMandate(allocId, bytes32(0), stranger, ONE_FUSD, 4500, 6500, 1, expiry, 0, dl, new bytes(4627));
    }

    function test_16_revertPqcKeyUnsupportedAlgorithm() public {
        keyStatusMock.setKey(owner, true, 2, new bytes(2592), true);
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcKeyUnsupportedAlgorithm.selector, owner, 2));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    function test_17_revertPqcKeyNotProven() public {
        keyStatusMock.setKey(owner, true, 1, new bytes(2592), false);
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcKeyNotProven.selector, owner));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    function test_18_revertPqcKeyLengthInvalid() public {
        keyStatusMock.setKey(owner, true, 1, new bytes(100), true);
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(PqcVerifier.PqcKeyLengthInvalid.selector, 100));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    // -------------------------------------------------------------------------
    // 3. Root Mandate, Admin & Nonce/Deadline Guards (19-26)
    // -------------------------------------------------------------------------

    function test_19_revertRootZeroOrchestrator() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        vault.setRootMandate(address(0), ONE_FUSD, 4000, 7000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    function test_20_revertRootInvalidBand() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.InvalidBand.selector, 7000, 4000));
        vault.setRootMandate(orchestrator, ONE_FUSD, 7000, 4000, 3, 2, dl, 0, dl, new bytes(4627));
    }

    function test_21_revertRootMandateExpired() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.MandateExpired.selector, block.timestamp, block.timestamp));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, uint64(block.timestamp), 0, dl, new bytes(4627));
    }

    function test_22_revertRootMaxDepthZero() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationDepthExceeded.selector, 1, 0));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 0, dl, 0, dl, new bytes(4627));
    }

    function test_23_revertSignatureExpired() public {
        uint64 dl = uint64(block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.SignatureExpired.selector, dl, block.timestamp));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, uint64(block.timestamp + 10), 0, dl, new bytes(4627));
    }

    function test_24_revertBadNonce() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.BadNonce.selector, owner, 0, 5));
        vault.setRootMandate(orchestrator, ONE_FUSD, 4000, 7000, 3, 2, dl, 5, dl, new bytes(4627));
    }

    function test_25_replacingActiveRootAdvancesEpoch() public {
        uint64 dl = uint64(block.timestamp + 3600);
        _installRoot(dl);
        assertEq(vault.rootEpoch(), 1);
        _installRoot(dl + 100);
        assertEq(vault.rootEpoch(), 2);
    }

    function test_26_revertSetVendorZeroAddress() public {
        vm.expectRevert(AttenuaVault.ZeroAddress.selector);
        vault.setVendor(address(0), true, 0, uint64(block.timestamp + 10), new bytes(4627));
    }

    // -------------------------------------------------------------------------
    // 4. Hierarchical Lattice Attenuation & Transitivity (27-37)
    // -------------------------------------------------------------------------

    function test_27_revertRootMandateInactive() public {
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(AttenuaVault.RootMandateInactive.selector);
        vault.registerSubMandate(allocId, bytes32(0), allocator, ONE_FUSD, 4500, 6500, 1, dl, 0, dl, new bytes(4627));
    }

    function test_28_revertInvalidMandateIdZero() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _installRoot(exp);
        vm.expectRevert(AttenuaVault.InvalidMandateId.selector);
        vault.registerSubMandate(bytes32(0), bytes32(0), allocator, ONE_FUSD, 4500, 6500, 1, exp, 0, exp, new bytes(4627));
    }

    function test_29_revertAttenuationBudgetExceeded() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _installRoot(exp);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationBudgetExceeded.selector, 21 * ONE_FUSD, 20 * ONE_FUSD));
        vault.registerSubMandate(allocId, bytes32(0), allocator, 21 * ONE_FUSD, 4500, 6500, 1, exp, 0, exp, new bytes(4627));
    }

    function test_30_revertAttenuationBandWidenedRoot() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _installRoot(exp);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationBandWidened.selector, 3000, 8000, 4000, 7000));
        vault.registerSubMandate(allocId, bytes32(0), allocator, ONE_FUSD, 3000, 8000, 1, exp, 0, exp, new bytes(4627));
    }

    function test_31_revertAttenuationMaskWidened() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _installRoot(exp);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationMaskWidened.selector, 7, 3));
        vault.registerSubMandate(allocId, bytes32(0), allocator, ONE_FUSD, 4500, 6500, 7, exp, 0, exp, new bytes(4627));
    }

    function test_32_revertAttenuationExpiryWidened() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _installRoot(exp);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationExpiryWidened.selector, exp + 1, exp));
        vault.registerSubMandate(allocId, bytes32(0), allocator, ONE_FUSD, 4500, 6500, 1, exp + 1, 0, exp, new bytes(4627));
    }

    function test_33_revertMandateAlreadyExists() public {
        _setupStandingSwarm();
        uint64 oN = vault.nonces(orchestrator);
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.MandateAlreadyExists.selector, allocId));
        vault.registerSubMandate(allocId, bytes32(0), allocator, ONE_FUSD, 4500, 6500, 1, exp, oN, exp, new bytes(4627));
    }

    function test_34_revertMandateNotFoundParent() public {
        _setupStandingSwarm();
        bytes32 missing = keccak256("MISSING");
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.MandateNotFound.selector, missing));
        vault.registerSubMandate(keccak256("CHILD"), missing, payables, ONE_FUSD, 4500, 6500, 1, exp, 0, exp, new bytes(4627));
    }

    function test_35_depth2TransitivityEnforcesParentBandNotRootBand() public {
        _setupStandingSwarm();
        uint64 exp = uint64(block.timestamp + 10 days);
        uint64 aN = vault.nonces(allocator);
        // [41%, 69%] is inside Root [40%, 70%] but violates Allocator [45%, 65%]!
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationBandWidened.selector, 4100, 6900, 4500, 6500));
        vault.registerSubMandate(keccak256("LEAF"), allocId, payables, 2 * ONE_FUSD, 4100, 6900, 1, exp, aN, exp, new bytes(4627));
    }

    function test_36_revertAttenuationDepthExceededAtDepth3() public {
        _setupStandingSwarm();
        uint64 exp = uint64(block.timestamp + 10 days);
        bytes32 leafId = keccak256("LEAF");
        _delegate(leafId, allocId, allocator, payables, 2 * ONE_FUSD, 4800, 6200, 1, exp);

        uint64 pN = vault.nonces(payables);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.AttenuationDepthExceeded.selector, 3, 2));
        vault.registerSubMandate(keccak256("D3"), leafId, research, ONE_FUSD, 5000, 6000, 1, exp - 1, pN, exp, new bytes(4627));
    }

    function test_37_auditH01_revertSelfDelegationAndNestedResearchSpoof() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 exp = uint64(block.timestamp + 5 days);
        uint64 pN = vault.nonces(payables);

        vm.expectRevert(AttenuaVault.SelfDelegationNotAllowed.selector);
        vault.registerSubMandate(keccak256("FORGED_RES"), payId, payables, 0, 4500, 6500, 0, exp, pN, dl, new bytes(4627));

        // Delegate a nested zero-budget mandate to stranger (has proven key) -> still rejected by executePayInvoice (parentId != 0)
        keyStatusMock.setValidKey(stranger);
        bytes32 nestedResId = keccak256("NESTED_RES");
        _delegate(nestedResId, payId, payables, stranger, 0, 4000, 7000, 0, exp);

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.InvalidResearchMandate.selector, nestedResId));
        vault.executePayInvoice(
            payId,
            nestedResId,
            vendor,
            keccak256("INV-NESTED"),
            ONE_FUSD,
            pN,
            dl,
            new bytes(4627),
            new bytes(4627),
            new bytes(4627)
        );
    }

    // -------------------------------------------------------------------------
    // 5. Reclaim, Audit H-02 / M-03 / H-03 / L-04 & Emergency (38-45)
    // -------------------------------------------------------------------------

    function test_38_auditH02_blocksPrematureReclaimAndForceReclaimDescendant() public {
        _setupStandingSwarm();
        uint64 exp = uint64(block.timestamp + 10 days);
        bytes32 leafId = keccak256("LEAF");
        _delegate(leafId, allocId, allocator, payables, 2 * ONE_FUSD, 4800, 6200, 1, exp);

        uint64 oN = vault.nonces(orchestrator);
        uint64 dl = uint64(block.timestamp + 3600);

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.ActiveChildrenExist.selector, allocId));
        vault.reclaimSubMandate(allocId, oN, dl, new bytes(4627));

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.ActiveChildrenExist.selector, allocId));
        vault.forceReclaimDescendant(allocId, oN, dl, new bytes(4627));

        bytes memory fSig = _mockPqcSign(
            orchestrator,
            abi.encodePacked("attenua-v1|FORCE_RECLAIM|", block.chainid, address(vault), vault.rootEpoch(), leafId, oN, dl)
        );
        vault.forceReclaimDescendant(leafId, oN, dl, fSig);

        uint64 oN2 = vault.nonces(orchestrator);
        bytes memory rSig = _mockPqcSign(
            orchestrator,
            abi.encodePacked("attenua-v1|RECLAIM|", block.chainid, address(vault), vault.rootEpoch(), allocId, oN2, dl)
        );
        vault.reclaimSubMandate(allocId, oN2, dl, rSig);

        (, , uint256 rootAllocated, , , , , , , , ) = vault.rootMandate();
        assertEq(rootAllocated, 2 * ONE_FUSD);

        uint64 oN3 = vault.nonces(orchestrator);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.MandateClosed.selector, allocId));
        vault.reclaimSubMandate(allocId, oN3, dl, rSig);
    }

    function test_39_auditL04_separationOfDutiesEnforced() public {
        _setupStandingSwarm();
        uint64 exp = uint64(block.timestamp + 10 days);
        bytes32 payResSame = keccak256("RES_ON_PAY");
        _delegate(payResSame, bytes32(0), orchestrator, payables, 0, 4000, 7000, 0, exp);

        uint64 pN = vault.nonces(payables);
        uint64 dl = uint64(block.timestamp + 3600);
        vm.expectRevert(AttenuaVault.SeparationOfDutiesViolated.selector);
        vault.executePayInvoice(
            payId, payResSame, vendor, keccak256("INV-SOD"), ONE_FUSD, pN, dl, new bytes(4627), new bytes(4627), new bytes(4627)
        );
    }

    function test_40_auditH03_freezeMonitorDisableAndEmergencyRedeem() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 ep = vault.rootEpoch();

        uint64 aN = vault.nonces(allocator);
        bytes memory allocSig = _mockPqcSign(
            allocator,
            abi.encodePacked(
                "attenua-v1|ALLOCATE|",
                block.chainid,
                address(vault),
                ep,
                allocId,
                uint256(3 * ONE_FUSD),
                true,
                uint256(3 * ONE_FUSD),
                true,
                aN,
                dl
            )
        );
        vault.executeAllocate(allocId, 3 * ONE_FUSD, true, 3 * ONE_FUSD, true, aN, dl, allocSig);

        vault.freeze(0, dl, _signMonitorFreeze(ep, 0, dl));
        assertTrue(vault.frozen());

        uint64 aN2 = vault.nonces(allocator);
        vm.expectRevert(AttenuaVault.VaultIsFrozen.selector);
        vault.executeAllocate(allocId, ONE_FUSD, true, 0, false, aN2, dl, new bytes(4627));

        uint64 oN = vault.nonces(owner);
        bytes memory setMonSig = _mockPqcSign(
            owner, abi.encodePacked("attenua-v1|SET_MONITOR|", block.chainid, address(vault), ep, address(0), oN, dl)
        );
        vault.setMonitorSigner(address(0), oN, dl, setMonSig);

        vm.expectRevert(AttenuaVault.MonitorDisabled.selector);
        vault.freeze(1, dl, new bytes(65));

        address safe = makeAddr("treasurySafe");
        uint64 rN = vault.nonces(owner);
        bytes memory redSig = _mockPqcSign(
            owner, abi.encodePacked("attenua-v1|EMERGENCY_REDEEM|", block.chainid, address(vault), ep, safe, rN, dl)
        );
        vault.emergencyRedeemVaults(safe, rN, dl, redSig);
        assertEq(fusd.balanceOf(safe), 6 * ONE_FUSD);

        uint64 uN = vault.nonces(owner);
        bytes memory unfSig =
            _mockPqcSign(owner, abi.encodePacked("attenua-v1|UNFREEZE|", block.chainid, address(vault), ep, uN, dl));
        vault.unfreeze(uN, dl, unfSig);
        assertFalse(vault.frozen());
    }

    function test_41_revertInvalidMonitorSignature() public {
        uint64 dl = uint64(block.timestamp + 3600);
        bytes memory badFreeze = _signMonitorFreeze(999, 0, dl);
        vm.expectRevert(AttenuaVault.InvalidMonitorSignature.selector);
        vault.freeze(0, dl, badFreeze);
    }

    function test_42_revokeRootEpochCascadesInO1() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 oN = vault.nonces(owner);
        uint64 ep = vault.rootEpoch();
        bytes memory revSig = _mockPqcSign(
            owner, abi.encodePacked("attenua-v1|REVOKE_EPOCH|", block.chainid, address(vault), ep, oN, dl)
        );
        vault.revokeRootEpoch(oN, dl, revSig);
        assertEq(vault.rootEpoch(), 2);

        uint64 aN = vault.nonces(allocator);
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.EpochMismatch.selector, 2, 1));
        vault.executeAllocate(allocId, ONE_FUSD, true, 0, false, aN, dl, new bytes(4627));
    }

    function test_43_emergencyWithdrawRequiresOwnerPqcAndTransfersFusd() public {
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 oN = vault.nonces(owner);
        uint64 ep = vault.rootEpoch();
        bytes memory wSig = _mockPqcSign(
            owner,
            abi.encodePacked(
                "attenua-v1|EMERGENCY_WITHDRAW|", block.chainid, address(vault), ep, owner, uint256(5 * ONE_FUSD), oN, dl
            )
        );
        vault.emergencyWithdraw(owner, 5 * ONE_FUSD, oN, dl, wSig);
        assertEq(fusd.balanceOf(owner), 5 * ONE_FUSD);
    }

    // -------------------------------------------------------------------------
    // 6. Allocator & Payables Execution Guards (44-48)
    // -------------------------------------------------------------------------

    function test_44_executeAllocateGuardsZeroAmountActionMaskZeroBudgetOverCap() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);

        vm.expectRevert(AttenuaVault.InvalidAmount.selector);
        vault.executeAllocate(allocId, 0, true, 0, true, 0, dl, new bytes(4627));

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.ActionNotPermitted.selector, 1, 0));
        vault.executeAllocate(researchId, ONE_FUSD, true, 0, false, 0, dl, new bytes(4627));

        keyStatusMock.setValidKey(stranger);
        bytes32 zeroAlloc = keccak256("ZERO_ALLOC");
        _delegate(zeroAlloc, bytes32(0), orchestrator, stranger, 0, 4500, 6500, 1, uint64(block.timestamp + 5 days));
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.ZeroBudgetCapability.selector, zeroAlloc));
        vault.executeAllocate(zeroAlloc, ONE_FUSD, true, 0, false, 0, dl, new bytes(4627));

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.SubMandateBudgetExceeded.selector, 7 * ONE_FUSD, 6 * ONE_FUSD));
        vault.executeAllocate(allocId, 7 * ONE_FUSD, true, 0, false, 0, dl, new bytes(4627));
    }

    function test_45_executeAllocatePortfolioBandViolatedReverts() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 aN = vault.nonces(allocator);
        uint64 ep = vault.rootEpoch();
        bytes memory badBandSig = _mockPqcSign(
            allocator,
            abi.encodePacked(
                "attenua-v1|ALLOCATE|",
                block.chainid,
                address(vault),
                ep,
                allocId,
                uint256(2 * ONE_FUSD),
                true,
                uint256(0),
                false,
                aN,
                dl
            )
        );
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.PortfolioBandViolated.selector, 10000, 4500, 6500));
        vault.executeAllocate(allocId, 2 * ONE_FUSD, true, 0, false, aN, dl, badBandSig);
    }

    function test_46_executeAllocateBalancedRebalanceInsideBandSucceeds() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        uint64 aN = vault.nonces(allocator);
        uint64 ep = vault.rootEpoch();
        bytes memory sig = _mockPqcSign(
            allocator,
            abi.encodePacked(
                "attenua-v1|ALLOCATE|",
                block.chainid,
                address(vault),
                ep,
                allocId,
                uint256(3 * ONE_FUSD),
                true,
                uint256(3 * ONE_FUSD),
                true,
                aN,
                dl
            )
        );
        vault.executeAllocate(allocId, 3 * ONE_FUSD, true, 3 * ONE_FUSD, true, aN, dl, sig);
        (, uint256 liqA, uint256 resA, uint256 bps) = vault.portfolioSummary();
        assertEq(liqA, 3 * ONE_FUSD);
        assertEq(resA, 3 * ONE_FUSD);
        assertEq(bps, 5000);
    }

    function test_47_executePayInvoiceUnlistedVendorAndZeroAmountRevert() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        bytes32 invId = keccak256("INV-001");

        vm.expectRevert(AttenuaVault.InvalidAmount.selector);
        vault.executePayInvoice(payId, researchId, vendor, invId, 0, 0, dl, new bytes(4627), new bytes(4627), new bytes(4627));

        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.VendorNotRegistered.selector, stranger));
        vault.executePayInvoice(
            payId, researchId, stranger, invId, ONE_FUSD, 0, dl, new bytes(4627), new bytes(4627), new bytes(4627)
        );
    }

    function test_48_executePayInvoiceThreeSigsAndReplayPrevention() public {
        _setupStandingSwarm();
        uint64 dl = uint64(block.timestamp + 3600);
        bytes32 invId = keccak256("INV-001");
        uint256 amt = 800_000;
        uint64 ep = vault.rootEpoch();
        uint64 pN = vault.nonces(payables);

        bytes memory pSig = _mockPqcSign(
            payables, abi.encodePacked("attenua-v1|PAY_INVOICE|", block.chainid, address(vault), ep, payId, vendor, invId, amt, pN, dl)
        );
        bytes memory vSig = _mockPqcSign(
            vendor, abi.encodePacked("attenua-v1|VENDOR_INVOICE|", block.chainid, address(vault), vendor, invId, amt)
        );
        bytes memory rSig = _mockPqcSign(
            research, abi.encodePacked("attenua-v1|RESEARCH_CLEAR|", block.chainid, address(vault), ep, researchId, vendor, invId, amt)
        );

        vault.executePayInvoice(payId, researchId, vendor, invId, amt, pN, dl, pSig, vSig, rSig);
        assertEq(fusd.balanceOf(vendor), amt);

        uint64 pN2 = vault.nonces(payables);
        bytes32 invKey = keccak256(abi.encodePacked(vendor, invId));
        vm.expectRevert(abi.encodeWithSelector(AttenuaVault.InvoiceAlreadyPaid.selector, invKey));
        vault.executePayInvoice(payId, researchId, vendor, invId, amt, pN2, dl, pSig, vSig, rSig);
    }
}
