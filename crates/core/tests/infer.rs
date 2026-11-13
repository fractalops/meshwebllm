//! End-to-end tests over real iroh endpoints on localhost, without relays.

use std::time::Duration;

use iroh::{Endpoint, SecretKey, endpoint::presets, protocol::Router};
use meshwebllm_core::{
    client::{AskError, CompletionStream, ask},
    proto::{ErrorCode, INFER_ALPN, Request},
    worker::{JobQueue, job_queue},
};

async fn local_endpoint(alpns: Vec<Vec<u8>>) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .alpns(alpns)
        .bind()
        .await
        .unwrap()
}

async fn worker(capacity: usize) -> (Router, JobQueue) {
    let (handler, queue) = job_queue(capacity);
    let ep = local_endpoint(vec![INFER_ALPN.to_vec()]).await;
    let router = Router::builder(ep).accept(INFER_ALPN, handler).spawn();
    (router, queue)
}

async fn connect(router: &Router) -> (Endpoint, iroh::endpoint::Connection) {
    let client = local_endpoint(vec![]).await;
    let conn = client
        .connect(router.endpoint().addr(), INFER_ALPN)
        .await
        .unwrap();
    (client, conn)
}

/// Answers every job by echoing the prompt in two chunks.
fn echo_model(queue: JobQueue) {
    tokio::spawn(async move {
        while let Some(mut job) = queue.next().await {
            let prompt = job.request.messages.last().unwrap().content.clone();
            let (a, b) = prompt.split_at(prompt.len() / 2);
            job.chunk(a.to_string()).await.unwrap();
            job.chunk(b.to_string()).await.unwrap();
            job.done("echo".into(), 1, 2).await.unwrap();
        }
    });
}

fn worker_code(err: AskError) -> ErrorCode {
    err.worker_code().expect("a worker error frame")
}

#[tokio::test]
async fn streams_chunks_then_done() {
    let (router, queue) = worker(4).await;
    echo_model(queue);
    let (_c, conn) = connect(&router).await;
    let mut text = String::new();
    let done = ask(&conn, &Request::user("hello world"), |t| text.push_str(t))
        .await
        .unwrap();
    assert_eq!(text, "hello world");
    assert_eq!(done.model, "echo");
    assert_eq!(done.completion_tokens, 2);
}

#[tokio::test]
async fn several_completions_share_one_connection() {
    let (router, queue) = worker(4).await;
    echo_model(queue);
    let (_c, conn) = connect(&router).await;
    for prompt in ["one", "two", "three"] {
        let mut text = String::new();
        ask(&conn, &Request::user(prompt), |t| text.push_str(t))
            .await
            .unwrap();
        assert_eq!(text, prompt);
    }
}

