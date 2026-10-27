.PHONY: generate check unit test function-image function-xpkg function-push install uninstall

# function-basis, the composition function behind every API (Project, Location,
# PostgresCluster, ValkeyCache, ModelServer, ModelGateway, MCPServer, GenAIStack).
FUNCTION_IMAGE ?= ghcr.io/bartvanbenthem/function-basis
FUNCTION_VERSION ?= v0.5.1
XPKG := _output/function-basis-$(FUNCTION_VERSION).xpkg

# Rebuild the function's embedded assets from monitoring/ (dashboards, alert rules)
# and the APIs' OpenAPI documents for the portal
generate:
	go run ./hack/generate

# Fail if a generated file is stale
check:
	go run ./hack/generate --check

# Vet and unit tests: the function and the tools
unit:
	go vet ./...
	go test ./...

# Unit tests, then offline render + schema validation tests (needs the
# crossplane CLI and Docker/podman)
test: unit
	tests/render/run.sh

function-image:
	docker build -f function/Dockerfile -t $(FUNCTION_IMAGE):$(FUNCTION_VERSION) .

# The Crossplane package: function/package metadata + the image as its runtime.
# Embedded from a saved tarball, so it works with podman's docker CLI too
# (--embed-runtime-image needs a Docker API socket).
function-xpkg: function-image
	mkdir -p _output
	rm -f _output/function-basis-$(FUNCTION_VERSION).tar  # podman won't overwrite an archive
	docker save -o _output/function-basis-$(FUNCTION_VERSION).tar $(FUNCTION_IMAGE):$(FUNCTION_VERSION)
	crossplane xpkg build --package-root=function/package \
	  --embed-runtime-image-tarball=_output/function-basis-$(FUNCTION_VERSION).tar --package-file=$(XPKG)

# Push the package; install/function-basis.yaml installs this tag
function-push: function-xpkg
	crossplane xpkg push --package-files=$(XPKG) $(FUNCTION_IMAGE):$(FUNCTION_VERSION)

install:
	install/install.sh

uninstall:
	install/uninstall.sh
