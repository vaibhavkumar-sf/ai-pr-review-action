import { extractRelativeImports, resolveRelativeImport } from '../../src/utils/imports';

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
