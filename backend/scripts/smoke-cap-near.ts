// On-chain policy proof: an agent that skips the approver and escrows above the human's cap is refused by the
// contract itself, and the token refunds it automatically. No money moves.
// Usage: pnpm smoke:cap:near
import { createHash } from 'node:crypto';
import { PhoebeNear, claimKeyId, intentIdOf, loadNearKeys, nearblocksTx } from '@klero/near';

const near = new PhoebeNear();
const keys = loadNearKeys();
const agent = near.d.agents[0]!;
const premium = near.d.providers['scribe-premium']!;
const jobKey = createHash('sha256').update(`cap-proof|${Date.now()}`).digest('hex');

const cap = await near.cap(near.d.human.humanHash);
console.log(`human cap on-chain: ${Number(cap) / 1e6} FUSD; trying to escrow ${Number(premium.price) / 1e6} FUSD with no approval`);
const c = await near.claim(near.account(agent, keys[claimKeyId(agent, near.d.contractId)]!), jobKey, 0, premium.accountId);
console.log(`claim → won=${c.won}  ${nearblocksTx(c.hash)}`);

const before = await near.balance(agent);
const e = await near.escrow(near.account(agent, keys[agent]!), jobKey, 0, premium.price, 120);
const after = await near.balance(agent);
console.log(`escrow tx  ${nearblocksTx(e.hash)}`);
console.log(`intent created: ${(await near.intent(intentIdOf(jobKey, 0))) !== null}`);
console.log(`agent balance: ${Number(before) / 1e6} → ${Number(after) / 1e6} FUSD (refunded by the token: ${before === after})`);
if ((await near.intent(intentIdOf(jobKey, 0))) !== null || before !== after) throw new Error('cap was NOT enforced');
console.log('OK: the contract refused the over-cap escrow (ft_on_transfer panicked: "over cap: human approval required")');
