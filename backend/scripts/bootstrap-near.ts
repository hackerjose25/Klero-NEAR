// Sets up Phoebe on NEAR testnet: operator, token, contract, providers, one human with three agents.
// Usage: pnpm bootstrap:near   (safe to re-run: every step skips what already exists)
//
// Keys are appended to .secrets/near-testnet-keys.json the moment an account exists on-chain,
// so an interrupted run never orphans a funded account.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from 'near-api-js';

const RPC = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const FAUCET = 'https://helper.nearprotocol.com/account';
const SECRETS = '.secrets/near-testnet-keys.json';
const DEPLOY = 'deployments/near-testnet.json';
const WASM = '../contracts/target/wasm32-unknown-unknown/release';
const TGAS = 1_000_000_000_000n;

const provider = new JsonRpcProvider({ url: RPC });
mkdirSync('.secrets', { recursive: true });
mkdirSync('deployments', { recursive: true });

type Secrets = { operator?: string; keys: Record<string, KeyPairString> };
const secrets: Secrets = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : { keys: {} };
const saveSecrets = () => writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));

const log = (...a: unknown[]) => console.log('•', ...a);
const exists = async (id: string) => {
  try {
    await new Account(id, provider).getState();
    return true;
  } catch {
    return false;
  }
};
const acct = (id: string) => new Account(id, provider, secrets.keys[id]);
const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args }) as Promise<T>;

function keyFor(id: string): KeyPair {
  if (!secrets.keys[id]) {
    secrets.keys[id] = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
    saveSecrets();
  }
  return KeyPair.fromString(secrets.keys[id]);
}

// ---------- 1. operator (funded by the testnet faucet) ----------
if (!secrets.operator) {
  secrets.operator = `klero-${Date.now().toString(36)}.testnet`;
  saveSecrets();
}
const OP = secrets.operator;
if (!(await exists(OP))) {
  const pk = keyFor(OP).getPublicKey().toString();
  log(`creating ${OP} via faucet`);
  const r = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: OP, newAccountPublicKey: pk }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${await r.text()}`);
  for (let i = 0; i < 20 && !(await exists(OP)); i++) await new Promise((s) => setTimeout(s, 1500));
  if (!(await exists(OP))) throw new Error(`${OP} not visible after faucet call`);
}
const op = acct(OP);
log(`operator ${OP}`);

// Testnet top-up: the faucet funds a throwaway account, which is deleted with the operator as beneficiary.
async function faucetTopUp() {
  const tmp = `tmp-${Date.now().toString(36)}.testnet`;
  const kp = KeyPair.fromRandom('ed25519');
  const r = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: tmp, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${await r.text()}`);
  for (let i = 0; i < 20 && !(await exists(tmp)); i++) await new Promise((s) => setTimeout(s, 1500));
  await new Account(tmp, provider, kp.toString() as KeyPairString).deleteAccount(OP);
  log(`faucet top-up via ${tmp} → ${OP}`);
}
const opAvailable = async () => BigInt((await op.getState()).balance.available);

// ---------- 2. sub-accounts ----------
const FUSD = `fusd.${OP}`;
// v2 adds on-chain spend caps + approvals (state layout changed, so it is a new account; v1 `klero.` is kept as history)
const PHOEBE = `klero-v2.${OP}`;
const CAP = '1000000'; // 1 FUSD per payment; above it, a World ID approval is required
const HUMAN = `human.${OP}`;
const PROVIDERS = { 'scribe-a': '50000', 'scribe-b': '40000', 'scribe-premium': '2000000' } as const;
const AGENTS = ['a', 'b', 'c'].map((p) => `${p}.${HUMAN}`);

async function sub(parent: Account, id: string, near: `${number}`) {
  if (await exists(id)) return;
  const prefix = id.slice(0, id.length - parent.accountId.length - 1);
  await parent.createSubAccount({
    accountOrPrefix: prefix,
    publicKey: keyFor(id).getPublicKey(),
    nearToTransfer: nearToYocto(near),
  });
  log(`created ${id} (${near} NEAR)`);
}

await sub(op, FUSD, '2.5');
if (!(await exists(PHOEBE)) && (await opAvailable()) < nearToYocto('4')) await faucetTopUp();
await sub(op, PHOEBE, '3.0');
for (const name of Object.keys(PROVIDERS)) await sub(op, `${name}.${OP}`, '0.1');
await sub(op, HUMAN, '0.8');
for (const a of AGENTS) await sub(acct(HUMAN), a, '0.2');
// agents prepay gas for escrow (~0.05 NEAR per call): keep at least 0.4 NEAR each
for (const a of AGENTS) {
  const avail = BigInt((await new Account(a, provider).getState()).balance.available);
  if (avail < nearToYocto('0.4')) {
    await op.transfer({ receiverId: a, amount: nearToYocto('0.3') });
    log(`topped up ${a} (+0.3 NEAR)`);
  }
}

