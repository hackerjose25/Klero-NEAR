#!/usr/bin/env -S npx tsx
import { Mirror } from '@forkos/shared';
import { Command } from 'commander';
import { audit } from './audit';

const program = new Command().name('klero').description('Verify Klero agent payments');

program
  .command('audit')
  .requiredOption('--topic <id>', 'ForkOS HCS topic id')
  .requiredOption('--operator <id>', 'ForkOS operator account (publisher of INTENT/SETTLED/VOID)')
  .option('--providers <ids>', 'comma-separated provider accounts (for REFUND)', '')
  .option('--job <jobKey>', 'only this job')
  .option('--mirror <url>', 'Mirror Node base URL', 'https://testnet.mirrornode.hedera.com')
  .action(async (o) => {
    const r = await audit({ topic: o.topic, operator: o.operator, providers: o.providers ? o.providers.split(',') : [], mirrorUrl: o.mirror, job: o.job });
    for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.job.slice(0, 16)}  ${c.check.padEnd(20)} ${c.detail}`);
    console.log(`\n${r.jobs} jobs, ${r.checks.length} checks — ${r.ok ? 'ALL PASSED' : 'VIOLATIONS FOUND'}`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('audit-near')
  .description('Replay the Klero NEAR contract from public data and check every job')
  .option('--contract <id>', 'Klero contract', 'klero-v2.klero-mw8x6bn1.testnet')
  .option('--token <id>', 'NEP-141 payment token', 'fusd.klero-mw8x6bn1.testnet')
  .option('--rpc <url>', 'NEAR RPC', 'https://test.rpc.fastnear.com')
  .option('--archival <url>', 'archival NEAR RPCs, comma-separated, tried in order', 'https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org')
  .option('--nearblocks <url>', 'NearBlocks API (only used to list tx hashes)', 'https://api-testnet.nearblocks.io')
  .option('--job <prefix>', 'only jobs whose key starts with this')
  .action(async (o) => {
    const { auditNear } = await import('./audit-near');
    const r = await auditNear({ ...o, log: (s: string) => console.log(s) });
    for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.job.slice(0, 16)}  ${c.check.padEnd(22)} ${c.detail}`);
    console.log(`\n${r.jobs} jobs, ${r.events} events, ${r.checks.length} checks — ${r.ok ? 'ALL PASSED' : 'VIOLATIONS FOUND'}`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('intent <txId> <deadline>')
  .description('Resolve one payment intent: PAID, FAILED, VOID or UNKNOWN')
  .action(async (txId: string, deadline: string) => {
    const { resolveIntent } = await import('@forkos/x402-hedera');
    console.log(await resolveIntent(new Mirror(), txId, Number(deadline)));
  });

await program.parseAsync();
