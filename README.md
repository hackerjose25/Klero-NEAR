# Phoebe

**Agents fork. Money doesn't.** Exactly-once payments for AI agents, enforced by a NEAR contract.

Your agent sent a payment and the connection dropped. Did it pay? Three of your agents decided to buy the same thing. Do you pay
three times? Phoebe gives every agent payment exactly two possible endings, **PAID once** or **VOID and refunded**, and anyone can
read which one it was from the contract.

Entry for [NEAR HACKATHON](https://nearhackathon.com), tracks `security`, `swarms`, `agents`. Everything runs on **NEAR testnet**.

| | |
|---|---|
| Contract (v2) | [`klero-v2.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/klero-v2.klero-mw8x6bn1.testnet) |
| Payment token (FUSD, NEP-141, 6 dp) | [`fusd.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/fusd.klero-mw8x6bn1.testnet) |
| Human and agents | [`human.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/human.klero-mw8x6bn1.testnet) with sub-accounts `a.`, `b.`, `c.` |
| Proof (raw output, NearBlocks links) | [docs/proof-near.md](docs/proof-near.md) |
| Demo video | [X post](https://x.com/hackerjose25/status/2121539719435850006) |
| Submission text | [docs/submission/description.md](docs/submission/description.md) |

The account ids start with `klero` because the project was called Klero before the hackathon, and NEAR account names are permanent.

## How it works

1. **Claim.** The agents of one human compute the same job key for the same task and call `claim(job, round, provider)` on the
   contract. The first claim in a round wins. The others get `won = false`, back off, and later receive the winner's result for free.
2. **Escrow.** The provider answers with an HTTP 402. The winner pays it with `ft_transfer_call` on the FUSD token. The contract holds
   the money as an intent with a deadline. Only the round's winner can pay, and only once per job and round.
3. **Settle: pay on delivery.** The provider checks the escrow on-chain, does the work, re-checks the deadline, and calls `settle`.
   The money goes to the provider → **PAID**.
4. **Void: refund.** If the provider never delivers, anyone can call `void_intent` after the deadline. The money goes back to the
   payer → **VOID**, and the job reopens in the next round.
5. **Exactly one ending.** Settling works only before the deadline and voiding only after it. The windows never overlap, so a
   payment can't be paid twice, or both paid and refunded. `get_intent_state` returns `PENDING`, `EXPIRED`, `PAID` or `VOID`.

## Security model

- **Agents are sub-accounts of their human** (`a.human…`, `b.human…`, `c.human…`), linked on-chain by the operator.
- **Claim-only keys.** Each agent claims with a function-call access key that can call `claim` on the Phoebe contract and nothing
  else. The bootstrap checks this on-chain.
- **On-chain spend cap.** Each human has a per-payment cap stored in the contract (1 FUSD in the demo). An escrow above it makes
  `ft_on_transfer` panic, so the token refunds the payer, unless the operator recorded a one-shot `approve_overcap` for that exact job,
  round and maximum amount.
- **The human decides.** The approver service checks on-chain that the agent won and that the price is over the cap, then asks the
  human. Approve → `approve_overcap` → the same payment goes through. Deny → `abandon_round`, no money moves. It supports World ID
  (device flow). Without World credentials it runs a clearly labelled manual mode: a local Approve/Deny page. All recorded runs used
  manual mode.

## Verified on testnet

From [docs/proof-near.md](docs/proof-near.md), each step with its transaction:

- 3 agents, 1 job → 1 winner → escrow → delivered → settled. **Payments on-chain: 1.** The two losers received the result.
- Provider crashes after escrow → deadline → void → refund → round 1 → **still 1 payment**.
- An escrow that is never settled → `EXPIRED` → void → **VOID**, balance back to what it was before.
- 2 FUSD escrow with no approval over a 1 FUSD cap → **refused by the contract**, balance unchanged.
- Over the cap: deny → round abandoned, nothing moved; approve → `approve_overcap` → escrow → delivered.
- **Independent audit:** `pnpm audit:near` → contract v2 and v1 both **ALL PASSED**.

## Run it

Needs Node 22+, pnpm 9.15 and, for the contract, Rust with the `wasm32-unknown-unknown` target.

```bash
# contract
cd contracts && cargo test                     # 22 tests (Windows: export AWS_LC_SYS_PREBUILT_NASM=1)
cargo build --release --target wasm32-unknown-unknown

# backend (from backend/)
pnpm install
pnpm bootstrap:near        # your own testnet accounts, token, contract, cap, claim-only keys; resumable
pnpm smoke:near            # race → escrow → PAID; then escrow → EXPIRED → VOID, refunded
pnpm smoke:cap:near        # an over-cap escrow with no approval is refused by the contract

pnpm dev:providers:near    # terminal 1, port 4050: three transcription providers
pnpm dev:approver:near     # terminal 2, port 4060: human approval
pnpm agents:near           # terminal 3: three agents race → payments on-chain this run: 1
```

- Provider crash: start the providers with `PROVIDERS_FAIL_ONCE=scribe-b` → void → refund → round 1.
- Over the cap: run the agents with `FORCE_PROVIDER=scribe-premium` → open the printed approval link → deny, then approve.
- Optional `backend/.env`: `WORLD_CLIENT_ID` / `WORLD_CLIENT_SECRET` (World ID approvals), and `LLM_API_KEY` with `LLM_BASE_URL`, for
  example `https://cloud-api.near.ai/v1` for NEAR AI Cloud (LLM provider choice and real transcripts). Without them: manual approvals,
  persona rules and labelled stub transcripts. The recorded runs used these defaults.

**Website** (`cd frontend && npm install && npm run dev`): `/` is the landing page, and `/near` reads every job and payment live from
the contract in your browser, with NearBlocks links, a deadline countdown and a lookup for any job key.

## Verify it yourself

```bash
cd backend && pnpm audit:near                                          # contract v2
pnpm audit:near --contract klero.klero-mw8x6bn1.testnet               # v1, which holds the VOID runs
```

The audit uses only public data. NearBlocks lists the transactions, an archival RPC returns their logs, and the contract's views give
the current state. It checks every job: one winner per round, paid at most once, payer = winner, cap respected or approved, one ending
per intent, every settlement and refund visible as a real token transfer, contract state = replay, and the replay saw every intent the
contract holds. It ends with `ALL PASSED` or `VIOLATIONS FOUND`.

## Repository

| Path | What |
| --- | --- |
| [`contracts/klero`](contracts/klero) | Rust contract: referee, escrow, cap, NEP-297 events. 22 unit tests |
| [`contracts/fusd`](contracts/fusd) | NEP-141 test token |
| [`backend/packages/near`](backend/packages/near) | contract client, deployment and key loaders, optional LLM |
| [`backend/services/provider-near`](backend/services/provider-near) | provider directory, 402 challenge, escrow check, work, settle |
| [`backend/services/approver-near`](backend/services/approver-near) | human approval (World ID or manual) → `approve_overcap` / `abandon_round` |
| [`backend/apps/agents/src/run-near.ts`](backend/apps/agents/src/run-near.ts) | the three-agent race |
| [`backend/apps/cli/src/audit-near.ts`](backend/apps/cli/src/audit-near.ts) | independent audit |
| [`backend/scripts`](backend/scripts) | `bootstrap-near`, `smoke-near`, `smoke-cap-near` |
| [`frontend`](frontend) | landing page and the live `/near` page |
| [`backend/deployments/near-testnet.json`](backend/deployments/near-testnet.json) | current testnet deployment (public ids only) |

## Limits

- Testnet only. FUSD is a test token, and nothing has handled real money.
- A World ID approval has not been run end to end yet (no app credentials). The recorded approvals used manual mode.
- The operator links agents to humans and records approvals. It is a trusted role in this version.
- The recorded runs used persona rules and stub transcripts, not an LLM.
- Other app pages in `frontend/` (`/dashboard`, `/race`, `/login`) and the non-NEAR backend services belong to the earlier version and
  are not wired to NEAR.

## Origin

Phoebe was first built on Hedera as Klero. That version is tag
[`pre-hackathon`](https://github.com/hackerjose25/Phoebe-NEARHack/tree/pre-hackathon), and its README is archived in
[docs/hedera-readme.md](docs/hedera-readme.md). As the rules allow (Q-002), only the NEAR work is the hackathon entry. The hackathon diff
is [`pre-hackathon...main`](https://github.com/hackerjose25/Phoebe-NEARHack/compare/pre-hackathon...main), and the change log is
[HISTORY.md](HISTORY.md). On NEAR the design got simpler: the contract holds the money and the state machine, so VOID is contract
state you read, not something inferred from a transaction expiry.

Libraries: `near-sdk` and `near-contract-standards` (Rust), `near-api-js`, Fastify, Next.js. Licence: MIT ([LICENSE](LICENSE)).
