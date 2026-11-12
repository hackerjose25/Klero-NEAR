import type { Metadata } from 'next';
import '../app.css';
import './near.css';
import NearView from './NearView';

export const metadata: Metadata = {
  title: 'Phoebe on NEAR: live contract state',
  description:
    'Exactly-once payments for AI agents on NEAR testnet. Every job and payment below is read live from the Phoebe contract: PAID once, or provably VOID and refunded.',
};

export default function NearPage() {
  return <NearView />;
}
