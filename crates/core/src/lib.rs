//! Shared code for the meshwebllm CLI and browser worker.
//!
//! - [`proto`]: wire format for one completion.
//! - [`worker`]: accepts completion requests and queues them for a model.
//! - [`client`]: sends a request and reads the streamed reply.
//! - [`presence`] and [`pool`]: signed worker announcements over gossip.

pub mod client;
pub mod pool;
pub mod presence;
pub mod proto;
pub mod worker;

pub use iroh::{Endpoint, EndpointId, SecretKey};
pub use iroh_gossip::{ALPN as GOSSIP_ALPN, Gossip};

use iroh::endpoint::{BindError, presets};

/// Endpoint IDs of the always-on nodes that new members use to join the
/// public pool.
pub const DEFAULT_BOOTSTRAP: &[&str] = &[];

/// Parses [`DEFAULT_BOOTSTRAP`].
pub fn default_bootstrap() -> Vec<EndpointId> {
    DEFAULT_BOOTSTRAP
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// Binds an endpoint that uses the public n0 relays and address lookup.
pub async fn bind_endpoint(
    secret_key: SecretKey,
    alpns: Vec<Vec<u8>>,
) -> Result<Endpoint, BindError> {
    Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        .alpns(alpns)
        .bind()
        .await
}
