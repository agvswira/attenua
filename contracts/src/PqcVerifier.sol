// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title PqcVerifier
/// @notice Fail-closed wrapper around QoreChain's ML-DSA-87 precompiles:
///         1. Calls pqcKeyStatus (0x...0a02) and rejects empty/malformed return data.
///         2. Requires registered == true, algorithmId == 1 (ML-DSA-87), possessionProven == true,
///            and pubkey.length == 2592.
///         3. Calls pqcVerify (0x...0a01) with the chain-registered pubkey and rejects empty return data.
library PqcVerifier {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    uint8 internal constant ALG_ML_DSA_87 = 1;
    uint256 internal constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 internal constant ML_DSA_87_SIG_LEN = 4627;

    error PrecompileInactive(address target);
    error PqcKeyNotRegistered(address account);
    error PqcKeyUnsupportedAlgorithm(address account, uint8 algorithmId);
    error PqcKeyNotProven(address account);
    error PqcKeyLengthInvalid(uint256 length);
    error PqcSigLengthInvalid(uint256 length);
    error PqcSignatureInvalid(address account);

    /// @notice Verifies that `account` has an active, possession-proven ML-DSA-87 key on chain.
    function requireProvenKey(address account) internal view returns (bytes memory pubkey) {
        (bool statusOk, bytes memory statusRet) = PQC_KEY_STATUS.staticcall(
            abi.encodeWithSignature("pqcKeyStatus(address)", account)
        );
        if (!statusOk || statusRet.length < 160) {
            revert PrecompileInactive(PQC_KEY_STATUS);
        }

        (bool registered, uint8 algorithmId, bytes memory key, bool possessionProven) =
            abi.decode(statusRet, (bool, uint8, bytes, bool));

        if (!registered) revert PqcKeyNotRegistered(account);
        if (algorithmId != ALG_ML_DSA_87) revert PqcKeyUnsupportedAlgorithm(account, algorithmId);
        if (!possessionProven) revert PqcKeyNotProven(account);
        if (key.length != ML_DSA_87_PUBKEY_LEN) revert PqcKeyLengthInvalid(key.length);
        return key;
    }

    /// @notice Verifies an ML-DSA-87 signature against `signer`'s chain-registered, proven key.
    function verify(
        address signer,
        bytes calldata signature,
        bytes memory message
    ) internal view {
        if (signature.length != ML_DSA_87_SIG_LEN) {
            revert PqcSigLengthInvalid(signature.length);
        }

        bytes memory pubkey = requireProvenKey(signer);

        (bool verifyOk, bytes memory verifyRet) = PQC_VERIFY.staticcall(
            abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, signature, message)
        );
        if (!verifyOk || verifyRet.length < 32) {
            revert PrecompileInactive(PQC_VERIFY);
        }

        bool valid = abi.decode(verifyRet, (bool));
        if (!valid) revert PqcSignatureInvalid(signer);
    }
}
