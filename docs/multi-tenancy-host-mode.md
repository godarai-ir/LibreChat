# Host-based multi-tenancy (`MULTI_TENANT_MODE=host`)

Status: **Phase 0 — findings and plan. No code has been written.**

Goal: one deployment serves many tenants. The tenant is chosen by the request `Host`:
`https://{slug}.chat.godarai.ir` → tenant `{slug}`. Each tenant has its own OIDC issuer
(`https://{slug}.godarai.ir`), client credentials, configuration, and isolated data. The existing
single-tenant behavior is unchanged when the mode is off.

Every claim below was read from code on branch `feat/host-based-multi-tenancy` (from `dev`,
`86b3a02b9`). Nothing was executed. Items marked **VERIFY** need a test or a runtime check before
being relied on.

## 1. Findings (confirmed by reading code)

### 1.1 Tenant resolution and context

| #   | Finding                                                                                                                                                                                                                                                                                           | Evidence                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| F1  | The only pre-auth resolver reads `X-Tenant-Id`, and only when `TRUST_TENANT_HEADER=true`. It never reads `Host`. There is no tenant registry, so an arbitrary well-formed id is accepted.                                                                                                         | `packages/api/src/middleware/preAuthTenant.ts:38-78`                                               |
| F2  | It is mounted per route, not globally: `/oauth`, `/api/auth`, `/api/pull-requests`, `/api/config`, `/api/share`. Static files, `/images`, `/api/files`, `/api/search`, `/api/messages`, `/api/convos`, ... run without pre-auth context and rely on `requireJwtAuth` → `tenantContextMiddleware`. | `api/server/index.js:405-447`                                                                      |
| F3  | `requireJwtAuth` runs passport (`jwt`, or `openidJwt` first when token reuse is on), then `tenantContextMiddleware` using `req.user.tenantId`. **Nothing compares the user's tenant with any host-derived tenant**, so a token for tenant A is accepted on host B.                                | `api/server/middleware/requireJwtAuth.js:167-211`, `packages/api/src/middleware/tenant.ts:130-172` |
| F4  | `TENANT_ISOLATION_STRICT=true` rejects authenticated requests without a tenant (403) and makes model access fail closed. The Mongoose plugin and its engine-neutral policy are solid foundations.                                                                                                 | `middleware/tenant.ts`, `data-schemas/src/tenant/policy.ts`, `models/plugins/tenantIsolation.ts`   |
| F5  | Middleware order: `requestContextMiddleware` → body parsers → `mongoSanitize` → `cors()` → `cookieParser` → **static files** → `passport.initialize` → `configureSocialLogins` → `capabilityContextMiddleware` → routes. A host middleware belongs before static files and before passport.       | `api/server/index.js:340-405`                                                                      |
| F6  | `trust proxy` defaults to `1` (`TRUST_PROXY`). Express then derives `req.hostname` from `X-Forwarded-Host`. In host mode the slug must come from the raw `Host` header, not `req.hostname`.                                                                                                       | `api/server/index.js:105,206`                                                                      |

### 1.2 OpenID Connect

| #   | Finding                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| O1  | `setupOpenId()` runs **once** at startup. It reads `OPENID_ISSUER`, `OPENID_CLIENT_ID`, `OPENID_CLIENT_SECRET`, `DOMAIN_SERVER + OPENID_CALLBACK_URL`, does discovery, stores the result in a module-level `openidConfig`, and registers a single passport strategy named `openid` (plus `openidAdmin`).                                                       | `api/strategies/openidStrategy.js:906-964`, `api/server/socialLogins.js:111-119` |
| O2  | `getOpenIdConfig()` is **synchronous** and is consumed in at least 17 files: `LogoutController`, `OpenIDSessionRefresh`, `OpenIDRefreshRecovery`, `OboTokenService`, `GraphApiService`, `routes/admin/auth`, `packages/api/src/auth/openid/{session,recovery}.ts`, `AuthController`.                                                                           | grep of `getOpenIdConfig\|openidConfig`                                          |
| O3  | `openIdJwtStrategy` takes audience, client id and issuer from `OPENID_CLIENT_ID` / the single config and uses one `jwks-rsa` client. It is built once.                                                                                                                                                                                                         | `api/strategies/openIdJwtStrategy.js:43-147`                                     |
| O4  | The OpenID session middleware (`express-session`) uses one `OPENID_SESSION_SECRET` and the `OPENID_SESSION` cache store. Cookies are `httpOnly`, `sameSite=strict`, `secure`, **no `Domain`** (host-only). Good: sibling tenant hosts do not share them.                                                                                                       | `socialLogins.js:50-65`, `packages/api/src/oauth/csrf.ts`                        |
| O5  | User creation for OIDC goes through `createUserIfAbsent`; whether `tenantId` is stamped depends on the ALS context at that moment (plugin stamps on save). The OIDC callback route `/oauth/openid/callback` is behind `preAuthTenantMiddleware`, so with correct context the stamp happens; without it the user is created untenanted. **VERIFY** with a test. | `openidStrategy.js:~705`, `models/plugins/tenantIsolation.ts`                    |
| O6  | The `openidRefreshFlight` model has **no `tenantId` field** (refresh single-flight state). `RefreshTokenBridge` is on the manual-scoping allow-list.                                                                                                                                                                                                           | `schema/openidRefreshFlight.ts`, `tenantIsolation.coverage.spec.ts`              |

