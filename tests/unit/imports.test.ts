import { extractImports, extractRelativeImports, resolveRelativeImport } from '../../src/utils/imports';

describe('extractImports', () => {
  it('captures specifiers for all import styles, including aliases and packages', () => {
    const src = `
      import { A } from './a';
      import B from '../lib/b';
      import * as C from '@scope/pkg';
      import { ApiService } from '@rao/core/api/api.service';
      import './side-effect';
      const d = await import('./d');
      const e = require('./e');
    `;
    const specifiers = extractImports(src).map((i) => i.specifier).sort();
    expect(specifiers).toEqual([
      '../lib/b', './a', './d', './e', './side-effect', '@rao/core/api/api.service', '@scope/pkg',
    ]);
  });

  it('captures exported names from named bindings, including "as" renames and type imports', () => {
    const src = `import { Foo, Bar as Baz, type Qux } from './things';`;
    expect(extractImports(src)[0].symbols).toEqual(['Foo', 'Bar', 'Qux']);
  });

  it('returns empty symbols for default, namespace, and side-effect imports', () => {
    const src = `
      import Def from './def';
      import * as NS from './ns';
      import './fx';
    `;
    for (const imp of extractImports(src)) {
      expect(imp.symbols).toEqual([]);
    }
  });

  it('captures export-from re-export statements (barrel files)', () => {
    const src = `
      export { UserModel } from './user.model';
      export * from './board.model';
    `;
    const imports = extractImports(src);
    const named = imports.find((i) => i.specifier === './user.model');
    expect(named?.symbols).toEqual(['UserModel']);
    expect(imports.some((i) => i.specifier === './board.model')).toBe(true);
  });
});

describe('extractRelativeImports', () => {
  it('extracts ES, dynamic, and require imports, relative only', () => {
    const src = `
      import { A } from './a';
      import B from '../lib/b';
      import * as C from '@scope/pkg';
      const d = await import('./d');
      const e = require('./e');
      const f = require('fs');
    `;
    expect(extractRelativeImports(src).sort()).toEqual(['../lib/b', './a', './d', './e']);
  });
});

describe('resolveRelativeImport', () => {
  it('resolves ./ and ../ against the importing file directory', () => {
    expect(resolveRelativeImport('src/services/user.ts', './repo')).toBe('src/services/repo');
    expect(resolveRelativeImport('src/services/user.ts', '../models/user')).toBe('src/models/user');
  });

  it('returns null when escaping the repository root', () => {
    expect(resolveRelativeImport('a.ts', '../outside')).toBeNull();
  });
});