#[tokio::test]
async fn full_queue_answers_busy() {
    // No model runs, so the single queue slot stays full.
    let (router, queue) = worker(1).await;
    let (_c, conn) = connect(&router).await;
    let conn2 = conn.clone();
    let first = tokio::spawn(async move { ask(&conn2, &Request::user("first"), |_| {}).await });
    // Wait until the first job sits in the queue.
    tokio::time::timeout(Duration::from_secs(5), async {
        while queue.waiting() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let err = ask(&conn, &Request::user("second"), |_| {})
        .await
        .unwrap_err();
    assert_eq!(worker_code(err), ErrorCode::Busy);
    first.abort();
}

#[tokio::test]
async fn paused_worker_answers_paused() {
    let (router, queue) = worker(4).await;
    queue.set_paused(true);
    let (_c, conn) = connect(&router).await;
    let err = ask(&conn, &Request::user("hi"), |_| {}).await.unwrap_err();
    assert_eq!(worker_code(err), ErrorCode::Paused);
    assert_eq!(queue.waiting(), 0);
}

#[tokio::test]
async fn empty_request_answers_bad_request() {
    let (router, _queue) = worker(4).await;
    let (_c, conn) = connect(&router).await;
    let req = Request {
        messages: vec![],
        max_tokens: None,
        temperature: None,
    };
    let err = ask(&conn, &req, |_| {}).await.unwrap_err();
    assert_eq!(worker_code(err), ErrorCode::BadRequest);
}

#[tokio::test]
async fn dropped_job_is_an_error_for_the_client() {
    let (router, queue) = worker(4).await;
    tokio::spawn(async move {
        let mut job = queue.next().await.unwrap();
        job.chunk("partial".into()).await.unwrap();
        drop(job); // The model runtime fails without an error frame.
    });
    let (_c, conn) = connect(&router).await;
    let mut text = String::new();
    let res = tokio::time::timeout(
        Duration::from_secs(10),
        ask(&conn, &Request::user("x"), |t| text.push_str(t)),
    )
    .await
    .expect("client must not hang");
    assert!(matches!(res, Err(AskError::Incomplete)), "{res:?}");
    assert_eq!(text, "partial");
}

#[tokio::test]
async fn dropping_a_completion_cancels_only_its_stream() {
    let (router, queue) = worker(4).await;
    let (_client, conn) = connect(&router).await;
    let mut stream = CompletionStream::open(&conn, &Request::user("cancel me"))
        .await
        .unwrap();
    let mut job = queue.next().await.unwrap();
    job.chunk("first".into()).await.unwrap();
    assert!(stream.next().await.unwrap().is_some());
    drop(stream);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if job.chunk("x".repeat(4096)).await.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the reader must stop the worker stream");
    drop(job);
    echo_model(queue);
    let done = ask(&conn, &Request::user("still connected"), |_| {})
        .await
        .unwrap();
    assert_eq!(done.model, "echo");
}

#[tokio::test]
async fn stalled_request_is_dropped_after_the_deadline() {
    let (handler, _queue) = job_queue(4);
    let handler = handler.with_request_timeout(Duration::from_millis(200));
    let ep = local_endpoint(vec![INFER_ALPN.to_vec()]).await;
    let router = Router::builder(ep).accept(INFER_ALPN, handler).spawn();
    let (_c, conn) = connect(&router).await;
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    // A length prefix with no body: the worker must not wait for it forever.
    send.write_all(&64u32.to_be_bytes()).await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), recv.read_to_end(1024))
        .await
        .expect("the worker must give up on a stalled request");
    assert!(res.is_err(), "{res:?}");
}

#[tokio::test]
async fn queue_skips_jobs_whose_client_left() {
    let (router, queue) = worker(4).await;
    let (_c, conn) = connect(&router).await;
    let abandoned = CompletionStream::open(&conn, &Request::user("gone"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while queue.waiting() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(abandoned);
    // Give the STOP_SENDING frame time to arrive.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let kept = conn.clone();
    let live = tokio::spawn(async move {
        let mut text = String::new();
        ask(&kept, &Request::user("still here"), |t| text.push_str(t))
            .await
            .map(|_| text)
    });
    // Both requests are queued before the worker looks at either. The stop for
    // the first stream was sent before the second request on this connection.
    tokio::time::timeout(Duration::from_secs(5), async {
        while queue.waiting() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let job = tokio::time::timeout(Duration::from_secs(5), queue.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.request.messages[0].content, "still here");
    let mut job = job;
    job.chunk("ok".into()).await.unwrap();
    job.done("echo".into(), 1, 1).await.unwrap();
    assert_eq!(live.await.unwrap().unwrap(), "ok");
}

#[tokio::test]
async fn running_job_observes_client_cancellation() {
    let (router, queue) = worker(4).await;
    let (_c, conn) = connect(&router).await;
    let stream = CompletionStream::open(&conn, &Request::user("cancel"))
        .await
        .unwrap();
    let job = queue.next().await.unwrap();
    assert!(!job.is_cancelled());
    let cancelled = job.cancelled();
    drop(stream);
    tokio::time::timeout(Duration::from_secs(5), cancelled)
        .await
        .expect("cancellation must be observed without writing");
    assert!(job.is_cancelled());
}

#[tokio::test]
async fn cancellation_future_ends_after_a_delivered_reply() {
    let (router, queue) = worker(4).await;
    let (_c, conn) = connect(&router).await;
    let reply = tokio::spawn({
        let conn = conn.clone();
        async move { ask(&conn, &Request::user("hi"), |_| {}).await }
    });
    let job = queue.next().await.unwrap();
    let cancelled = job.cancelled();
    job.done("echo".into(), 1, 0).await.unwrap();
    reply.await.unwrap().unwrap();
    // Holders such as the browser binding must not keep a pending wait forever.
    tokio::time::timeout(Duration::from_secs(5), cancelled)
        .await
        .expect("a finished stream resolves once acknowledged or stopped");
}
