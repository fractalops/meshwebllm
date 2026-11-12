//! Pool membership.
//!
//! Workers broadcast a signed [`Announcement`] on the pool gossip topic every
//! [`HEARTBEAT`]. Every node keeps a [`Roster`] built from those messages. A
//! worker that sends nothing for [`STALE_AFTER`] is marked stale. After
//! [`EXPIRE_AFTER`] it is removed. A worker that leaves on purpose sends
//! [`Announcement::Leave`] and is removed at once.
//!
//! Gossip messages carry no author, so each message is signed with the
//! sender's endpoint key. The roster uses the receiver's clock for timeouts.
//! The sender's timestamp only orders messages from the same sender.

use std::{collections::HashMap, time::Duration};

use iroh::{PublicKey, SecretKey, Signature};
use iroh_gossip::proto::TopicId;
use serde::{Deserialize, Serialize};

use crate::EndpointId;

/// Name of the public pool. The gossip topic is derived from it.
pub const POOL_NAME: &str = "meshwebllm/pool/v1";
/// Interval between two announcements from one worker.
pub const HEARTBEAT: Duration = Duration::from_secs(10);
/// Silence after which a worker is shown as stale.
pub const STALE_AFTER: Duration = Duration::from_secs(30);
/// Silence after which a worker is removed.
pub const EXPIRE_AFTER: Duration = Duration::from_secs(45);
/// Largest encoded announcement a node accepts, in bytes.
pub const MAX_ANNOUNCEMENT: usize = 2048;

/// Gossip topic of a pool: the pool name, zero-padded to 32 bytes.
pub fn pool_topic(name: &str) -> TopicId {
    let mut bytes = [0u8; 32];
    let n = name.len().min(32);
    bytes[..n].copy_from_slice(&name.as_bytes()[..n]);
    TopicId::from_bytes(bytes)
}

/// What a worker is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerState {
    Loading { percent: u8 },
    Idle,
    Busy,
    Paused,
}

/// Self-reported worker status. Other nodes cannot verify these numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    pub state: WorkerState,
    pub model: String,
    /// GPU vendor and architecture as the browser reports them.
    pub adapter: String,
    pub active: u8,
    pub waiting: u8,
    pub served: u64,
    pub tokens_out: u64,
    pub tokens_per_sec: f32,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Announcement {
    /// Status of a worker.
    Worker(WorkerInfo),
    /// The worker left the pool.
    Leave,
    /// A new member asks workers to announce now.
    Hello,
}

#[derive(Serialize, Deserialize)]
struct Signed {
    from: PublicKey,
    data: Vec<u8>,
    signature: Signature,
}

#[derive(Serialize, Deserialize)]
struct Body {
    timestamp_ms: u64,
    announcement: Announcement,
}

/// A verified announcement.
#[derive(Debug, Clone, PartialEq)]
pub struct Received {
    pub from: EndpointId,
    pub timestamp_ms: u64,
    pub announcement: Announcement,
}

#[derive(Debug, thiserror::Error)]
pub enum PresenceError {
    #[error("announcement is {0} bytes, limit is {MAX_ANNOUNCEMENT}")]
    TooLarge(usize),
    #[error("announcement is not valid")]
    Decode(#[from] postcard::Error),
    #[error("announcement signature is not valid")]
    Signature,
}

/// Signs and encodes an announcement.
pub fn encode(
    secret_key: &SecretKey,
    timestamp_ms: u64,
    announcement: &Announcement,
) -> Result<Vec<u8>, PresenceError> {
    let data = postcard::to_stdvec(&Body {
        timestamp_ms,
        announcement: announcement.clone(),
    })?;
    let signature = secret_key.sign(&data);
    let bytes = postcard::to_stdvec(&Signed {
        from: secret_key.public(),
        data,
        signature,
    })?;
    if bytes.len() > MAX_ANNOUNCEMENT {
        return Err(PresenceError::TooLarge(bytes.len()));
    }
    Ok(bytes)
}

/// Decodes an announcement and checks its signature.
pub fn decode(bytes: &[u8]) -> Result<Received, PresenceError> {
    if bytes.len() > MAX_ANNOUNCEMENT {
        return Err(PresenceError::TooLarge(bytes.len()));
    }
    let signed: Signed = postcard::from_bytes(bytes)?;
    signed
        .from
        .verify(&signed.data, &signed.signature)
        .map_err(|_| PresenceError::Signature)?;
    let body: Body = postcard::from_bytes(&signed.data)?;
    Ok(Received {
        from: signed.from,
        timestamp_ms: body.timestamp_ms,
        announcement: body.announcement,
    })
}

/// One worker in the roster.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub id: EndpointId,
    pub info: WorkerInfo,
    /// Receiver time of the first announcement.
    pub first_seen_ms: u64,
    /// Receiver time of the latest announcement.
    pub last_seen_ms: u64,
}

impl Member {
    /// Time since the latest announcement.
    pub fn silence(&self, now_ms: u64) -> Duration {
        Duration::from_millis(now_ms.saturating_sub(self.last_seen_ms))
    }

