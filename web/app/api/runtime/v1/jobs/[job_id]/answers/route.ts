import { admitAnswer, admitResponse, control, dynamic, errorResponse, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function POST(
  request: Request,
  context: { params: Promise<{ job_id: string }> | { job_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const jobId = decodeURIComponent(resolved.job_id ?? "");
    const body = await request.json();
    const result = await admitAnswer(await control(), jobId, body);
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
