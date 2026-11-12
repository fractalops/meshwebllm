//! Client side of the inference protocol.

use iroh::endpoint::{ClosedStream, Connection, ConnectionError};

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

/// Runs one completion on an open connection. Calls `on_chunk` for each
/// piece of text as it arrives.
pub async fn ask(
    conn: &Connection,
    request: &Request,
    mut on_chunk: impl FnMut(&str),
) -> Result<Completion, AskError> {
    let (mut send, mut recv) = conn.open_bi().await?;
    // The worker sees the stream only after the first bytes arrive, so the
    // client always writes first.
    write_frame(&mut send, request).await?;
    send.finish()?;
    loop {
        match read_frame::<_, Response>(&mut recv).await? {
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
