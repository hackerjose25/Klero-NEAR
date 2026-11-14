'use client';

import { useCallback, useEffect, useState } from 'react';

// Public testnet facts (backend/deployments/near-testnet.json). Nothing here is trusted: every state is read live from the chain.
const RPC = 'https://test.rpc.fastnear.com';
const NB = 'https://testnet.nearblocks.io';
const OPERATOR = 'klero-mw8x6bn1.testnet';
const V2 = 'klero-v2.klero-mw8x6bn1.testnet';
const V1 = 'klero.klero-mw8x6bn1.testnet';
const TOKEN = 'fusd.klero-mw8x6bn1.testnet';
const HUMAN = 'human.klero-mw8x6bn1.testnet';
const AGENTS = ['a', 'b', 'c'].map((x) => `${x}.${HUMAN}`);
const DECIMALS = 6;

type DiscoveredJob = { contract: string; key: string; txHash: string; timestamp: string };

type Job = { human: string; round: number; winner: string | null; provider: string | null; status: string; intent_id: string | null };
type Intent = { job_key: string; round: number; payer: string; provider: string; amount: string; created_ns: number; deadline_ns: number; status: string };
type Row = { round: number; intent: Intent | null; state: string | null };
type Loaded = { job: Job | null; rows: Row[]; cap: string | null };

async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'near-page',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

async function loadJob(contract: string, key: string): Promise<Loaded> {
  const job = await view<Job | null>(contract, 'get_job', { job_key: key });
  if (!job) return { job: null, rows: [], cap: null };
  const rows = await Promise.all(
    Array.from({ length: job.round + 1 }, async (_, round) => {
      const id = `${key}:${round}`;
      const [intent, state] = await Promise.all([
        view<Intent | null>(contract, 'get_intent', { intent_id: id }),
        view<string | null>(contract, 'get_intent_state', { intent_id: id }),
      ]);
      return { round, intent, state };
    }),
  );
  const cap = contract === V2 ? await view<string | null>(contract, 'get_cap', { human: job.human }).catch(() => null) : null;
  return { job, rows, cap };
}

const fusd = (base: string) => (Number(base) / 10 ** DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (acct: string) => acct.replace(`.${OPERATOR}`, '');
const acctLink = (a: string) => `${NB}/address/${a}`;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StateBadge({ state }: { state: string | null }) {
  const s = state ?? 'NO ESCROW';
  const cls = s === 'PAID' ? 'ok' : s === 'VOID' ? 'void' : s === 'EXPIRED' ? 'warn' : s === 'NO ESCROW' ? 'none' : 'info';
  return <span className={`nr-badge nr-${cls}`}>{s}</span>;
}

function Clock({ intent, state }: { intent: Intent; state: string | null }) {
  const live = state === 'PENDING';
  const now = useNow(live);
  if (!live) return null;
  const left = Math.max(0, Math.round(intent.deadline_ns / 1e6 - now) / 1000);
  return <span className="nr-clock">settle window closes in {left.toFixed(1)} s, then anyone may void</span>;
}

function JobCard({ contract, jobKey, label, timestamp }: { contract: string; jobKey: string; label?: string; timestamp?: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    loadJob(contract, jobKey).then(setData, (e) => setErr(String(e)));
  }, [contract, jobKey]);
  useEffect(load, [load]);

  const paid = data?.rows.filter((r) => r.state === 'PAID').length ?? 0;
  return (
    <article className="nr-card">
      <header className="nr-card-head">
        <div>
          {label && <p className="nr-label">{label}</p>}
          <p className="mono">
            job {jobKey.slice(0, 16)}… · <a href={acctLink(contract)} target="_blank" rel="noreferrer">{contract === V2 ? 'contract v2' : 'contract v1'}</a>
          </p>
          {timestamp && <p className="nr-micro">Recorded: {new Date(Number(timestamp) / 1_000_000).toLocaleString()}</p>}
        </div>
        <div className="nr-count">
          <span className="num">{data ? paid : '–'}</span>
          <span className="nr-micro">payments</span>
        </div>
      </header>
      {err && <p className="nr-err">Could not read the contract: {err} <button onClick={load}>retry</button></p>}
      {!data && !err && <p className="nr-micro">reading the contract…</p>}
      {data && !data.job && <p className="nr-micro">No such job on this contract.</p>}
      {data?.job && (
        <>
          <table className="nr-table">
            <thead>
              <tr><th>Round</th><th>Payment</th><th>Payer → provider</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.round}>
                  <td className="num">{r.round}</td>
                  <td><StateBadge state={r.state} />{r.intent && <Clock intent={r.intent} state={r.state} />}</td>
                  <td className="mono">
                    {r.intent ? (
                      <>
                        <a href={acctLink(r.intent.payer)} target="_blank" rel="noreferrer">{short(r.intent.payer)}</a> →{' '}
                        <a href={acctLink(r.intent.provider)} target="_blank" rel="noreferrer">{short(r.intent.provider)}</a>
                      </>
                    ) : r.round === data.job!.round ? (
                      data.job!.winner ? `winner ${short(data.job!.winner)}, awaiting escrow` : 'open'
                    ) : (
                      'abandoned or refused: no money moved'
                    )}
                  </td>
                  <td className="num">{r.intent ? `${fusd(r.intent.amount)} FUSD` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="nr-micro">
            job status <b>{data.job.status}</b> · current round {data.job.round}
            {data.cap && <> · human cap {fusd(data.cap)} FUSD per payment</>}
          </p>
        </>
      )}
    </article>
  );
}

