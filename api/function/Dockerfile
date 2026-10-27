# function-basis. Build from the api directory:
#   docker build -f function/Dockerfile -t function-basis .
FROM docker.io/library/golang:1.26 AS build
WORKDIR /src
ENV CGO_ENABLED=0
COPY go.mod go.sum ./
RUN go mod download
COPY function/ function/
RUN go build -trimpath -ldflags="-s -w" -o /function ./function

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /function /function
EXPOSE 9443
USER nonroot:nonroot
ENTRYPOINT ["/function"]
