-- 0003_malicious_version_ranges_resync
-- Schema changes and the rows the application needs to work. Plain SQL, one transaction with the rest of the
-- chain: no BEGIN/COMMIT, no CONCURRENTLY, no ALTER TYPE ... ADD VALUE. Never edited once it is on main.

-- Feed rows synced before version ranges were imported have version_range NULL (every version).
-- An empty watermark sorts before any changes_since, so the next sync is a full load, which
-- writes each row's pinned versions. The rest of the feed state stays for the status page.
UPDATE malicious_feed_state SET watermark = '';
