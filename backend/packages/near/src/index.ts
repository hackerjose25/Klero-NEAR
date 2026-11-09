// Thin client for the Klero contract on NEAR. Used by the agents, the providers and the scripts.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, getTransactionLastResult, type KeyPairString } from 'near-api-js';

export const TGAS = 1_000_000_000_000n;
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type NearDeployment = {
  network: string;
  rpc: string;
  operatorId: string;
  contractId: string;
  token: { id: string; symbol: string; decimals: number };
  providers: Record<string, { accountId: string; price: string }>;
  human: { accountId: string; humanHash: string };
  agents: string[];
};

export type JobStatus = 'Open' | 'Claimed' | 'Paying' | 'Paid';
export type NearJob = {
  human: string;
  round: number;
  winner: string | null;
  provider: string | null;
  status: JobStatus;
  intent_id: string | null;
};
export type IntentState = 'PENDING' | 'EXPIRED' | 'SETTLING' | 'VOIDING' | 'PAID' | 'VOID';
export type NearIntent = {
  job_key: string;
  round: number;
  payer: string;
  provider: string;
  amount: string;
  created_ns: number;
  deadline_ns: number;
  status: 'Escrowed' | 'Settling' | 'Paid' | 'Voiding' | 'Void';
};

export function loadNearDeployment(path = join(BACKEND, 'deployments', 'near-testnet.json')): NearDeployment {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Local testnet keys written by `pnpm bootstrap:near` (never committed). */
export function loadNearKeys(path = join(BACKEND, '.secrets', 'near-testnet-keys.json')): Record<string, KeyPairString> {
  if (!existsSync(path)) throw new Error(`${path} missing: run pnpm bootstrap:near first`);
  return JSON.parse(readFileSync(path, 'utf8')).keys;
}

export const intentIdOf = (jobKey: string, round: number) => `${jobKey}:${round}`;
export const nearblocksTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

export class KleroNear {
  readonly provider: JsonRpcProvider;
  constructor(readonly d: NearDeployment = loadNearDeployment()) {
    this.provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? d.rpc });
  }

  account(id: string, key: KeyPairString) {
    return new Account(id, this.provider, key);
  }

  private view<T>(contractId: string, method: string, args: Record<string, unknown>) {
    return this.provider.callFunction({ contractId, method, args }) as Promise<T>;
  }

  job(jobKey: string) {
    return this.view<NearJob | null>(this.d.contractId, 'get_job', { job_key: jobKey });
  }
  intent(intentId: string) {
    return this.view<NearIntent | null>(this.d.contractId, 'get_intent', { intent_id: intentId });
  }
  intentState(intentId: string) {
    return this.view<IntentState | null>(this.d.contractId, 'get_intent_state', { intent_id: intentId });
  }
  link(agent: string) {
    return this.view<{ human: string; epoch: number; active: boolean } | null>(this.d.contractId, 'get_link', { agent });
  }
  async balance(accountId: string) {
    return BigInt(await this.view<string>(this.d.token.id, 'ft_balance_of', { account_id: accountId }));
  }

  private async call(signer: Account, contractId: string, methodName: string, args: object, deposit = 0n, gas = 50n * TGAS) {
    const r = await signer.callFunctionRaw({ contractId, methodName, args, deposit, gas });
    return { hash: r.transaction.hash as string, result: getTransactionLastResult(r as never) as unknown };
  }

  /** Sign with the agent's claim-only key. Returns whether this agent won the round. */
  async claim(claimer: Account, jobKey: string, round: number, providerAccount: string) {
    const r = await this.call(claimer, this.d.contractId, 'claim', { job_key: jobKey, round, provider: providerAccount });
    return { won: r.result === true, hash: r.hash };
  }

  /** Winner escrows `amount` (token base units) on the Klero contract via NEP-141 ft_transfer_call. */
  async escrow(payer: Account, jobKey: string, round: number, amount: string, ttlS = 120) {
    const msg = JSON.stringify({ job_key: jobKey, round, ttl_s: ttlS });
    return this.call(payer, this.d.token.id, 'ft_transfer_call', { receiver_id: this.d.contractId, amount, msg }, 1n);
  }

  settle(signer: Account, intentId: string) {
    return this.call(signer, this.d.contractId, 'settle', { intent_id: intentId });
  }

  voidIntent(signer: Account, intentId: string) {
    return this.call(signer, this.d.contractId, 'void_intent', { intent_id: intentId });
  }
}
