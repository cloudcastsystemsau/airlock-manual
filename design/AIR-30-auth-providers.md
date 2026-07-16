# AIR-30 — User authentication modes: internal, LDAP/AD, OIDC

Status: **IMPLEMENTED 2026-07-08** (go-ahead from Dan). LDAP verified live
against a glauth directory (search-then-bind, JIT provisioning, memberOf
role mapping, break-glass shadowing); OIDC implemented on IdentityModel
primitives with graceful failure paths — first live verification against
Dan's Entra ID/Keycloak recommended before rollout · relates to AIR-11
(security posture), §8.1 (roles).

## Requirement

Support three user auth modes, configurable in server settings and usable
together: **internal** (existing LiteDB users), **LDAP/Active Directory**
(broadcast plants are AD-heavy), and **OIDC SSO** (Entra ID / Okta /
Keycloak). Roles (admin/operator/viewer) must map from directory groups /
IdP claims; audits must show who authenticated via what.

## The load-bearing constraint

Airlock's own JWT is not just a REST bearer token: the WebSocket previews,
audio monitoring, and clip `<video>` media all carry it as a query token,
and its 8 h lifetime / claims shape is assumed throughout. Replacing it with
IdP-issued tokens would ripple through every one of those paths and couple
media auth to external token formats and lifetimes.

## Recommended architecture: federation into first-party token issuance

All modes converge on one pipeline:

```
authenticate (any mode) → resolve identity + role → mint the Airlock JWT
```

External IdPs federate INTO our token issuance — the rest of the system is
untouched. This is the BFF-style pattern current guidance recommends for
SPAs (backend is the OAuth client; browser never holds IdP tokens).

### Mode 1 — Internal (exists)
Unchanged. Also serves as **break-glass**: local admin login always works
regardless of directory/IdP outages or misconfiguration — an appliance must
not be lockable-out by its own SSO config.

### Mode 2 — LDAP / Active Directory
- Library: **Novell.Directory.Ldap.NETStandard** (MIT). Pure managed — no
  native surface (fits the supply-chain rules) and more reliable than
  System.DirectoryServices.Protocols off Windows, where S.DS.P needs a
  native libldap and lacks features on top of it.
- Flow: the existing login form → *search-then-bind*: service account (or
  anonymous, if permitted) finds the user DN from a filter template
  (`(sAMAccountName={0})` default), then binds as the user with the typed
  password. Direct bind-DN template supported as the no-service-account
  alternative.
- Security: LDAPS or StartTLS required by default (`ldap.security`:
  ssl | starttls | none-with-explicit-override).
- Role mapping: ordered list of `{groupDn → role}` rules evaluated against
  the user's `memberOf` (first match wins; no match = login refused unless
  a `defaultRole` is configured).
- JIT provisioning: on first login a user record is created (mode=ldap, no
  password hash) so audits, `lastLogin` and the users list stay coherent.

### Mode 3 — OIDC
- Flow: **Authorization Code + PKCE**, server-side (confidential client):
  `GET /api/auth/oidc/login` → provider → `GET /api/auth/oidc/callback` →
  validate ID token → map claims → mint Airlock JWT → redirect the SPA with
  the token. The browser never sees IdP tokens; state/nonce handled by the
  framework.
- Library: the framework's `Microsoft.AspNetCore.Authentication.OpenIdConnect`
  handler (discovery, code exchange, validation, nonce/state) scoped to the
  handshake only — a transient cookie carries the roundtrip, then our JWT
  takes over.
- Config: authority URL, clientId, clientSecret (write-only, like the SMTP
  password), scopes (`openid profile email` + groups), role mapping from a
  configurable claim (`groups`/`roles`) with `{claimValue → role}` rules.
- SPA: the login page shows "Sign in with SSO" when OIDC is enabled,
  alongside the username/password form.
- Requires `PublicBaseUrl` (already exists, AIR-23) for the redirect URI.

### Username/password form routing when LDAP + internal are both enabled
Try internal first (exact local user match), then LDAP. Local users shadow
directory users of the same name — deliberate, so break-glass can't be
shadowed the other way around.

## Settings shape (server settings, admin)

```
auth: {
  ldap:  { enabled, host, port, security, bindDn?, bindPassword?(write-only),
           baseDn, userFilter, roleMappings[{group, role}], defaultRole? }
  oidc:  { enabled, authority, clientId, clientSecret(write-only),
           scopes, roleClaim, roleMappings[{value, role}], defaultRole? }
}
```

Internal mode has no toggle — it is always available (break-glass).

## Audit & UX

- Audit principal becomes `user@mode` (e.g. `dan@ldap`, `dan@oidc`); LOGIN_OK/
  LOGIN_FAILED include the mode. Login rate limiting (AIR-11) applies to the
  form regardless of mode; OIDC redirects are exempt (provider rate-limits).
- Users page shows mode per user; password change hidden for directory users.

## Alternatives rejected

- **IdP tokens as the API token** (validate Entra/Okta JWTs directly):
  breaks the query-token media paths, couples lifetimes/claims to each IdP,
  and still needs a parallel path for internal/LDAP. Rejected.
- **System.DirectoryServices.Protocols**: native libldap dependency
  off-Windows and platform-divergent behaviour; the managed library wins on
  supply-chain and portability grounds.
- **Embedding a full IdP (IdentityServer/Keycloak sidecar)**: an appliance
  should consume the plant's identity, not run another identity product.

## Test & verification plan

- Unit: role-mapping rules (LDAP memberOf and OIDC claims), settings
  masking, provider fallthrough order, break-glass invariant.
- Integration (dev): LDAP against an OpenLDAP/Samba container; OIDC against
  a local Keycloak — both scriptable in CI later.
- Manual (Dan's plant): AD over LDAPS + Entra ID app registration.

## Estimate

LDAP provider + settings + tests ~1 day; OIDC handshake + SPA button + tests
~1 day; users-page/audit polish + docs ~½ day.
