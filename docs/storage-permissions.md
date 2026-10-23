# Storage permissions — who may write what

Plan T-18 (decision D-10; findings HT-65, Prog-2, Soc-1). Code:
`modules/src/core/storage_permissions.ts`.

## Rule

Every collection the server uses (the registry `core/collections.ts`)
is **server-only for writes**: objects are written with
`permissionWrite: 0`. Reads keep their meaning (0 server, 1 owner,
2 public). `analytics_events` is read 0 as well: its events name other
players (`friend_added`, `player_blocked`).

Before T-18 about 21 writes used `permissionWrite: 1`, and Nakama 3.27
defaults an **omitted** permission to 1, so a modified client could
rewrite its own pass (`premiumPurchased`), missions, rating, friend
edges or club role with the native `WriteStorageObjects` API.

## Two layers

1. **Permissions** — `permissionWrite: 0` on every server write. The
   source scan in `tests/unit/storage_permissions.test.ts` fails on a
   `permissionWrite: 1`, and the e2e test double throws on any server
   write that leaves an object client-writable (an omitted field counts
   as 1, as in 3.27).
2. **Before-hook** — `registerBeforeWriteStorageObjects` rejects every
   client request that touches a collection outside the cloud-save
   whitelist, with `PERMISSION_DENIED` (HTTP 403). Permissions cannot
   stop a client from **creating** an object the server has not written
   yet (a `pass` row before the first `pass_get`, an `idem` key); the
   hook does.

## The cloud-save exception

The client's cloud save (plan B2, `NakamaSaveCloudStore` in the
`com.jgk.backend.nakama` package) writes with the native API to:

| Collection | Client permissions | Contents |
|---|---|---|
| `save` | read 1 / write 1 (owner) | private save documents `{"v":1,"b64":"…"}`, CAS by version |
| `public` | read 2 / write 1 | public documents `{"value": <json>}` other players read |

Those two collections are the hook's whitelist
(`CLIENT_WRITABLE_COLLECTIONS`); the server never writes them and they
are not in `core/collections.ts`.

## Existing objects

Objects written before T-18 keep their old permissions until
`admin_migrate_permissions` rewrites them (see
[`admin.md`](./admin.md) §7b): write 0 everywhere, read 0 in
`analytics_events`, values unchanged, resumable with
`{collection, cursor}`.