// ---------- 3. contracts ----------
async function deploy(id: string, file: string, init: Record<string, unknown>) {
  const code = await acct(id).getContractCode().catch(() => null);
  if (code && code.code?.length) return log(`${id} already deployed`);
  await acct(id).deployContract(readFileSync(`${WASM}/${file}`));
  await acct(id).callFunction({ contractId: id, methodName: 'new', args: init, gas: 30n * TGAS });
  log(`deployed ${file} → ${id}`);
}
await deploy(FUSD, 'fusd.wasm', { owner: OP });
await deploy(PHOEBE, 'klero.wasm', { operator: OP, token: FUSD });

// ---------- 4. token registrations + demo balances ----------
for (const id of [PHOEBE, ...Object.keys(PROVIDERS).map((n) => `${n}.${OP}`)]) {
  const bal = await view<unknown>(FUSD, 'storage_balance_of', { account_id: id });
  if (bal) continue;
  await op.callFunction({
    contractId: FUSD,
    methodName: 'storage_deposit',
    args: { account_id: id },
    deposit: nearToYocto('0.00125'),
    gas: 30n * TGAS,
  });
  log(`registered ${id} on FUSD`);
}
for (const a of AGENTS) {
  const bal = BigInt(await view<string>(FUSD, 'ft_balance_of', { account_id: a }));
  if (bal > 0n) continue;
  await op.callFunction({
    contractId: FUSD,
    methodName: 'mint',
    args: { account_id: a, amount: '10000000' },
    gas: 30n * TGAS,
  });
  log(`minted 10 FUSD → ${a}`);
}

// ---------- 5. link agents to the human ----------
// Placeholder until the World ID flow is wired to NEAR: a stable hash for the demo human.
const humanHash = createHash('sha256').update(`demo-human:${HUMAN}`).digest('hex');
for (const a of AGENTS) {
  if (await view<unknown>(PHOEBE, 'get_link', { agent: a })) continue;
  await op.callFunction({
    contractId: PHOEBE,
    methodName: 'link_agent',
    args: { agent: a, human: humanHash, epoch: 1 },
    gas: 30n * TGAS,
  });
  log(`linked ${a}`);
}

// ---------- 5b. on-chain spend cap for the human ----------
const cap = await view<string | null>(PHOEBE, 'get_cap', { human: humanHash });
if (cap !== CAP) {
  await op.callFunction({ contractId: PHOEBE, methodName: 'set_cap', args: { human: humanHash, cap: CAP }, gas: 30n * TGAS });
  log(`cap for the human set to ${Number(CAP) / 1e6} FUSD`);
}

// ---------- 6. scoped agent keys ----------
// Each agent also gets a function-call key that can ONLY call `claim` on the Phoebe contract,
// with a 0.25 NEAR gas allowance. It cannot move tokens or touch any other contract.
for (const a of AGENTS) {
  const id = `${a}#claim@${PHOEBE}`; // one claim key per contract
  const kp = keyFor(id);
  const onChain = await acct(a).getAccessKey(kp.getPublicKey()).then(() => true, () => false);
  if (onChain) continue;
  await acct(a).addFunctionCallAccessKey({
    publicKey: kp.getPublicKey(),
    contractId: PHOEBE,
    methodNames: ['claim'],
    allowance: nearToYocto('0.25'),
  });
  log(`added claim-only key to ${a}`);
}

// ---------- 7. write deployment ----------
const deployment = {
  network: 'near:testnet',
  rpc: RPC,
  createdAt: new Date().toISOString(),
  operatorId: OP,
  contractId: PHOEBE,
  token: { id: FUSD, symbol: 'FUSD', decimals: 6 },
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([n, price]) => [n, { accountId: `${n}.${OP}`, price }]),
  ),
  human: { accountId: HUMAN, humanHash },
  agents: AGENTS,
  spendCap: CAP,
  previousContracts: [`klero.${OP}`],
  explorer: `https://testnet.nearblocks.io/address/${PHOEBE}`,
};
writeFileSync(DEPLOY, JSON.stringify(deployment, null, 2));
log(`wrote ${DEPLOY}`);
console.log(await view(PHOEBE, 'get_config'));