    pub fn is_stale(&self, now_ms: u64) -> bool {
        self.silence(now_ms) >= STALE_AFTER
    }
}

/// A change in pool membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RosterEvent {
    Joined(EndpointId),
    Left(EndpointId),
    Stale(EndpointId),
    Expired(EndpointId),
}

/// Pool members built from announcements.
#[derive(Debug, Default, Clone)]
pub struct Roster {
    members: HashMap<EndpointId, Member>,
    // Keep sequence floors after leave and expiry to reject old packets.
    timestamps: HashMap<EndpointId, u64>,
    revision: u64,
}

impl Roster {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies one announcement received at `now_ms`.
    pub fn apply(&mut self, msg: Received, now_ms: u64) -> Option<RosterEvent> {
        if matches!(msg.announcement, Announcement::Hello)
            || self
                .timestamps
                .get(&msg.from)
                .is_some_and(|ts| msg.timestamp_ms <= *ts)
        {
            return None;
        }
        self.timestamps.insert(msg.from, msg.timestamp_ms);
        self.revision += 1;
        match msg.announcement {
            Announcement::Leave => self
                .members
                .remove(&msg.from)
                .map(|_| RosterEvent::Left(msg.from)),
            Announcement::Hello => None,
            Announcement::Worker(info) => match self.members.get_mut(&msg.from) {
                Some(m) => {
                    m.info = info;
                    m.last_seen_ms = now_ms;
                    None
                }
                None => {
                    self.members.insert(
                        msg.from,
                        Member {
                            id: msg.from,
                            info,
                            first_seen_ms: now_ms,
                            last_seen_ms: now_ms,
                        },
                    );
                    Some(RosterEvent::Joined(msg.from))
                }
            },
        }
    }

