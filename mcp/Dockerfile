# basis-mcp, the MCP server of an MCPServer. Build from the mcp directory:
#   docker build -t basis-mcp .
FROM docker.io/library/golang:1.26 AS build
WORKDIR /src
ENV CGO_ENABLED=0
ARG VERSION=dev
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /basis-mcp .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /basis-mcp /basis-mcp
EXPOSE 8080 9090
USER nonroot:nonroot
ENTRYPOINT ["/basis-mcp"]
