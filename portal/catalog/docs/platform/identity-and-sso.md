# Single sign-on and personal database access with an IdP

Status: design notes, not implemented
Relates to: the *Single sign-on* and *Personal database access* items in the
[README TODO](https://github.com/bartvanbenthem/basis/blob/main/README.md#todo)

There are two separate problems here, and they differ a lot in difficulty:

1. **SSO for the platform:** the portal, each Project's Grafana and `kubectl` on the
   control plane sign in through the organisation's IdP (OIDC, e.g. Keycloak). This is mostly
   configuration.
2. **Personal database access:** engineers connect to PostgreSQL as themselves, with
   an identity from the IdP, instead of using a shared password. CNPG has nothing IdP-specific
   for this. It happens at the PostgreSQL level and has real trade-offs.

## 1. SSO for the platform

Today the portal uses the `guest` provider (`auth.providers.guest` in
[`app-config.production.yaml`](https://github.com/bartvanbenthem/basis/blob/main/portal/app-config.production.yaml)).

| Component | What to do |
|---|---|
| Backstage | OIDC sign-in against the IdP. A sign-in resolver maps the user and their IdP groups onto catalog `User`/`Group` entities, which are loaded from the IdP (Keycloak or LDAP org provider) instead of `examples/org.yaml`. Project access and portal permissions then follow IdP group membership. |
| Per-Project Grafana | Generic OAuth against the IdP, set on the Grafana CR that grafana-operator manages. Grafana roles (Viewer/Editor/Admin) are mapped from group claims, so a Project's team gets access to its own Grafana. |
| `kubectl` on the control plane | Kubernetes OIDC authentication (structured authentication config) with the IdP as issuer. The RoleBindings a Project creates then name IdP groups as subjects. |

The risk is low and nothing changes in the data path.

## 2. Personal database access

The `PostgresCluster` API already exposes the two hooks every option below needs:
`pgHba` (extra `pg_hba.conf` lines) and `roles[]` (CNPG managed roles), see the
[definition](https://github.com/bartvanbenthem/basis/blob/main/api/apis/postgrescluster/definition.yaml).

### Options

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **Short-lived credentials** (recommended first step) | The user signs in to the portal through the IdP and requests access to a cluster. The platform creates a login role with `VALID UNTIL` (CNPG managed roles support `validUntil`), or delegates to the Vault/OpenBao database secrets engine, and hands out a temporary password. | Works with every client and driver, and through PgBouncer. Fits the self-service model. Every login traces to a person. | Not SSO at the wire level: a credential exists for the length of its TTL. |
| **PostgreSQL 18 OAuth** (`oauth` in `pg_hba`, SASL `OAUTHBEARER`) | The client gets a token from the IdP (libpq uses the device authorization flow, so `psql` shows a URL and code). PostgreSQL validates the token with a **validator module** loaded through `oauth_validator_libraries`. | Real SSO with the IdP's MFA, and no database passwords. The authenticated identity appears in the logs (`log_connections`). | PostgreSQL 18 ships no validator, so a third-party one has to be in the image (or loaded from an extension image). Only libpq 18 based clients support it today, which excludes most GUI tools and JDBC. PgBouncer would have to support it too; until then humans connect to the cluster's `-rw`/`-ro` services directly. Requires PostgreSQL 18 clusters. |
| **LDAP in `pg_hba`** | Only applies when the IdP federates from AD/LDAP. PostgreSQL binds to AD itself (Keycloak is not an LDAP server). | Simple. Every client supports it. | The password passes through PostgreSQL (TLS required), there's no MFA, and roles still have to be synced. |
| **Kerberos / GSSAPI** | Uses AD tickets. | Real SSO. | Hard in Kubernetes (keytabs, service principals per cluster, DNS). Only worth it in an existing AD/Kerberos shop. |

Check the state of OAuth validators and PgBouncer support before committing to the
OAuth option; both are moving.

### Mapping identities to roles

Whichever option is chosen, the IdP identity has to end up as a PostgreSQL role:

- **Group roles per cluster:** NOLOGIN roles such as `<project>_read` and `<project>_write`,
  created through `roles[]` and given privileges (e.g. `pg_read_all_data`, or grants on the
  application schema). IdP groups map onto these.
- **Per-person login roles** that are granted the group roles. These are easy to audit but the
  number of roles grows with the number of people; with short-lived credentials they expire
  on their own.
- **Or no per-person roles:** with OAuth (or LDAP), `pg_ident.conf` maps every authenticated
  identity in a group onto the shared group role. The logs still record the authenticated
  identity, so you keep the audit trail.
- **One source of truth:** the Project's IdP group membership decides both portal access and
  database access, so removing someone from the group removes both.

### Suggested order

1. SSO for Backstage, Grafana and `kubectl`, with Project access driven by IdP groups.
2. Read/write group roles per cluster, plus short-lived personal credentials issued by the
   portal.
3. PostgreSQL 18 OAuth for passwordless `psql`, once a validator is chosen and packaged in the
   image catalog.
