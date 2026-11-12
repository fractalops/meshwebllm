//! Endpoint, key and pool setup shared by the commands.

use std::{
    fs,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use iroh::protocol::Router;
use meshwebllm_core::{
    GOSSIP_ALPN, Gossip, SecretKey, bind_endpoint, default_bootstrap,
    pool::{Pool, now_ms},
};

use crate::PoolArgs;

/// A node that is a member of the pool.
pub struct PoolNode {
    pub router: Router,
    pub pool: Pool,
}

impl PoolNode {
    pub async fn join(args: &PoolArgs, key: SecretKey) -> Result<Self> {
        let mut bootstrap = args.bootstrap.clone();
        if bootstrap.is_empty() {
            bootstrap = default_bootstrap();
        }
        if bootstrap.is_empty() {
            bail!(
                "no bootstrap node is set. Use --bootstrap <ENDPOINT_ID> or set MESHWEBLLM_BOOTSTRAP"
            );
        }
        Self::join_with(args, key, bootstrap).await
    }

    pub async fn join_with(
        args: &PoolArgs,
        key: SecretKey,
        bootstrap: Vec<meshwebllm_core::EndpointId>,
    ) -> Result<Self> {
        let endpoint = bind_endpoint(key.clone(), vec![GOSSIP_ALPN.to_vec()]).await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let router = Router::builder(endpoint)
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        let pool = Pool::join(&gossip, key, &args.pool, bootstrap).await?;
        Ok(Self { router, pool })
    }

    /// Waits until the roster stops growing, or until `max` passes.
    /// Workers announce every 10 s, so a full roster takes up to one
    /// heartbeat after the first neighbor connects.
    pub async fn settle(&self, max: Duration, enough: impl Fn(&Pool) -> bool) {
        let start = Instant::now();
        while start.elapsed() < max && !enough(&self.pool) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Closes the node. Waits at most 3 s so a slow peer cannot block exit.
    pub async fn shutdown(self) {
        let _ = tokio::time::timeout(Duration::from_secs(3), self.router.shutdown()).await;
    }
}

/// True when at least one worker can take a job.
pub fn has_candidate(pool: &Pool) -> bool {
    !pool.roster().candidates(now_ms()).is_empty()
}

/// Loads a 32-byte secret key from `path`, or creates one there.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        let bytes = fs::read(path).with_context(|| format!("read key file {}", path.display()))?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
            anyhow::anyhow!("key file {} must hold exactly 32 bytes", path.display())
        })?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let key = SecretKey::generate();
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .with_context(|| format!("create key file {}", path.display()))?;
    file.write_all(&key.to_bytes())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_file_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("meshwebllm-test-{}", std::process::id()));
        let path = dir.join("sub").join("node.key");
        let _ = fs::remove_dir_all(&dir);
        let a = load_or_create_key(&path).unwrap();
        let b = load_or_create_key(&path).unwrap();
        assert_eq!(a.public(), b.public());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn short_key_file_is_an_error() {
        let path =
            std::env::temp_dir().join(format!("meshwebllm-short-{}.key", std::process::id()));
        fs::write(&path, [1, 2, 3]).unwrap();
        assert!(load_or_create_key(&path).is_err());
        fs::remove_file(&path).unwrap();
    }
}