### 1.3 Origins, cookies, CSRF

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| D1  | `DOMAIN_CLIENT` / `DOMAIN_SERVER` are read in 19 non-test files under `api/` and 7 under `packages/` (callbacks of every social strategy, `LogoutController`, `AuthService`, `UserController`, `routes/config.js`, `routes/oauth.js`, `oauthNavigation`, `requireSameOrigin`, `passkey.ts`, `mcp/oauth/handler.ts`, `middleware/error.ts`, `oauth/csrf.ts`, `pulls/oauth.ts`, `utils/path.ts`, `<base href>` in `index.js`). | grep                                          |
| D2  | The same-origin guard already falls back to comparing `Origin` with the request's own scheme + `Host`, so it needs no static wildcard in host mode — as long as `DOMAIN_CLIENT/SERVER` are not what feeds `trustedOrigins`.                                                                                                                                                                                                  | `packages/api/src/middleware/origin.ts:29-55` |
| D3  | `app.use(cors())` is the permissive default (no credentials).                                                                                                                                                                                                                                                                                                                                                                | `index.js:363`                                |

### 1.4 Data layer

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| M1  | 52 schemas; 5 have no `tenantId`: `codeEnvRef`, `defaults`, `fading` (helpers/sub-schemas), `openidRefreshFlight`, `skillSyncCredential`. Four models are on a reviewed manual-scoping allow-list: `SystemGrant`, `SkillSyncStatus`, `AuditLog`, `RefreshTokenBridge`.                                                                                                            | `schema/*.ts`, `tenantIsolation.coverage.spec.ts` |
| M2  | The existing coverage spec only checks models that **already have** a `tenantId` path. A new model without the field passes silently. In host mode it should fail.                                                                                                                                                                                                                | `tenantIsolation.coverage.spec.ts:36-50`          |
| M3  | `runAsSystem` is used in ~30 non-test files, heavily in scheduled/triggered work: `agents/triggers/service.ts` (20), `schedules/engine.ts` (11), `agents/queuedTurns.ts` (9), `images/authorization.ts` (7), `api/server/index.js` (7), `experimental.js` (5), `AuthController.js` (5), `schedules/service.ts` (5), `shared-links/access.ts` (4). Each needs a per-site decision. | grep                                              |

### 1.5 Files

| #   | Finding                                                                                                                                                                                                                                                                                     | Evidence                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| FI1 | S3 keys are tenant-prefixed (`.../t/<tenantId>/<base>/<userId>/<file>`) and verified against the file's tenant on access.                                                                                                                                                                   | `packages/api/src/storage/s3/crud.ts:185,723-736`                                         |
| FI2 | Local and Firebase have **no** tenant segment (`uploads/<userId>`, `images/<userId>`). CloudFront code is tenant-aware (shares S3 keys). Azure: not checked.                                                                                                                                | `api/server/services/Files/Local/crud.js`, `.../Firebase`                                 |
| FI3 | `/images/*` is served from `paths.imageOutput` behind `createImageAuthorizationMiddleware`, which parses `/images/<ownerId>/<filename>` and authorizes by owner and session. It already loads the owner's `tenantId` for config. It does not compare the owner's tenant with a host tenant. | `api/server/index.js:440-446`, `packages/api/src/images/authorization.ts:125-167,404-535` |

### 1.6 Search

