# syntax=docker/dockerfile:1
#
# Render Web Service build for the WHAT data server.
# Builds the existing `what-server` binary and runs it bound to $PORT
# (Render injects PORT at runtime). The standalone `cargo build` /
# `cargo run` workflow is untouched.

# ---- Builder ----
FROM rust:1-bookworm AS builder

# fstapi builds C sources via the `cc` crate and generates bindings with
# `bindgen` (needs libclang); it also links zlib (-lz).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        clang \
        libclang-dev \
        zlib1g-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what the build needs: the server crate and the local
# third_party crates it depends on (fstapi, fst-reader).
COPY server ./server
COPY third_party/fst-tools ./third_party/fst-tools
COPY third_party/fst-reader ./third_party/fst-reader

# Build the release binary.
RUN cargo build --release --manifest-path server/Cargo.toml

# ---- Runtime ----
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        zlib1g \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/server/target/release/what-server /app/bin/what-server

# Bake the example KDB + waveform data into the image so the container
# can serve them without external storage.
COPY server/examples/kdb /app/examples/kdb
COPY server/examples/waves /app/examples/waves

# Render runs a long-running HTTP server on $PORT (injected at runtime;
# defaults to 80 if unset).
EXPOSE 80
ENV PORT=80

CMD ["sh", "-c", "exec /app/bin/what-server \
        --host 0.0.0.0 \
        --port ${PORT:-80} \
        --kdb-dir /app/examples/kdb \
        --wave-dir /app/examples/waves \
        --disable-web"]
