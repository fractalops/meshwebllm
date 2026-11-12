//! Worker side of the inference protocol.
//!
//! [`InferHandler`] accepts streams and puts each valid request in a bounded
//! queue as a [`Job`]. The model runtime takes jobs from [`JobQueue`] and
//! answers them. The handler answers `Busy` when the queue is full and
//! `Paused` when the worker is paused, so the model runtime never sees those
//! requests.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use iroh::{
    EndpointId,
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler},
};
use tracing::{debug, warn};

use crate::proto::{ErrorCode, FrameError, Request, Response, read_frame, write_frame};

/// An error while answering a job.
#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error("the stream is already closed")]
    Closed(#[from] iroh::endpoint::ClosedStream),
}

/// One request waiting for the model.
#[derive(Debug)]
pub struct Job {
    pub peer: EndpointId,
    pub request: Request,
    send: SendStream,
}

impl Job {
    /// Sends one piece of generated text.
    pub async fn chunk(&mut self, text: String) -> Result<(), JobError> {
        Ok(write_frame(&mut self.send, &Response::Chunk { text }).await?)
    }

    /// Ends the completion with token counts.
    pub async fn done(
        self,
        model: String,
        prompt_tokens: u32,
        completion_tokens: u32,
    ) -> Result<(), JobError> {
        self.end(Response::Done {
            model,
            prompt_tokens,
            completion_tokens,
        })
        .await
    }

    /// Ends the completion with an error.
    pub async fn fail(self, code: ErrorCode, message: String) -> Result<(), JobError> {
        self.end(Response::Error { code, message }).await
    }

    async fn end(mut self, last: Response) -> Result<(), JobError> {
        write_frame(&mut self.send, &last).await?;
        self.send.finish()?;
        Ok(())
    }
}

/// Protocol handler to register on a router under [`crate::proto::INFER_ALPN`].
#[derive(Debug, Clone)]
pub struct InferHandler {
    jobs: async_channel::Sender<Job>,
    paused: Arc<AtomicBool>,
}

/// The model runtime's end of the job queue.
#[derive(Debug, Clone)]
pub struct JobQueue {
    jobs: async_channel::Receiver<Job>,
    paused: Arc<AtomicBool>,
}

/// Creates a handler and its queue. `capacity` is the number of jobs that
/// can wait while the model is busy.
pub fn job_queue(capacity: usize) -> (InferHandler, JobQueue) {
    let (tx, rx) = async_channel::bounded(capacity.max(1));
    let paused = Arc::new(AtomicBool::new(false));
    (
        InferHandler {
            jobs: tx,
            paused: paused.clone(),
        },
        JobQueue { jobs: rx, paused },
    )
}

impl JobQueue {
    /// Waits for the next job. Returns `None` when the handler is gone.
    pub async fn next(&self) -> Option<Job> {
        self.jobs.recv().await.ok()
    }

    /// Number of jobs waiting.
    pub fn waiting(&self) -> usize {
        self.jobs.len()
    }

    /// While paused, new requests get a `Paused` error.
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

impl InferHandler {
    async fn handle_stream(
        &self,
        peer: EndpointId,
        mut send: SendStream,
        mut recv: RecvStream,
    ) -> Result<(), JobError> {
        let Some(request) = read_frame::<_, Request>(&mut recv).await? else {
            return Ok(());
        };
        let reject = |code, message: &str| Response::Error {
            code,
            message: message.to_string(),
        };
        let rejection = if self.paused.load(Ordering::Relaxed) {
            Some(reject(ErrorCode::Paused, "worker is paused"))
        } else if request.messages.is_empty() {
            Some(reject(ErrorCode::BadRequest, "request has no messages"))
        } else {
            match self.jobs.try_send(Job {
                peer,
                request,
                send,
            }) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    send = e.into_inner().send;
                    Some(reject(ErrorCode::Busy, "worker queue is full"))
                }
            }
        };
        if let Some(r) = rejection {
            debug!(%peer, ?r, "rejecting request");
            write_frame(&mut send, &r).await?;
            send.finish()?;
        }
        Ok(())
    }
}

impl ProtocolHandler for InferHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer = connection.remote_id();
        // One stream per completion. Serve streams until the peer closes.
        while let Ok((send, recv)) = connection.accept_bi().await {
            let this = self.clone();
            n0_future::task::spawn(async move {
                if let Err(err) = this.handle_stream(peer, send, recv).await {
                    warn!(%peer, "stream failed: {err}");
                }
            });
        }
        Ok(())
    }
}
