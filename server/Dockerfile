FROM golang:1.23 AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/watchtogeather-server .

FROM gcr.io/distroless/base-debian12

WORKDIR /app

COPY --from=builder /out/watchtogeather-server /app/watchtogeather-server

EXPOSE 8080

ENTRYPOINT ["/app/watchtogeather-server"]
