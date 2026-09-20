import { admitImport, admitResponse, control, controlError, dynamic, errorResponse, listProjectJobs, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(
  _request: Request,
  context: { params: Promise<{ project_id: string }> | { project_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const projectId = decodeURIComponent(resolved.project_id ?? "");
    const body = await listProjectJobs(await control(), projectId);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return controlError(error);
  }
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
    const result = await admitImport(await control(), projectId, body, bodyBytes);
    return admitResponse(result);
  } catch (error) {
    return controlError(error);
  }
}
