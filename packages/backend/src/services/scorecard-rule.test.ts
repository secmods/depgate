import { describe, expect, it } from 'vitest';
import {
  compileScorecard,
  normaliseRepoUrl,
  parseDepsDevProject,
  parseScorecardApi,
  scorecardConditionsError,
  scorecardOutcome,
  canonicalScorecardChecks,
  type ScorecardLookup,
  type ScorecardResult,
} from './scorecard-rule.js';

describe('normaliseRepoUrl', () => {
  it.each([
    ['git+https://github.com/expressjs/express.git', 'github.com/expressjs/express'],
    ['https://github.com/expressjs/express', 'github.com/expressjs/express'],
    ['http://www.github.com/expressjs/express/', 'github.com/expressjs/express'],
    ['git@github.com:o/r.git', 'github.com/o/r'],
    ['ssh://git@github.com/o/r.git', 'github.com/o/r'],
    ['git://github.com/o/r.git', 'github.com/o/r'],
    ['github:o/r', 'github.com/o/r'],
    ['gitlab:group/r', 'gitlab.com/group/r'],
    ['https://github.com/babel/babel/tree/main/packages/babel-core', 'github.com/babel/babel'],
    ['https://github.com/o/r#readme', 'github.com/o/r'],
    ['https://github.com/o/r?tab=readme', 'github.com/o/r'],
    ['https://GitHub.COM/Owner/Repo', 'github.com/Owner/Repo'],
    ['https://gitlab.com/group/sub/project/-/tree/main', 'gitlab.com/group/sub/project'],
    ['scm:git:git://github.com/junit-team/junit4.git', 'github.com/junit-team/junit4'],
    ['scm:git:https://github.com/google/guava.git', 'github.com/google/guava'],
    ['github.com/spf13/cobra', 'github.com/spf13/cobra'],
  ])('%s → %s', (raw, expected) => {
    expect(normaliseRepoUrl(raw)).toBe(expected);
  });

  describe.each([
    [
      'ssh://',
      [
        'ssh://git@github.com/o/r.git',
        'ssh://github.com/o/r',
        'ssh://git@github.com:22/o/r.git',
        'ssh://git@github.com:o/r.git',
        'git+ssh://git@github.com/o/r.git',
        'git+ssh://git@github.com:o/r.git',
        'scm:git:ssh://git@github.com/o/r.git',
        'SSH://GIT@GITHUB.COM/o/r.git',
      ],
    ],
    ['git://', ['git://github.com/o/r.git', 'git://github.com/o/r', 'git+git://github.com/o/r.git', 'scm:git:git://github.com/o/r.git']],
    [
      'https:// and http://',
      [
        'https://github.com/o/r',
        'https://github.com/o/r.git',
        'https://github.com/o/r.git/',
        'https://github.com:443/o/r',
        'HTTPS://GITHUB.COM/o/r',
        'http://github.com/o/r',
        'http://www.github.com/o/r',
        'git+https://github.com/o/r.git',
        'git+https://github.com/o/r.git#v1.0.0',
        'https://user:token@github.com/o/r.git',
        'https://github.com/o/r/issues',
        'https://github.com/o/r/blob/main/README.md',
        'https://github.com/o/r.git?x=1',
        'scm:git:https://github.com/o/r',
      ],
    ],
    ['scp-style and bare', ['git@github.com:o/r.git', 'git@github.com:o/r', 'scm:git:git@github.com:o/r.git', 'github.com:o/r', 'github.com/o/r', 'github:o/r']],
  ])('%s forms', (_scheme, urls) => {
    it.each(urls)('%s → github.com/o/r', (raw) => {
      expect(normaliseRepoUrl(raw)).toBe('github.com/o/r');
    });
  });

  it.each([
    ['https://github.com/google/bughunters/tree/main/'],
    ['https://github.com/google/bughunters/tree/main/oss-repository-tier'],
    ['https://github.com/google/bughunters/tree/main/bughunters/articles#readme'],
    ['https://github.com/google/bughunters/tree/feature/x/y?tab=readme-ov-file'],
    ['https://github.com/google/bughunters/blob/main/README.md'],
    ['https://github.com/google/bughunters/commit/abc123'],
    ['https://github.com/google/bughunters/releases/tag/v1.0.0'],
    ['https://github.com/google/bughunters/pulls'],
    ['https://github.com/google/bughunters.git/'],
    ['git+https://github.com/google/bughunters.git/tree/main'],
    ['git@github.com:google/bughunters.git/tree/main'],
  ])('a GitHub URL with a full path is its repository: %s', (raw) => {
    expect(normaliseRepoUrl(raw)).toBe('github.com/google/bughunters');
  });

  it.each([
    ['https://gitlab.com/group/sub/repo/-/tree/main/src'],
    ['https://gitlab.com/group/sub/repo/-/blob/main/README.md'],
    ['https://gitlab.com/group/sub/repo.git/-/tree/main'],
    ['https://gitlab.com/group/sub/repo/tree/master'],
    ['https://gitlab.com/group/sub/repo/blob/master/x.md'],
    ['https://gitlab.com/group/sub/repo/raw/master/x'],
    ['https://gitlab.com/group/sub/repo/commits/master'],
    ['https://gitlab.com/group/sub/repo/merge_requests'],
    ['https://gitlab.com/group/sub/repo/releases'],
  ])('a GitLab URL with a full path is its repository: %s', (raw) => {
    expect(normaliseRepoUrl(raw)).toBe('gitlab.com/group/sub/repo');
  });

  it('a GitLab group or project named like a page is kept when it comes first', () => {
    expect(normaliseRepoUrl('https://gitlab.com/tags/releases')).toBe('gitlab.com/tags/releases');
  });

  it.each([
    ['ssh://git@gitlab.com/group/sub/repo.git'],
    ['git@gitlab.com:group/sub/repo.git'],
    ['git+ssh://git@gitlab.com:group/sub/repo.git'],
    ['git://gitlab.com/group/sub/repo.git'],
    ['https://gitlab.com/group/sub/repo/-/tree/main'],
  ])('GitLab keeps nested groups: %s', (raw) => {
    expect(normaliseRepoUrl(raw)).toBe('gitlab.com/group/sub/repo');
  });

  it.each([
    ['https://bitbucket.org/o/r'],
    ['ssh://git@bitbucket.org/o/r.git'],
    ['git@bitbucket.org:o/r.git'],
    ['git://git.example.com/o/r.git'],
    ['bitbucket:o/r'],
    ['file:///home/me/r'],
    ['https://expressjs.com/'],
    ['https://github.com'],
    ['https://github.com/onlyowner'],
    ['ssh://git@github.com:22/onlyowner'],
    ['git@github.com:onlyowner'],
    [''],
    ['   '],
    ['not a url at all'],
  ])('%s is not a Scorecard repository', (raw) => {
    expect(normaliseRepoUrl(raw)).toBeNull();
  });

  it('reads a bare owner/repo as GitHub only for npm', () => {
    expect(normaliseRepoUrl('expressjs/express', { npmShorthand: true })).toBe('github.com/expressjs/express');
    expect(normaliseRepoUrl('expressjs/express')).toBeNull();
  });

  it('ignores values that are not strings', () => {
    expect(normaliseRepoUrl(undefined)).toBeNull();
    expect(normaliseRepoUrl({ url: 'https://github.com/o/r' })).toBeNull();
  });
});

