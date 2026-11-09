# Klero on NEAR testnet: proof

Raw output of `pnpm smoke:near` (backend/scripts/smoke-near.ts), run 2026-11-09. Every link opens the transaction on NearBlocks.

| | |
|---|---|
| Contract | [`klero.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/klero.klero-mw8x6bn1.testnet) |
| Token (FUSD, NEP-141, 6 dp) | [`fusd.klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/fusd.klero-mw8x6bn1.testnet) |
| Operator | [`klero-mw8x6bn1.testnet`](https://testnet.nearblocks.io/address/klero-mw8x6bn1.testnet) |
| Agents (sub-accounts of one human) | `a`, `b`, `c` `.human.klero-mw8x6bn1.testnet` |

Each claim is signed with the agent's **claim-only function-call key**: it can call `claim` on the Klero contract and nothing else.

```text
=== Run 1: three agents, one job → one payment ===
[b] claim → won=true  https://testnet.nearblocks.io/txns/6wE7yDeUJrSoKd6ym7tB2oujg3KBWVLwjBYTrbPmAuWf
[a] claim → won=false  https://testnet.nearblocks.io/txns/Ffpa4LYMptYS5LppEQ3fgm5C7dNbJ5XHkevMUUDb976z
[c] claim → won=false  https://testnet.nearblocks.io/txns/3c2wFqHr2gTWgDu4ya8ppZPfTjc1hyMMwaGrajMkJTU4
winner: b
[b] escrowed 2 FUSD  https://testnet.nearblocks.io/txns/EqT8WVrZbT6aKughXHZY4HoSReZRSaCeprheSpmdhjRn
state: PENDING
[scribe-premium] settle  https://testnet.nearblocks.io/txns/AXgQiExn39Y7Et5jrJrpibU7HstyyhVFMx1fmZsSjcPb
state: PAID
provider received: 2 FUSD (payments = 1)

=== Run 2: payment never settled → provably VOID ===
[a] claim → won=false  https://testnet.nearblocks.io/txns/5pQDHqFHds9N6hZxpRsF5MEbkDkLeNAhsnwnvDAJhyyq
[b] claim → won=true  https://testnet.nearblocks.io/txns/AECoZ5HCMQJ2MPDc3m2E9UY6gEJVgixFQcJyPgGehomV
[c] claim → won=false  https://testnet.nearblocks.io/txns/Hs4sK3JMvkmaUeo3iRseMdBDWEu8pFUt2U66yhvY7NfA
[b] escrowed 0.04 FUSD  https://testnet.nearblocks.io/txns/12NstWUFfjDrCWDrAzamVw8tKDkxnCm59QyE1kvfeidq
state: PENDING (deadline in 30 s, provider stays silent)
state: EXPIRED → anyone may void
void  https://testnet.nearblocks.io/txns/CykwAvSin2LAhXjqm1ZpsMHqkvffArm4PCZ2gPxAYNEW
state: VOID
refund to b: balance back to 8 FUSD (was 8 before escrow)
job reopened: round 1, Open
```

An earlier run (same day) also produced exactly one winner from three claims; its escrow step failed before sending because the agent account
held too little NEAR for the gas prepayment. No tokens moved. The bootstrap script now tops agents up.

## Full agent flow (Day 3): `pnpm dev:providers:near` + `pnpm agents:near`

Three agents → provider directory → each picks a provider (persona rules; no LLM key was set for these runs) → claim on-chain →
the winner gets a 402 from the provider, escrows, and the provider works, then settles (pay on delivery) → losers fetch the
winner's result. Run 2026-11-09.

### Happy path (`NEAR_AUTO_APPROVE=1`)
```text
[c] claim round 0 via scribe-premium → lost  https://testnet.nearblocks.io/txns/ECDqNnUKJJBfnDQi4KsEUeqdoC5nJsgoLJrUL8fJmCve
[b] claim round 0 via scribe-b → WON  https://testnet.nearblocks.io/txns/6z4bFsehaAgRgWVBgnJE8aSjKjcdGKPqnrhG6E9HpCL6
[a] claim round 0 via scribe-b → lost  https://testnet.nearblocks.io/txns/DfFQE7CUsaZrvDw9zAhgANcNrETMgQDLkXSDvoQWZsi6
[b] escrowed 0.04 FUSD  https://testnet.nearblocks.io/txns/RrCxF9tn252icvC2ssiP1MaxShsdHLZHW3s6ML9SgrH
[b] delivered + settled  https://testnet.nearblocks.io/txns/ALd3Bc4bR68Y4b3mEnBq7c4htYb7bNHRUTpQrg8pqw5K
[c] received the winner's result from scribe-b
[a] received the winner's result from scribe-b
a PAID_BY_OTHER · b PAID_BY_ME · c PAID_BY_OTHER
payments on-chain this run: 1 [{"provider":"scribe-b","receivedFUSD":0.04}]
```

### Provider crashes after escrow (`PROVIDERS_FAIL_ONCE=scribe-b`)
```text
[a] claim round 0 via scribe-b → WON  https://testnet.nearblocks.io/txns/2vz8yS8HCABqbXp8vm8u64bKVhc7KMn3URHiau7BW5bf
[c] claim round 0 via scribe-premium → lost  https://testnet.nearblocks.io/txns/5WsdJ8VC2F2S155AWfXVua4pjhJy94UcqGjn2mbfg9Pt
[b] claim round 0 via scribe-b → lost  https://testnet.nearblocks.io/txns/tadeSK8TjncxqNGDojS4qKpWkv2mjCkZ4m2bySu4o5V
[a] escrowed 0.04 FUSD  https://testnet.nearblocks.io/txns/QNPrLzesMXr3SbmTruKiyZcQpkUkrK3scHpDTbZA2R5
[a] provider did not deliver (NOT_DELIVERED) → waiting for the deadline to void
[a] voided → refunded  https://testnet.nearblocks.io/txns/Fa7uG7QF9wwgcHXtFCyffKD9w6bz8sV3Dxibjqf7eDR9
[a] claim round 1 via scribe-b → WON  https://testnet.nearblocks.io/txns/4CejCwUHQPXDoTKKukprJXZLLnRcCiyrAnS85f1z5JCC
[c] claim round 1 via scribe-premium → lost  https://testnet.nearblocks.io/txns/7ptT4SBFaagq9SKBxsdkNdSHGLE6M3w7t1ZSxTTyAdHq
[b] claim round 1 via scribe-b → lost  https://testnet.nearblocks.io/txns/GtnxnaenmeC3UE5T6fhn7ALzCoKZkioLbQ1QGGjeMa5b
[a] escrowed 0.04 FUSD  https://testnet.nearblocks.io/txns/8vp5je5P5fiYYwJnpwvjHTgnu8T6ksLAT16kk1JJghrk
[a] delivered + settled  https://testnet.nearblocks.io/txns/hTYuSYo2HSgta2iEUHVcjpcKbJpKmPkco7EU4MjHaY7
[c] received the winner's result from scribe-b
[b] received the winner's result from scribe-b
a PAID_BY_ME · b PAID_BY_OTHER · c PAID_BY_OTHER
payments on-chain this run: 1 [{"provider":"scribe-b","receivedFUSD":0.04}]
```
The transcripts in these runs are labelled stubs because no LLM key was configured; the payment flow is the same either way.
