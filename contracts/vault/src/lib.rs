//! Orto Vault contract on Freenet: decentralized, encrypted Local-First key-value store.
//!
//! Parameters = owner_pubkey (32 bytes Ed25519) || salt (16 bytes) [ || app_path (only for Viso delegation) ]
//!
//! Every record is signed on its own, so the state is self-verifying and any subset of records can travel as a delta:
//!   signature over `orto1|<params hex>|<key>|<updated_at>|<deleted>|<data>`
//! Supports BOTH direct Ed25519 signing (cert: None) and Viso/whoiam delegated signing (cert: Some).
//! Merge is last-write-wins per record (ties broken by the larger data string so every node converges).

use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use whoiam_delegation::Cert;

type R<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct VaultRecord {
    #[serde(default)]
    pub data: String,
    pub updated_at: u64,
    #[serde(default)]
    pub deleted: bool,
    pub sig: String,
    #[serde(default)]
    pub cert: Option<Cert>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct VaultState {
    #[serde(default)]
    pub records: BTreeMap<String, VaultRecord>,
    #[serde(default)]
    pub updated_at: u64,
}

/// A delta is a set of signed records (same shape as a state).
pub type DeltaBody = VaultState;

#[derive(Serialize, Deserialize, Default)]
struct Summary {
    ts: u64,
}

const MAX_KEY_LEN: usize = 160;
const MAX_RECORD_DATA_BYTES: usize = 2 * 1024 * 1024; // 2 MB per record payload
const MAX_TOTAL_RECORDS: usize = 50_000;

fn is_valid_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= MAX_KEY_LEN
        && k.contains(':')
        && !k.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// App path from hex parameters if present (after 48 bytes).
pub fn app_of(params: &str) -> R<Option<String>> {
    let raw = hex::decode(params).map_err(|e| e.to_string())?;
    if raw.len() <= 48 {
        Ok(None)
    } else {
        Ok(Some(String::from_utf8(raw[48..].to_vec()).map_err(|e| e.to_string())?))
    }
}

pub fn record_msg(params: &str, key: &str, r: &VaultRecord) -> String {
    format!("orto1|{params}|{key}|{}|{}|{}", r.updated_at, r.deleted, r.data)
}

/// Verify one record: direct owner signature (no cert) or delegated app key (cert).
pub fn verify_record(params: &str, key: &str, r: &VaultRecord) -> R<()> {
    if params.len() < 96 {
        return Err("parameters too short: need at least 48 bytes".into());
    }
    let owner_hex = &params[..64];
    let msg = record_msg(params, key, r);
    match &r.cert {
        None => {
            let pk: [u8; 32] = hex::decode(owner_hex).map_err(|e| e.to_string())?.try_into().map_err(|_| "bad owner key")?;
            let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk).map_err(|e| format!("invalid key: {e}"))?;
            let sg: [u8; 64] = hex::decode(&r.sig).map_err(|e| e.to_string())?.try_into().map_err(|_| "bad signature length")?;
            vk.verify_strict(msg.as_bytes(), &ed25519_dalek::Signature::from_bytes(&sg))
                .map_err(|e| format!("signature failed: {e}"))
        }
        Some(cert) => {
            let app = app_of(params)?.ok_or_else(|| "parameters carry no app path, needed for Viso delegation".to_string())?;
            let app_key = whoiam_delegation::check(owner_hex, &app, cert).map_err(|e| format!("delegation: {e}"))?;
            whoiam_delegation::verify(&app_key, msg.as_bytes(), &r.sig).map_err(|e| format!("delegated signature: {e}"))
        }
    }
}

pub fn check_state(params: &str, s: &VaultState) -> R<()> {
    if s.records.len() > MAX_TOTAL_RECORDS {
        return Err("too many records".into());
    }
    for (k, r) in &s.records {
        if !is_valid_key(k) {
            return Err(format!("invalid record key: {k}"));
        }
        if r.data.len() > MAX_RECORD_DATA_BYTES {
            return Err(format!("record too big: {k}"));
        }
        verify_record(params, k, r)?;
    }
    Ok(())
}

fn newer(a: &VaultRecord, b: &VaultRecord) -> bool {
    (a.updated_at, a.data.as_str()) > (b.updated_at, b.data.as_str())
}

/// Merge verified incoming records into the state (last write wins per record).
pub fn merge(params: &str, mut state: VaultState, incoming: VaultState) -> R<VaultState> {
    check_state(params, &incoming)?;
    for (k, r) in incoming.records {
        match state.records.get(&k) {
            Some(cur) if !newer(&r, cur) => {}
            _ => {
                state.records.insert(k, r);
            }
        }
    }
    state.updated_at = state.records.values().map(|r| r.updated_at).max().unwrap_or(0);
    Ok(state)
}

/// Records newer than `peer_ts` (what a peer at that timestamp is missing).
pub fn delta_for(state: &VaultState, peer_ts: u64) -> Vec<u8> {
    let records: BTreeMap<_, _> = state
        .records
        .iter()
        .filter(|(_, r)| r.updated_at > peer_ts)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if records.is_empty() {
        return Vec::new();
    }
    serde_json::to_vec(&VaultState { records, updated_at: state.updated_at }).unwrap_or_default()
}

fn params_hex(p: &Parameters) -> String {
    hex::encode(p.as_ref())
}

fn parse_state(b: &[u8]) -> Result<VaultState, ContractError> {
    if b.is_empty() {
        return Ok(VaultState::default());
    }
    serde_json::from_slice(b).map_err(|e| ContractError::Deser(e.to_string()))
}

struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let ok = serde_json::from_slice::<VaultState>(state.as_ref()).is_ok_and(|s| check_state(&params_hex(&parameters), &s).is_ok());
        Ok(if ok { ValidateResult::Valid } else { ValidateResult::Invalid })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let params = params_hex(&parameters);
        let mut cur = parse_state(state.as_ref())?;
        for u in data {
            let payloads: Vec<Vec<u8>> = match u {
                UpdateData::State(s) => vec![s.as_ref().to_vec()],
                UpdateData::Delta(d) => vec![d.as_ref().to_vec()],
                UpdateData::StateAndDelta { state, delta } => vec![state.as_ref().to_vec(), delta.as_ref().to_vec()],
                _ => return Err(ContractError::InvalidUpdate),
            };
            for p in payloads.into_iter().filter(|p| !p.is_empty()) {
                cur = merge(&params, cur, parse_state(&p)?).map_err(|_| ContractError::InvalidUpdate)?;
            }
        }
        let bytes = serde_json::to_vec(&cur).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let ts = parse_state(state.as_ref()).map(|s| s.updated_at).unwrap_or(0);
        let s = serde_json::to_vec(&Summary { ts }).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(StateSummary::from(s))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let peer = if summary.as_ref().is_empty() { 0 } else { serde_json::from_slice::<Summary>(summary.as_ref()).unwrap_or_default().ts };
        let s = parse_state(state.as_ref())?;
        Ok(StateDelta::from(delta_for(&s, peer)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sk(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    fn params(k: &SigningKey) -> String {
        format!("{}11223344556677889900aabbccddeeff", hex::encode(k.verifying_key().to_bytes()))
    }
    fn rec(k: &SigningKey, params: &str, key: &str, data: &str, ts: u64, deleted: bool) -> (String, VaultRecord) {
        let mut r = VaultRecord { data: data.into(), updated_at: ts, deleted, sig: String::new(), cert: None };
        r.sig = hex::encode(k.sign(record_msg(params, key, &r).as_bytes()).to_bytes());
        (key.to_string(), r)
    }
    fn state(items: Vec<(String, VaultRecord)>) -> VaultState {
        let updated_at = items.iter().map(|(_, r)| r.updated_at).max().unwrap_or(0);
        VaultState { records: items.into_iter().collect(), updated_at }
    }

    #[test]
    fn signed_record_merges_into_empty_state() {
        let k = sk(42);
        let p = params(&k);
        let s = merge(&p, VaultState::default(), state(vec![rec(&k, &p, "vault:n-1", "e1.c1", 1000, false)])).unwrap();
        assert_eq!(s.records["vault:n-1"].data, "e1.c1");
        assert_eq!(s.updated_at, 1000);
        assert!(check_state(&p, &s).is_ok());
    }

    #[test]
    fn last_write_wins() {
        let k = sk(1);
        let p = params(&k);
        let mut s = merge(&p, VaultState::default(), state(vec![rec(&k, &p, "tasks:t-1", "v1", 1000, false)])).unwrap();
        s = merge(&p, s, state(vec![rec(&k, &p, "tasks:t-1", "old", 800, false)])).unwrap();
        assert_eq!(s.records["tasks:t-1"].data, "v1");
        s = merge(&p, s, state(vec![rec(&k, &p, "tasks:t-1", "v2", 2000, false)])).unwrap();
        assert_eq!(s.records["tasks:t-1"].data, "v2");
        assert_eq!(s.updated_at, 2000);
    }

    #[test]
    fn merge_is_order_independent_on_ties() {
        let k = sk(3);
        let p = params(&k);
        let (ka, a) = rec(&k, &p, "vault:x", "aaa", 5, false);
        let (_, b) = rec(&k, &p, "vault:x", "bbb", 5, false);
        let s1 = merge(&p, merge(&p, VaultState::default(), state(vec![(ka.clone(), a.clone())])).unwrap(), state(vec![(ka.clone(), b.clone())])).unwrap();
        let s2 = merge(&p, merge(&p, VaultState::default(), state(vec![(ka.clone(), b)])).unwrap(), state(vec![(ka, a)])).unwrap();
        assert_eq!(s1, s2);
    }

    #[test]
    fn tombstone_replaces_record() {
        let k = sk(4);
        let p = params(&k);
        let mut s = merge(&p, VaultState::default(), state(vec![rec(&k, &p, "vault:n", "e1.note", 1000, false)])).unwrap();
        s = merge(&p, s, state(vec![rec(&k, &p, "vault:n", "", 1500, true)])).unwrap();
        assert!(s.records["vault:n"].deleted);
    }

    #[test]
    fn wrong_signer_and_tampering_rejected() {
        let (k1, k2) = (sk(1), sk(2));
        let p = params(&k1);
        assert!(merge(&p, VaultState::default(), state(vec![rec(&k2, &p, "vault:n", "x", 1, false)])).is_err());
        let (key, mut r) = rec(&k1, &p, "vault:n", "x", 1, false);
        r.data = "tampered".into();
        assert!(merge(&p, VaultState::default(), state(vec![(key, r)])).is_err());
        // a signature for one key cannot be reused under another key name
        let (_, r) = rec(&k1, &p, "vault:a", "x", 1, false);
        assert!(merge(&p, VaultState::default(), state(vec![("vault:b".into(), r)])).is_err());
    }

    #[test]
    fn delta_only_has_newer_records() {
        let k = sk(5);
        let p = params(&k);
        let s = merge(&p, VaultState::default(), state(vec![rec(&k, &p, "vault:old", "o", 500, false), rec(&k, &p, "vault:new", "n", 1500, false)])).unwrap();
        let d: VaultState = serde_json::from_slice(&delta_for(&s, 1000)).unwrap();
        assert_eq!(d.records.len(), 1);
        assert!(d.records.contains_key("vault:new"));
        assert!(delta_for(&s, 1500).is_empty());
    }
}
