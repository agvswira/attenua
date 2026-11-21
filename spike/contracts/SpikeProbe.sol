// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title SpikeProbe
/// @notice Minimal empirical probe deployed on qorechain-diana (chain ID 9800) for Step 0 verification.
///         Tests:
///         - S1: actual msg.sender observed during x/abstractaccount MsgExecuteEVM
///         - S3: selector-level allowed_evm_calls isolation (allowedAction vs forbiddenAction)
///         - S4: freeze-only monitor authenticator call + rule isolation
///         - S5: fail-closed PqcVerifier wrapper (pqcKeyStatus -> possessionProven -> pqcVerify),
///               live gas measurements for 1x, 2x, 3x ML-DSA-87 checks, and inactive precompile guard
contract SpikeProbe {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    address internal constant INACTIVE_AI_ANOMALY = 0x0000000000000000000000000000000000000B02;

    uint8 internal constant ALG_ML_DSA_87 = 1;
    uint256 internal constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 internal constant ML_DSA_87_SIG_LEN = 4627;

    struct PqcCheck {
        address signer;
        bytes signature;
        bytes message;
    }

    address public lastCaller;
    uint256 public allowedCalls;
    uint256 public forbiddenCalls;
    bool public frozen;
    uint256 public freezeCount;
    uint256 public verifiedCount;

    error EmptyBatch();
    error PrecompileInactive(address target);
    error PqcKeyNotRegistered(address account);
    error PqcKeyUnsupportedAlgorithm(address account, uint8 algorithmId);
    error PqcKeyNotProven(address account);
    error PqcKeyLengthInvalid(uint256 length);
    error PqcSigLengthInvalid(uint256 length);
    error PqcSignatureInvalid(address account);

    event CallerRecorded(address indexed caller, uint256 blockNumber);
    event AllowedActionExecuted(address indexed caller, uint256 count);
    event ForbiddenActionExecuted(address indexed caller, uint256 count);
    event Frozen(address indexed caller, uint256 count);
    event PqcBatchVerified(uint256 checks, uint256 verifiedCount);

    /// @notice S1: Records who msg.sender is when invoked via MsgExecuteEVM vs EVM window
    function whoCalled() external returns (address) {
        lastCaller = msg.sender;
        emit CallerRecorded(msg.sender, block.number);
        return msg.sender;
    }

    /// @notice S3: Selector intended to be allowlisted in x/abstractaccount allowed_evm_calls
    function allowedAction() external returns (uint256) {
        allowedCalls += 1;
        lastCaller = msg.sender;
        emit AllowedActionExecuted(msg.sender, allowedCalls);
        return allowedCalls;
    }

    /// @notice S3: Selector intentionally NOT allowlisted in x/abstractaccount allowed_evm_calls
    function forbiddenAction() external returns (uint256) {
        forbiddenCalls += 1;
        lastCaller = msg.sender;
        emit ForbiddenActionExecuted(msg.sender, forbiddenCalls);
        return forbiddenCalls;
    }

    /// @notice S4: Monotonic freeze entrypoint for monitor authenticator spike
    function freeze() external returns (bool) {
        frozen = true;
        freezeCount += 1;
        lastCaller = msg.sender;
        emit Frozen(msg.sender, freezeCount);
        return true;
    }

    /// @notice S5: Verify N (1, 2, or 3+) registered & possession-proven ML-DSA-87 signatures (fail-closed)
    function verifyBatch(PqcCheck[] calldata checks) external returns (bool) {
        uint256 len = checks.length;
        if (len == 0) revert EmptyBatch();
        for (uint256 i = 0; i < len; ++i) {
            _verifyPqc(checks[i].signer, checks[i].signature, checks[i].message);
        }
        verifiedCount += len;
        emit PqcBatchVerified(len, verifiedCount);
        return true;
    }

    /// @notice S5: Confirm calling an inactive precompile (0x...0B02) fails closed when return data is empty
    function probeInactivePrecompile(address account, uint256 amount) external view returns (uint256, bool) {
        (bool ok, bytes memory ret) = INACTIVE_AI_ANOMALY.staticcall(
            abi.encodeWithSignature("aiAnomalyCheck(address,uint256)", account, amount)
        );
        if (!ok || ret.length < 64) {
            revert PrecompileInactive(INACTIVE_AI_ANOMALY);
        }
        return abi.decode(ret, (uint256, bool));
    }

    /// @notice Read-only wrapper check for eth_call parity verification
    function checkPqcView(
        address signer,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool) {
        _verifyPqc(signer, signature, message);
        return true;
    }

    /// @dev Fail-closed verification order:
    ///      1. Query pqcKeyStatus(signer) with empty-return guard
    ///      2. Require registered && algorithmId == 1 && possessionProven && pubkey.length == 2592
    ///      3. Query pqcVerify(pubkey, signature, message) with empty-return guard
    ///      4. Require valid == true
    function _verifyPqc(
        address signer,
        bytes calldata signature,
        bytes calldata message
    ) internal view {
        if (signature.length != ML_DSA_87_SIG_LEN) {
            revert PqcSigLengthInvalid(signature.length);
        }

        (bool statusOk, bytes memory statusRet) = PQC_KEY_STATUS.staticcall(
            abi.encodeWithSignature("pqcKeyStatus(address)", signer)
        );
        if (!statusOk || statusRet.length < 128) {
            revert PrecompileInactive(PQC_KEY_STATUS);
        }

        (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven) =
            abi.decode(statusRet, (bool, uint8, bytes, bool));

        if (!registered) revert PqcKeyNotRegistered(signer);
        if (algorithmId != ALG_ML_DSA_87) revert PqcKeyUnsupportedAlgorithm(signer, algorithmId);
        if (!possessionProven) revert PqcKeyNotProven(signer);
        if (pubkey.length != ML_DSA_87_PUBKEY_LEN) revert PqcKeyLengthInvalid(pubkey.length);

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
