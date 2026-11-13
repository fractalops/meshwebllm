//! Browser bindings. The page runs the model. This crate runs the network.

mod transport;

use std::{sync::Arc, time::Duration};

use iroh::{endpoint::Connection, protocol::Router};
use meshwebllm_core::{
    Endpoint, EndpointId, GOSSIP_ALPN, Gossip, SecretKey, bind_endpoint,
    client::CompletionStream,
    pool::{Pool, now_ms},
    presence::{RosterEvent, WorkerInfo},
    proto::{ErrorCode, INFER_ALPN, Request},
    worker::{Job as CoreJob, JobQueue, job_queue},
};
use n0_future::StreamExt;
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell};
use wasm_bindgen::prelude::*;
use wasm_streams::readable::{ReadableStream, sys::ReadableStream as JsReadableStream};

/// Jobs that can wait while the model is busy.
const QUEUE_CAPACITY: usize = 2;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tracing_subscriber::fmt()
        .with_writer(|| ConsoleWriter(Vec::new()))
        .with_max_level(tracing::Level::INFO)
        .without_time()
        .with_ansi(false)
        .init();
}

/// Collects one log line and writes it to the browser console on drop.
struct ConsoleWriter(Vec<u8>);

impl std::io::Write for ConsoleWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for ConsoleWriter {
    fn drop(&mut self) {
        let line = String::from_utf8_lossy(&self.0);
        let line = line.trim_end();
        if !line.is_empty() {
            web_sys::console::log_1(&JsValue::from_str(line));
        }
    }
}

