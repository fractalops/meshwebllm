use std::time::Duration;

use anyhow::Result;
use clap::Args;
use meshwebllm_core::{
    SecretKey,
    pool::now_ms,
    presence::{Member, WorkerState},
};

use crate::{PoolArgs, net::PoolNode};

#[derive(Debug, Args)]
pub struct PeersArgs {
    /// Seconds to listen before the list is printed.
    #[arg(long, default_value_t = 12)]
    wait: u64,
    #[command(flatten)]
    pool: PoolArgs,
}

pub async fn run(args: PeersArgs) -> Result<()> {
    let node = PoolNode::join(&args.pool, SecretKey::generate()).await?;
    // Wait a full heartbeat so every worker has announced once.
    node.settle(Duration::from_secs(args.wait), |_| false).await;
    let now = now_ms();
    let mut members: Vec<Member> = node.pool.roster().members().cloned().collect();
    members.sort_by(|a, b| b.info.tokens_per_sec.total_cmp(&a.info.tokens_per_sec));
    println!("{}", render(&members, now, node.pool.neighbors()));
    node.shutdown().await;
    Ok(())
}

fn state(m: &Member, now: u64) -> String {
    if m.is_stale(now) {
        return "stale".into();
    }
    match m.info.state {
        WorkerState::Loading { percent } => format!("loading {percent}%"),
        WorkerState::Idle => "idle".into(),
        WorkerState::Busy => "busy".into(),
        WorkerState::Paused => "paused".into(),
    }
}

fn render(members: &[Member], now: u64, neighbors: usize) -> String {
    let mut out = format!(
        "{} workers · {} gossip neighbors\n",
        members.len(),
        neighbors
    );
    if members.is_empty() {
        return out;
    }
    out.push_str(&format!(
        "{:<12} {:<12} {:<22} {:>5} {:>7} {:>9} {:>6} {:>5}\n",
        "ENDPOINT", "STATUS", "ADAPTER", "JOBS", "SERVED", "TOKENS", "TOK/S", "BEAT"
    ));
    for m in members {
        out.push_str(&format!(
            "{:<12} {:<12} {:<22} {:>5} {:>7} {:>9} {:>6.1} {:>4}s\n",
            m.id.fmt_short().to_string(),
            state(m, now),
            truncate(&m.info.adapter, 22),
            format!("{}+{}", m.info.active, m.info.waiting),
            m.info.served,
            m.info.tokens_out,
            m.info.tokens_per_sec,
            m.silence(now).as_secs()
        ));
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).chain(['…']).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_prints_only_the_summary() {
        assert_eq!(render(&[], 0, 2), "0 workers · 2 gossip neighbors\n");
    }

    #[test]
    fn long_adapter_names_are_cut() {
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("abc", 4), "abc");
    }
}
