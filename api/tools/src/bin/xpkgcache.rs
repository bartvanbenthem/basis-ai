//! xpkgcache writes a package into a Crossplane package cache, so a cluster
//! can install it without a registry (hack/e2e-*.sh on kind: Crossplane
//! can't pull from a plain-HTTP local registry).
//!
//!     xpkgcache <package-root> <repository> <out-dir>
//!
//! It writes <out-dir>/<cache id>.gz, the gzipped package.yaml stream
//! Crossplane caches (here: the package root's crossplane.yaml), and prints
//! the package reference to install it by: <repository>@sha256:<digest of
//! the stream>. With packagePullPolicy: Never and that digest-pinned
//! reference, Crossplane reads the package from its cache and never
//! contacts the registry.

use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("usage: xpkgcache <package-root> <repository> <out-dir>");
        std::process::exit(2);
    }
    if let Err(e) = run(&args[0], &args[1], &args[2]) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run(root: &str, repository: &str, out: &str) -> Result<(), String> {
    let meta = Path::new(root).join("crossplane.yaml");
    let stream = std::fs::read(&meta).map_err(|e| format!("{}: {e}", meta.display()))?;
    let identifier = format!("sha256:{}", hex::encode(Sha256::digest(&stream)));
    let reference = format!("{repository}@{identifier}");
    // The key Crossplane's package manager looks the package up by
    // (xpkg.FriendlyID of the source and the digest).
    let id = friendly_id(repository, &identifier);
    let path = Path::new(out).join(format!("{id}.gz"));
    let file = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut gz = GzEncoder::new(file, Compression::default());
    gz.write_all(&stream).and_then(|_| gz.finish().map(|_| ())).map_err(|e| format!("{}: {e}", path.display()))?;
    println!("{reference}");
    Ok(())
}

/// crossplane-runtime's xpkg.FriendlyID: name and hash cut to 50 and 12
/// bytes, as a DNS label.
fn friendly_id(name: &str, hash: &str) -> String {
    let cut = |s: &str, n: usize| s.get(..n).unwrap_or(s).to_string();
    to_dns_label(&format!("{}-{}", cut(name, 50), cut(hash, 12)))
}

/// crossplane-runtime's xpkg.ToDNSLabel.
fn to_dns_label(s: &str) -> String {
    let b = s.as_bytes();
    let mut cut = String::new();
    for (i, &c) in b.iter().enumerate() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cut.push(c as char);
        }
        if matches!(c, b'.' | b'/' | b':' | b'-') && i != 0 && i != 62 && i != b.len() - 1 {
            cut.push('-');
        }
        if i == 62 {
            break;
        }
    }
    cut.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn friendly_id() {
        // As crossplane-runtime names it.
        assert_eq!(
            super::friendly_id("ghcr.io/bartvanbenthem/function-basis", "sha256:a9c30a4170c75b3e1855d2e35ec72a7a5f8a5345cec1e6aa5d701c52cd3c68c9"),
            "ghcr-io-bartvanbenthem-function-basis-sha256-a9c30"
        );
    }
}
