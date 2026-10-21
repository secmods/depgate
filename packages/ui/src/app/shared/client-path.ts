/** The path a package client uses for a repository, before the server has reported its own. */
export function clientPathFor(ecosystem: string, key: string): string {
  const paths: Record<string, string> = {
    npm: `/npm/${key}/`,
    pypi: `/pypi/${key}/simple/`,
    go: `/go/${key}`,
    maven: `/maven/${key}/`,
    nuget: `/nuget/${key}/v3/index.json`,
    cargo: `/cargo/${key}/`,
    composer: `/composer/${key}/packages.json`,
    rubygems: `/rubygems/${key}`,
  };
  return paths[ecosystem] ?? `/${ecosystem}/${key}/`;
}
