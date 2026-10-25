//! Extensions: the postgres-extensions catalog says what each extension
//! needs (postgresql.conf settings, preloaded libraries, an image to mount
//! it from), the spec which ones the databases use.

use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

use super::manifests::{ClusterExtension, ExtensionImage};
use super::{Composition, Member, REQUIRED_EXTENSIONS, fill_params};
use crate::common::lenient::decode;
use crate::common::util::dig_opt;
use crate::lenient;

/// The first PostgreSQL major that loads extensions from image volumes
/// (extension_control_path).
pub const IMAGE_EXTENSIONS_MIN_VERSION: i64 = 18;

lenient! {
    /// One entry of the postgres-extensions catalog.
    #[serde(rename_all = "camelCase")]
    pub struct CatalogExtension {
        pub name: String,
        pub parameters: Map<String, Value>,
        /// Extensions it needs created first (CNPG doesn't CASCADE).
        pub requires: Vec<String>,
        /// Libraries CNPG must preload (shared_preload_libraries).
        pub shared_preload_libraries: Vec<String>,
        /// An extension the PostgreSQL image doesn't ship: mounted from this
        /// image (CNPG image volume extensions, PostgreSQL 18+).
        pub image: Option<ExtensionImage>,
        /// Directories inside the image; CNPG defaults to share / lib.
        pub extension_control_path: Vec<String>,
        pub dynamic_library_path: Vec<String>,
        #[serde(rename = "ldLibraryPath")]
        pub ld_library_path: Vec<String>,
    }
}

lenient! {
    pub struct CatalogData { pub extensions: Vec<CatalogExtension> }
}
lenient! {
    pub struct Catalog { pub data: CatalogData }
}

/// What the extensions in use need in the Cluster.
#[derive(Debug, Clone, Default)]
pub struct ExtensionConfig {
    /// postgresql.conf settings (the first extension to set one wins).
    pub parameters: BTreeMap<String, String>,
    pub preload: Vec<String>,
    /// Image volume extensions, in catalog order.
    pub images: Vec<ClusterExtension>,
    /// Image volume extensions in use that the catalog doesn't (or can't) say
    /// how to mount: kept from the running Cluster, see image_extensions.
    pub missing: Vec<String>,
    /// What each catalog extension needs created first.
    pub requires: BTreeMap<String, Vec<String>>,
}

impl ExtensionConfig {
    /// A database's extensions list with what they require (catalog
    /// requires) added and put first: CNPG creates them in this order.
    pub fn ordered(&self, extensions: &[String]) -> Vec<String> {
        fn add(cfg: &ExtensionConfig, out: &mut Vec<String>, e: &str, depth: usize) {
            if out.iter().any(|x| x == e) || depth > 8 {
                return;
            }
            for r in cfg.requires.get(e).into_iter().flatten() {
                add(cfg, out, r, depth + 1);
            }
            out.push(e.to_string());
        }
        let mut out = vec![];
        for e in extensions {
            add(self, &mut out, e, 0);
        }
        out
    }
}

impl Composition<'_> {
    /// The extensions every database of the spec lists.
    fn used_extensions(&self) -> BTreeSet<String> {
        let mut used: BTreeSet<String> = self.spec.database.extensions.iter().cloned().collect();
        for d in &self.spec.databases {
            used.extend(d.extensions.iter().cloned());
        }
        used
    }

    /// The extensions in use, resolved against the postgres-extensions catalog.
    pub(super) fn resolve_extensions(&mut self) -> ExtensionConfig {
        let catalog: Catalog = self.input.first(REQUIRED_EXTENSIONS).map(decode).unwrap_or_default();
        let mut cfg = ExtensionConfig::default();
        for e in &catalog.data.extensions {
            cfg.requires.insert(e.name.clone(), e.requires.clone());
        }
        let mut used: BTreeSet<String> = BTreeSet::new();
        for e in self.used_extensions() {
            used.extend(cfg.ordered(&[e]));
        }
        let mut known: BTreeSet<&str> = BTreeSet::new();
        let too_old = self.spec.postgres_version() < IMAGE_EXTENSIONS_MIN_VERSION;
        let mut skipped: Vec<&str> = vec![];
        for e in &catalog.data.extensions {
            known.insert(&e.name);
            if !used.contains(&e.name) {
                continue;
            }
            let image = e.image.as_ref().is_some_and(|i| !i.reference.is_empty());
            if image && too_old {
                skipped.push(&e.name);
                continue;
            }
            fill_params(&mut cfg.parameters, &e.parameters);
            for l in &e.shared_preload_libraries {
                if !cfg.preload.contains(l) {
                    cfg.preload.push(l.clone());
                }
            }
            if image {
                cfg.images.push(ClusterExtension {
                    name: e.name.clone(),
                    image: e.image.clone().unwrap_or_default(),
                    extension_control_path: e.extension_control_path.clone(),
                    dynamic_library_path: e.dynamic_library_path.clone(),
                    ld_library_path: e.ld_library_path.clone(),
                });
            }
        }
        cfg.missing = used.iter().filter(|e| !known.contains(e.as_str())).cloned().collect();
        if !skipped.is_empty() {
            // The admission policy refuses this; never mount them into an older PostgreSQL.
            self.set_problem(format!(
                "extensions {} are mounted from images, which needs postgresVersion {IMAGE_EXTENSIONS_MIN_VERSION} or later",
                skipped.join(", ")
            ));
        }
        cfg
    }
}

impl Member {
    /// The image volume extensions m's Cluster mounts: the catalog's, plus
    /// those the running Cluster already mounts for an extension still in use
    /// that the catalog no longer describes (or that can't be read). Dropping
    /// one would restart the instances without a library they preload.
    pub(super) fn image_extensions(&self, cfg: &ExtensionConfig) -> Vec<ClusterExtension> {
        let mut out = cfg.images.clone();
        let running: Vec<ClusterExtension> =
            dig_opt(self.cluster.as_ref(), &["spec", "postgresql", "extensions"]).map(decode).unwrap_or_default();
        for r in running {
            if cfg.missing.contains(&r.name) {
                out.push(r);
            }
        }
        out
    }

    /// The libraries m's Cluster preloads: spec's and the catalog's for the
    /// extensions in use. While m keeps an image extension the catalog doesn't
    /// describe (see image_extensions), it keeps every library the running
    /// Cluster preloads too.
    pub(super) fn preload_libraries(&self, spec: &[String], cfg: &ExtensionConfig, images: &[ClusterExtension]) -> Vec<String> {
        let mut out = spec.to_vec();
        let mut extra = cfg.preload.clone();
        if images.len() > cfg.images.len() {
            let running: Vec<String> =
                dig_opt(self.cluster.as_ref(), &["spec", "postgresql", "shared_preload_libraries"]).map(decode).unwrap_or_default();
            extra.extend(running);
        }
        for l in extra {
            if !out.contains(&l) {
                out.push(l);
            }
        }
        out
    }
}
