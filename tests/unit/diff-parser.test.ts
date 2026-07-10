import { findDiffPosition, parseDiff } from '../../src/github/diff-parser';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const one = 1;
+const two = 2;
 const three = 3;
-const four = 4;
@@ -10,2 +11,3 @@
 const ten = 10;
+const eleven = 11;
 const twelve = 12;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
 export {};
+export const b = 1;
`;

describe('parseDiff', () => {
  it('parses files, hunks and line numbers', () => {
    const parsed = parseDiff(DIFF);
    expect(parsed.map(p => p.filename)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed[0].hunks).toHaveLength(2);

    const added = parsed[0].hunks[0].lines.find(l => l.type === 'add');
    expect(added?.content).toBe('const two = 2;');
    expect(added?.newLineNumber).toBe(2);

    const removed = parsed[0].hunks[0].lines.find(l => l.type === 'remove');
    expect(removed?.content).toBe('const four = 4;');
  });

  it('returns [] for empty input', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('   ')).toEqual([]);
  });
});

describe('findDiffPosition', () => {
  const parsed = parseDiff(DIFF);

  it('finds positions for added and context lines', () => {
    expect(findDiffPosition(parsed, 'src/a.ts', 2)).not.toBeNull();
    expect(findDiffPosition(parsed, 'src/a.ts', 1)).not.toBeNull(); // context
    expect(findDiffPosition(parsed, 'src/b.ts', 2)).not.toBeNull();
  });

  it('returns null for lines outside the diff', () => {
    expect(findDiffPosition(parsed, 'src/a.ts', 999)).toBeNull();
    expect(findDiffPosition(parsed, 'src/none.ts', 1)).toBeNull();
  });
});