const RESULT: ScorecardResult = {
  project: 'github.com/x/y',
  via: 'registry',
  scoreVia: 'scorecard',
  date: '2026-10-06T00:00:00.000Z',
  overall: 3.4,
  checks: { 'Dangerous-Workflow': 0, Maintained: 10, Fuzzing: -1 },
};
const found = (overrides: Partial<ScorecardResult> = {}): ScorecardLookup => ({ status: 'found', result: { ...RESULT, ...overrides } });

describe('scorecardOutcome', () => {
  const rule = (conditions: Parameters<typeof compileScorecard>[0]) => compileScorecard(conditions)!;

  it('matches an overall score below the minimum, not at or above it', () => {
    const below = scorecardOutcome(found({ overall: 4.9 }), rule({ scorecardMinScore: 5 }), 'pkg');
    expect(below.match).toBe(true);
    expect(below.reasonKey).toBe('scorecard:overall');
    expect(below.reasons).toEqual(['Scorecard 4.9 is below 5 (github.com/x/y, declared by the package, 2026-10-06)']);
    expect(scorecardOutcome(found({ overall: 5 }), rule({ scorecardMinScore: 5 }), 'pkg').match).toBe(false);
    expect(scorecardOutcome(found({ overall: 8.9 }), rule({ scorecardMinScore: 5 }), 'pkg').match).toBe(false);
  });

  it('matches when one listed check is below its minimum, even with a good overall score', () => {
    const outcome = scorecardOutcome(
      found({ overall: 8.9 }),
      rule({ scorecardMinScore: 5, scorecardChecks: [{ name: 'Dangerous-Workflow', minScore: 10 }] }),
      'pkg'
    );
    expect(outcome).toMatchObject({ match: true, reasonKey: 'scorecard:Dangerous-Workflow' });
    expect(outcome.reasons).toEqual(['Scorecard check Dangerous-Workflow is 0, minimum 10 (github.com/x/y)']);
  });

  it('never matches a -1 (inconclusive) check or a check the source did not report', () => {
    const checks = [
      { name: 'Fuzzing', minScore: 5 },
      { name: 'Vulnerabilities', minScore: 10 },
    ];
    expect(scorecardOutcome(found(), rule({ scorecardChecks: checks }), 'pkg').match).toBe(false);
  });

  it('names the first failing condition as the reason key and lists every reason', () => {
    const outcome = scorecardOutcome(
      found(),
      rule({ scorecardMinScore: 5, scorecardChecks: [{ name: 'Dangerous-Workflow', minScore: 10 }] }),
      'pkg'
    );
    expect(outcome.reasonKey).toBe('scorecard:overall');
    expect(outcome.reasons).toHaveLength(2);
  });

  it('says where the repository and the score came from', () => {
    const outcome = scorecardOutcome(
      found({ via: 'deps.dev', provenance: 'SLSA_ATTESTATION', scoreVia: 'deps.dev', date: '2026-08-24T00:00:00.000Z' }),
      rule({ scorecardMinScore: 5 }),
      'pkg'
    );
    expect(outcome.reasons[0]).toBe('Scorecard 3.4 is below 5 (github.com/x/y, from deps.dev, SLSA_ATTESTATION, 2026-08-24, score from deps.dev)');
  });

  it('follows scorecardUnknown for a package without a result', () => {
    const unknown: ScorecardLookup = { status: 'unknown', reason: 'no-repository' };
    expect(scorecardOutcome(unknown, rule({ scorecardMinScore: 5 }), 'pkg').match).toBe(false);
    expect(scorecardOutcome(unknown, rule({ scorecardMinScore: 5, scorecardUnknown: 'block' }), 'pkg')).toEqual({
      match: true,
      reasons: ['No OpenSSF Scorecard result for pkg'],
      reasonKey: 'scorecard:unknown',
    });
  });

  it('follows scorecardUnavailable for a failed lookup, and marks it incomplete either way', () => {
    const failed: ScorecardLookup = { status: 'unavailable' };
    expect(scorecardOutcome(failed, rule({ scorecardMinScore: 5 }), 'pkg')).toEqual({ match: false, reasons: [], unavailable: true });
    expect(scorecardOutcome(failed, rule({ scorecardMinScore: 5, scorecardUnavailable: 'block' }), 'pkg')).toMatchObject({
      match: true,
      reasonKey: 'scorecard:unavailable',
      unavailable: true,
    });
  });

  it('never matches when the rule does not apply or is turned off, whatever the options', () => {
    const strict = rule({ scorecardMinScore: 5, scorecardUnknown: 'block', scorecardUnavailable: 'block' });
    expect(scorecardOutcome({ status: 'not-applicable', reason: 'internal-remote' }, strict, 'pkg').match).toBe(false);
    expect(scorecardOutcome({ status: 'not-applicable', reason: 'private-name' }, strict, 'pkg').match).toBe(false);
    expect(scorecardOutcome({ status: 'disabled' }, strict, 'pkg').match).toBe(false);
  });
});

