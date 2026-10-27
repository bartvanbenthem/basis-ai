package postgrescluster

import (
	"slices"
	"strings"
)

// Workload profiles (spec.profile). A profile tunes a cluster for a kind of
// workload: the size's settings for it (postgres-sizes, sizes[].profiles),
// and for vector the exporter queries on vector indexes. The extensions a
// profile suggests are the portal's business; the spec lists them.
const (
	ProfileGeneral = "general"
	ProfileVector  = "vector"
)

// imageExtensionsMinVersion is the first PostgreSQL major that loads
// extensions from image volumes (extension_control_path).
const imageExtensionsMinVersion = 18

// catalogExtension is one entry of the postgres-extensions catalog.
type catalogExtension struct {
	Name       string         `json:"name"`
	Parameters map[string]any `json:"parameters"`
	// Extensions it needs created first (CNPG doesn't CASCADE).
	Requires []string `json:"requires"`
	// Libraries CNPG must preload (shared_preload_libraries).
	SharedPreloadLibraries []string `json:"sharedPreloadLibraries"`
	// An extension the PostgreSQL image doesn't ship: mounted from this
	// image (CNPG image volume extensions, PostgreSQL 18+).
	Image *ExtensionImage `json:"image"`
	// Directories inside the image; CNPG defaults to share / lib.
	ExtensionControlPath []string `json:"extensionControlPath"`
	DynamicLibraryPath   []string `json:"dynamicLibraryPath"`
	LDLibraryPath        []string `json:"ldLibraryPath"`
}

// extensionConfig is what the extensions in use need in the Cluster.
type extensionConfig struct {
	// postgresql.conf settings (the first extension to set one wins).
	parameters map[string]string
	preload    []string
	// Image volume extensions, in catalog order.
	images []ClusterExtension
	// Image volume extensions in use that the catalog doesn't (or can't) say
	// how to mount: kept from the running Cluster, see member.imageExtensions.
	missing []string
	// What each catalog extension needs created first.
	requires map[string][]string
}

// ordered is a database's extensions list with what they require (catalog
// requires) added and put first: CNPG creates them in this order.
func (cfg extensionConfig) ordered(extensions []string) []string {
	var out []string
	var add func(e string, depth int)
	add = func(e string, depth int) {
		if slices.Contains(out, e) || depth > 8 {
			return
		}
		for _, r := range cfg.requires[e] {
			add(r, depth+1)
		}
		out = append(out, e)
	}
	for _, e := range extensions {
		add(e, 0)
	}
	return out
}

// usedExtensions are the extensions every database of the spec lists.
func (s *Spec) usedExtensions() map[string]bool {
	used := map[string]bool{}
	for _, e := range s.Database.Extensions {
		used[e] = true
	}
	for _, d := range s.Databases {
		for _, e := range d.Extensions {
			used[e] = true
		}
	}
	return used
}

// resolveExtensions resolves the extensions in use against the postgres-extensions
// catalog.
func (c *composition) resolveExtensions() extensionConfig {
	var catalog struct {
		Data struct {
			Extensions []catalogExtension `json:"extensions"`
		} `json:"data"`
	}
	if items := c.required[RequiredExtensions]; len(items) > 0 {
		decode(items[0], &catalog)
	}
	cfg := extensionConfig{parameters: map[string]string{}, requires: map[string][]string{}}
	for _, e := range catalog.Data.Extensions {
		cfg.requires[e.Name] = e.Requires
	}
	used := map[string]bool{}
	for e := range c.spec.usedExtensions() {
		for _, r := range cfg.ordered([]string{e}) {
			used[r] = true
		}
	}
	known := map[string]bool{}
	tooOld := c.spec.postgresVersion() < imageExtensionsMinVersion
	var skipped []string
	for _, e := range catalog.Data.Extensions {
		known[e.Name] = true
		if !used[e.Name] {
			continue
		}
		image := e.Image != nil && e.Image.Reference != ""
		if image && tooOld {
			skipped = append(skipped, e.Name)
			continue
		}
		fillParams(cfg.parameters, e.Parameters)
		for _, l := range e.SharedPreloadLibraries {
			if !slices.Contains(cfg.preload, l) {
				cfg.preload = append(cfg.preload, l)
			}
		}
		if image {
			cfg.images = append(cfg.images, ClusterExtension{Name: e.Name, Image: *e.Image,
				ExtensionControlPath: e.ExtensionControlPath, DynamicLibraryPath: e.DynamicLibraryPath,
				LDLibraryPath: e.LDLibraryPath})
		}
	}
	for e := range used {
		if !known[e] {
			cfg.missing = append(cfg.missing, e)
		}
	}
	slices.Sort(cfg.missing)
	if len(skipped) > 0 {
		// The admission policy refuses this; never mount them into an older PostgreSQL.
		c.setProblem("extensions %s are mounted from images, which needs postgresVersion %d or later",
			strings.Join(skipped, ", "), imageExtensionsMinVersion)
	}
	return cfg
}

// imageExtensions are the image volume extensions m's Cluster mounts: the
// catalog's, plus those the running Cluster already mounts for an extension
// still in use that the catalog no longer describes (or that can't be read).
// Dropping one would restart the instances without a library they preload.
func (m *member) imageExtensions(cfg extensionConfig) []ClusterExtension {
	out := slices.Clone(cfg.images)
	var running []ClusterExtension
	decode(dig(m.cluster, "spec", "postgresql", "extensions"), &running)
	for _, r := range running {
		if slices.Contains(cfg.missing, r.Name) {
			out = append(out, r)
		}
	}
	return out
}

// preloadLibraries are the libraries m's Cluster preloads: spec's and the
// catalog's for the extensions in use. While m keeps an image extension the
// catalog doesn't describe (see imageExtensions), it keeps every library the
// running Cluster preloads too.
func (m *member) preloadLibraries(spec []string, cfg extensionConfig, images []ClusterExtension) []string {
	out := slices.Clone(spec)
	extra := cfg.preload
	if len(images) > len(cfg.images) {
		var running []string
		decode(dig(m.cluster, "spec", "postgresql", "shared_preload_libraries"), &running)
		extra = append(slices.Clone(extra), running...)
	}
	for _, l := range extra {
		if !slices.Contains(out, l) {
			out = append(out, l)
		}
	}
	return out
}
