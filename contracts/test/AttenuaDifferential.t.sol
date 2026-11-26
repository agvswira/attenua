// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AttenuaVault} from "../src/AttenuaVault.sol";
import {QoreChainHybridHolderGuard} from "../vendor/asset-kit/guard/QoreChainHybridHolderGuard.sol";
import {QoreChainRwaVault} from "../vendor/asset-kit/vaults/QoreChainRwaVault.sol";
import {MockFusd} from "./mocks/MockFusd.sol";
import {PqcKeyStatusMock, PqcVerifyMock} from "./mocks/PqcPrecompileMock.sol";

/// @notice Two-Model Differential Test: replays 120 randomized state-transition vectors
///         produced by the independent TypeScript reference LatticeModel (`agent/test/differential.test.ts`)
///         through live Solidity `AttenuaVault`, asserting 0 divergences on accept/revert outcomes
///         and exact post-state (`rootAllocated`).
contract AttenuaDifferentialTest is Test {
    using stdJson for string;

    address internal constant PQC_VERIFY_ADDR = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS_ADDR = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant ONE_FUSD = 1_000_000;

    PqcKeyStatusMock internal keyStatus;
    AttenuaVault internal vault;
    address internal owner = makeAddr("diff-owner");
    address internal orch = makeAddr("diff-orch");
    address internal agentA = makeAddr("diff-a");
    address internal agentB = makeAddr("diff-b");
    address internal monitor = makeAddr("diff-mon");

    function setUp() public {
        vm.warp(1_000_000);
        vm.etch(PQC_KEY_STATUS_ADDR, address(new PqcKeyStatusMock()).code);
        vm.etch(PQC_VERIFY_ADDR, address(new PqcVerifyMock()).code);
        keyStatus = PqcKeyStatusMock(PQC_KEY_STATUS_ADDR);
        keyStatus.setActive(true);
        PqcVerifyMock(PQC_VERIFY_ADDR).setActive(true);
        keyStatus.setValidKey(owner);
        keyStatus.setValidKey(orch);
        keyStatus.setValidKey(agentA);
        keyStatus.setValidKey(agentB);

        MockFusd fusd = new MockFusd();
        QoreChainHybridHolderGuard guard = new QoreChainHybridHolderGuard(owner);
        QoreChainRwaVault lv = new QoreChainRwaVault(fusd, "L", "aL", guard);
        QoreChainRwaVault rv = new QoreChainRwaVault(fusd, "R", "aR", guard);
        vault = new AttenuaVault(address(fusd), address(lv), address(rv), owner, monitor);

        uint64 dl = uint64(block.timestamp + 10_000);
        bytes memory d = abi.encodePacked(
            "attenua-v1|SET_ROOT|",
            block.chainid,
            address(vault),
            uint64(1),
            orch,
            uint256(20 * ONE_FUSD),
            uint16(4000),
            uint16(7000),
            uint8(3),
            uint8(2),
            uint64(2_000_000),
            uint64(0),
            dl
        );
        vault.setRootMandate(orch, 20 * ONE_FUSD, 4000, 7000, 3, 2, uint64(2_000_000), 0, dl, _sign(owner, d));
    }

    function _sign(address signer, bytes memory digest) internal view returns (bytes memory sig) {
        (, , bytes memory pk, ) = keyStatus.pqcKeyStatus(signer);
        bytes32 tag = keccak256(abi.encodePacked(pk, digest));
        sig = new bytes(4627);
        assembly ("memory-safe") {
            mstore(add(sig, 32), tag)
        }
    }

    function _actorAddr(string memory tag) internal view returns (address) {
        bytes32 h = keccak256(bytes(tag));
        if (h == keccak256("orch")) return orch;
        if (h == keccak256("agentA")) return agentA;
        return agentB;
    }

    function test_differential120StepsMatchReferenceLatticeModel() public {
        string memory json = vm.readFile("test/fixtures/diff-vectors.json");
        uint256 count = json.readUint(".count");
        assertEq(count, 120);

        uint64 dl = uint64(block.timestamp + 10_000);
        for (uint256 i = 0; i < count; i++) {
            string memory base = string.concat(".steps[", vm.toString(i), "]");
            string memory op = json.readString(string.concat(base, ".op"));
            bool expectedOk = json.readBool(string.concat(base, ".expectedOk"));
            uint256 expectedRootAlloc = json.readUint(string.concat(base, ".expectedRootAllocated"));

            bool actualOk;
            if (keccak256(bytes(op)) == keccak256("register")) {
                bytes32 id = json.readBytes32(string.concat(base, ".id"));
                bytes32 parentId = json.readBytes32(string.concat(base, ".parentId"));
                address issuer = _actorAddr(json.readString(string.concat(base, ".issuer")));
                address subAgent = _actorAddr(json.readString(string.concat(base, ".subAgent")));
                uint256 budget = json.readUint(string.concat(base, ".budget"));
                uint16 minBps = uint16(json.readUint(string.concat(base, ".minBps")));
                uint16 maxBps = uint16(json.readUint(string.concat(base, ".maxBps")));
                uint8 mask = uint8(json.readUint(string.concat(base, ".mask")));
                uint64 exp = uint64(json.readUint(string.concat(base, ".expiry")));
                uint64 nonce = vault.nonces(issuer);

                bytes memory sig = _sign(
                    issuer,
                    abi.encodePacked(
                        "attenua-v1|SUB_MANDATE|",
                        block.chainid,
                        address(vault),
                        vault.rootEpoch(),
                        id,
                        parentId,
                        subAgent,
                        budget,
                        minBps,
                        maxBps,
                        mask,
                        exp,
                        nonce,
                        dl
                    )
                );
                try vault.registerSubMandate(id, parentId, subAgent, budget, minBps, maxBps, mask, exp, nonce, dl, sig) {
                    actualOk = true;
                } catch {
                    actualOk = false;
                }
            } else {
                bytes32 id = json.readBytes32(string.concat(base, ".id"));
                address issuer = _actorAddr(json.readString(string.concat(base, ".issuer")));
                uint64 nonce = vault.nonces(issuer);
                bytes memory sig = _sign(
                    issuer,
                    abi.encodePacked("attenua-v1|RECLAIM|", block.chainid, address(vault), vault.rootEpoch(), id, nonce, dl)
                );
                try vault.reclaimSubMandate(id, nonce, dl, sig) {
                    actualOk = true;
                } catch {
                    actualOk = false;
                }
            }

            assertEq(actualOk, expectedOk, string.concat("differential outcome mismatch at step ", vm.toString(i)));
            (, , uint256 actualRootAlloc, , , , , , , , ) = vault.rootMandate();
            assertEq(actualRootAlloc, expectedRootAlloc, string.concat("rootAllocated mismatch at step ", vm.toString(i)));
        }
    }
}
