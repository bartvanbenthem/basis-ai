//! The api directory's development tools (src/bin): what make generate,
//! tests/render/run.sh and the e2e scripts run.
//!
//! ```text
//! generate     the function's embedded assets and the APIs' OpenAPI documents
//! rendertest   the render tests' filters and assertions
//! observe      an observed-state fixture for the render tests
//! alertrules   monitoring/alerts/cnpg-cluster-rules.yaml from the upstream chart
//! xpkgcache    a package in a Crossplane package cache (e2e on kind)
//! ```

#![recursion_limit = "256"]

pub mod doc;
pub mod yaml;
