# History

What changed, newest first. Hackathon window: 2026-10-19 → 2026-11-14 23:59 UTC. Baseline: tag `pre-hackathon`.

## 2026-11-09: Day 2, deployed and proven on NEAR testnet (`9801c34`)
- `backend/scripts/bootstrap-near.ts` (`pnpm bootstrap:near`): resumable testnet setup. It creates the operator via the faucet,
  FUSD token, Klero contract, three provider accounts, one human with agents `a`/`b`/`c` as sub-accounts, claim-only
  function-call keys, demo FUSD balances, agent links, and gas top-ups. Keys go to `.secrets/near-testnet-keys.json`
  (git-ignored) the moment each account exists.
- `backend/scripts/smoke-near.ts` (`pnpm smoke:near`): live race → escrow → settle (PAID), and escrow → deadline → void
  (VOID, refunded). Output in `docs/proof-near.md`.
- Deployed: operator `klero-mw8x6bn1.testnet`, contract `klero.klero-mw8x6bn1.testnet`, token `fusd.klero-mw8x6bn1.testnet`
  (`backend/deployments/near-testnet.json`).
- Contracts are built with stripped symbols (wasm ~40% smaller, cheaper storage).
- Problem hit: the first smoke run's escrow failed before sending, because agents had too little NEAR for 100 TGas of
  prepaid gas. No tokens moved. Fixed with 50 TGas and agent top-ups.

## 2026-11-09: Day 1, contracts (`d984650`, `a9fef77`)
- `contracts/klero`: referee + escrow (link agents, first-claim-wins rounds, one intent per job and round with a deadline,
  `settle` → PAID / `void_intent` → VOID, `abandon_round`, NEP-297 events, views). 16 unit tests.
- `contracts/fusd`: NEP-141 test token, 6 dp, owner mint.
- MIT `LICENSE` at the repo root.
- Dev setup on Windows: Rust (MSVC) + VS Build Tools C++ workload; tests need `AWS_LC_SYS_PREBUILT_NASM=1`.

## 2026-11-09: Repo created (`45d2ae8`, tag `pre-hackathon`)
- New repo, seeded with Klero (Hedera) as of commit `1cb9f19` of the original repo. Port plan:
  `docs/planning/near-port-plan.md`.
