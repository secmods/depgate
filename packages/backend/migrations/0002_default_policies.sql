-- 0002_default_policies: the policies a new installation starts with. Inserted once; administrators
-- edit, disable or delete them freely, and nothing recreates them. Four enforce, four monitor.
-- Rows the application needs: a gateway with no policy at all protects nothing on its first day.

INSERT INTO policies (name, description, decision, conditions, mode, mode_changed_at) VALUES
('Quarantine new releases',
 'Blocks versions published less than 72 hours ago. Hijacked and typo-squatted packages are usually removed within that window. Use an exception for an urgent fix.',
 'BLOCK', '{"releaseAgeMaxHours": 72}', 'enforce', NULL),

('Critical vulnerabilities',
 'Blocks versions with a known vulnerability scored CVSS 9.0 or higher.',
 'BLOCK', '{"cvssMin": 9}', 'enforce', NULL),

('No pre-release versions',
 'Blocks alpha, beta, release-candidate, dev and snapshot versions. Pin a released version instead.',
 'BLOCK', '{"releaseTypes": ["prerelease", "dev", "snapshot"]}', 'enforce', NULL),

('Go pseudo-versions',
 'Blocks Go modules pulled at an untagged commit (v0.0.0-yyyymmddhhmmss-abcdef). Tag a release instead.',
 'BLOCK', '{"ecosystem": ["go"], "releaseTypes": ["pseudo"]}', 'enforce', NULL),

('Likely exploited vulnerabilities',
 'Records versions with a vulnerability whose EPSS probability of exploitation within 30 days is 50% or higher. Vulnerabilities without an EPSS score are ignored.',
 'BLOCK', '{"epssMin": 0.5, "epssUnknown": "ignore"}', 'monitor', now()),

('Strong copyleft licenses',
 'Records packages under GPL, AGPL, SSPL or EUPL, including -only, -or-later and WITH-exception forms. Decide with legal whether to enforce.',
 'BLOCK', '{"licenseDenyList": ["GPL-*", "AGPL-*", "SSPL-*", "EUPL-*"]}', 'monitor', now()),

('Unmaintained packages',
 'Records packages whose latest release is more than two years old.',
 'BLOCK', '{"releaseAgeMinDays": 730}', 'monitor', now()),

('Low project health',
 'Records packages whose source repository scores below 3 of 10 on the OpenSSF Scorecard. Projects without a score are not matched.',
 'BLOCK', '{"scorecardMinScore": 3, "scorecardUnknown": "allow", "scorecardUnavailable": "allow"}', 'monitor', now());