describe('scorecard conditions', () => {
  it('accepts an overall minimum, check minimums and both options', () => {
    expect(
      scorecardConditionsError({
        scorecardMinScore: 5,
        scorecardChecks: [{ name: 'dangerous-workflow', minScore: 10 }],
        scorecardUnknown: 'block',
        scorecardUnavailable: 'allow',
      })
    ).toBeNull();
  });

  it.each([
    [{ scorecardMinScore: 11 }, /from 0 to 10/],
    [{ scorecardMinScore: -1 }, /from 0 to 10/],
    [{ scorecardMinScore: '5' }, /from 0 to 10/],
    [{ scorecardChecks: 'Maintained' }, /must be a list/],
    [{ scorecardChecks: [{ name: 'Nope', minScore: 1 }] }, /Unknown Scorecard check "Nope"/],
    [{ scorecardChecks: [{ name: 'Webhooks', minScore: 1 }] }, /never in public results/],
    [{ scorecardChecks: [{ name: 'Maintained', minScore: 12 }] }, /minimum for Maintained/],
    [
      {
        scorecardChecks: [
          { name: 'Maintained', minScore: 1 },
          { name: 'maintained', minScore: 2 },
        ],
      },
      /listed twice/,
    ],
    [{ scorecardMinScore: 5, scorecardUnknown: 'maybe' }, /scorecardUnknown must be allow or block/],
    [{ scorecardMinScore: 5, scorecardUnavailable: true }, /scorecardUnavailable must be allow or block/],
  ])('rejects %j', (conditions, message) => {
    expect(scorecardConditionsError(conditions as never)).toMatch(message);
  });

  it('stores check names in their canonical spelling', () => {
    expect(canonicalScorecardChecks({ scorecardChecks: [{ name: ' pinned-DEPENDENCIES ', minScore: 5 }] }).scorecardChecks).toEqual([
      { name: 'Pinned-Dependencies', minScore: 5 },
    ]);
  });

  it('compiles defaults: unknown and unavailable let packages through', () => {
    expect(compileScorecard({ scorecardMinScore: 4 })).toEqual({ minScore: 4, checks: [], unknown: 'allow', unavailable: 'allow' });
    expect(compileScorecard({ scorecardUnknown: 'block' })).toBeNull();
  });
});

