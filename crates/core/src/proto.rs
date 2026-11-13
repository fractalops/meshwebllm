//! Wire format for one completion.
//!
//! The client opens one bidirectional stream per completion. It writes one
//! [`Request`] frame and finishes its send side. The worker writes zero or
//! more [`Response::Chunk`] frames, then exactly one [`Response::Done`] or
//! [`Response::Error`] frame, and finishes.
//!
//! A frame is a 4-byte big-endian length followed by a postcard body.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// ALPN for the inference protocol.
pub const INFER_ALPN: &[u8] = b"meshwebllm/infer/0";

/// Largest frame a peer accepts, in bytes.
pub const MAX_FRAME: usize = 1 << 20;

/// Bytes reserved before a frame body arrives.
const INITIAL_BODY_CAPACITY: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

impl Request {
    /// A request with one user message and default options.
    pub fn user(prompt: impl Into<String>) -> Self {
        Self {
            messages: vec![ChatMessage {
                role: Role::User,
                content: prompt.into(),
            }],
            max_tokens: None,
            temperature: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    /// The worker queue is full.
    Busy,
    /// The worker is paused by its user.
    Paused,
    /// The request is not valid.
    BadRequest,
    /// The model failed while generating.
    Inference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Response {
    Chunk {
        text: String,
    },
    Done {
        model: String,
        prompt_tokens: u32,
        completion_tokens: u32,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

/// An error while reading or writing a frame.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("i/o error")]
    Io(#[from] std::io::Error),
    #[error("frame is {0} bytes, limit is {MAX_FRAME}")]
    TooLarge(usize),
    #[error("frame body is not valid")]
    Decode(#[from] postcard::Error),
}

/// Writes one frame.
pub async fn write_frame<W, T>(w: &mut W, value: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = postcard::to_stdvec(value)?;
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(body.len()));
    }
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    Ok(())
}

/// Reads one frame. Returns `None` when the stream ends before a new frame.
pub async fn read_frame<R, T>(r: &mut R) -> Result<Option<T>, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    // Grow with the received bytes. A length prefix alone must not reserve
    // up to MAX_FRAME for a peer that never sends the body.
    let mut body = Vec::with_capacity(len.min(INITIAL_BODY_CAPACITY));
    r.take(len as u64).read_to_end(&mut body).await?;
    if body.len() != len {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
    }
    Ok(Some(postcard::from_bytes(&body)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        let req = Request {
            temperature: Some(0.5),
            max_tokens: Some(128),
            ..Request::user("Summarize this")
        };
        write_frame(&mut a, &req).await.unwrap();
        let got: Request = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(got, req);
    }

    #[tokio::test]
    async fn responses_in_order_then_eof() {
        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        let sent = vec![
            Response::Chunk { text: "Hel".into() },
            Response::Chunk { text: "lo".into() },
            Response::Done {
                model: "m".into(),
                prompt_tokens: 3,
                completion_tokens: 2,
            },
        ];
        for r in &sent {
            write_frame(&mut a, r).await.unwrap();
        }
        drop(a);
        let mut got = Vec::new();
        while let Some(r) = read_frame::<_, Response>(&mut b).await.unwrap() {
            got.push(r);
        }
        assert_eq!(got, sent);
    }

    #[tokio::test]
    async fn rejects_oversized_length_prefix() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&((MAX_FRAME as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        let err = read_frame::<_, Response>(&mut b).await.unwrap_err();
        assert!(matches!(err, FrameError::TooLarge(_)), "{err}");
    }

    #[tokio::test]
    async fn truncated_body_is_an_error() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(&[1, 2, 3]).await.unwrap();
        drop(a);
        assert!(read_frame::<_, Response>(&mut b).await.is_err());
    }
}