| #   | Finding                                                                                                                                                                                                                              | Evidence                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| S1  | One filterable attribute (`user`); the plugin adds `user` to indexed attributes. Four call sites: `conversation.ts:~3775` (`filter: user = "..."`), `message.ts:4286` (`searchMessages`), `share.ts:1136`, `routes/messages.js:186`. | `mongoMeili.ts:1088-1108`, grep |

### 1.7 Cache, sessions, limiters

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C1  | `REDIS_KEY_PREFIX` is one deployment-wide prefix. `scopedCacheKey(base)` appends `:<tenantId>` and is used only in the MCP registry caches, `files/speech.ts`, and `agents/instructions/linked.ts`. App-config overrides (`_OVERRIDE_:<tenantId>:...`) and code environments have their own tenant schemes.                                                                                                                                         | `cache/cacheConfig.ts:172`, `data-schemas/src/config/tenantContext.ts:64` |
| C2  | `api/cache/getLogStores.js` defines ~35 stores. Tenant-dependent and unscoped (to be keyed): `ROLES`, `APP_CONFIG`, `CONFIG_STORE`, `TOOL_CACHE`, `TOKEN_CONFIG`, `MODEL_QUERIES`, `ENDPOINT_CONFIG`, `STARTUP_CONFIG`, `MODELS_CONFIG`, `USER_PRINCIPALS`, `FLOWS`, `ABORT_KEYS`, `PENDING_REQ`, `GEN_TITLE`, `AUDIO_RUNS`, `MESSAGES`, `OPENID_SESSION`, `OPENID_EXCHANGED_TOKENS`, `AUTH_USER_DOC`, `PASSKEY_CHALLENGE`, `ADMIN_OAUTH_EXCHANGE`. | `api/cache/getLogStores.js:26-79`                                         |
| C3  | ~30 rate limiters (`api/server/middleware/limiters/*`) use `keyGenerator: removePorts` (IP only) and a Redis/Keyv store per limiter name. One tenant's traffic shares a bucket with every other tenant. Violation caches are keyed the same way.                                                                                                                                                                                                    | `limiters/loginLimiter.js`, `getLogStores.js:26-41`                       |

### 1.8 Background work

~25 timers/engines exist. Request-less ones that touch tenant data: `files/sweep.ts` (expired files), `schedules/engine.ts`, `agents/triggers/engine.ts`, `agents/queuedTurns.ts`, `code/lifecycle.ts`, `skills/sync/github.ts`, `mcp/authorizationRetry.ts`, `stream/GenerationJobManager.ts` + job stores, `flow/manager.ts`. Clustered variant: `api/server/experimental.js` (separate entry; same wiring needs).

## 2. Design

### 2.1 Mode and guards (all new levers also get a `configSchema` field or a documented env)

- `MULTI_TENANT_MODE=host` (default off). `TENANT_HOST_BASE_DOMAIN=chat.godarai.ir`. `TENANT_OIDC_ISSUER_TEMPLATE=https://{slug}.godarai.ir`. `TENANT_RESERVED_SLUGS` (default: admin api app auth billing chat default help localhost login root shahrah signup support system www).
- Startup refuses to run in host mode unless `TENANT_ISOLATION_STRICT=true`, the base domain is set, and `TRUST_TENANT_HEADER` is not true. It also refuses or disables features that cannot be made tenant-safe (see §4 Q3).

### 2.2 Registry

A system-scoped collection `tenants` (explicitly on the manual-scoping allow-list):
`tenantId` (opaque, immutable), `slug` (unique, mutable alias), `status` (`active|suspended|deleting`),
`oidc { issuer?, clientId, clientSecret (encrypted with the existing credentials helpers), scopes }`,
timestamps. Cached lookup (short TTL, negative caching, explicit invalidation). CLI
`config/tenant.js` (create / update / rotate-secret / suspend / list; never prints secrets).

### 2.3 Host middleware (`packages/api/src/middleware/host.ts`)

Mounted first (right after `requestContextMiddleware`, before static files), on every route except `/health`, `/livez`, `/readyz`, `/metrics`. Parses the raw `Host` (lowercase, strip one port, reject trailing dot, empty, multi-label, over-long, non-`[a-z0-9-]`, punycode `xn--`), requires `{slug}.{TENANT_HOST_BASE_DOMAIN}`, rejects reserved slugs, loads the registry entry (404 unknown, 403 suspended), sets `req.tenantId` / `req.tenantSlug`, pre-warms the tenant's OIDC client config (see 2.4), and runs the rest of the request in `tenantStorage`. `X-Tenant-Id` is ignored in host mode.

