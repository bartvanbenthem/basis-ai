# Catalogs

What teams can choose is set by EnvironmentConfigs on the control plane. `api/install/install.sh`
installs them once and never overwrites them: after that, the objects on the control plane are the
catalogs, and you edit them there (`kubectl edit environmentconfig <name>`, or GitOps).

| Catalog | Holds | Read by |
|---|---|---|
| `postgres-extensions` | Extensions clusters may add, their settings, preloads, images | function, extension admission policy, portal |
| `project-defaults` | Ingress hosts, remote write, COSI driver and access class | Project composition |

The shipped extensions catalog is `api/apis/postgrescluster/extensions.yaml`, with every key
documented in its header.

## Extensions

```yaml
- name: vchord
  displayName: VectorChord
  description: Fast vector indexes for large embedding collections
  requires: [vector]                 # created first in every database that lists it
  sharedPreloadLibraries: [vchord]   # adding or removing it restarts the instances
  image:                             # not in the PostgreSQL image: mounted (PostgreSQL 18+)
    reference: ghcr.io/tensorchord/vchord-scratch:pg18-v1.1.1@sha256:...
  extensionControlPath: [usr/share/postgresql/18]
  dynamicLibraryPath: [usr/lib/postgresql/18/lib]
```

- Without `image`, only list extensions every image in the image catalog ships (contrib, pgvector,
  pgaudit in the standard images).
- With `image`: build it for the image catalog's PostgreSQL major and OS (trixie), pin a digest, and
  check that the locations support image volumes. Changing the digest rolls the instances out.
- **Removing an extension** only blocks clusters from adding it. Databases keep it, and a cluster keeps
  mounting an image extension it still uses.
- Check the license of what you add: VectorChord is AGPLv3 or ELv2, pg_search AGPLv3.

## Profiles

Profiles (`general`, `vector`) are part of the API, not a catalog; the function tunes each cluster
to its CPU, memory and profile (see [Configure a cluster](../clusters/configure.md#resources)).

## Admission

A ValidatingAdmissionPolicy takes the extensions catalog as its parameter: a new cluster (or a change
of extensions) must name what's in it, and an image extension needs PostgreSQL 18. Without the
catalog the policy lets everything through, and the function reports what it can't resolve in the
cluster's `status.message`.
