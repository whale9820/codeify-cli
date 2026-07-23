# Containerization

Codeify runs with the permissions of the process that starts it. Run the entire CLI inside a container, VM, or other policy-controlled environment when the repository or automation is not fully trusted.

## Docker

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . /opt/codeify
RUN cd /opt/codeify && npm install --ignore-scripts && npm run build:offline

ENTRYPOINT ["/opt/codeify/codeify-test.sh"]
```

Build and run it with only the workspace and credentials you intend to expose:

```bash
docker build -t codeify-sandbox .
docker run --rm -it \
  -e CODEIFY_API_KEY \
  -v "$PWD:/workspace" \
  codeify-sandbox
```

Use a separate volume for `/root/.codeify/agent` when sessions should stay inside the container. Do not mount your host credentials unless the container is trusted.

## Stronger isolation

For unattended or untrusted work, use a VM or a policy-controlled sandbox with explicit filesystem, process, network, and credential rules. Mount only the repository paths Codeify needs and provide short-lived credentials where possible.
