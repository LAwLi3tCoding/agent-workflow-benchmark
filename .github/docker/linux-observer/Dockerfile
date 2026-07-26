FROM node:22-bookworm-slim AS launcher-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential libseccomp-dev \
  && rm -rf /var/lib/apt/lists/*

COPY seccomp-launcher.c /tmp/seccomp-launcher.c
RUN cc -O2 -Wall -Wextra -o /usr/local/bin/awb-seccomp-launcher /tmp/seccomp-launcher.c -lseccomp \
  && chmod 0755 /usr/local/bin/awb-seccomp-launcher

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libseccomp2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=launcher-build /usr/local/bin/awb-seccomp-launcher /usr/local/bin/awb-seccomp-launcher

USER 65532:65532
WORKDIR /workspace
