import { describe, expect, it } from 'vitest';
import {
  artifactName,
  extractVersionFromArtifactUrl,
  findSimpleIndexFile,
  markYankedAnchor,
  simpleArtifactHref,
} from './pypi-simple.js';

describe('pypi-simple', () => {
  it('links a listed file by package and file name, with no upstream address in the link', () => {
    const href = simpleArtifactHref(
      'http://localhost:3050/',
      '/pypi/default/files',
      'requests',
      'https://files.pythonhosted.org/packages/f9/9b/requests-2.32.3-py3-none-any.whl',
      '#sha256=707'
    );
    expect(href).toBe('http://localhost:3050/pypi/default/files/requests/requests-2.32.3-py3-none-any.whl#sha256=707');
    // Nothing follows the file name, so pip can append .metadata (PEP 658).
    expect(href!.split('#')[0]).not.toContain('?');
    expect(simpleArtifactHref('http://localhost:3050', '/pypi/files', 'x', 'https://pypi.org/', '')).toBeNull();
  });

  it('finds a file in a simple index page, absolute or relative', () => {
    const html = [
      '<a href="https://files.pythonhosted.org/packages/x/y/pkg-1.0.0.tar.gz#sha256=abc">pkg-1.0.0.tar.gz</a>',
      '<a href="../../packages/a/b/c/pkg-1.0.0-py3-none-any.whl">wheel</a>',
    ].join('\n');
    expect(findSimpleIndexFile(html, 'https://pypi.org/simple/pkg/', 'pkg-1.0.0.tar.gz')).toBe(
      'https://files.pythonhosted.org/packages/x/y/pkg-1.0.0.tar.gz'
    );
    expect(findSimpleIndexFile(html, 'https://pypi.org/simple/pkg/', 'pkg-1.0.0-py3-none-any.whl')).toBe(
      'https://pypi.org/packages/a/b/c/pkg-1.0.0-py3-none-any.whl'
    );
    expect(findSimpleIndexFile(html, 'https://pypi.org/simple/pkg/', 'pkg-9.9.9.tar.gz')).toBeNull();
    expect(artifactName('https://files.pythonhosted.org/packages/x/y/pkg%2B1.0.tar.gz')).toBe('pkg+1.0.tar.gz');
  });

  it('marks a blocked file yanked with the policy sentence', () => {
    const anchor = '<a href="http://localhost:3050/pypi/files/pkg/pkg-1.2.3.tar.gz">pkg</a>';
    const marked = markYankedAnchor(anchor, 'Package blocked by policy "Block requests": manual block.');
    expect(marked).toContain('data-yanked="Package blocked by policy &quot;Block requests&quot;: manual block."');
    expect(marked).toContain('pkg-1.2.3.tar.gz');
  });

  it('extracts version from source artifact URL', () => {
    const url =
      'https://files.pythonhosted.org/packages/ba/bb/dfa0141a32d773c47e4dede1a617c59a23b74dd302e449cf85413fc96bc4/requests-0.2.0.tar.gz';
    expect(extractVersionFromArtifactUrl(url, 'requests')).toBe('0.2.0');
  });

  it('extracts version from wheel artifact URL', () => {
    const url =
      'https://files.pythonhosted.org/packages/aa/bb/cc/charset_normalizer-3.3.2-py3-none-any.whl';
    expect(extractVersionFromArtifactUrl(url, 'charset-normalizer')).toBe('3.3.2');
  });
});
