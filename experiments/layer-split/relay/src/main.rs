//! Optional loopback-only transport fixture. No model or inference code runs here.
use iroh_relay::server::{RelayConfig, Server, ServerConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new(([127, 0, 0, 1], 3340)));
    let server = Server::spawn(config).await?;
    println!("Test relay: http://127.0.0.1:3340 (loopback only)");
    tokio::signal::ctrl_c().await?;
    server.shutdown().await?;
    Ok(())
}
