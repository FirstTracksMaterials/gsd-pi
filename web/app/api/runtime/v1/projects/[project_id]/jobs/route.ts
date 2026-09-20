import { admitImport, admitResponse, control, dynamic, errorResponse, notReady, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  return notReady("Job list snapshots are not ready until C07");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ project_id: string }> | { project_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const projectId = decodeURIComponent(resolved.project_id ?? "");
    const rawText = await request.text();
    const bodyBytes = Buffer.byteLength(rawText);
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return errorResponse(400, {
        code: "invalid_request",
        message: "Request body must be JSON",
        retryable: false,
      });
    }
    const result = await admitImport(control(), projectId, body, bodyBytes);
    return admitResponse(result);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status: number }).status) : 400;
    return errorResponse(status, {
      code: "invalid_request",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
}
