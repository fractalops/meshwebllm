use std::{
    io::{Read, Write},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use clap::Args;
use meshwebllm_core::{
    Endpoint, EndpointId, SecretKey, bind_endpoint,
    client::{AskError, Completion, ask},
    pool::now_ms,
    proto::{ChatMessage, INFER_ALPN, Request, Role},
};

use crate::{
    PoolArgs,
    net::{PoolNode, has_candidate},
};

/// Workers to try before `ask` gives up.
const MAX_ATTEMPTS: usize = 3;

#[derive(Debug, Args)]
pub struct AskArgs {
    /// The prompt. If you omit it, the prompt is read from standard input.
    prompt: Option<String>,
    /// Send the prompt to this worker. Without it, a worker is chosen from the pool.
    #[arg(long, short)]
    worker: Option<EndpointId>,
    /// A system message to send before the prompt.
    #[arg(long)]
    system: Option<String>,
    /// Maximum number of tokens to generate.
    #[arg(long)]
    max_tokens: Option<u32>,
    /// Sampling temperature.
    #[arg(long)]
    temperature: Option<f32>,
    /// Seconds to wait for a connection to a worker.
    #[arg(long, default_value_t = 30)]
    connect_timeout: u64,
    /// Seconds to wait for a worker to appear in the pool.
    #[arg(long, default_value_t = 15)]
    wait: u64,
    /// Print the worker, model and token counts to standard error.
    #[arg(long, short)]
    verbose: bool,
    #[command(flatten)]
    pool: PoolArgs,
}

pub async fn run(args: AskArgs) -> Result<()> {
    let request = build_request(&args)?;
    let key = SecretKey::generate();

    if let Some(worker) = args.worker {
        let endpoint = bind_endpoint(key, vec![]).await?;
        let res = ask_one(&endpoint, worker, &request, &args).await;
        endpoint.close().await;
        return finish(res.map_err(Attempt::into_error)?, worker, args.verbose);
    }

    let node = PoolNode::join(&args.pool, key).await?;
    node.settle(Duration::from_secs(args.wait), has_candidate)
        .await;
    let candidates = node.pool.roster().candidates(now_ms());
    if candidates.is_empty() {
        node.shutdown().await;
        bail!("no worker is available in the pool. Run `meshwebllm peers` to see the pool");
    }
    let endpoint = node.router.endpoint().clone();
    let mut last_err = None;
    for worker in candidates.into_iter().take(MAX_ATTEMPTS) {
        match ask_one(&endpoint, worker, &request, &args).await {
            Ok(done) => {
                node.shutdown().await;
                return finish(done, worker, args.verbose);
            }
            Err(Attempt::Retry(err)) => {
                if args.verbose {
                    eprintln!("worker {} not used: {err:#}", worker.fmt_short());
                }
                last_err = Some(err);
            }
            Err(Attempt::Fatal(err)) => {
                node.shutdown().await;
                return Err(err);
            }
        }
    }
    node.shutdown().await;
    Err(last_err
        .expect("at least one attempt")
        .context(format!("{MAX_ATTEMPTS} workers did not answer")))
}

enum Attempt {
    /// Nothing was printed, so another worker can take the request.
    Retry(anyhow::Error),
    /// Output was already printed. A retry would repeat it.
    Fatal(anyhow::Error),
}

impl Attempt {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Retry(e) | Self::Fatal(e) => e,
        }
    }
}

async fn ask_one(
    endpoint: &Endpoint,
    worker: EndpointId,
    request: &Request,
    args: &AskArgs,
) -> Result<Completion, Attempt> {
    let conn = tokio::time::timeout(
        Duration::from_secs(args.connect_timeout),
        endpoint.connect(worker, INFER_ALPN),
    )
    .await
    .map_err(|_| {
        Attempt::Retry(anyhow::anyhow!(
            "no connection after {} s",
            args.connect_timeout
        ))
    })?
    .map_err(|e| Attempt::Retry(anyhow::Error::new(e).context("connect to the worker")))?;

    let mut printed = false;
    let mut out = std::io::stdout().lock();
    let res = ask(&conn, request, |text| {
        printed = true;
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    })
    .await;
    if printed {
        let _ = writeln!(out);
    }
    drop(out);
    conn.close(0u32.into(), b"done");

    res.map_err(|e: AskError| {
        let e = anyhow::Error::new(e);
        if printed {
            Attempt::Fatal(e)
        } else {
            Attempt::Retry(e)
        }
    })
}

fn finish(done: Completion, worker: EndpointId, verbose: bool) -> Result<()> {
    if verbose {
        eprintln!(
            "worker {} · model {} · prompt {} tokens · completion {} tokens",
            worker.fmt_short(),
            done.model,
            done.prompt_tokens,
            done.completion_tokens
        );
    }
    Ok(())
}

fn build_request(args: &AskArgs) -> Result<Request> {
    let prompt = match &args.prompt {
        Some(p) => p.clone(),
        None => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .context("read the prompt from standard input")?;
            s
        }
    };
    if prompt.trim().is_empty() {
        bail!("the prompt is empty");
    }
    let mut messages = Vec::new();
    if let Some(system) = &args.system {
        messages.push(ChatMessage {
            role: Role::System,
            content: system.clone(),
        });
    }
    messages.push(ChatMessage {
        role: Role::User,
        content: prompt,
    });
    Ok(Request {
        messages,
        max_tokens: args.max_tokens,
        temperature: args.temperature,
    })
}
