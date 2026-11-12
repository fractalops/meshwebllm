mod ask;
mod bootstrap;
mod net;
mod peers;

use std::{path::PathBuf, process::ExitCode};

use clap::{Args, Parser, Subcommand};
use meshwebllm_core::EndpointId;

#[derive(Debug, Parser)]
#[command(version, about = "Send prompts to browser tabs that run WebLLM.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Send one prompt and print the reply as it arrives.
    Ask(ask::AskArgs),
    /// Show the workers in the pool.
    Peers(peers::PeersArgs),
    /// Run an always-on node that new members use to join the pool.
    Bootstrap(bootstrap::BootstrapArgs),
}

/// Options for commands that join the pool.
#[derive(Debug, Clone, Args)]
pub struct PoolArgs {
    /// Endpoint ID of a bootstrap node. Repeat for more than one.
    #[arg(
        long = "bootstrap",
        env = "MESHWEBLLM_BOOTSTRAP",
        value_delimiter = ','
    )]
    pub bootstrap: Vec<EndpointId>,
    /// Name of the pool to join.
    #[arg(long, default_value = meshwebllm_core::presence::POOL_NAME)]
    pub pool: String,
}

/// Default location of a key file.
pub fn default_key_path(name: &str) -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("meshwebllm").join(name)
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_env("MESHWEBLLM_LOG"))
        .with_writer(std::io::stderr)
        .init();
    let result = match Cli::parse().command {
        Command::Ask(args) => ask::run(args).await,
        Command::Peers(args) => peers::run(args).await,
        Command::Bootstrap(args) => bootstrap::run(args).await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}
