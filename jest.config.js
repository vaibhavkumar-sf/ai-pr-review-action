/** Jest configuration — unit tests live in tests/, fixtures in tests/fixtures/. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.' } }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
};
