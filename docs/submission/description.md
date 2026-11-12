# Phoebe on NEAR

**Agents fork. Money doesn't.** Phoebe makes sure an AI agent's payment happens exactly once. Every payment ends in one of
two states, **PAID once** or **provably VOID (refunded)**, and anyone can read which one from a NEAR contract.

Tracks: **AI Security**, **AI Swarms**, **AI Agents**. Network: NEAR testnet.

## The problem

Agent wallets today stop *bad* payments with limits and allowlists. They don't answer the question that breaks agents:
**the agent sent a payment and the connection dropped. Did it pay?** If it retries, it may pay twice. If it gives up, the work
never ships. With parallel agents it gets worse: three agents working for one person can all decide to buy the same thing.

## What Phoebe does on NEAR

One Rust contract, [`klero-v2.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/klero-v2.klero-mw8x6bn1.testnet),
acts as referee, escrow and policy:

1. **Referee (swarms).** Agents that work for the same human compute the same job key. Each one calls `claim(job, round,
   provider)`, and the first claim in a round wins. The losers don't pay. They wait and receive the winner's result.
2. **Escrow with a deadline.** The winner pays the provider's 402 challenge by sending FUSD (NEP-141) with `ft_transfer_call`.
   The contract holds it as an intent with a deadline.
3. **Exactly one ending.** Before the deadline, only the provider can `settle` → **PAID**. After it, anyone can `void_intent` →
   **VOID**, and the payer is refunded. The two windows don't overlap, so a payment cannot end both ways or end twice.
   `get_intent_state` is a public view: VOID is a fact you read from the contract, not a guess.
4. **Pay on delivery.** The provider checks the escrow on-chain, does the work, re-checks the deadline, and only then settles.
   A provider that crashes never gets paid. The agent voids after the deadline, gets its refund, and the job moves to the next
   round.

## A human stays in charge (security)

- **Agents are sub-accounts of the human** (`a.human…`, `b.human…`, `c.human…`), and each signs with a **claim-only
  function-call key**: it can call `claim` on the Phoebe contract and nothing else. A leaked agent key can't move money anywhere.
- **The spend cap is enforced on-chain.** Each human has a per-payment cap stored in the contract (1 FUSD in the demo). An
  escrow above it makes `ft_on_transfer` panic, so the token refunds the payer, unless the operator recorded a one-shot
  `approve_overcap` for that exact job, round and maximum amount.
- **The approval comes from the human.** The approver service checks on-chain that the agent really won and the price really is
  over the cap, then asks the human (World ID device flow; a clearly labelled manual mode when no World credentials are set).
  Deny → `abandon_round`, no money moves. Approve → the same payment goes through.

## Verified on testnet

Every line below is in [`docs/proof-near.md`](../proof-near.md), with a NearBlocks link per transaction:

- 3 agents claim one job → 1 winner → escrow → provider delivers and settles → **payments on-chain: 1**. The two losers get the
  result for free.
- Provider crashes after escrow → deadline passes → void → refund → round 1 → **still 1 payment**.
- An escrow that is never settled → `EXPIRED` → void → **VOID**, the balance back to what it was before the escrow.
- A 2 FUSD escrow with no approval, over a 1 FUSD cap → **refused by the contract**, balance unchanged.
- Over-cap: deny → round abandoned, nothing moved; approve → `approve_overcap` on-chain → escrow → delivered.

## You don't have to trust us

`pnpm audit:near` rebuilds every job from public data alone. It uses NearBlocks to find the transactions, an archival NEAR RPC
for their logs, and the contract's own views. Per job it checks: one winner per round, paid at most once, the payer is the round
winner, the cap is respected or approved, each settlement and refund appears as a real token transfer, and the contract's state
matches the replay. Results on testnet: contract v2, 3 jobs and 25 checks; v1, 5 jobs and 42 checks. **All passed.**

## How it's made

- **Contract:** Rust, `near-sdk` + `near-contract-standards`. NEP-297 events (`claim`, `intent`, `settled`, `void`), cross-contract
  `ft_transfer` with callbacks (`on_settled`, `on_voided`) and transient `SETTLING`/`VOIDING` states. 22 unit tests: double
  claim, settle twice, settle after the deadline, void before it, cap and approval cases. Plus a NEP-141 test token, FUSD (6 dp).
- **Off-chain:** TypeScript with `near-api-js` 7. A resumable bootstrap creates every testnet account, key and balance. A
  provider server hosts three transcription providers. The agent runner does the race. The approver handles World ID. The
  agents can choose providers with an LLM through any OpenAI-compatible endpoint, including NEAR AI Cloud.

**Hacky parts worth naming**

- **Reading too early.** `settle` finishes over several receipts. Our provider read the intent while the callback was still
  pending, saw `SETTLING`, and reported a failure, although the payment had completed. Calls now wait for `FINAL`, and readers
  poll past `SETTLING`/`VOIDING`.
- **Gas versus balance.** The first escrow failed before it was sent, because the agent held too little NEAR to prepay 100 TGas.
  No tokens moved. Now we use 50 TGas, and the bootstrap tops up the agents.
- **New state layout, new account.** Adding the cap changed the contract state, so v2 was deployed as a new account. v1 is kept
  as history.

## Origin and honesty

Phoebe was first built on Hedera, as tag [`pre-hackathon`](https://github.com/hackerjose25/Klero-NEAR/tree/pre-hackathon). Only the
NEAR work is the hackathon entry: [`pre-hackathon...main`](https://github.com/hackerjose25/Klero-NEAR/compare/pre-hackathon...main).
NEAR made the design simpler: on Hedera, VOID was inferred from transaction expiry plus a 404. On NEAR the contract holds the money
and the state machine, so VOID is contract state. Everything runs on testnet only. The proof runs used persona rules and labelled stub
transcripts (no LLM key set), and approvals ran in manual mode (no World credentials set). The Hedera-era web dashboard is not
wired to NEAR.
