use std::path::PathBuf;

use anyhow::Result;
use clap::Args;
use meshwebllm_core::presence::RosterEvent;

use crate::{PoolArgs, default_key_path, net};

#[derive(Debug, Args)]
pub struct BootstrapArgs {
    /// File that holds this node's secret key. The node ID stays the same
    /// while the file exists. The file is created if it does not exist.
    #[arg(long)]
    key_file: Option<PathBuf>,
    #[command(flatten)]
    pool: PoolArgs,
}

pub async fn run(args: BootstrapArgs) -> Result<()> {
    let path = args
        .key_file
        .unwrap_or_else(|| default_key_path("bootstrap.key"));
    let key = net::load_or_create_key(&path)?;
    // Other bootstrap nodes are optional here. The first one starts alone.
    let node = net::PoolNode::join_with(&args.pool, key, args.pool.bootstrap.clone()).await?;
    println!("bootstrap node {}", node.pool.id());
    println!("key file {}", path.display());
    println!("pool {}", args.pool.pool);

    let events = node.pool.events();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            ev = events.recv() => match ev {
                Ok(RosterEvent::Joined(id)) => println!("joined  {}", id.fmt_short()),
                Ok(RosterEvent::Left(id)) => println!("left    {}", id.fmt_short()),
                Ok(RosterEvent::Stale(id)) => println!("stale   {}", id.fmt_short()),
                Ok(RosterEvent::Expired(id)) => println!("expired {}", id.fmt_short()),
                Err(_) => break,
            },
        }
    }
    node.shutdown().await;
    Ok(())
}
