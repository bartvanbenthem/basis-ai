# BASIS Lens. Build from this directory: docker build -t basis-lens .
FROM docker.io/library/golang:1.26 AS build
WORKDIR /src
ENV CGO_ENABLED=0
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web/ web/
RUN go build -trimpath -ldflags="-s -w" -o /lens .

# static-debian12 has the CA certificates for the sample photos' HTTPS.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /lens /lens
EXPOSE 8080
# Numeric: Kubernetes can only verify runAsNonRoot for a numeric user
USER 65532:65532
ENTRYPOINT ["/lens"]
