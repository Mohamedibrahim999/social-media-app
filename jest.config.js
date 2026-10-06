/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  globalSetup: "<rootDir>/tests/support/global-setup.ts",
  setupFiles: ["<rootDir>/tests/support/env.ts"],
  testTimeout: 60000,
  // Integration tests share one MongoDB + Redis, so test files must not run in parallel (yarn test uses --runInBand).
  maxWorkers: 1,
};
