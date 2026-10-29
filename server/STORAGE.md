# Local SQLite storage

Run `pnpm dev`, or `pnpm build` and `pnpm preview`. Both start the storage API inside Orvane's existing local server. There is no separate database server to install or launch. Static-only hosting cannot provide local filesystem storage.

The default file is `.orvane/workspace.sqlite`, relative to the project. Set `ORVANE_DATA_DIR` before starting Orvane to choose another local directory. The directory is excluded from Git and denied by the web server. SQLite may also maintain `-wal` and `-shm` files next to the database. Do not delete these while Orvane is running. Browsers on this computer, including different profiles and localhost/127.0.0.1 origins, use the same database when connected to servers configured with the same data directory. Other computers do not automatically synchronize.

## Migration

When SQLite has no workspace, its editing browser copies the current IndexedDB workspace, or falls back to the older `orvane.workspace.v1` localStorage record. Validation occurs before saving. Invalid data is not silently replaced with an empty workspace. The initial migration creates a recovery snapshot. The original browser database and localStorage bytes are retained and never dual-written.

An already populated SQLite database takes priority over browser-local data. To recover another browser's previous workspace, open that browser at its original Orvane URL and choose **Workspace → Recover earlier browser workspace**. Review Merge/Replace before committing. The shared workspace is snapshotted in the same transaction. Browser storage permissions are needed only to read an earlier browser workspace during migration/recovery.

## Consistency and recovery

The backend owns an editing lease for one browser tab. Heartbeats renew it; readers poll for saved revisions. Closing an editor releases ownership, and a crashed/disconnected editor's lease expires after 15 seconds. The database checks both ownership and the expected saved revision for every workspace mutation. Stale or expired clients cannot overwrite the newer workspace. After an ownership conflict, local work remains visible for export; reload to view the current shared workspace.

Workspace writes and recovery snapshots are atomic SQLite transactions. WAL mode, full synchronous commits, a busy timeout and a five-snapshot retention policy are configured. Imports and recovery use the same backend rather than keeping a writable browser copy. A small final autosave can be sent with lease release; pending unsaved edits also trigger the browser's normal close warning. If the backend is unavailable, edits remain in memory and the app offers export/retry. Restoring connectivity triggers another save when this browser still owns editing.

Use **Workspace → Export backup** for a portable JSON backup. For a complete filesystem backup, stop all Orvane server instances before copying the data directory, or use SQLite's online backup facility. Copying only the main `.sqlite` file while WAL transactions are active can omit recent data. Recovery snapshots live in the same database and do not replace external backups.

## Security boundary and runtime

The pinned `better-sqlite3` 13.0.3 dependency was verified at runtime to use SQLite **3.53.4**. Node's bundled SQLite 3.53.0 is not used. Startup rejects SQLite engines older than 3.53.4. The driver uses a bundled native library; no database executable installer is required on the verified Windows x64 platform. Check the actual engine when upgrading the driver, rather than assuming its package version equals the SQLite version.

The storage API accepts only local loopback connections with a loopback Host and same-origin browser requests. JSON-only mutations, no cross-origin CORS grant, opaque-origin rejection, session leases and bound SQL parameters protect the endpoint. It exposes fixed workspace operations, never caller-supplied SQL, database filenames or filesystem paths. Database downloads and direct Vite filesystem access to the data directory are blocked. SQLite uses `trusted_schema=OFF`; browser-authored app code has no database handle. The database file is not encrypted at rest; operating-system account access controls still apply. A patched engine is not a guarantee that all future vulnerabilities are absent.

Tests use a separate Vite server in `test-storage` mode and a distinct SQLite namespace for every test. Namespace selection is disabled in normal development and preview. These tests never reset or modify the user's shared database.
