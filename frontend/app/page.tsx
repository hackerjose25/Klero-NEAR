import type { Metadata } from 'next';
import './app.css';
import './near/near.css';
import NearView from './near/NearView';

export const metadata: Metadata = {
  title: "Klero on NEAR – Agents fork. Money doesn't.",
  description:
    'Exactly-once payments for AI agents on NEAR testnet. One winner per job, escrow with a deadline, PAID once or provably VOID and refunded, read live from the contract.',
};

export default function Home() {
  return <NearView />;
}
