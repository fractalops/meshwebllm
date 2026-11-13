//! A live view of the pool over gossip.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use iroh_gossip::{
    Gossip,
    api::{ApiError, Event, GossipReceiver, GossipSender},
};
use n0_future::{
    StreamExt,
    task::{self, AbortOnDropHandle},
    time::{self, Duration, SystemTime},
};
use tokio::sync::Notify;
use tracing::{debug, warn};

use crate::{
    EndpointId, SecretKey,
    presence::{self, Announcement, HEARTBEAT, Roster, RosterEvent, WorkerInfo},
};

const SWEEP_INTERVAL: Duration = Duration::from_secs(1);
/// Announcements requested within this window are sent once.
const COALESCE: Duration = Duration::from_secs(2);
const EVENT_CAPACITY: usize = 256;

/// Current time in milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Default)]
struct Shared {
    roster: Roster,
    neighbors: usize,
    own: Option<WorkerInfo>,
    updates: Option<async_channel::Sender<()>>,
}

#[derive(Debug)]
struct Sender {
    gossip: GossipSender,
    timestamp_ms: u64,
}

/// Membership in one pool. Dropping it stops all background tasks.
#[derive(Debug, Clone)]
pub struct Pool {
    me: EndpointId,
    secret_key: SecretKey,
    sender: Arc<tokio::sync::Mutex<Sender>>,
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Notify>,
    events: async_channel::Receiver<RosterEvent>,
    updates: async_channel::Receiver<()>,
    _tasks: Arc<[AbortOnDropHandle<()>; 3]>,
}

impl Pool {
    /// Joins the pool topic. Returns at once. Peers appear as gossip
    /// connects to the bootstrap nodes.
    pub async fn join(
        gossip: &Gossip,
        secret_key: SecretKey,
        pool_name: &str,
        bootstrap: Vec<EndpointId>,
    ) -> Result<Self, ApiError> {
        let me = secret_key.public();
        let bootstrap = bootstrap.into_iter().filter(|id| *id != me).collect();
        let topic = gossip
            .subscribe(presence::pool_topic(pool_name), bootstrap)
            .await?;
        let (sender, receiver) = topic.split();
        let sender = Arc::new(tokio::sync::Mutex::new(Sender {
            gossip: sender,
            timestamp_ms: 0,
        }));
        let (update_tx, updates) = async_channel::bounded(1);
        let shared = Arc::new(Mutex::new(Shared {
            updates: Some(update_tx),
            ..Shared::default()
        }));
        let wake = Arc::new(Notify::new());
        let (tx, rx) = async_channel::bounded(EVENT_CAPACITY);

        let recv_task = task::spawn(receive_loop(
            me,
            secret_key.clone(),
            receiver,
            sender.clone(),
            shared.clone(),
            wake.clone(),
            tx.clone(),
        ));
        let sweep_task = task::spawn(sweep_loop(shared.clone(), tx));
        let beat_task = task::spawn(heartbeat_loop(
            secret_key.clone(),
            sender.clone(),
            shared.clone(),
            wake.clone(),
        ));
        Ok(Self {
            me,
            secret_key,
            sender,
            shared,
            wake,
            events: rx,
            updates,
            _tasks: Arc::new([
                AbortOnDropHandle::new(recv_task),
                AbortOnDropHandle::new(sweep_task),
                AbortOnDropHandle::new(beat_task),
            ]),
        })
    }

    pub fn id(&self) -> EndpointId {
        self.me
    }

    /// Sets this node's worker status. The status is broadcast with every
    /// heartbeat. Changes wake the sender and share a two-second rate limit.
    pub fn announce(&self, info: WorkerInfo) {
        let changed = {
            let mut s = self.shared.lock().expect("poisoned");
            if let Some(own) = &mut s.own {
                own.uptime_secs = info.uptime_secs;
            }
            let changed = s.own.as_ref() != Some(&info);
            s.own = Some(info);
            changed
        };
        if changed {
            self.wake.notify_one();
        }
    }

    /// Stops announcing and tells the pool that this worker left.
    pub async fn leave(&self) -> Result<(), ApiError> {
        self.shared.lock().expect("poisoned").own = None;
        broadcast(&self.secret_key, &self.sender, &Announcement::Leave).await
    }

    /// A copy of the roster. It does not include this node.
    pub fn roster(&self) -> Roster {
        self.shared.lock().expect("poisoned").roster.clone()
    }

