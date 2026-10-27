// Command xpkgcache writes a package into a Crossplane package cache, so a
// cluster can install it without a registry (hack/e2e-*.sh on kind: Crossplane
// can't pull from a plain-HTTP local registry).
//
//	xpkgcache <package-root> <repository> <out-dir>
//
// It writes <out-dir>/<cache id>.gz, the gzipped package.yaml stream
// Crossplane caches (here: the package root's crossplane.yaml), and prints the
// package reference to install it by: <repository>@sha256:<digest of the
// stream>. With packagePullPolicy: Never and that digest-pinned reference,
// Crossplane reads the package from its cache and never contacts the registry.
package main

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/crossplane/crossplane-runtime/v2/pkg/xpkg"
	"github.com/google/go-containerregistry/pkg/name"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: xpkgcache <package-root> <repository> <out-dir>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root, repository, out string) error {
	stream, err := os.ReadFile(filepath.Join(root, xpkg.MetaFile))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(stream)
	ref, err := name.ParseReference(repository + "@sha256:" + hex.EncodeToString(sum[:]))
	if err != nil {
		return err
	}
	// The key Crossplane's package manager looks the package up by.
	id := xpkg.FriendlyID(xpkg.ParsePackageSourceFromReference(ref), ref.Identifier())

	f, err := os.Create(filepath.Join(out, id+".gz"))
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck // closed below on the happy path
	w := gzip.NewWriter(f)
	if _, err := w.Write(stream); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	fmt.Println(ref.String())
	return nil
}
