//! function-basis, the Crossplane composition function behind BASIS's APIs.
//!
//!     function-basis --insecure --debug   # local, for `crossplane render` (see tests/render/run.sh)
//!
//! Crossplane runs it with TLS_SERVER_CERTS_DIR set: mTLS on :9443.

use clap::Parser;
use function_sdk_rust::{Args, logging, serve};

#[tokio::main]
async fn main() -> Result<(), function_sdk_rust::Error> {
    let args = Args::parse();
    logging::configure(args.debug);
    serve(function_basis::function::Function, &args).await
}