### 2.4 Per-tenant OIDC without breaking 17 consumers

Keep `getOpenIdConfig()` **synchronous and signature-compatible**. In host mode it reads the current tenant from ALS and returns that tenant's `Configuration` from an in-memory cache that the host middleware has already populated (discovery is async, so it happens in the middleware, not in the getter). Pieces:

- `packages/api/src/auth/openid/tenant.ts`: cache of `{tenantId → Configuration}` with TTL, single-flight discovery, retry/backoff reusing the existing discovery settings, invalidation on registry change.
- One passport strategy per tenant (`openid:<tenantId>`), created lazily, with `callbackURL = https://{slug}.chat.godarai.ir/oauth/openid/callback` built from the validated host. The `/oauth/openid` route picks the strategy by `req.tenantId`.
- `iss` must equal the tenant issuer; if `tid`/`tenant` claims are present they must match the registry (mix-up protection). State/nonce/PKCE are stored in the tenant-bound session.
- `openIdJwtStrategy`: per-tenant audience (client id), issuer and JWKS client (cache keyed by issuer).
- `openidAdmin` / admin-panel SSO: disabled in host mode.

### 2.5 Host↔user binding

A small middleware after authentication: `user.tenantId !== req.tenantId` → 403 (log tenant ids and request id only). It is attached in `requireJwtAuth`, `optionalJwtAuth`, refresh, share, SSE/WebSocket auth, and the image/file authorization paths.

### 2.6 Per-request origin

`getTenantOrigin(req)` replaces the process-wide values wherever they are used per request (D1). `trustedOrigins` is derived from the validated tenant only. The `<base href>` logic is unchanged (always `/`).

### 2.7 Remaining areas

Data audit (M1-M3: coverage spec fails for any model without `tenantId` unless allow-listed; every `runAsSystem` site and native-collection access is listed with a decision), files (tenant segment for Local and any other non-S3 strategy; image authorization compares owner tenant to host tenant), search (`tenantId` filterable + mandatory filter at the 4 call sites + settings migration + a guard test), caches and limiters (key by tenant), background jobs (explicit per-tenant iteration or reviewed `runAsSystem`), logs (tenant slug in structured logs).

## 3. Phases (one commit each, tests + `tsc --noEmit` + lint per phase)

1. Flags, startup guards, `configSchema` fields
2. Registry model, cache, CLI
3. Host middleware (+ `/health` exemption, spoofing tests)
4. `getTenantOrigin` and replacing process-wide origins
5. Per-tenant OIDC (config cache, strategies, `iss`/`tid` checks, JWT strategy)
6. Host↔user binding
7. Data-layer audit + stricter coverage test + `runAsSystem` inventory fixes
8. Files (+ image authorization)
9. Search
10. Caches and limiters
11. Background jobs
12. Docs, `UPGRADING.md`

## 4. Decisions (answered before Phase 1)

- **Tenant identity.** `tenantId` is the immutable Godar tenant UUID (the `tid` claim). `slug` is a mutable alias held only in the registry, so a slug rename never rewrites documents or file paths.
- **Registry writer.** The external provisioner writes the registry (CLI and a system-authenticated internal API). LibreChat has no runtime dependency on the Godar control-plane to serve a request.
- **Feature scope.** Everything that touches tenant data must be tenant-safe in host mode: chat, agents, schedules, triggers, queued turns, skills sync, code API, MCP. Identity providers with one global credential set (SAML, LDAP, Google, Facebook, GitHub, Discord, Apple) and the admin-panel SSO cannot be made tenant-safe by this design (Godar is the only IdP), so startup refuses them in host mode instead of leaving them half-working.
- **File storage.** S3-compatible storage is required in host mode (`s3` or `cloudfront`); `local`, `firebase` and the rest are refused at startup. Tenant segments for Local are not implemented.
- **Redis.** `USE_REDIS=true` is required in host mode.

## 5. Registry (Phase 2, implemented)