    /// Removes expired members. Reports members that became stale since
    /// `previous_ms` and members that expired.
    pub fn sweep(&mut self, previous_ms: u64, now_ms: u64) -> Vec<RosterEvent> {
        let mut events = Vec::new();
        self.members.retain(|id, m| {
            if m.silence(now_ms) >= EXPIRE_AFTER {
                events.push(RosterEvent::Expired(*id));
                false
            } else {
                if m.is_stale(now_ms) && !m.is_stale(previous_ms) {
                    events.push(RosterEvent::Stale(*id));
                }
                true
            }
        });
        events
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn get(&self, id: &EndpointId) -> Option<&Member> {
        self.members.get(id)
    }

    pub fn len(&self) -> usize {
        self.members.len()
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    pub fn members(&self) -> impl Iterator<Item = &Member> {
        self.members.values()
    }

    /// Workers that can take a job now, best first: idle workers by
    /// reported speed, then busy workers by queue length.
    pub fn candidates(&self, now_ms: u64) -> Vec<EndpointId> {
        let mut usable: Vec<&Member> = self
            .members
            .values()
            .filter(|m| {
                !m.is_stale(now_ms) && matches!(m.info.state, WorkerState::Idle | WorkerState::Busy)
            })
            .collect();
        usable.sort_by(|a, b| {
            let rank = |m: &Member| matches!(m.info.state, WorkerState::Busy) as u8;
            rank(a)
                .cmp(&rank(b))
                .then(a.info.waiting.cmp(&b.info.waiting))
                .then(b.info.tokens_per_sec.total_cmp(&a.info.tokens_per_sec))
        });
        usable.into_iter().map(|m| m.id).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(state: WorkerState, tps: f32, waiting: u8) -> WorkerInfo {
        WorkerInfo {
            state,
            model: "m".into(),
            adapter: "apple · metal-3".into(),
            active: 0,
            waiting,
            served: 0,
            tokens_out: 0,
            tokens_per_sec: tps,
            uptime_secs: 0,
        }
    }

    fn received(key: &SecretKey, ts: u64, a: Announcement) -> Received {
        decode(&encode(key, ts, &a).unwrap()).unwrap()
    }

    #[test]
    fn replay_cannot_remove_or_revive_a_worker() {
        let key = SecretKey::generate();
        let mut r = Roster::new();
        let worker = || Announcement::Worker(info(WorkerState::Busy, 12.0, 2));
        r.apply(received(&key, 10, worker()), 0);
        let revision = r.revision();
        assert_eq!(r.apply(received(&key, 9, Announcement::Leave), 1), None);
        assert_eq!(r.revision(), revision);
        assert_eq!(r.len(), 1);
        r.apply(received(&key, 11, Announcement::Leave), 2);
        assert_eq!(r.apply(received(&key, 10, worker()), 3), None);
        assert!(r.is_empty());
        r.apply(received(&key, 12, worker()), 4);
        r.sweep(4, 50_000);
        assert_eq!(r.apply(received(&key, 12, worker()), 50_001), None);
        assert!(r.is_empty());
        assert_eq!(
            r.apply(received(&key, 13, worker()), 50_002),
            Some(RosterEvent::Joined(key.public()))
        );
    }

    #[test]
    fn topic_is_stable() {
        assert_eq!(pool_topic(POOL_NAME), pool_topic(POOL_NAME));
        assert_ne!(pool_topic(POOL_NAME), pool_topic("other"));
    }

    #[test]
    fn signed_round_trip() {
        let key = SecretKey::generate();
        let a = Announcement::Worker(info(WorkerState::Loading { percent: 40 }, 0.0, 0));
        let got = received(&key, 7, a.clone());
        assert_eq!(got.from, key.public());
        assert_eq!(got.timestamp_ms, 7);
        assert_eq!(got.announcement, a);
    }

    #[test]
    fn tampered_message_is_rejected() {
        let key = SecretKey::generate();
        let mut bytes = encode(&key, 1, &Announcement::Leave).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn forged_sender_is_rejected() {
        let real = SecretKey::generate();
        let other = SecretKey::generate();
        let bytes = encode(&real, 1, &Announcement::Leave).unwrap();
        let mut signed: Signed = postcard::from_bytes(&bytes).unwrap();
        signed.from = other.public();
        let forged = postcard::to_stdvec(&signed).unwrap();
        assert!(matches!(decode(&forged), Err(PresenceError::Signature)));
    }

    #[test]
    fn oversized_input_is_rejected_before_decoding() {
        assert!(matches!(
            decode(&vec![0; MAX_ANNOUNCEMENT + 1]),
            Err(PresenceError::TooLarge(_))
        ));
    }

    #[test]
    fn join_update_leave() {
        let key = SecretKey::generate();
        let id = key.public();
        let mut r = Roster::new();
        let a = |s| Announcement::Worker(info(s, 10.0, 0));
        assert_eq!(
            r.apply(received(&key, 1, a(WorkerState::Idle)), 0),
            Some(RosterEvent::Joined(id))
        );
        assert_eq!(r.apply(received(&key, 2, a(WorkerState::Busy)), 1000), None);
        assert_eq!(r.get(&id).unwrap().info.state, WorkerState::Busy);
        assert_eq!(r.get(&id).unwrap().last_seen_ms, 1000);
        assert_eq!(
            r.apply(received(&key, 3, Announcement::Leave), 2000),
            Some(RosterEvent::Left(id))
        );
        assert!(r.is_empty());
    }

    #[test]
    fn replayed_message_does_not_refresh_member() {
        let key = SecretKey::generate();
        let mut r = Roster::new();
        let old = received(
            &key,
            5,
            Announcement::Worker(info(WorkerState::Idle, 1.0, 0)),
        );
        r.apply(old.clone(), 0);
        r.apply(
            received(
                &key,
                6,
                Announcement::Worker(info(WorkerState::Busy, 1.0, 0)),
            ),
            1000,
        );
        r.apply(old, 2000);
        let m = r.get(&key.public()).unwrap();
        assert_eq!(m.info.state, WorkerState::Busy);
        assert_eq!(m.last_seen_ms, 1000);
    }

    #[test]
    fn silent_member_goes_stale_then_expires() {
        let key = SecretKey::generate();
        let id = key.public();
        let mut r = Roster::new();
        r.apply(
            received(
                &key,
                1,
                Announcement::Worker(info(WorkerState::Idle, 1.0, 0)),
            ),
            0,
        );
        assert!(r.sweep(0, 29_000).is_empty());
        assert_eq!(r.sweep(29_000, 30_000), vec![RosterEvent::Stale(id)]);
        assert!(r.sweep(30_000, 31_000).is_empty(), "stale is reported once");
        assert_eq!(r.sweep(31_000, 45_000), vec![RosterEvent::Expired(id)]);
        assert!(r.is_empty());
    }

    #[test]
    fn candidates_prefer_idle_fast_then_short_queues() {
        let mut r = Roster::new();
        let mut add = |state, tps, waiting| {
            let k = SecretKey::generate();
            r.apply(
                received(&k, 1, Announcement::Worker(info(state, tps, waiting))),
                0,
            );
            k.public()
        };
        let busy_long = add(WorkerState::Busy, 90.0, 2);
        let idle_slow = add(WorkerState::Idle, 5.0, 0);
        let paused = add(WorkerState::Paused, 99.0, 0);
        let idle_fast = add(WorkerState::Idle, 40.0, 0);
        let loading = add(WorkerState::Loading { percent: 10 }, 0.0, 0);
        let busy_short = add(WorkerState::Busy, 10.0, 0);
        let got = r.candidates(1000);
        assert_eq!(got, vec![idle_fast, idle_slow, busy_short, busy_long]);
        assert!(!got.contains(&paused) && !got.contains(&loading));
    }

    #[test]
    fn stale_members_are_not_candidates() {
        let mut r = Roster::new();
        let k = SecretKey::generate();
        r.apply(
            received(&k, 1, Announcement::Worker(info(WorkerState::Idle, 1.0, 0))),
            0,
        );
        assert!(r.candidates(STALE_AFTER.as_millis() as u64).is_empty());
    }
}
