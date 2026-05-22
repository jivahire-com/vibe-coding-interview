/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/test'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/__mocks__/vscode.ts',
  },
  globals: {
    'ts-jest': {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
        strict: false,
      },
    },
  },
  clearMocks: false,
  resetMocks: false,
  restoreMocks: false,
  // The extension's auto-commit setInterval(180_000) lives for the whole
  // session in production; in tests it has no owner that calls clearInterval
  // unless a test exercises the submit flow. Force-exit so a leaked interval
  // from a test that activate()s without submitting doesn't wedge `npm test`.
  forceExit: true,
};