describe('response parsing', () => {
  it('reads the Scorecard API body', () => {
    const parsed = parseScorecardApi({
      date: '2026-10-12T21:25:40Z',
      repo: { name: 'github.com/expressjs/express' },
      score: 8.9,
      checks: [
        { name: 'Fuzzing', score: 0, reason: 'project is not fuzzed', details: ['Warn'], documentation: { short: 'x', url: 'y' } },
        { name: 'Signed-Releases', score: -1, reason: 'no releases found' },
      ],
    });
    expect(parsed).toEqual({ date: '2026-10-12T21:25:40.000Z', overall: 8.9, checks: { Fuzzing: 0, 'Signed-Releases': -1 } });
  });

  it('reads the deps.dev project body, which nests the scan and calls the score overallScore', () => {
    const parsed = parseDepsDevProject({
      projectKey: { id: 'github.com/expressjs/express' },
      starsCount: 69553,
      scorecard: {
        date: '2026-08-24T00:00:00Z',
        overallScore: 8.5,
        checks: [{ name: 'Maintained', score: 10, documentation: { shortDescription: 'x', url: 'y' } }],
        metadata: [],
      },
    });
    expect(parsed).toEqual({ date: '2026-08-24T00:00:00.000Z', overall: 8.5, checks: { Maintained: 10 } });
  });

  it('returns null without a score', () => {
    expect(parseScorecardApi({ date: 'x' })).toBeNull();
    expect(parseDepsDevProject({ projectKey: { id: 'github.com/x/y' } })).toBeNull();
  });
});
