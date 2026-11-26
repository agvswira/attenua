// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title PqcPrecompileMock
/// @notice Test-only mock for QoreChain's ML-DSA-87 precompiles (`0x...0a01` and `0x...0a02`),
///         installed at the canonical precompile addresses via Foundry `vm.etch`.
///
///         IMPORTANT DISCLOSURE:
///         Forge EVM runs in an isolated local VM without QoreChain's Go precompiles.
///         Therefore, `forge test` mocks `0x0a01` (pqcVerify) and `0x0a02` (pqcKeyStatus) here
///         to exhaustively verify every AttenuaVault state transition, lattice invariant, and
///         fail-closed precompile error branch. Genuine FIPS 204 ML-DSA-87 cryptographic
///         verification against real 2,592-byte public keys and 4,627-byte signatures is
///         proven live on `qorechain-diana` (`deployments/live-run-evidence.json`,
///         `deployments/standing-tree.json`, `npm run verify`, and `npm run lab -- ALL`).
contract PqcKeyStatusMock {
    struct KeyEntry {
        bool registered;
        uint8 algorithmId;
        uint16 pubkeyLen;
        bytes32 pubkeyTag;
        bool possessionProven;
    }

    bool public active = true;
    mapping(address => KeyEntry) internal keys;

    function setActive(bool active_) external {
        active = active_;
    }

    function setKey(address account, bool registered, uint8 algorithmId, bytes calldata pubkey, bool possessionProven)
        external
    {
        bytes32 tag = keccak256(pubkey);
        keys[account] = KeyEntry({
            registered: registered,
            algorithmId: algorithmId,
            pubkeyLen: uint16(pubkey.length),
            pubkeyTag: tag,
            possessionProven: possessionProven
        });
    }

    function setValidKey(address account) external {
        keys[account] = KeyEntry({
            registered: true,
            algorithmId: 1,
            pubkeyLen: 2592,
            pubkeyTag: keccak256(abi.encodePacked("attenua-mock-pk|", account)),
            possessionProven: true
        });
    }

    /// @dev Synthesizes `pubkeyLen` bytes in memory (2 storage reads total) so it stays
    ///      strictly inside QoreChainHybridHolderGuard's 50,000-gas staticcall budget.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory publicKey, bool possessionProven)
    {
        if (!active) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        KeyEntry storage k = keys[account];
        publicKey = new bytes(k.pubkeyLen);
        if (k.pubkeyLen >= 32) {
            bytes32 tag = k.pubkeyTag;
            assembly ("memory-safe") {
                mstore(add(publicKey, 32), tag)
            }
        }
        return (k.registered, k.algorithmId, publicKey, k.possessionProven);
    }
}

contract PqcVerifyMock {
    bool public active = true;
    bool public forceFail = false;

    function setActive(bool active_) external {
        active = active_;
    }

    function setForceFail(bool forceFail_) external {
        forceFail = forceFail_;
    }

    /// @dev Deterministic ML-DSA-87 mock binding: requires signature[0..32] == keccak256(pubkey, message).
    ///      Tests can corrupt either `signature` or `message` or `signer` key and verify exact failure.
    function pqcVerify(bytes calldata publicKey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        if (!active) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        if (forceFail) return false;
        if (publicKey.length != 2592 || signature.length != 4627) return false;
        bytes32 expectedTag = keccak256(abi.encodePacked(publicKey, message));
        bytes32 providedTag;
        assembly ("memory-safe") {
            providedTag := calldataload(signature.offset)
        }
        return expectedTag == providedTag;
    }
}
