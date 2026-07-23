# Security Policy

Codeify CLI runs locally with the permissions of the user who starts it. It can read and write repository files, execute processes, access the network, and use credentials available to that user. Users are responsible for reviewing its operations or placing it inside a container, virtual machine, or other sandbox.

The local user account, writable home-directory files, shell startup files, environment, repository instructions, skills, and Codeify configuration are inside the same trust boundary as the CLI. Reports that require prior control of those resources are not privilege-boundary vulnerabilities unless they show how Codeify crosses an operating-system boundary.

Only install skills and tools you trust. Repository instructions and skill content can influence an agent by design.

## Reporting

Report security issues privately to `security@earendil.com` or through GitHub Security Advisories for this repository. Include the affected package and version, a reproducible description, impact, proof of concept or logs, and mitigations when known. Do not open a public issue for sensitive reports.

## Scope

Security issues in distributed packages, command-line tools, APIs, and repository code are in scope, as are issues in Codeify-operated infrastructure on `codeify.cc`.

## Out Of Scope

- Expected local command execution and filesystem access
- Prompt injection or malicious model output
- Behavior of user-installed skills or tools
- Risks from untrusted repositories or intentionally weakened configuration
- Issues requiring control of local files, symlinks, environment variables, shell configuration, or credentials
- Public exposure created by the user
- Third-party credential exposure or MITM proxy behavior
- Resource exhaustion requiring trusted local input
