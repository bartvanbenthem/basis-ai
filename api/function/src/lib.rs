//! function-basis: every BASIS API's composition, one module per API, behind
//! one Crossplane composition function that dispatches on the XR's kind
//! (function.rs).

pub mod common;
pub mod function;

pub mod genaistack;
pub mod location;
pub mod mcpserver;
pub mod modelgateway;
pub mod modelserver;
pub mod postgrescluster;
pub mod project;
pub mod valkeycache;
