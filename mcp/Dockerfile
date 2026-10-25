# basis-mcp, the MCP server of an MCPServer. Build from the mcp directory:
#   docker build -t basis-mcp .
FROM docker.io/library/rust:1.93-trixie AS build
WORKDIR /src
ARG VERSION=dev
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    VERSION=${VERSION} cargo build --release --locked \
 && cp target/release/basis-mcp /basis-mcp

# glibc as the build stage's (Debian 13)
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=build /basis-mcp /basis-mcp
EXPOSE 8080 9090
USER nonroot:nonroot
ENTRYPOINT ["/basis-mcp"]
