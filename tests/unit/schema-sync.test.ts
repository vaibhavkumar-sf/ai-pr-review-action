import * as fs from 'fs';
import * as path from 'path';
import { INPUTS, inputEnvVar } from '../../src/config/schema';

/**
 * Guards the config SSOT: the committed action.yml must reflect every schema
 * input. (`npm run check:action` enforces byte-exact sync at build time; this
 * test asserts the structural contract independently so a broken generator or a
 * hand-edit is caught by the test suite too.)
 */
describe('action.yml ↔ schema sync', () => {
  const actionYml = fs.readFileSync(path.join(__dirname, '..', '..', 'action.yml'), 'utf-8');

  it('declares every schema input with its default', () => {
    for (const spec of INPUTS) {
      expect(actionYml).toContain(`  ${spec.name}:`);
      if (!spec.required) {
        const quoted = `'${spec.default.replace(/'/g, "''")}'`;
        expect(actionYml).toContain(`    default: ${quoted}`);
      }
    }
  });

  it('wires an INPUT_ env line for every schema input', () => {
    for (const spec of INPUTS) {
      expect(actionYml).toContain(`    ${inputEnvVar(spec.name)}: \${{ inputs.${spec.name} }}`);
    }
  });

  it('declares the new provider and pr_number inputs (regression: previously missing/undeclared)', () => {
    const names = INPUTS.map(s => s.name);
    expect(names).toContain('ai_provider');
    expect(names).toContain('pr_number');
    expect(names).toContain('enable_diagrams');
    expect(actionYml).toContain('    INPUT_ENABLE_DIAGRAMS: ${{ inputs.enable_diagrams }}');
  });
});