- Model `Tenant` (`packages/data-schemas`): `tenantId` (immutable), `slug` (unique, lowercase DNS label), `status`, `oidc { issuer?, clientId, clientSecret, scopes? }`. It carries `tenantId` as data but is **not** tenant-isolated; it is on the reviewed manual-scoping allow-list because it is read before any tenant context exists. The schema rejects a plaintext `clientSecret` (must start with `v3:`) and a non-https issuer.
- Methods: `getTenantBySlug`, `getTenantById`, `listTenants`, `createTenant`, `updateTenant`. Expected failures (`DUPLICATE_SLUG`, `DUPLICATE_TENANT_ID`, `NOT_FOUND`) are typed results; lookups return `null` only for a missing row, and a database failure throws. `tenantId` cannot be changed through `updateTenant`.
- `createTenantRegistry` (`packages/api/src/tenancy/registry.ts`): cached lookup by slug with dependencies injected. Found tenants are cached for `ttlMs` (30 s), unknown or misconfigured slugs for `negativeTtlMs` (5 s) in a separate bounded map, so a flood of random hosts cannot evict real tenants. Concurrent lookups share one query, a lookup that began before an `invalidate` cannot cache stale data, and a database error is never reported as "unknown tenant". Only active tenants have their secret decrypted.
- CLI: `node config/tenant.js create|rotate-secret|set-status|rename|list`. The client secret is read from `TENANT_OIDC_CLIENT_SECRET` or stdin, never from an argument, and is stored with `encryptV3`. Reserved slugs are refused. A change reaches a running server within the registry TTL.
- Residual risk: `encryptV3` uses the deployment-wide `CREDS_KEY`, so tenant secrets are not encrypted under per-tenant keys. Separation between tenants is by `tenantId`, not by key.

## 6. Host middleware (Phase 3, implemented)

- `createHostTenantMiddleware` runs right after `requestContextMiddleware`, before static files, sessions and passport (`/health`, `/livez`, `/readyz` are registered earlier and stay reachable without a tenant host). It reads the raw `Host` header only: never `X-Forwarded-Host`, `req.hostname` or `X-Tenant-Id`.
- A tenant host is exactly `<slug>.<TENANT_HOST_BASE_DOMAIN>` with an optional numeric port. Rejected: trailing dot, several labels, IPv6 literals, userinfo, non-ASCII, `xn--` labels, labels over 63 characters, and the base domain itself.
- Responses: non-tenant host, reserved slug, unknown tenant or a tenant being deleted -> 404; suspended -> 403 `TENANT_SUSPENDED`; misconfigured tenant or a registry/database failure -> 503. Bodies never echo the host, the reason, or the error. A database failure is never reported as "unknown tenant".
- On success it sets `req.tenantId` / `req.tenantSlug` (any pre-set value is cleared first) and runs the rest of the request in the tenant's AsyncLocalStorage context. Concurrent requests for different tenants keep separate contexts (tested).
- `preAuthTenantMiddleware` previously opened a new context without a tenant on `/oauth`, `/api/auth`, `/api/config`, `/api/share`, which would have erased the host tenant. It now leaves the context alone when `req.tenantId` is already set, so the header can never override the host.
- Wiring is `createHostTenancyRuntime(...)` in `api/server/index.js` and `experimental.js`; it returns `null` when the mode is off.

## 7. Per-request origin (Phase 4, implemented)

- The host middleware sets `req.tenantOrigin` (`<TENANT_HOST_SCHEME>://<slug>.<base domain>[:port]`) from validated parts only, and the same value rides in the tenant's async context (`TenantContext.origin`, `getTenantOrigin()`), so code that runs inside a request without `req` still gets it.
- `getClientOrigin(req?)` / `getServerOrigin(req?)` return the tenant origin and otherwise `DOMAIN_CLIENT` / `DOMAIN_SERVER` exactly as before. The async-context lookup happens only when `MULTI_TENANT_MODE=host`, so single-tenant deployments never touch it.
- Converted: OAuth success redirect, OAuth/OpenID failure redirects (`redirectToAuthFailure`, error middleware), OpenID post-logout redirect, `/api/config` `serverDomain`, email-change links (lazy `clientDomain`), MCP OAuth redirect URI, pull-request OAuth redirect URI, Actions OAuth redirect URI, Flux image URLs.
- New startup refusals in host mode: a set `DOMAIN_CLIENT`/`DOMAIN_SERVER` (one fixed origin would put links to the wrong tenant in redirects and emails), `ADMIN_PANEL_URL` (every tenant would trust it as a cross-site origin), `ALLOW_PASSKEY_LOGIN` (a passkey is bound to one relying-party host), and an unsupported `TENANT_HOST_SCHEME`.
- Not converted on purpose: the social-login `failureRedirect` strings and `admin` routes (refused at startup in host mode), and OpenID logout, whose `OPENID_ISSUER` precondition belongs to the per-tenant OIDC work (Phase 5).
