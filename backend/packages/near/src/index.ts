// Thin client for the Phoebe contract on NEAR. Used by the agents, the providers and the scripts.
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

/** Secrets key id of an agent's claim-only function-call key for a given contract. */
export const claimKeyId = (agent: string, contractId: string) => `${agent}#claim@${contractId}`;

export const intentIdOf = (jobKey: string, round: number) => `${jobKey}:${round}`;
export const nearblocksTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

export class PhoebeNear {
  readonly provider: JsonRpcProvider;
  constructor(readonly d: NearDeployment = loadNearDeployment()) {
    this.provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? d.rpc });
  }

  account(id: string, key: KeyPairString) {
    return new Account(id, this.provider, key);
  }

  /** Read-only call, retried on network errors (public testnet RPCs drop connections now and then). */
  private async view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return (await this.provider.callFunction({ contractId, method, args })) as T;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? '');
        if (i >= 3 || !/fetch failed|ECONNRESET|ETIMEDOUT|socket|network|50[234]/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
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
  cap(human: string) {
    return this.view<string | null>(this.d.contractId, 'get_cap', { human });
  }
  /** Operator: record a human's World ID approval for one over-cap payment. */
  approveOvercap(operator: Account, jobKey: string, round: number, maxAmount: string) {
    return this.call(operator, this.d.contractId, 'approve_overcap', { job_key: jobKey, round, max_amount: maxAmount });
  }
  /** Operator: close a claimed round that never escrowed (e.g. approval denied). No money moved. */
  abandonRound(operator: Account, jobKey: string) {
    return this.call(operator, this.d.contractId, 'abandon_round', { job_key: jobKey });
  }
  /** Poll until the intent leaves a transitional state (SETTLING / VOIDING). */
  async settledState(intentId: string, timeoutMs = 30_000): Promise<IntentState | null> {
    const start = Date.now();
    for (;;) {
      const st = await this.intentState(intentId);
      if ((st !== 'SETTLING' && st !== 'VOIDING') || Date.now() - start > timeoutMs) return st;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  link(agent: string) {
    return this.view<{ human: string; epoch: number; active: boolean } | null>(this.d.contractId, 'get_link', { agent });
  }
  async balance(accountId: string) {
    return BigInt(await this.view<string>(this.d.token.id, 'ft_balance_of', { account_id: accountId }));
  }

  private async call(signer: Account, contractId: string, methodName: string, args: object, deposit = 0n, gas = 50n * TGAS) {
    // FINAL: wait for every receipt (cross-contract transfer + callback), not just the first one
    const r = await signer.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
    return { hash: r.transaction.hash as string, result: getTransactionLastResult(r as never) as unknown };
  }

  /** Sign with the agent's claim-only key. Returns whether this agent won the round. */
  async claim(claimer: Account, jobKey: string, round: number, providerAccount: string) {
    const r = await this.call(claimer, this.d.contractId, 'claim', { job_key: jobKey, round, provider: providerAccount });
    return { won: r.result === true, hash: r.hash };
  }

  /** Winner escrows `amount` (token base units) on the Phoebe contract via NEP-141 ft_transfer_call. */
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