fn js_err(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(js_err)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_key(s: &str) -> Result<SecretKey, JsError> {
    if s.len() != 64 {
        return Err(js_err("secret key must be 64 hex characters"));
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(js_err)?;
    }
    Ok(SecretKey::from_bytes(&bytes))
}

/// One browser node: a pool member that can also serve completions.
#[wasm_bindgen]
pub struct MeshNode {
    key: SecretKey,
    router: Router,
    pool: Pool,
    queue: JobQueue,
    requester: OnceCell<Endpoint>,
    connection: Mutex<Option<Connection>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberView<'a> {
    id: String,
    info: &'a WorkerInfo,
    first_seen_ms: u64,
    last_seen_ms: u64,
    stale: bool,
}

#[derive(Serialize)]
struct EventView {
    kind: &'static str,
    id: String,
}

#[wasm_bindgen]
impl MeshNode {
    /// Starts a node and joins the pool. `secret_key_hex` keeps the same
    /// endpoint ID across page loads. Pass `undefined` to create a key.
    /// The node rejects completion requests until `setPaused(false)`.
    pub async fn spawn(
        secret_key_hex: Option<String>,
        pool_name: String,
        bootstrap: Vec<String>,
        relay: Option<String>,
    ) -> Result<MeshNode, JsError> {
        let key = match secret_key_hex {
            Some(s) => parse_key(&s)?,
            None => SecretKey::generate(),
        };
        let bootstrap = bootstrap
            .iter()
            .map(|s| s.parse::<EndpointId>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(js_err)?;
        let endpoint = transport::bind(
            key.clone(),
            vec![INFER_ALPN.to_vec(), GOSSIP_ALPN.to_vec()],
            relay,
        )
        .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let (handler, queue) = job_queue(QUEUE_CAPACITY);
        queue.set_paused(true);
        let router = Router::builder(endpoint)
            .accept(INFER_ALPN, handler)
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        let pool = Pool::join(&gossip, key.clone(), &pool_name, bootstrap)
            .await
            .map_err(js_err)?;
        Ok(MeshNode {
            key,
            router,
            pool,
            queue,
            requester: OnceCell::new(),
            connection: Mutex::new(None),
        })
    }

    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.router.endpoint().id().to_string()
    }

    /// The secret key as hex. Store it to keep the endpoint ID.
    #[wasm_bindgen(js_name = secretKeyHex)]
    pub fn secret_key_hex(&self) -> String {
        hex(&self.key.to_bytes())
    }

    pub fn neighbors(&self) -> usize {
        self.pool.neighbors()
    }

    /// Current pool members, without this node.
    pub fn roster(&self) -> Result<JsValue, JsError> {
        let now = now_ms();
        let roster = self.pool.roster();
        let view: Vec<MemberView> = roster
            .members()
            .map(|m| MemberView {
                id: m.id.to_string(),
                info: &m.info,
                first_seen_ms: m.first_seen_ms,
                last_seen_ms: m.last_seen_ms,
                stale: m.is_stale(now),
            })
            .collect();
        to_js(&view)
    }

    /// Coalesced roster and neighbor invalidations. Read `roster()` on each item.
    #[wasm_bindgen(js_name = rosterUpdates)]
    pub fn roster_updates(&self) -> JsReadableStream {
        let rx = self.pool.updates();
        let stream = n0_future::stream::unfold(rx, |rx| async move {
            rx.recv().await.ok()?;
            Some((Ok::<_, JsValue>(JsValue::NULL), rx))
        });
        ReadableStream::from_stream(stream).into_raw()
    }

    /// Membership changes as `{ kind, id }` objects.
    pub fn events(&self) -> JsReadableStream {
        let rx = self.pool.events();
        let stream = n0_future::stream::unfold(rx, |rx| async move {
            let ev = rx.recv().await.ok()?;
            let (kind, id) = match ev {
                RosterEvent::Joined(id) => ("joined", id),
                RosterEvent::Left(id) => ("left", id),
                RosterEvent::Stale(id) => ("stale", id),
                RosterEvent::Expired(id) => ("expired", id),
            };
            Some((
                EventView {
                    kind,
                    id: id.to_string(),
                },
                rx,
            ))
        })
        .map(|ev| to_js(&ev).map_err(JsValue::from));
        ReadableStream::from_stream(stream).into_raw()
    }

    /// Sets this node's worker status. See `WorkerInfo` in the core crate.
    pub fn announce(&self, info: JsValue) -> Result<(), JsError> {
        let info: WorkerInfo = serde_wasm_bindgen::from_value(info).map_err(js_err)?;
        self.pool.announce(info);
        Ok(())
    }

    /// Stops announcing and tells the pool that this worker left.
    pub async fn leave(&self) -> Result<(), JsError> {
        self.queue.set_paused(true);
        self.pool.leave().await.map_err(js_err)
    }

    /// While paused, new requests get a `Paused` error.
    #[wasm_bindgen(js_name = setPaused)]
    pub fn set_paused(&self, paused: bool) {
        self.queue.set_paused(paused);
    }

    /// Number of jobs waiting.
    pub fn waiting(&self) -> usize {
        self.queue.waiting()
    }

    /// Waits for the next job.
    #[wasm_bindgen(js_name = nextJob)]
    pub async fn next_job(&self) -> Option<Job> {
        self.queue
            .next()
            .await
            .map(|j| Job(Arc::new(Mutex::new(Some(j)))))
    }

    /// Sends a chat to a worker and streams the existing response frames to JS.
    /// A separate outbound endpoint also lets this tab test its own GPU over iroh.
    pub async fn complete(
        &self,
        worker: String,
        request: JsValue,
    ) -> Result<JsReadableStream, JsError> {
        let worker: EndpointId = worker.parse().map_err(js_err)?;
        let request: Request = serde_wasm_bindgen::from_value(request).map_err(js_err)?;
        let endpoint = self
            .requester
            .get_or_try_init(|| async { bind_endpoint(SecretKey::generate(), vec![]).await })
            .await
            .map_err(js_err)?;
        let addr = if worker == self.router.endpoint().id() {
            self.router.endpoint().addr()
        } else {
            worker.into()
        };
        let (connection, responses) = n0_future::time::timeout(Duration::from_secs(30), async {
            let mut slot = self.connection.lock().await;
            if !slot
                .as_ref()
                .is_some_and(|c| c.remote_id() == worker && c.close_reason().is_none())
            {
                *slot = Some(endpoint.connect(addr, INFER_ALPN).await.map_err(js_err)?);
            }
            let connection = slot.as_ref().expect("connection established").clone();
            drop(slot);
            let responses = CompletionStream::open(&connection, &request)
                .await
                .map_err(js_err)?;
            Ok::<_, JsError>((connection, responses))
        })
        .await
        .map_err(|_| js_err("The worker did not connect within 30 seconds."))??;
        // The stream owns the receive side. Cancelling the JS stream drops it
        // and sends STOP_SENDING; no detached task continues reading tokens.
        let stream = n0_future::stream::unfold(
            (responses, connection),
            |(mut responses, connection)| async move {
                match responses.next().await {
                    Ok(Some(frame)) => Some((
                        to_js(&frame).map_err(JsValue::from),
                        (responses, connection),
                    )),
                    Ok(None) => None,
                    Err(err) => Some((Err(JsValue::from(js_err(err))), (responses, connection))),
                }
            },
        );
        Ok(ReadableStream::from_stream(stream).into_raw())
    }

    pub async fn shutdown(&self) {
        if let Some(endpoint) = self.requester.get() {
            endpoint.close().await;
        }
        let _ = self.router.shutdown().await;
    }
}

/// One completion request. Answer it with `chunk`, then `done` or `fail`.
#[wasm_bindgen]
pub struct Job(Arc<Mutex<Option<CoreJob>>>);

#[wasm_bindgen]
impl Job {
    /// Endpoint ID of the client.
    pub async fn peer(&self) -> Option<String> {
        self.0.lock().await.as_ref().map(|j| j.peer.to_string())
    }

    /// The request: `{ messages: [{ role, content }], max_tokens, temperature }`.
    /// Roles are `System`, `User` or `Assistant`.
    pub async fn request(&self) -> Result<JsValue, JsError> {
        let guard = self.0.lock().await;
        let job = guard.as_ref().ok_or_else(|| js_err("job is finished"))?;
        let req: &Request = &job.request;
        to_js(req)
    }

    pub async fn chunk(&self, text: String) -> Result<(), JsError> {
        let mut guard = self.0.lock().await;
        let job = guard.as_mut().ok_or_else(|| js_err("job is finished"))?;
        job.chunk(text).await.map_err(js_err)
    }

    pub async fn done(
        &self,
        model: String,
        prompt_tokens: u32,
        completion_tokens: u32,
    ) -> Result<(), JsError> {
        let job = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| js_err("job is finished"))?;
        job.done(model, prompt_tokens, completion_tokens)
            .await
            .map_err(js_err)
    }

    /// Ends the job with an error. `code` is `Inference` or `Paused`.
    pub async fn fail(&self, code: String, message: String) -> Result<(), JsError> {
        let code = match code.as_str() {
            "Paused" => ErrorCode::Paused,
            _ => ErrorCode::Inference,
        };
        let job = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| js_err("job is finished"))?;
        job.fail(code, message).await.map_err(js_err)
    }
}
