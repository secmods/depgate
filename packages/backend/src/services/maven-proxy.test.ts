import { describe, expect, it } from 'vitest';
import {
  extractMavenMetadataVersions,
  filterMavenMetadataXml,
  parseMavenPath,
} from './maven-proxy.js';

describe('maven-proxy service', () => {
  it('parses maven metadata path', () => {
    expect(parseMavenPath('junit/junit/maven-metadata.xml')).toEqual({
      type: 'metadata',
      groupId: 'junit',
      artifactId: 'junit',
      packageName: 'junit:junit',
      path: 'junit/junit/maven-metadata.xml',
    });
  });

  it('parses maven artifact path', () => {
    expect(parseMavenPath('junit/junit/4.13.2/junit-4.13.2.pom')).toEqual({
      type: 'artifact',
      groupId: 'junit',
      artifactId: 'junit',
      version: '4.13.2',
      packageName: 'junit:junit',
      fileName: 'junit-4.13.2.pom',
      path: 'junit/junit/4.13.2/junit-4.13.2.pom',
    });
  });

  it('extracts and filters metadata versions', () => {
    const xml = `
      <metadata>
        <versioning>
          <latest>2.0.0</latest>
          <release>2.0.0</release>
          <versions>
            <version>1.0.0</version>
            <version>2.0.0</version>
          </versions>
        </versioning>
      </metadata>
    `;
    expect(extractMavenMetadataVersions(xml)).toEqual(['1.0.0', '2.0.0']);
    const filtered = filterMavenMetadataXml(xml, new Set(['2.0.0']));
    expect(filtered).toContain('<version>1.0.0</version>');
    expect(filtered).not.toContain('<version>2.0.0</version>');
  });

});
