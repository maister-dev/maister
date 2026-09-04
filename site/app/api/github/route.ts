import { NextResponse } from "next/server";

import { fetchRepositorySummary, GitHubRepositoryError } from "@/lib/github";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await fetchRepositorySummary());
  } catch (error) {
    if (error instanceof GitHubRepositoryError) {
      return NextResponse.json(
        { error: "GITHUB_REPOSITORY_UNAVAILABLE" },
        { status: 502 },
      );
    }

    throw error;
  }
}
