# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).

## Xen Orchestra REST API (protocol documentation)

- Source: the Xen Orchestra documentation, "REST API" (https://docs.xen-orchestra.com/restapi, source
  `docs/docs/automation/restapi.md` of https://github.com/vatesfr/xen-orchestra), read on 2026-11-25, and the
  OpenAPI (Swagger) description that Xen Orchestra serves at `/rest/v0/docs/swagger.json` (REST API 0.41.1,
  xo-server 5.214.0, read from the container image `ronivay/xen-orchestra` that day).
- What was used: the routes (`/rest/v0/vms`, `/vms/<id>`, `/vms/<id>/stats`, `/vms/<id>/actions/<action>`,
  `/hosts`, `/srs`, `/backup-jobs`, `/backup-logs`, `/users/me`, `/users/<id>/authentication_tokens`,
  `/users/authentication_tokens`), the `fields`, `filter` and `limit` parameters, the `authenticationToken`
  cookie, the renewal of a token with itself, and the shapes of the answers, to write the client and the
  simulated Xen Orchestra of the tests.
- Xen Orchestra itself is AGPL-3.0 software (Vates SAS) that runs at the user's. No code is copied or ported
  from it, and none of it is shipped in this image: the integration only calls its documented REST API over
  the network.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
