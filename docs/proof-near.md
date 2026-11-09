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
