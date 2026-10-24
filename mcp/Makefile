.PHONY: test test-db image push

# basis-mcp, the image every MCPServer runs (api/function/mcpserver's
# DefaultImage names this tag).
IMAGE ?= ghcr.io/bartvanbenthem/basis-mcp
VERSION ?= v0.1.0
TEST_DATABASE_URL ?= postgres://app:test@127.0.0.1:55432/app

# Unit tests; the store's tests are skipped without a database
test:
	go vet ./...
	go test -race ./...

# Every test, the store's against PostgreSQL with pgvector in a container
test-db:
	podman rm -f basis-mcp-test-pg >/dev/null 2>&1 || true
	podman run -d --name basis-mcp-test-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=test -p 55432:5432 \
	  docker.io/pgvector/pgvector:pg18 >/dev/null
	until podman exec basis-mcp-test-pg pg_isready -U app >/dev/null 2>&1; do sleep 1; done
	podman exec basis-mcp-test-pg psql -U app -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
	BASIS_MCP_TEST_DATABASE_URL=$(TEST_DATABASE_URL) go test -race -count=1 ./...; \
	  status=$$?; podman rm -f basis-mcp-test-pg >/dev/null; exit $$status

image:
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(VERSION) .

# Push the image; the package must be public, or each location needs a pull secret
push: image
	docker push $(IMAGE):$(VERSION)