    /// Number of direct gossip neighbors.
    pub fn neighbors(&self) -> usize {
        self.shared.lock().expect("poisoned").neighbors
    }

    /// Coalesced invalidations. Read a fresh roster after each signal.
    pub fn updates(&self) -> async_channel::Receiver<()> {
        self.updates.clone()
    }

    /// Membership changes. If nobody reads them, new events can be dropped.
    pub fn events(&self) -> async_channel::Receiver<RosterEvent> {
        self.events.clone()
    }
}

async fn broadcast(
    key: &SecretKey,
    sender: &tokio::sync::Mutex<Sender>,
    a: &Announcement,
) -> Result<(), ApiError> {
    let mut sender = sender.lock().await;
    sender.timestamp_ms = now_ms().max(sender.timestamp_ms.saturating_add(1));
    match presence::encode(key, sender.timestamp_ms, a) {
        Ok(bytes) => sender.gossip.broadcast(Bytes::from(bytes)).await,
        Err(err) => {
            warn!("cannot encode announcement: {err}");
            Ok(())
        }
    }
}

async fn receive_loop(
    me: EndpointId,
    key: SecretKey,
    mut receiver: GossipReceiver,
    sender: Arc<tokio::sync::Mutex<Sender>>,
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Notify>,
    events: async_channel::Sender<RosterEvent>,
) {
    let mut greeted = false;
    while let Some(event) = receiver.next().await {
        let event = match event {
            Ok(e) => e,
            Err(err) => {
                warn!("gossip receive failed: {err}");
                break;
            }
        };
        let roster_event = {
            let mut s = shared.lock().expect("poisoned");
            let revision = s.roster.revision();
            let neighbors = s.neighbors;
            let result = match event {
                Event::NeighborUp(_) => {
                    s.neighbors += 1;
                    None
                }
                Event::NeighborDown(_) => {
                    s.neighbors = s.neighbors.saturating_sub(1);
                    None
                }
                Event::Received(msg) => match presence::decode(&msg.content) {
                    Ok(r) if r.from == me => None,
                    Ok(r) if r.announcement == Announcement::Hello => {
                        // A new member asks for status. Workers answer with
                        // their next announcement.
                        if s.own.is_some() {
                            wake.notify_one();
                        }
                        None
                    }
                    Ok(r) => s.roster.apply(r, now_ms()),
                    Err(err) => {
                        debug!(from = %msg.delivered_from, "dropping announcement: {err}");
                        None
                    }
                },
                Event::Lagged => None,
                _ => None,
            };
            if (revision != s.roster.revision() || neighbors != s.neighbors)
                && let Some(tx) = &s.updates
            {
                let _ = tx.try_send(());
            }
            result
        };
        if let Some(e) = roster_event {
            let _ = events.try_send(e);
        }
        // After the first neighbor connects, ask workers to announce now
        // instead of at their next heartbeat.
        if !greeted && shared.lock().expect("poisoned").neighbors > 0 {
            greeted = true;
            if let Err(err) = broadcast(&key, &sender, &Announcement::Hello).await {
                warn!("hello failed: {err}");
            }
        }
    }
}

async fn sweep_loop(shared: Arc<Mutex<Shared>>, events: async_channel::Sender<RosterEvent>) {
    let mut previous = now_ms();
    loop {
        time::sleep(SWEEP_INTERVAL).await;
        let now = now_ms();
        let swept = shared.lock().expect("poisoned").roster.sweep(previous, now);
        previous = now;
        if !swept.is_empty()
            && let Some(tx) = &shared.lock().expect("poisoned").updates
        {
            let _ = tx.try_send(());
        }
        for e in swept {
            let _ = events.try_send(e);
        }
    }
}

async fn heartbeat_loop(
    key: SecretKey,
    sender: Arc<tokio::sync::Mutex<Sender>>,
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Notify>,
) {
    loop {
        let own = shared.lock().expect("poisoned").own.clone();
        if let Some(info) = own
            && let Err(err) = broadcast(&key, &sender, &Announcement::Worker(info)).await
        {
            warn!("heartbeat failed: {err}");
        }
        // All worker status traffic shares this minimum interval, including
        // state changes and replies to Hello. Pending changes use latest data.
        time::sleep(COALESCE).await;
        n0_future::future::race(time::sleep(HEARTBEAT - COALESCE), wake.notified()).await;
    }
}
