//! Gossip presence between three local nodes, without relays.

use std::time::Duration;

use iroh::{
    Endpoint, SecretKey, address_lookup::MemoryLookup, endpoint::presets, protocol::Router,
};
use meshwebllm_core::{
    GOSSIP_ALPN, Gossip,
    pool::Pool,
    presence::{RosterEvent, WorkerInfo, WorkerState},
};

struct Node {
    key: SecretKey,
    router: Router,
    gossip: Gossip,
    lookup: MemoryLookup,
}

async fn node() -> Node {
    let key = SecretKey::generate();
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(key.clone())
        .alpns(vec![GOSSIP_ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let lookup = MemoryLookup::new();
    ep.address_lookup().unwrap().add(lookup.clone());
    let gossip = Gossip::builder().spawn(ep.clone());
    let router = Router::builder(ep)
        .accept(GOSSIP_ALPN, gossip.clone())
        .spawn();
    Node {
        key,
        router,
        gossip,
        lookup,
    }
}

fn info(state: WorkerState) -> WorkerInfo {
    WorkerInfo {
        state,
        model: "Qwen3-4B-q4f16_1-MLC".into(),
        adapter: "apple · metal-3".into(),
        active: 0,
        waiting: 0,
        served: 0,
        tokens_out: 0,
        tokens_per_sec: 30.0,
        uptime_secs: 1,
    }
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for: {what}"));
}

#[tokio::test]
async fn worker_appears_changes_and_leaves() {
    let boot = node().await;
    let worker = node().await;
    let observer = node().await;
    for n in [&worker, &observer] {
        n.lookup.add_endpoint_info(boot.router.endpoint().addr());
    }
    let boot_id = boot.router.endpoint().id();
    let name = "test-pool";

    let _b = Pool::join(&boot.gossip, boot.key.clone(), name, vec![])
        .await
        .unwrap();
    let w = Pool::join(&worker.gossip, worker.key.clone(), name, vec![boot_id])
        .await
        .unwrap();
    let o = Pool::join(&observer.gossip, observer.key.clone(), name, vec![boot_id])
        .await
        .unwrap();
    let events = o.events();

    eventually("both members have a neighbor", || {
        w.neighbors() > 0 && o.neighbors() > 0
    })
    .await;

    w.announce(info(WorkerState::Loading { percent: 10 }));
    eventually("observer sees the worker", || {
        o.roster().get(&w.id()).is_some()
    })
    .await;
    assert_eq!(events.recv().await.unwrap(), RosterEvent::Joined(w.id()));

    w.announce(info(WorkerState::Idle));
    eventually("observer sees the state change", || {
        o.roster().get(&w.id()).map(|m| m.info.state) == Some(WorkerState::Idle)
    })
    .await;
    assert_eq!(
        o.roster().candidates(meshwebllm_core::pool::now_ms()),
        vec![w.id()]
    );

    assert!(
        w.roster().get(&w.id()).is_none(),
        "a node does not list itself"
    );

    let updates = o.updates();
    while updates.try_recv().is_ok() {}
    let mut changed = info(WorkerState::Idle);
    changed.served = 4;
    changed.waiting = 2;
    changed.tokens_per_sec = 42.0;
    w.announce(changed.clone());
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            updates.recv().await.unwrap();
            if o.roster().get(&w.id()).is_some_and(|m| m.info == changed) {
                break;
            }
        }
    })
    .await
    .expect("same-state counters should trigger a roster update");
    let seen = o.roster().get(&w.id()).unwrap().last_seen_ms;
    for count in 5..20 {
        changed.served = count;
        w.announce(changed.clone());
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(o.roster().get(&w.id()).unwrap().last_seen_ms, seen);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            updates.recv().await.unwrap();
            if o.roster().get(&w.id()).is_some_and(|m| m.info == changed) {
                break;
            }
        }
    })
    .await
    .expect("coalescing should deliver the newest counters");

    w.leave().await.unwrap();
    eventually("observer drops the worker", || o.roster().is_empty()).await;
    assert_eq!(events.recv().await.unwrap(), RosterEvent::Left(w.id()));
}

#[tokio::test]
async fn late_joiner_sees_workers_before_the_next_heartbeat() {
    let boot = node().await;
    let worker = node().await;
    let late = node().await;
    for n in [&worker, &late] {
        n.lookup.add_endpoint_info(boot.router.endpoint().addr());
    }
    let boot_id = boot.router.endpoint().id();
    let name = "late-pool";
    let b = Pool::join(&boot.gossip, boot.key.clone(), name, vec![])
        .await
        .unwrap();
    let w = Pool::join(&worker.gossip, worker.key.clone(), name, vec![boot_id])
        .await
        .unwrap();
    w.announce(info(WorkerState::Idle));
    eventually("bootstrap sees the worker", || {
        b.roster().get(&w.id()).is_some()
    })
    .await;

    // The worker's next heartbeat is up to 10 s away. Hello must make it
    // announce at once.
    let start = std::time::Instant::now();
    let l = Pool::join(&late.gossip, late.key.clone(), name, vec![boot_id])
        .await
        .unwrap();
    eventually("late joiner sees the worker", || {
        l.roster().get(&w.id()).is_some()
    })
    .await;
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "took {:?}",
        start.elapsed()
    );
}
