# Step 0 Testnet Spike Results (`qorechain-diana`)

- **Run timestamp (UTC):** 2026-11-21T20:30:54.002Z
- **Network:** `qorechain-diana` (EVM Chain ID `9800`)
- **SpikeProbe Contract:** `0xe4bf5d52d9ea33fcf3515ae3ee55841df847c626`
- **Resolved `MsgExecuteEVM` Digest Version:** `v2`

| Test | Description | Result | Evidence / Measured Numbers |
|---|---|---|---|
| **S1** | msg.sender identity under MsgExecuteEVM | PASS | Observed msg.sender = 0xb54C32481C4DdB7aD6E8801A1953Ff1f8916B889 (equals Owner 0x=true) <br/> `242DA49DF5AFDF9873101D2199E108D93025B81EB0267502DE2688872AB962B8` |
| **S2** | Direct fUSD.transfer bounded by x/abstractaccount denom_limits | PASS | 0.5 fUSD succeeded (delta=+500000); >1.0 fUSD refused with outer code=0 + abstractaccount_execution_failed (delta=0) <br/> `8F9C24613DD4FF2A3209DF632FA358ED054F171C0382FD898E335E3341B90A20 / 7B7025D1DAE1BC04E9F6E1D95ADD83D76D938243381E086CF299BB69EA4439D7` |
| **S3** | Selector-level allowed_evm_calls enforcement | PASS | allowedAction=1, forbiddenAction=0 (refused on-chain) <br/> `09B7A6BDD3F6E44115CBE1A4772D62969FDEC7D36F3B61D877E79E817B6D6E8D / 69E3070EB5A38B852627AD45112F35F8615B6B65951AB0CFBBEEA111E12C5BA7` |
| **S4** | Dedicated freeze-only Monitor authenticator (AA #2) & cap=0 vs cap=1 uqor | PASS | cap=0: (rejected before broadcast: the account's first enabled spending rule (monitor-zero) does not bound every denom, which a key with the permission(s) evm needs from chain v3.2.8: set perTxLimit > 0 or dailyLimit > 0, or list allowedDenoms and give each one a denomLimits entry with an amount); cap=1 uqor: freeze() succeeded (frozen=true), non-freeze selector refused <br/> `0340DBDD9998592B0B6431D58A7F97104B31997374748D7C7FAF08FB38AA7695 / 16A6255E9AA8E86D2E5DAA87CF19528C7B2FEB2D5C96A7605D4FE5DED325DD8D` |
| **S5** | PqcVerifier wrapper (1x / 2x / 3x gas benchmarks, forged sig, inactive 0x0B02) | PASS | EVM gasUsed: 1x=249133 | 2x=430499 | 3x=629738; forgedSigRefused=true; inactive0x0B02FailClosed=true <br/> `1x=1B875E5DE5F8A4BA3881C605E8A30CDB0B1EBD8EA6A8AFBDE7662DCBCF588CA7, 2x=03EE03AD635819F9FAC176AFB22F5990489631AFD3D1502A026E49D4E41D0450, 3x=909C9A30AD140861A290324F1CF6BD9285CEF49889158798F7C7F3BDED06982C, bad=B6721B79FA79E6BE5EF0EF0372036D7950FAC73EC9BAEE67D7F093F072637F74` |
| **S6** | Instant MsgRevokeAuthenticator kill-switch | PASS | Post-revoke MsgExecuteEVM rejected immediately=true <br/> `F5170CDD437454AC5223093DE0F0B49D74EA90627A7776C43DFE8B9C00C4CAB0` |
| **S7** | Scoped EVM Window (allowedTargets + unlisted rejection + immediate close) | PASS | Scoped call=success, unlistedTargetRejected=true, closedLive=false <br/> `open=B1DD2537B2BB7CB8EA8F0B31CFAD077E4BF2DA0143B3EF7FC0FD1C95E49687E4, call=0x929d4f0fb1d5ccb4de597960207861ef4ca99b92eb4a545fe3eccec417c2a7a2, close=FC03D55702D2CB317C1E69E2995F0903185DDFC219C959B50ECF8BB0DFFFF236` |
| **S8** | Two linked keys on one account inherit the same account-wide spending rule | PASS | authenticatorRules=0, accountRules=1; second key inherited MonitorAccount rule (freeze ok, non-freeze refused) <br/> `link=3B2E55F82424A2853FCF2F20636DA59517508EA85F7793390D3581B3F86A5289, freeze=98BAE2B8C079D30F89A56969772DF2441E386CE98C43A1E899B860694D8930B1, forbid=9670A5588F360D0C870E59A5C8BD7899411971A64C6F2D824B3371079787BB9A` |

## Verbatim Details & Refusal Logs

### S1 — msg.sender identity under MsgExecuteEVM
- **Status:** PASS
- **Tx:** `242DA49DF5AFDF9873101D2199E108D93025B81EB0267502DE2688872AB962B8`
- **Summary:** Observed msg.sender = 0xb54C32481C4DdB7aD6E8801A1953Ff1f8916B889 (equals Owner 0x=true)
- **Details:** outerCode=0, failedEvent=false, evmGasUsed=44904

### S2 — Direct fUSD.transfer bounded by x/abstractaccount denom_limits
- **Status:** PASS
- **Tx:** `8F9C24613DD4FF2A3209DF632FA358ED054F171C0382FD898E335E3341B90A20 / 7B7025D1DAE1BC04E9F6E1D95ADD83D76D938243381E086CF299BB69EA4439D7`
- **Summary:** 0.5 fUSD succeeded (delta=+500000); >1.0 fUSD refused with outer code=0 + abstractaccount_execution_failed (delta=0)
- **Details:** refusalReason="per-tx limit 1000000erc20/0x97143B771D34ddb9130b807b135Ae675A5a963CA exceeded (attempted 1000001): spending limit exceeded"

### S3 — Selector-level allowed_evm_calls enforcement
- **Status:** PASS
- **Tx:** `09B7A6BDD3F6E44115CBE1A4772D62969FDEC7D36F3B61D877E79E817B6D6E8D / 69E3070EB5A38B852627AD45112F35F8615B6B65951AB0CFBBEEA111E12C5BA7`
- **Summary:** allowedAction=1, forbiddenAction=0 (refused on-chain)
- **Details:** refusalReason="a linked key with a spending rule may call 0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626 with data only if the rule lists the call in allowed_evm_calls (or lists the token as "erc20/0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626" for a token transfer or approval): authenticator not permitted for this action"

### S4 — Dedicated freeze-only Monitor authenticator (AA #2) & cap=0 vs cap=1 uqor
- **Status:** PASS
- **Tx:** `0340DBDD9998592B0B6431D58A7F97104B31997374748D7C7FAF08FB38AA7695 / 16A6255E9AA8E86D2E5DAA87CF19528C7B2FEB2D5C96A7605D4FE5DED325DD8D`
- **Summary:** cap=0: (rejected before broadcast: the account's first enabled spending rule (monitor-zero) does not bound every denom, which a key with the permission(s) evm needs from chain v3.2.8: set perTxLimit > 0 or dailyLimit > 0, or list allowedDenoms and give each one a denomLimits entry with an amount); cap=1 uqor: freeze() succeeded (frozen=true), non-freeze selector refused
- **Details:** nonFreezeReason="a linked key with a spending rule may call 0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626 with data only if the rule lists the call in allowed_evm_calls (or lists the token as "erc20/0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626" for a token transfer or approval): authenticator not permitted for this action"

### S5 — PqcVerifier wrapper (1x / 2x / 3x gas benchmarks, forged sig, inactive 0x0B02)
- **Status:** PASS
- **Tx:** `1x=1B875E5DE5F8A4BA3881C605E8A30CDB0B1EBD8EA6A8AFBDE7662DCBCF588CA7, 2x=03EE03AD635819F9FAC176AFB22F5990489631AFD3D1502A026E49D4E41D0450, 3x=909C9A30AD140861A290324F1CF6BD9285CEF49889158798F7C7F3BDED06982C, bad=B6721B79FA79E6BE5EF0EF0372036D7950FAC73EC9BAEE67D7F093F072637F74`
- **Summary:** EVM gasUsed: 1x=249133 | 2x=430499 | 3x=629738; forgedSigRefused=true; inactive0x0B02FailClosed=true
- **Details:** badSigReason="execution reverted: evm transaction execution failed"; inactive0x0B02="The contract function "probeInactivePrecompile" reverted with the following signature:
0xa25e3bc9

Unable to decode signature "0xa25e3bc9" a"

### S6 — Instant MsgRevokeAuthenticator kill-switch
- **Status:** PASS
- **Tx:** `F5170CDD437454AC5223093DE0F0B49D74EA90627A7776C43DFE8B9C00C4CAB0`
- **Summary:** Post-revoke MsgExecuteEVM rejected immediately=true
- **Details:** rejected at CheckTx/broadcast: permission denied - the authenticator lacks the permission this message requires (check the permission_schema) (failed to execute message; message index: 0: lin

### S7 — Scoped EVM Window (allowedTargets + unlisted rejection + immediate close)
- **Status:** PASS
- **Tx:** `open=B1DD2537B2BB7CB8EA8F0B31CFAD077E4BF2DA0143B3EF7FC0FD1C95E49687E4, call=0x929d4f0fb1d5ccb4de597960207861ef4ca99b92eb4a545fe3eccec417c2a7a2, close=FC03D55702D2CB317C1E69E2995F0903185DDFC219C959B50ECF8BB0DFFFF236`
- **Summary:** Scoped call=success, unlistedTargetRejected=true, closedLive=false
- **Details:** unlistedErr="Missing or invalid parameters.
Double check you have provided the correct parameters.

URL: https://evm-testnet.qore.host
Request body: {"method":"eth_sendRawTr"

### S8 — Two linked keys on one account inherit the same account-wide spending rule
- **Status:** PASS
- **Tx:** `link=3B2E55F82424A2853FCF2F20636DA59517508EA85F7793390D3581B3F86A5289, freeze=98BAE2B8C079D30F89A56969772DF2441E386CE98C43A1E899B860694D8930B1, forbid=9670A5588F360D0C870E59A5C8BD7899411971A64C6F2D824B3371079787BB9A`
- **Summary:** authenticatorRules=0, accountRules=1; second key inherited MonitorAccount rule (freeze ok, non-freeze refused)
- **Details:** secondKeyNonFreezeReason="a linked key with a spending rule may call 0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626 with data only if the rule lists the call in allowed_evm_calls (or lists the token as "erc20/0xE4bf5d52D9eA33Fcf3515AE3eE55841DF847c626" for a token transfer or approval): authenticator not permitted for this action"
