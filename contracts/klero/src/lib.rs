//! Klero on NEAR: exactly-once payments for AI agents.
//!
//! 1. The operator links agents to a human (after a World ID check off-chain).
//! 2. Agents of one human `claim` a job. The first claim in a round wins; the rest wait for the result.
//! 3. The winner escrows the payment with `ft_transfer_call` on the FUSD token. This creates one
//!    intent per (job, round), with a deadline.
//! 4. Before the deadline the provider can `settle` (pays provider → PAID).
//!    After the deadline anyone can `void_intent` (refunds payer → VOID).
//!    The two windows don't overlap, so each intent ends exactly one way.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const MIN_TTL_S: u64 = 30;
const MAX_TTL_S: u64 = 600;
const NS: u64 = 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Links,
    Jobs,
    Intents,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub human: String,
    pub epoch: u32,
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus {
    Open,
    Claimed,
    Paying,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Job {
    pub human: String,
    pub round: u32,
    pub winner: Option<AccountId>,
    pub provider: Option<AccountId>,
    pub status: JobStatus,
    pub intent_id: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum IntentStatus {
    Escrowed,
    Settling,
    Paid,
    Voiding,
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Intent {
    pub job_key: String,
    pub round: u32,
    pub payer: AccountId,
    pub provider: AccountId,
    pub amount: U128,
    pub created_ns: u64,
    pub deadline_ns: u64,
    pub status: IntentStatus,
}

/// What the payer sends as `msg` in `ft_transfer_call`.
#[near(serializers = [json])]
pub struct EscrowMsg {
    pub job_key: String,
    pub round: u32,
    pub ttl_s: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Klero {
    operator: AccountId,
    token: AccountId,
    links: LookupMap<AccountId, Link>,
    jobs: LookupMap<String, Job>,
    intents: LookupMap<String, Intent>,
}

pub fn intent_id_of(job_key: &str, round: u32) -> String {
    format!("{job_key}:{round}")
}

fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": "klero", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

#[near]
impl Klero {
    #[init]
    pub fn new(operator: AccountId, token: AccountId) -> Self {
        Self {
            operator,
            token,
            links: LookupMap::new(StorageKey::Links),
            jobs: LookupMap::new(StorageKey::Jobs),
            intents: LookupMap::new(StorageKey::Intents),
        }
    }

    // ---------- operator ----------

    /// Link (or re-link with a higher epoch) an agent account to a human.
    pub fn link_agent(&mut self, agent: AccountId, human: String, epoch: u32) {
        self.assert_operator();
        if let Some(old) = self.links.get(&agent) {
            require!(epoch > old.epoch, "epoch must increase");
        }
        self.links.insert(agent.clone(), Link { human: human.clone(), epoch, active: true });
        emit("link", json!({ "agent": agent, "human": human, "epoch": epoch }));
    }

    pub fn unlink_agent(&mut self, agent: AccountId) {
        self.assert_operator();
        let mut link = self.links.get(&agent).cloned().unwrap_or_else(|| env::panic_str("not linked"));
        link.active = false;
        self.links.insert(agent.clone(), link);
        emit("unlink", json!({ "agent": agent }));
    }

    /// Close a round whose winner never escrowed (e.g. human approval never came). No money moved.
    pub fn abandon_round(&mut self, job_key: String) {
        self.assert_operator();
        let mut job = self.job(&job_key);
        require!(job.status == JobStatus::Claimed, "only a claimed, unpaid round can be abandoned");
        let closed = job.round;
        job.round += 1;
        job.status = JobStatus::Open;
        job.winner = None;
        job.provider = None;
        self.jobs.insert(job_key.clone(), job);
        emit("abandon", json!({ "job_key": job_key, "round": closed }));
    }

    // ---------- agents ----------

    /// Returns true if the caller won this round.
    pub fn claim(&mut self, job_key: String, round: u32, provider: AccountId) -> bool {
        let agent = env::predecessor_account_id();
        let link = self.active_link(&agent);
        let mut job = self.jobs.get(&job_key).cloned().unwrap_or(Job {
            human: link.human.clone(),
            round: 0,
            winner: None,
            provider: None,
            status: JobStatus::Open,
            intent_id: None,
        });
        require!(job.human == link.human, "job belongs to another human");
        require!(round == job.round, "wrong round");

        let won = job.status == JobStatus::Open;
        if won {
            job.winner = Some(agent.clone());
            job.provider = Some(provider.clone());
            job.status = JobStatus::Claimed;
            self.jobs.insert(job_key.clone(), job);
        }
        emit(
            "claim",
            json!({ "job_key": job_key, "round": round, "agent": agent, "provider": provider, "won": won }),
        );
        won
    }

    // ---------- settlement ----------

    /// Provider (or operator) collects before the deadline.
    pub fn settle(&mut self, intent_id: String) -> Promise {
        let mut it = self.intent(&intent_id);
        let caller = env::predecessor_account_id();
        require!(caller == it.provider || caller == self.operator, "only provider or operator");
        require!(it.status == IntentStatus::Escrowed, "intent is not escrowed");
        require!(env::block_timestamp() <= it.deadline_ns, "deadline passed: intent can only be voided");
        it.status = IntentStatus::Settling;
        self.intents.insert(intent_id.clone(), it.clone());

        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(it.provider.clone(), it.amount, Some(format!("klero:{intent_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settled(intent_id))
    }

    /// Anyone can void after the deadline; the payer is refunded.
    pub fn void_intent(&mut self, intent_id: String) -> Promise {
        let mut it = self.intent(&intent_id);
        require!(it.status == IntentStatus::Escrowed, "intent is not escrowed");
        require!(env::block_timestamp() > it.deadline_ns, "deadline not reached");
        it.status = IntentStatus::Voiding;
        self.intents.insert(intent_id.clone(), it.clone());

        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(it.payer.clone(), it.amount, Some(format!("klero-void:{intent_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_voided(intent_id))
    }

    #[private]
    pub fn on_settled(&mut self, intent_id: String, #[callback_result] r: Result<(), PromiseError>) -> bool {
        let mut it = self.intent(&intent_id);
        if r.is_err() {
            it.status = IntentStatus::Escrowed; // transfer failed: retry settle, or void after deadline
            self.intents.insert(intent_id, it);
            return false;
        }
        it.status = IntentStatus::Paid;
        let mut job = self.job(&it.job_key);
        job.status = JobStatus::Paid;
        self.jobs.insert(it.job_key.clone(), job);
        emit(
            "settled",
            json!({ "intent_id": intent_id, "provider": it.provider, "amount": it.amount }),
        );
        self.intents.insert(intent_id, it);
        true
    }

    #[private]
    pub fn on_voided(&mut self, intent_id: String, #[callback_result] r: Result<(), PromiseError>) -> bool {
        let mut it = self.intent(&intent_id);
        if r.is_err() {
            it.status = IntentStatus::Escrowed;
            self.intents.insert(intent_id, it);
            return false;
        }
        it.status = IntentStatus::Void;
        // The job reopens in a fresh round; this intent id can never be reused.
        let mut job = self.job(&it.job_key);
        job.round += 1;
        job.status = JobStatus::Open;
        job.winner = None;
        job.provider = None;
        job.intent_id = None;
        self.jobs.insert(it.job_key.clone(), job);
        emit("void", json!({ "intent_id": intent_id, "payer": it.payer, "amount": it.amount }));
        self.intents.insert(intent_id, it);
        true
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Value {
        json!({ "operator": self.operator, "token": self.token })
    }

    pub fn get_link(&self, agent: AccountId) -> Option<Link> {
        self.links.get(&agent).cloned()
    }

    pub fn get_job(&self, job_key: String) -> Option<Job> {
        self.jobs.get(&job_key).cloned()
    }

    pub fn get_intent(&self, intent_id: String) -> Option<Intent> {
        self.intents.get(&intent_id).cloned()
    }

    /// PAID, VOID, PENDING (settle still possible) or EXPIRED (anyone may void now).
    pub fn get_intent_state(&self, intent_id: String) -> Option<String> {
        let it = self.intents.get(&intent_id)?;
        let s = match it.status {
            IntentStatus::Paid => "PAID",
            IntentStatus::Void => "VOID",
            IntentStatus::Settling => "SETTLING",
            IntentStatus::Voiding => "VOIDING",
            IntentStatus::Escrowed if env::block_timestamp() > it.deadline_ns => "EXPIRED",
            IntentStatus::Escrowed => "PENDING",
        };
        Some(s.to_string())
    }

    // ---------- helpers ----------

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only operator");
    }

    fn active_link(&self, agent: &AccountId) -> Link {
        let link = self.links.get(agent).cloned().unwrap_or_else(|| env::panic_str("agent not linked"));
        require!(link.active, "agent unlinked");
        link
    }

    fn job(&self, job_key: &str) -> Job {
        self.jobs.get(job_key).cloned().unwrap_or_else(|| env::panic_str("unknown job"))
    }

    fn intent(&self, intent_id: &str) -> Intent {
        self.intents.get(intent_id).cloned().unwrap_or_else(|| env::panic_str("unknown intent"))
    }
}

#[near]
impl FungibleTokenReceiver for Klero {
    /// Escrow entry point. Any panic here makes the token refund the full amount to the sender.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "unsupported token");
        require!(amount.0 > 0, "amount must be positive");
        let m: EscrowMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
        require!((MIN_TTL_S..=MAX_TTL_S).contains(&m.ttl_s), "ttl_s out of range");

        let link = self.active_link(&sender_id);
        let mut job = self.job(&m.job_key);
        require!(job.human == link.human, "job belongs to another human");
        require!(job.round == m.round, "wrong round");
        require!(job.status == JobStatus::Claimed, "job is not awaiting payment");
        require!(job.winner.as_ref() == Some(&sender_id), "only the round winner can pay");

        let intent_id = intent_id_of(&m.job_key, m.round);
        require!(self.intents.get(&intent_id).is_none(), "intent already exists"); // exactly once
        let now = env::block_timestamp();
        let provider = job.provider.clone().unwrap();
        let intent = Intent {
            job_key: m.job_key.clone(),
            round: m.round,
            payer: sender_id.clone(),
            provider: provider.clone(),
            amount,
            created_ns: now,
            deadline_ns: now + m.ttl_s * NS,
            status: IntentStatus::Escrowed,
        };
        job.status = JobStatus::Paying;
        job.intent_id = Some(intent_id.clone());
        self.jobs.insert(m.job_key.clone(), job);
        emit(
            "intent",
            json!({ "intent_id": intent_id, "payer": sender_id, "provider": provider,
                    "amount": amount, "deadline_ns": intent.deadline_ns.to_string() }),
        );
        self.intents.insert(intent_id, intent);
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, ts_s: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("klero.testnet"))
            .predecessor_account_id(acct(predecessor))
            .block_timestamp(ts_s * NS)
            .build());
    }

    /// Three agents of one human; agent a wins round 0 and escrows 2 FUSD with a 120 s deadline.
    fn setup_escrowed() -> Klero {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        for a in ["a.alice.testnet", "b.alice.testnet", "c.alice.testnet"] {
            k.link_agent(acct(a), "human1".into(), 1);
        }
        ctx("a.alice.testnet", 1000);
        assert!(k.claim("job1".into(), 0, acct("scribe.testnet")));
        ctx("fusd.testnet", 1000);
        let _ = k.ft_on_transfer(
            acct("a.alice.testnet"),
            U128(2_000_000),
            r#"{"job_key":"job1","round":0,"ttl_s":120}"#.into(),
        );
        k
    }

    #[test]
    fn first_claim_wins_others_lose() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        k.link_agent(acct("a.testnet"), "h".into(), 1);
        k.link_agent(acct("b.testnet"), "h".into(), 1);
        ctx("a.testnet", 1000);
        assert!(k.claim("j".into(), 0, acct("p.testnet")));
        ctx("b.testnet", 1000);
        assert!(!k.claim("j".into(), 0, acct("q.testnet")));
        let job = k.get_job("j".into()).unwrap();
        assert_eq!(job.winner, Some(acct("a.testnet")));
        assert_eq!(job.provider, Some(acct("p.testnet")));
    }

    #[test]
    #[should_panic(expected = "agent not linked")]
    fn unlinked_agent_cannot_claim() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        ctx("x.testnet", 1000);
        k.claim("j".into(), 0, acct("p.testnet"));
    }

    #[test]
    #[should_panic(expected = "job belongs to another human")]
    fn other_human_cannot_claim_job() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        k.link_agent(acct("a.testnet"), "h1".into(), 1);
        k.link_agent(acct("z.testnet"), "h2".into(), 1);
        ctx("a.testnet", 1000);
        k.claim("j".into(), 0, acct("p.testnet"));
        ctx("z.testnet", 1000);
        k.claim("j".into(), 0, acct("p.testnet"));
    }

    #[test]
    fn escrow_creates_pending_intent() {
        let k = setup_escrowed();
        let it = k.get_intent("job1:0".into()).unwrap();
        assert_eq!(it.status, IntentStatus::Escrowed);
        assert_eq!(it.deadline_ns, 1120 * NS);
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "PENDING");
        assert_eq!(k.get_job("job1".into()).unwrap().status, JobStatus::Paying);
    }

    #[test]
    #[should_panic(expected = "only the round winner can pay")]
    fn loser_cannot_escrow() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        k.link_agent(acct("a.alice.testnet"), "human1".into(), 1);
        k.link_agent(acct("b.alice.testnet"), "human1".into(), 1);
        ctx("a.alice.testnet", 1000);
        k.claim("job1".into(), 0, acct("scribe.testnet"));
        ctx("fusd.testnet", 1000);
        let _ = k.ft_on_transfer(acct("b.alice.testnet"), U128(1), r#"{"job_key":"job1","round":0,"ttl_s":120}"#.into());
    }

    #[test]
    #[should_panic(expected = "job is not awaiting payment")]
    fn winner_cannot_escrow_twice() {
        let mut k = setup_escrowed();
        ctx("fusd.testnet", 1000);
        let _ = k.ft_on_transfer(acct("a.alice.testnet"), U128(1), r#"{"job_key":"job1","round":0,"ttl_s":120}"#.into());
    }

    #[test]
    #[should_panic(expected = "unsupported token")]
    fn other_token_rejected() {
        let mut k = setup_escrowed();
        ctx("fake.testnet", 1000);
        let _ = k.ft_on_transfer(acct("a.alice.testnet"), U128(1), "{}".into());
    }

    #[test]
    fn settle_then_paid() {
        let mut k = setup_escrowed();
        ctx("scribe.testnet", 1100);
        let _ = k.settle("job1:0".into());
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "SETTLING");
        ctx("klero.testnet", 1101);
        assert!(k.on_settled("job1:0".into(), Ok(())));
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "PAID");
        assert_eq!(k.get_job("job1".into()).unwrap().status, JobStatus::Paid);
    }

    #[test]
    #[should_panic(expected = "intent is not escrowed")]
    fn cannot_settle_twice() {
        let mut k = setup_escrowed();
        ctx("scribe.testnet", 1100);
        let _ = k.settle("job1:0".into());
        let _ = k.settle("job1:0".into());
    }

    #[test]
    fn failed_payout_returns_to_escrow() {
        let mut k = setup_escrowed();
        ctx("scribe.testnet", 1100);
        let _ = k.settle("job1:0".into());
        ctx("klero.testnet", 1101);
        assert!(!k.on_settled("job1:0".into(), Err(PromiseError::Failed)));
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "PENDING");
    }

    #[test]
    #[should_panic(expected = "deadline passed")]
    fn cannot_settle_after_deadline() {
        let mut k = setup_escrowed();
        ctx("scribe.testnet", 1121);
        let _ = k.settle("job1:0".into());
    }

    #[test]
    #[should_panic(expected = "deadline not reached")]
    fn cannot_void_before_deadline() {
        let mut k = setup_escrowed();
        ctx("anyone.testnet", 1120);
        let _ = k.void_intent("job1:0".into());
    }

    #[test]
    fn void_after_deadline_reopens_job() {
        let mut k = setup_escrowed();
        ctx("anyone.testnet", 1121);
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "EXPIRED");
        let _ = k.void_intent("job1:0".into());
        ctx("klero.testnet", 1122);
        assert!(k.on_voided("job1:0".into(), Ok(())));
        assert_eq!(k.get_intent_state("job1:0".into()).unwrap(), "VOID");
        let job = k.get_job("job1".into()).unwrap();
        assert_eq!(job.round, 1);
        assert_eq!(job.status, JobStatus::Open);
    }

    #[test]
    #[should_panic(expected = "only provider or operator")]
    fn stranger_cannot_settle() {
        let mut k = setup_escrowed();
        ctx("mallory.testnet", 1100);
        let _ = k.settle("job1:0".into());
    }

    #[test]
    fn abandoned_round_moves_no_money() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        k.link_agent(acct("a.testnet"), "h".into(), 1);
        ctx("a.testnet", 1000);
        k.claim("j".into(), 0, acct("p.testnet"));
        ctx("op.testnet", 1050);
        k.abandon_round("j".into());
        let job = k.get_job("j".into()).unwrap();
        assert_eq!((job.round, job.status), (1, JobStatus::Open));
        assert!(k.get_intent("j:0".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "only operator")]
    fn only_operator_links() {
        ctx("op.testnet", 1000);
        let mut k = Klero::new(acct("op.testnet"), acct("fusd.testnet"));
        ctx("a.testnet", 1000);
        k.link_agent(acct("a.testnet"), "h".into(), 1);
    }
}
