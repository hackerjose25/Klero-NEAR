# Klero NEAR contracts

| Crate | What it is |
| --- | --- |
| `klero` | The referee and escrow: agent links, first-claim-wins rounds, payment intents with a deadline, `settle` → PAID or `void_intent` → VOID |
| `fusd` | A NEP-141 test token (6 decimals, owner can mint) used as the payment unit on testnet |

## Prerequisites (one-time)

1. Rust: https://rustup.rs. On Windows, accept the Visual Studio C++ Build Tools prompt.
2. `rustup target add wasm32-unknown-unknown`
3. `cargo install cargo-near near-cli-rs`

## Test

```sh
cd contracts
cargo test   # on Windows first: export AWS_LC_SYS_PREBUILT_NASM=1 (avoids needing NASM)
```

## Build

```sh
cd contracts/klero && cargo near build non-reproducible-wasm
cd ../fusd && cargo near build non-reproducible-wasm
```

## Deploy to testnet (outline; the bootstrap script will automate this)

```sh
# accounts: <op>.testnet (operator), fusd.<op>.testnet, klero.<op>.testnet
near contract deploy fusd.<op>.testnet use-file target/near/fusd/fusd.wasm \
  with-init-call new json-args '{"owner":"<op>.testnet"}' ...
near contract deploy klero.<op>.testnet use-file target/near/klero/klero.wasm \
  with-init-call new json-args '{"operator":"<op>.testnet","token":"fusd.<op>.testnet"}' ...
# the Klero contract must be registered on FUSD so it can hold escrow:
near contract call-function as-transaction fusd.<op>.testnet storage_deposit \
  json-args '{"account_id":"klero.<op>.testnet"}' ... attached-deposit '0.01 NEAR'
```

## Payment flow

1. Operator: `link_agent(agent, human, epoch)` for each agent, after a World ID check.
2. Agent: `claim(job_key, round, provider)` → `true` if it won.
3. Winner: on FUSD, `ft_transfer_call(receiver_id = klero, amount, msg = {"job_key","round","ttl_s"})` escrows the payment and
   creates intent `<job_key>:<round>`.
4. Provider: `settle(intent_id)` before the deadline → PAID. Anyone: `void_intent(intent_id)` after the deadline → VOID,
   the payer is refunded and the job reopens in the next round.
5. Anyone: `get_intent_state(intent_id)` → `PENDING | EXPIRED | SETTLING | VOIDING | PAID | VOID`.
