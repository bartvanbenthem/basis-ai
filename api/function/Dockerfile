# function-basis. Build from the api directory:
#   docker build -f function/Dockerfile -t function-basis .
FROM docker.io/library/rust:1.93-trixie AS build
WORKDIR /src
# The workspace: the function and the tools beside it (a member, so it must be there).
COPY Cargo.toml Cargo.lock ./
COPY function/ function/
COPY tools/ tools/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p function-basis --bin function-basis \
 && cp target/release/function-basis /function-basis

# glibc as the build stage's (Debian 13)
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=build /function-basis /function-basis
EXPOSE 9443
USER nonroot:nonroot
ENTRYPOINT ["/function-basis"]
