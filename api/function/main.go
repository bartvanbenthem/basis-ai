// Command function is function-basis, the Crossplane composition
// function behind BASIS's APIs (see postgrescluster/ for PostgresCluster).
//
//	function --insecure --debug   # local, for `crossplane render` (see tests/render/run.sh)
//
// Crossplane runs it with TLS_SERVER_CERTS_DIR set: mTLS on :9443.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/crossplane/function-sdk-go"
)

func main() {
	var (
		debug    = flag.Bool("debug", false, "Emit debug logs in addition to info logs.")
		network  = flag.String("network", "tcp", "Network on which to listen for gRPC connections.")
		address  = flag.String("address", ":9443", "Address at which to listen for gRPC connections.")
		certs    = flag.String("tls-server-certs-dir", os.Getenv("TLS_SERVER_CERTS_DIR"), "Directory containing server certs (tls.key, tls.crt) and the CA used to verify client certificates (ca.crt).")
		insecure = flag.Bool("insecure", false, "Run without mTLS credentials. If you supply this flag --tls-server-certs-dir will be ignored.")
	)
	flag.Parse()
	if err := run(*debug, *network, *address, *certs, *insecure); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(debug bool, network, address, certs string, insecure bool) error {
	log, err := function.NewLogger(debug)
	if err != nil {
		return err
	}
	return function.Serve(&Function{log: log},
		function.Listen(network, address),
		function.MTLSCertificates(certs),
		function.Insecure(insecure))
}