export default function NearView() {
  const [q, setQ] = useState('');
  const [lookup, setLookup] = useState<{ contract: string; key: string } | null>(null);
  const [contract, setContract] = useState(V2);
  const [jobs, setJobs] = useState<DiscoveredJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadJobs = async () => {
      try {
        const response = await fetch('http://localhost:4050/jobs');
        if (!response.ok) throw new Error(`Provider API returned ${response.status}`);

        const result = (await response.json()) as DiscoveredJob[];
        if (!Array.isArray(result)) throw new Error('Invalid jobs response');

        if (active) {
          setJobs(result);
          setJobsError(null);
        }
      } catch (error) {
        if (active) setJobsError(error instanceof Error ? error.message : 'Could not load jobs');
      } finally {
        if (active) setJobsLoading(false);
      }
    };

    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 30_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="sp nr">
      <main className="nr-wrap">
        <p className="nr-kicker">NEAR testnet · live</p>
        <h1 className="nr-h1">Agents fork. Money doesn’t.</h1>
        <p className="nr-lead">
          Three AI agents of one human race for the same job. The Phoebe contract on NEAR picks one winner, holds the payment in escrow, and
          ends it exactly one way: <b>PAID</b> once by the provider before the deadline, or <b>VOID</b> and refunded after it. Every row
          below is discovered through NearBlocks by our server; job state and payment details are read live from the contract in your browser.
        </p>

        <section className="nr-facts">
          <a href={acctLink(V2)} target="_blank" rel="noreferrer"><span className="nr-micro">Contract</span><span className="mono">{V2}</span></a>
          <a href={acctLink(TOKEN)} target="_blank" rel="noreferrer"><span className="nr-micro">Token (NEP-141, 6 dp)</span><span className="mono">{TOKEN}</span></a>
          <a href={acctLink(HUMAN)} target="_blank" rel="noreferrer"><span className="nr-micro">Human</span><span className="mono">{HUMAN}</span></a>
          <div>
            <span className="nr-micro">Agents (sub-accounts, claim-only keys)</span>
            {AGENTS.map((a) => (
              <a key={a} className="mono" href={acctLink(a)} target="_blank" rel="noreferrer">{a}</a>
            ))}
          </div>
        </section>

        <section>
          <h2 className="nr-h2">Look up any job</h2>
          <form
            className="nr-form"
            onSubmit={(e) => {
              e.preventDefault();
              const key = q.trim();
              if (key) setLookup({ contract, key });
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="job key (64 hex chars)" aria-label="job key" />
            <select value={contract} onChange={(e) => setContract(e.target.value)} aria-label="contract">
              <option value={V2}>v2</option>
              <option value={V1}>v1</option>
            </select>
            <button type="submit">Read</button>
          </form>
          {lookup && <JobCard key={`${lookup.contract}:${lookup.key}`} contract={lookup.contract} jobKey={lookup.key} />}
        </section>

        <section>
          <h2 className="nr-h2">Recently discovered jobs</h2>
          <div className="nr-grid">
            {jobsLoading && <p>Discovering jobs from NEAR testnet...</p>}
            {jobsError && <p role="alert">Could not load jobs: {jobsError}</p>}
            {!jobsLoading && !jobsError && jobs.length === 0 && <p>No jobs discovered yet.</p>}
            {jobs.map((job) => (
              <JobCard
                key={`${job.contract}:${job.key}`}
                contract={job.contract}
                jobKey={job.key}
                timestamp={job.timestamp}
              />
            ))}
          </div>
          <p className="nr-micro">Job discovery powered by <a href="https://nearblocks.io" target="_blank" rel="noreferrer">NearBlocks</a>.</p>
        </section>

        <section className="nr-verify">
          <h2 className="nr-h2">Don’t trust this page either</h2>
          <p>
            Run <code>pnpm audit:near</code> in <code>backend/</code>. It replays every job from NearBlocks and an archival RPC and checks
            one winner per round, paid at most once, the cap, and every settlement and refund against the token’s transfers. Source and
            proof: <a href="https://github.com/hackerjose25/Phoebe-NEARHack" target="_blank" rel="noreferrer">github.com/hackerjose25/Phoebe-NEARHack</a>.

          </p>
        </section>
      </main>
    </div>
  );
}
