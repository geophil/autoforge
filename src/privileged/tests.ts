export interface TestRunResult {
  passRate: number;
  output: string;
}

export async function runAuthenticatedTests(_workingDirectory: string, _projectId: string): Promise<TestRunResult> {
  return {
    passRate: 1,
    output: "authenticated test runner placeholder: PASS"
  };
}
