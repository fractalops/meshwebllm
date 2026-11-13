//! Disposable layer-split transport. Enable only with `layer-split-experiment`.
//! This ALPN is deliberately independent of the completion protocol.

use std::{sync::Arc, time::Duration};

use iroh::{
    SecretKey,
    endpoint::{Connection, SendStream},
    protocol::{AcceptError, ProtocolHandler, Router},
};
use iroh_blobs::{BlobsProtocol, Hash, store::mem::MemStore};
use meshwebllm_core::bind_endpoint;
use n0_future::time::timeout;
use tokio::sync::{Mutex, mpsc};
use wasm_bindgen::prelude::*;

use crate::js_err;

const ALPN: &[u8] = b"meshwebllm/experiment-stage/0";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Pending {
    bytes: Vec<u8>,
    send: SendStream,
}

#[derive(Debug)]
struct Handler(mpsc::Sender<Pending>);

impl ProtocolHandler for Handler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        while let Ok((send, mut recv)) = connection.accept_bi().await {
            // One sequential request per connection in this experiment.
            let Ok(Ok(bytes)) = timeout(DEADLINE, recv.read_to_end(MAX_BYTES)).await else {
                break;
            };
            if self.0.try_send(Pending { bytes, send }).is_err() {
                break;
            }
        }
        Ok(())
    }
}

#[wasm_bindgen]
pub struct StagePeer {
    router: Router,
    jobs: Mutex<mpsc::Receiver<Pending>>,
    connection: Mutex<Option<Connection>>,
    blobs: MemStore,
    blob_connection: Mutex<Option<Connection>>,
}

#[wasm_bindgen]
impl StagePeer {
    pub async fn spawn(relay: Option<String>) -> Result<StagePeer, JsError> {
        let alpns = vec![ALPN.to_vec(), iroh_blobs::ALPN.to_vec()];
        let endpoint = if let Some(url) = relay {
            let url: iroh::RelayUrl = url.parse().map_err(js_err)?;
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(SecretKey::generate())
                .relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from(url)))
                .alpns(alpns)
                .bind()
                .await
                .map_err(js_err)?
        } else {
            bind_endpoint(SecretKey::generate(), alpns)
                .await
                .map_err(js_err)?
        };
        let blobs = MemStore::new();
        let (tx, rx) = mpsc::channel(1);
        let router = Router::builder(endpoint)
            .accept(ALPN, Handler(tx))
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .spawn();
        Ok(Self {
            router,
            jobs: Mutex::new(rx),
            connection: Mutex::new(None),
            blobs,
            blob_connection: Mutex::new(None),
        })
    }

    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.router.endpoint().id().to_string()
    }

    /// Explicit endpoint address avoids waiting for public discovery propagation.
    pub fn address(&self) -> Result<JsValue, JsError> {
        crate::to_js(&self.router.endpoint().addr())
    }

    pub async fn request(&self, address: JsValue, bytes: Vec<u8>) -> Result<Vec<u8>, JsError> {
        if bytes.len() > MAX_BYTES {
            return Err(js_err("activation payload exceeds 8 MiB"));
        }
        let address: iroh::EndpointAddr =
            serde_wasm_bindgen::from_value(address).map_err(js_err)?;
        timeout(DEADLINE, async {
            let mut slot = self.connection.lock().await;
            if !slot
                .as_ref()
                .is_some_and(|c| c.remote_id() == address.id && c.close_reason().is_none())
            {
                *slot = Some(
                    self.router
                        .endpoint()
                        .connect(address, ALPN)
                        .await
                        .map_err(js_err)?,
                );
            }
            let conn = slot.as_ref().expect("connection just established").clone();
            drop(slot);
            let (mut send, mut recv) = conn.open_bi().await.map_err(js_err)?;
            send.write_all(&bytes).await.map_err(js_err)?;
            send.finish().map_err(js_err)?;
            recv.read_to_end(MAX_BYTES).await.map_err(js_err)
        })
        .await
        .map_err(js_err)?
    }

    #[wasm_bindgen(js_name = nextJob)]
    pub async fn next_job(&self) -> Option<StageJob> {
        self.jobs
            .lock()
            .await
            .recv()
            .await
            .map(|job| StageJob(Arc::new(Mutex::new(Some(job)))))
    }

    /// Wait for a usable relay address before issuing an invite.
    pub async fn online(&self) -> Result<(), JsError> {
        timeout(DEADLINE, self.router.endpoint().online())
            .await
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = addBlob)]
    pub async fn add_blob(&self, bytes: Vec<u8>) -> Result<String, JsError> {
        if bytes.len() > MAX_BYTES {
            return Err(js_err("blob exceeds 8 MiB"));
        }
        let tag = self.blobs.add_bytes(bytes).await.map_err(js_err)?;
        Ok(tag.hash.to_string())
    }

    #[wasm_bindgen(js_name = verifyBlob)]
    pub fn verify_blob(bytes: &[u8], hash: String) -> Result<bool, JsError> {
        let hash: Hash = hash.parse().map_err(js_err)?;
        Ok(Hash::new(bytes) == hash)
    }

    #[wasm_bindgen(js_name = getBlob)]
    pub async fn get_blob(
        &self,
        address: JsValue,
        hash: String,
        expected_bytes: usize,
    ) -> Result<Vec<u8>, JsError> {
        if expected_bytes > MAX_BYTES {
            return Err(js_err("blob exceeds 8 MiB"));
        }
        let hash: Hash = hash.parse().map_err(js_err)?;
        let address: iroh::EndpointAddr =
            serde_wasm_bindgen::from_value(address).map_err(js_err)?;
        timeout(Duration::from_secs(180), async {
            let mut slot = self.blob_connection.lock().await;
            if !slot
                .as_ref()
                .is_some_and(|c| c.remote_id() == address.id && c.close_reason().is_none())
            {
                *slot = Some(
                    self.router
                        .endpoint()
                        .connect(address, iroh_blobs::ALPN)
                        .await
                        .map_err(js_err)?,
                );
            }
            let connection = slot.as_ref().expect("connection just established").clone();
            drop(slot);
            // iroh-blobs verifies the Bao/BLAKE3 stream against the requested hash.
            let bytes = iroh_blobs::get::request::get_blob(connection, hash)
                .await
                .map_err(js_err)?;
            if bytes.len() != expected_bytes {
                return Err(js_err("blob size mismatch"));
            }
            Ok(bytes.to_vec())
        })
        .await
        .map_err(js_err)?
    }

    pub async fn shutdown(&self) {
        let _ = self.router.shutdown().await;
    }
}

#[wasm_bindgen]
pub struct StageJob(Arc<Mutex<Option<Pending>>>);

#[wasm_bindgen]
impl StageJob {
    pub async fn payload(&self) -> Result<Vec<u8>, JsError> {
        let guard = self.0.lock().await;
        Ok(guard
            .as_ref()
            .ok_or_else(|| js_err("job finished"))?
            .bytes
            .clone())
    }

    pub async fn respond(&self, bytes: Vec<u8>) -> Result<(), JsError> {
        if bytes.len() > MAX_BYTES {
            return Err(js_err("response exceeds 8 MiB"));
        }
        let mut job = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| js_err("job finished"))?;
        timeout(DEADLINE, job.send.write_all(&bytes))
            .await
            .map_err(js_err)?
            .map_err(js_err)?;
        job.send.finish().map_err(js_err)
    }
}
