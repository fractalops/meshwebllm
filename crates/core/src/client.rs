//! Client side of the inference protocol.

use iroh::endpoint::{ClosedStream, Connection, ConnectionError, RecvStream};

use crate::proto::{ErrorCode, FrameError, Request, Response, read_frame, write_frame};

/// Summary of a finished completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub model: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// An error from [`ask`].
#[derive(Debug, thiserror::Error)]
pub enum AskError {
    /// The worker answered with an error frame.
    #[error("worker error ({code:?}): {message}")]
    Worker { code: ErrorCode, message: String },
    /// The worker closed the stream before it sent `Done` or `Error`.
    #[error("the worker closed the stream before the completion finished")]
    Incomplete,
    #[error("could not open a stream")]
    Connection(#[from] ConnectionError),
    #[error("stream already closed")]
    Closed(#[from] ClosedStream),
    #[error(transparent)]
    Frame(#[from] FrameError),
}

impl AskError {
    /// The worker's error code, if the worker sent an error frame.
    pub fn worker_code(&self) -> Option<ErrorCode> {
        match self {
            Self::Worker { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// One response stream. Dropping it stops receiving this completion without
/// closing the connection or affecting other requests.
pub struct CompletionStream {
    recv: RecvStream,
    finished: bool,
}

impl CompletionStream {
    /// Opens a completion using the existing inference protocol.
    pub async fn open(conn: &Connection, request: &Request) -> Result<Self, AskError> {
        let (mut send, recv) = conn.open_bi().await?;
        write_frame(&mut send, request).await?;
        send.finish()?;
        Ok(Self {
            recv,
            finished: false,
        })
    }

    /// Returns chunks and the final Done or Error frame. An early EOF is an error.
    pub async fn next(&mut self) -> Result<Option<Response>, AskError> {
        if self.finished {
            return Ok(None);
        }
        match read_frame::<_, Response>(&mut self.recv).await {
            Ok(Some(response)) => {
                self.finished = !matches!(response, Response::Chunk { .. });
                Ok(Some(response))
            }
            Ok(None) => {
                self.finished = true;
                Err(AskError::Incomplete)
            }
            Err(err) => {
                self.finished = true;
                Err(err.into())
            }
        }
    }
}

/// Runs one completion on an open connection. Calls `on_chunk` for each
/// piece of text as it arrives.
pub async fn ask(
    conn: &Connection,
    request: &Request,
    mut on_chunk: impl FnMut(&str),
) -> Result<Completion, AskError> {
    let mut stream = CompletionStream::open(conn, request).await?;
    loop {
        match stream.next().await? {
            Some(Response::Chunk { text }) => on_chunk(&text),
            Some(Response::Done {
                model,
                prompt_tokens,
                completion_tokens,
            }) => {
                return Ok(Completion {
                    model,
                    prompt_tokens,
                    completion_tokens,
                });
            }
            Some(Response::Error { code, message }) => {
                return Err(AskError::Worker { code, message });
            }
            None => return Err(AskError::Incomplete),
        }
    }
}
